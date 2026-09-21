/**
 * safeFs —— 文件系统特权的唯一执行点（S3 / I2）
 *
 * 为什么存在：仓库里原有两份互不复用的路径守卫（src/mcp/tools/filesystem.ts 的私有
 * isPathSafe、src/utils/permissions.ts 的 checkFilePermission），且**没有在真正执行
 * I/O 的那一行被调用**——走 adaptTool 的 write/read 基元更是完全裸奔。入口校验一旦
 * 与执行点分离，任何新调用方（内部管道、场景路由、外部 MCP 包装）都自动获得免检通道。
 *
 * 本模块把判定搬到 I/O 之前紧邻的一行，并补齐字符串守卫做不到的两件事：
 *   1. realpath：对已存在的最深祖先做真实路径解析，符号链接指向沙箱外即拒；
 *   2. 逐跳：对相对路径的每个前缀做锚点判定，防止只在末段比对被目录构造绕过。
 *
 * 沙箱根固定为 process.cwd()：调用方传入的 roots 只能收窄、不能放宽。
 */
import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { decideCapability, type Capability } from "./permissions.js";

export interface SafeFsOptions {
  /** 审计主体（不影响放行结论） */
  principal?: string;
  /** 期望的允许根；落在进程沙箱根之外的部分会被丢弃 */
  roots?: readonly string[];
}

/** 被拒时统一抛出，消息以 `denied:` 起始，便于上层与门用例断言。 */
export class CapabilityDeniedError extends Error {
  constructor(reason: string) {
    super(`denied: ${reason}`);
    this.name = "CapabilityDeniedError";
  }
}

function sandboxRoot(): string {
  return process.cwd();
}

function effectiveRoots(opts?: SafeFsOptions): string[] {
  const base = path.resolve(sandboxRoot());
  if (!opts?.roots || opts.roots.length === 0) return [base];
  // 只接受仍位于进程沙箱根内的收窄值：越界的 roots 参数不得成为放宽边界的后门
  return opts.roots
    .map((r) => path.resolve(base, r))
    .filter((r) => {
      const rel = path.relative(base, r);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
}

function withinAny(abs: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, abs);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/** 已存在的最深祖先的真实路径；整条路径都不存在时返回 null（新文件写入）。 */
function realAncestor(abs: string): { real: string } | null {
  let cur = abs;
  for (;;) {
    try {
      return { real: fsSync.realpathSync(cur) };
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

/**
 * 授权并返回绝对路径。判定顺序：越界 → 锚点（逐跳） → realpath 复核 → decideCapability。
 */
export function authorizePath(
  target: string,
  capability: Capability,
  opts?: SafeFsOptions,
): string {
  const roots = effectiveRoots(opts);
  const base = path.resolve(sandboxRoot());
  const abs = path.resolve(base, target);

  if (!withinAny(abs, roots)) {
    throw new CapabilityDeniedError(
      `path '${target}' escapes sandbox root ${base} for capability ${capability}`,
    );
  }

  // 逐跳：对每个祖先目录前缀单独判定，末段命中不算唯一依据
  const relative = path.relative(base, abs);
  const hops = relative.split(path.sep).filter(Boolean);
  for (let i = 1; i <= hops.length; i++) {
    const prefix = hops.slice(0, i).join("/");
    const decision = decideCapability({
      capability,
      target: path.join(base, prefix),
      principal: opts?.principal,
    });
    if (!decision.allow) {
      throw new CapabilityDeniedError(
        decision.reason ?? `path segment '${prefix}' denied for capability ${capability}`,
      );
    }
  }

  const found = realAncestor(abs);
  if (found) {
    const realBases = roots.map((r) => {
      try {
        return fsSync.realpathSync(r);
      } catch {
        return r;
      }
    });
    if (!withinAny(found.real, realBases)) {
      throw new CapabilityDeniedError(
        `path '${target}' resolves to '${found.real}' outside sandbox (symlink escape)`,
      );
    }
    for (const rb of realBases) {
      const realRelative = path.relative(rb, found.real);
      if (realRelative === "" || realRelative.startsWith(".")) continue;
      const decision = decideCapability({
        capability,
        target: path.join(base, realRelative),
        principal: opts?.principal,
      });
      if (!decision.allow) {
        throw new CapabilityDeniedError(
          decision.reason ?? `realpath '${found.real}' denied for capability ${capability}`,
        );
      }
    }
  }

  const decision = decideCapability({
    capability,
    target: abs,
    principal: opts?.principal,
  });
  if (!decision.allow) {
    throw new CapabilityDeniedError(decision.reason ?? `${capability} denied for '${target}'`);
  }
  return abs;
}

/** 读取。能力固定 fs.read：外部调用方无法把它升级为写。 */
export async function readFile(target: string, opts?: SafeFsOptions): Promise<Buffer> {
  const abs = authorizePath(target, "fs.read", opts);
  return fsp.readFile(abs);
}

export interface WriteOptions extends SafeFsOptions {
  /** 追加而非覆盖 */
  append?: boolean;
  /** 写文件时的能力档位（默认 fs.write；改配置须显式声明 cfg.write） */
  capability?: Capability;
}

/** 写入（含父目录创建，父目录同样逐跳判定）。 */
export async function writeFile(
  target: string,
  data: string | Buffer,
  opts?: WriteOptions,
): Promise<void> {
  const abs = authorizePath(target, opts?.capability ?? "fs.write", opts);
  const parent = path.dirname(abs);
  if (parent && parent !== abs) {
    await fsp.mkdir(parent, { recursive: true });
  }
  if (opts?.append) {
    await fsp.appendFile(abs, data);
  } else {
    await fsp.writeFile(abs, data);
  }
}

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

/**
 * 列目录 —— 逐项判定。
 *
 * 这是 L2 的封堵点：旧实现只对 root 过检，子项直接回显，`.env` 内容可经递归遍历外泄。
 * 被拒的子项从结果中剔除（目录本身仍可读），使越权读取在返回值里就没有通道。
 */
export async function readDir(
  target: string,
  opts?: SafeFsOptions,
): Promise<DirEntry[]> {
  const abs = authorizePath(target, "fs.glob", opts);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const entry of entries) {
    const type: DirEntry["type"] = entry.isDirectory()
      ? "directory"
      : entry.isSymbolicLink()
        ? "symlink"
        : "file";
    let blocked = false;
    try {
      authorizePath(path.join(abs, entry.name), "fs.read", opts);
    } catch {
      blocked = true;
    }
    if (!blocked) out.push({ name: entry.name, type });
  }
  return out;
}

export async function move(
  from: string,
  to: string,
  opts?: SafeFsOptions,
): Promise<void> {
  const src = authorizePath(from, "fs.delete", opts);
  const dst = authorizePath(to, "fs.write", opts);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
}

export async function remove(target: string, opts?: SafeFsOptions): Promise<void> {
  const abs = authorizePath(target, "fs.delete", opts);
  await fsp.rm(abs, { recursive: true, force: false });
}
