/**
 * 执行沙箱统一层（T3，2026-09-18）
 *
 * 背景：路径/命令校验此前分散在多处——`src/mcp/tool-registry.ts` 的字段名启发式、
 * `src/mcp/tools/filesystem.ts`（14 处 isPathSafe）、`src/computer-use/browser-launch.ts`、
 * `src/knowledge/document-ingest.ts`、`src/sandbox/docker-sandbox.ts` 各自一套，
 * 且 tool-registry 自己的注释已承认「仍非完备——非常规字段名携带路径可绕过本初筛」。
 *
 * 本模块是**唯一执行收口点**：把「参数 → 硬底线拒绝」的策略集中到一处，
 * 由 `ToolRegistry` 的默认守卫在**每个 MCP 工具执行前**调用。
 *
 * 设计边界（避免过度施工）：
 *   - 只做**硬底线**（命令高危模式 + 敏感路径），不做 cwd 围栏。
 *     cwd 围栏是文件系统工具的专属语义（合法外部绝对路径很多），
 *     由调用方显式 `{ cwdFenced: true }` 开启，不做全局默认。
 *   - 不新增拒绝规则：分类规则与既有字段名并集一致，只是把**递归**补上。
 *   - 语义源复用既有 `utils/permissions.ts` 与 `utils/path-safety.ts`，不另立一套。
 */
import { checkCommandPermission, checkFilePermission } from "../utils/permissions.js";
import { isPathSafe, resolvePath } from "../utils/path-safety.js";

/** 收口点拒绝执行时抛出的错误（调用方按 toolName 归类即可） */
export class ExecutionDeniedError extends Error {
  readonly code: string;
  readonly toolName: string;
  readonly field: string;

  /**
   * 消息格式与收口前的 `[HardFloor] <reason> (tool=<name>, field=<key>)` 保持一致
   * （既有回归用例与文档按 `HardFloor` 断言）。
   * 本类自身**不拼接参数值**，只放 reason 与字段名。
   * 注意（如实登记）：`utils/permissions.ts` 的 reason 文本本身包含路径
   * （如 `Sensitive path: /etc/shadow requires manual confirmation`），
   * 因此消息中仍可能出现路径。这是改动前既有行为，未在本轮改动，
   * 需连同 permissions.ts 的消息格式一起评审后才能收紧。
   */
  constructor(code: string, toolName: string, field: string, reason: string) {
    super(`[HardFloor] ${reason} (tool=${toolName}, field=${field || "-"}, code=${code})`);
    this.name = "ExecutionDeniedError";
    this.code = code;
    this.toolName = toolName;
    this.field = field;
  }
}

export interface GuardedValue {
  /** 承载该值的字段名（数组元素沿用其父字段名） */
  key: string;
  value: string;
}

export interface GuardOptions {
  /** true = 路径参数必须落在 cwd 内（文件系统工具语义），默认 false */
  cwdFenced?: boolean;
}

/**
 * 字段名并集（与 tool-registry 改动前的列表逐项一致，仅补递归）。
 * 扩大这里的列表会新增拒绝面，属行为变更，需单独评审。
 */
const PATH_LIKE_KEY_RE =
  /^(path|file|filePath|file_path|target|destination|source|url|from|to|repoPath|repo_path|cwd|dir|dirPath|dir_path|folder|directory|absPath|abs_path|newPath|new_path|oldPath|old_path|destPath|dest_path|srcPath|src_path|outputPath|output_path)$/i;

const COMMAND_LIKE_KEY_RE = /command|script|cmd/i;

/** 与 utils/permissions.ts 的敏感段规则同源：整串命中即视为敏感路径候选 */
const SENSITIVE_VALUE_RE =
  /(^|[\\/])\.env([\\/].*)?$|(^|[\\/])\.env\.[^\\/]+$|^\/etc(\/|$)|\/etc\/(shadow|passwd|sudoers)$|(^|[\\/])\.ssh([\\/]|$)|(^|[\\/])\.git[\\/]config$/i;

export function isPathLikeKey(key: string): boolean {
  return PATH_LIKE_KEY_RE.test(key);
}

export function isCommandLikeKey(key: string): boolean {
  return COMMAND_LIKE_KEY_RE.test(key);
}

/** 值本身的形态是否像路径（不含 URL；相对裸文件名不算，除敏感段外） */
export function looksLikePathValue(value: string): boolean {
  if (!value || value.length > 4096) return false;
  if (value.includes("://")) return false;
  if (/\s/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.includes("/") || value.includes("\\");
}

/**
 * 递归收集参数中的字符串值，保留其字段名。
 * 深度与条目数设上限，避免深层/超大参数造成 CPU 放大（拒绝服务面）。
 */
export function collectGuardedValues(
  args: unknown,
  limit = { maxEntries: 2000, maxDepth: 12 },
): GuardedValue[] {
  const out: GuardedValue[] = [];
  const walk = (node: unknown, key: string, depth: number): void => {
    if (out.length >= limit.maxEntries || depth > limit.maxDepth) return;
    if (typeof node === "string") {
      if (node.trim()) out.push({ key, value: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, k, depth + 1);
    }
  };
  walk(args, "", 0);
  return out;
}

function operationFor(toolName: string): "read" | "write" | "delete" {
  if (/delete|remove/i.test(toolName)) return "delete";
  if (/write|create|move/i.test(toolName)) return "write";
  return "read";
}

/**
 * 唯一执行收口点：任一硬底线命中即抛 `ExecutionDeniedError`。
 * 通过 = 返回 undefined（不产生返回值语义，避免调用方误用）。
 */
export function guardToolExecution(
  toolName: string,
  args: Record<string, unknown>,
  opts?: GuardOptions,
): void {
  const op = operationFor(toolName);
  for (const { key, value } of collectGuardedValues(args)) {
    if (isCommandLikeKey(key)) {
      const c = checkCommandPermission(value);
      if (!c.allowed) {
        throw new ExecutionDeniedError(
          "hard-floor-command",
          toolName,
          key,
          c.reason ?? "high-risk command",
        );
      }
    }

    const pathCandidate =
      isPathLikeKey(key) || looksLikePathValue(value) || SENSITIVE_VALUE_RE.test(value);
    if (!pathCandidate) continue;

    const f = checkFilePermission(value, op);
    if (!f.allowed) {
      throw new ExecutionDeniedError(
        "hard-floor-path",
        toolName,
        key,
        f.reason ?? "sensitive path",
      );
    }

    if (opts?.cwdFenced) {
      const safe = isPathSafe(resolvePath(value));
      if (!safe.safe) {
        throw new ExecutionDeniedError("cwd-fence", toolName, key, safe.error ?? "path escapes cwd");
      }
    }
  }
}

/** 执行收口点的自述信息（用于状态接口/文档一致性检查） */
export const EXECUTION_GUARD_INFO = {
  name: "execution-guard",
  /** 唯一收口函数名 */
  entry: "guardToolExecution",
  policy: ["hard-floor-command", "hard-floor-path", "cwd-fence(opt-in)"],
} as const;
