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

// ===== 同路径写串行化（进程内） =====
// 每次调用都成功，最终内容必为某一完整版本：rename 原子替换，进程崩溃也不留半截文件。
const writeQueues = new Map<string, Promise<unknown>>();

function queueWrite<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(abs) ?? Promise.resolve();
  const task = prev.then(fn, fn);
  writeQueues.set(abs, task);
  void task
    .catch(() => {})
    .then(() => {
      if (writeQueues.get(abs) === task) writeQueues.delete(abs);
    });
  return task;
}

/** mkdir -p 的 EEXIST 竞态可忽略：真实错误（EACCES 等）由后续写入显式抛出。 */
async function ensureParent(abs: string): Promise<void> {
  const parent = path.dirname(abs);
  if (parent && parent !== abs) {
    try {
      await fsp.mkdir(parent, { recursive: true });
    } catch {
      /* 交由紧邻的写盘步骤返回真实错误 */
    }
  }
}

export interface WriteOptions extends SafeFsOptions {
  /** 追加而非覆盖 */
  append?: boolean;
  /** 写文件时的能力档位（默认 fs.write；改配置须显式声明 cfg.write） */
  capability?: Capability;
}

/**
 * 写入（含父目录创建，父目录同样逐跳判定）。
 *
 * 串行化 + 原子替换自 mcp/tools/filesystem.ts 上收到这里（R1）：
 * 那两处修复由 CI 实证过（并发写同一文件会交错出损坏产物；Windows 下并发 rename
 * 同一目标确定性 EPERM），若只留在某一个工具里，其他调用方（write 基元、快照还原、
 * 插件）会各自重新踩一遍。授权与写盘同点，围栏不因调用方而异。
 */
export async function writeFile(
  target: string,
  data: string | Buffer,
  opts?: WriteOptions,
): Promise<void> {
  const capability = opts?.capability ?? "fs.write";
  const abs = authorizePath(target, capability, opts);
  await ensureParent(abs);
  await queueWrite(abs, async () => {
    // mkdir→write 窗口复核：父目录可能在这一步之间被换成指向沙箱外的链接（H-03 TOCTOU）
    authorizePath(target, capability, opts);
    if (opts?.append) {
      await fsp.appendFile(abs, data);
      return;
    }
    const tmp = `${abs}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, abs);
    } catch (writeErr) {
      try {
        await fsp.unlink(tmp);
      } catch {
        /* tmp 可能尚未创建 */
      }
      throw writeErr;
    }
  });
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

/** 移动/重命名：源按 fs.delete、目标按 fs.write 各自判定，缺一即拒。 */
export async function move(
  from: string,
  to: string,
  opts?: SafeFsOptions,
): Promise<void> {
  const src = authorizePath(from, "fs.delete", opts);
  const dst = authorizePath(to, "fs.write", opts);
  await ensureParent(dst);
  await queueWrite(dst, async () => {
    // mkdir→rename 窗口复核：目标与源都可能在此期间被替换为指向沙箱外的链接
    authorizePath(to, "fs.write", opts);
    authorizePath(from, "fs.delete", opts);
    await fsp.rename(src, dst);
  });
}

/**
 * 删除 —— 仅单文件 unlink，目录一律拒绝（fs_delete 的对外声明同此）。
 *
 * 刻意不提供 recursive rm：一旦这个原语自带递归，任何调用方都拿到"整棵子树消失"
 * 的爆破半径（S3 / L6），而当前没有需要递归删除的生产调用方。
 */
export async function remove(target: string, opts?: SafeFsOptions): Promise<void> {
  const abs = authorizePath(target, "fs.delete", opts);
  const stat = await fsp.lstat(abs);
  if (stat.isDirectory()) {
    throw new CapabilityDeniedError(`'${target}' is a directory; remove() deletes single files only`);
  }
  await fsp.unlink(abs);
}

