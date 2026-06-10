/**
 * CodeGraph 记忆索引封装层
 * 将 CodeGraph 作为代码/项目知识的计算检索引擎
 *
 * CodeGraph 提供:
 *   - 符号搜索 (searchNodes)
 *   - 调用关系 (getCallers / getCallees)
 *   - 影响分析 (getImpactRadius)
 *   - 上下文构建 (buildContext)
 *   - 代码追踪 (tracePath)
 *   - 文件结构 (getFiles)
 *
 * 所有操作都是 100% 本地，无需 API key
 */
import { spawn } from "child_process";
import path from "path";
import { logger } from "../utils/logger.js";
import { Cache } from "../utils/cache.js";
import { TIMEOUTS } from "../constants/timeouts.js";

// ═══════════════════════════════════════════════════════════════
// CodeGraph 查询缓存层 (P0 优化)
// ═══════════════════════════════════════════════════════════════

const codegraphCache = new Cache<unknown>({
  namespace: "codegraph",
  maxSize: 500,
  defaultTtlMs: TIMEOUTS.CODEGRAPH_CACHE_TTL,
  persistent: false, // 内存缓存即可，索引变更时自动失效
  redis: false,
});

/** 生成缓存 key */
function cacheKey(method: string, params: unknown): string {
  return `${method}:${JSON.stringify(params)}`;
}

/** 包装带缓存的查询 */
async function cachedQuery<T>(
  method: string,
  params: unknown,
  executor: () => Promise<T>
): Promise<T> {
  const key = cacheKey(method, params);
  const cached = codegraphCache.getSync(key) as T | undefined;
  if (cached !== undefined) {
    logger.debug("[CodeGraph] Cache hit", { method, params });
    return cached;
  }
  const result = await executor();
  codegraphCache.set(key, result as unknown, TIMEOUTS.CODEGRAPH_CACHE_TTL);
  return result;
}

/** 使缓存失效（在索引重建后调用） */
export function invalidateCodegraphCache(): void {
  codegraphCache.clear();
  logger.info("[CodeGraph] Cache invalidated after reindex");
}

let codegraphBin: string | null = null;

function getCodegraphBin(): string {
  if (codegraphBin) return codegraphBin;
  // 尝试在 node_modules 中找到平台特定的二进制文件
  const candidates = [
    path.resolve("node_modules/@colbymchenry/codegraph-win32-x64/bin/codegraph.cmd"),
    path.resolve("node_modules/@colbymchenry/codegraph-darwin-x64/bin/codegraph"),
    path.resolve("node_modules/@colbymchenry/codegraph-darwin-arm64/bin/codegraph"),
    path.resolve("node_modules/@colbymchenry/codegraph-linux-x64/bin/codegraph"),
    path.resolve("node_modules/@colbymchenry/codegraph-linux-arm64/bin/codegraph"),
    "codegraph", // PATH 中的全局安装
  ];
  for (const c of candidates) {
    try {
      const { statSync } = require("fs");
      statSync(c);
      codegraphBin = c;
      return c;
    } catch { /* ignore */ }
  }
  throw new Error("CodeGraph binary not found. Run: npm install -g @colbymchenry/codegraph");
}

function runCodegraph(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const bin = getCodegraphBin();
    const proc = spawn(bin, args, { cwd: cwd || process.cwd(), shell: true });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });
}

export interface CodeGraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature?: string;
}

export interface CodeGraphSearchResult {
  node: CodeGraphNode;
  score: number;
}

export interface CodeGraphContextResult {
  task: string;
  nodes: Array<{ node: CodeGraphNode; code?: string }>;
  relationships: Array<{ from: string; to: string; type: string }>;
  summary?: string;
}

export interface CodeGraphFileResult {
  path: string;
  language: string;
  nodeCount: number;
  size: number;
}

/**
 * 通过 glob 模式搜索已索引的文件
 *
 * 使用 codegraph files --pattern <glob> --format flat -j 查询
 */
export async function searchFiles(
  pattern: string,
  opts?: { path?: string; limit?: number; projectPath?: string }
): Promise<CodeGraphFileResult[]> {
  const args = ["files", "--pattern", pattern, "--format", "flat", "--json"];

  if (opts?.path) {
    const projectPath = opts.projectPath || process.cwd();
    let filterPath = opts.path;
    if (path.isAbsolute(filterPath)) {
      filterPath = path.relative(projectPath, filterPath);
    }
    if (filterPath && filterPath !== "." && filterPath !== "") {
      args.push("--filter", filterPath);
    }
  }

  const { stdout, stderr, exitCode } = await runCodegraph(args, opts?.projectPath);
  if (exitCode !== 0) {
    logger.warn("[CodeGraph] Files search failed", { pattern, error: stderr });
    return [];
  }

  try {
    const results = JSON.parse(stdout) as CodeGraphFileResult[];
    if (opts?.limit && opts.limit > 0) {
      return results.slice(0, opts.limit);
    }
    return results;
  } catch {
    return [];
  }
}

/** 检查项目是否已索引 */
export async function isCodegraphInitialized(projectPath?: string): Promise<boolean> {
  const cwd = projectPath || process.cwd();
  try {
    const { statSync } = require("fs");
    statSync(path.join(cwd, ".codegraph", "codegraph.db"));
    return true;
  } catch {
    return false;
  }
}

/** 初始化并索引项目 */
export async function initializeCodegraph(projectPath?: string): Promise<void> {
  const cwd = projectPath || process.cwd();
  const { stdout, stderr, exitCode } = await runCodegraph(["init", "-i"], cwd);
  if (exitCode !== 0) {
    logger.error("[CodeGraph] Init failed", new Error(stderr || stdout));
    throw new Error(`CodeGraph init failed: ${stderr || stdout}`);
  }
  logger.info("[CodeGraph] Initialized and indexed", { path: cwd });
}

/** 搜索符号 (带缓存) */
export async function searchSymbols(
  query: string,
  opts?: { kind?: string; limit?: number; projectPath?: string }
): Promise<CodeGraphSearchResult[]> {
  return cachedQuery("searchSymbols", { query, ...opts }, async () => {
    const args = ["query", query, "--json"];
    if (opts?.kind) args.push("--kind", opts.kind);
    if (opts?.limit) args.push("--limit", String(opts.limit));

    const { stdout, stderr, exitCode } = await runCodegraph(args, opts?.projectPath);
    if (exitCode !== 0) {
      logger.warn("[CodeGraph] Search failed", { query, error: stderr });
      return [];
    }

    try {
      return JSON.parse(stdout) as CodeGraphSearchResult[];
    } catch {
      return [];
    }
  });
}

/** 获取符号的调用者 (带缓存) */
export async function getCallers(
  symbolName: string,
  opts?: { limit?: number; projectPath?: string }
): Promise<CodeGraphSearchResult[]> {
  return cachedQuery("getCallers", { symbolName, ...opts }, async () => {
    const args = ["callers", symbolName, "--json"];
    if (opts?.limit) args.push("--limit", String(opts.limit));

    const { stdout, exitCode } = await runCodegraph(args, opts?.projectPath);
    if (exitCode !== 0) return [];
    try { return JSON.parse(stdout); } catch { return []; }
  });
}

/** 获取符号的被调用者 (带缓存) */
export async function getCallees(
  symbolName: string,
  opts?: { limit?: number; projectPath?: string }
): Promise<CodeGraphSearchResult[]> {
  return cachedQuery("getCallees", { symbolName, ...opts }, async () => {
    const args = ["callees", symbolName, "--json"];
    if (opts?.limit) args.push("--limit", String(opts.limit));

    const { stdout, exitCode } = await runCodegraph(args, opts?.projectPath);
    if (exitCode !== 0) return [];
    try { return JSON.parse(stdout); } catch { return []; }
  });
}

/** 构建任务相关的代码上下文 (带缓存) */
export async function buildContext(
  task: string,
  opts?: { maxNodes?: number; includeCode?: boolean; format?: "markdown" | "json"; projectPath?: string }
): Promise<string> {
  return cachedQuery("buildContext", { task, ...opts }, async () => {
    const args = ["context", task];
    if (opts?.maxNodes) args.push("--max-nodes", String(opts.maxNodes));
    if (opts?.includeCode !== false) args.push("--include-code");
    if (opts?.format) args.push("--format", opts.format);

    const { stdout, exitCode } = await runCodegraph(args, opts?.projectPath);
    if (exitCode !== 0) {
      logger.warn("[CodeGraph] Context build failed", { task, error: stdout });
      return "";
    }
    return stdout;
  });
}

/** 获取符号的影响半径 */
export async function getImpact(
  symbolName: string,
  opts?: { depth?: number; projectPath?: string }
): Promise<string> {
  const args = ["impact", symbolName];
  if (opts?.depth) args.push("--depth", String(opts.depth));

  const { stdout, exitCode } = await runCodegraph(args, opts?.projectPath);
  if (exitCode !== 0) return "";
  return stdout;
}

/** 获取索引状态 */
export async function getStatus(projectPath?: string): Promise<{ files: number; nodes: number; edges: number } | null> {
  const { stdout, exitCode } = await runCodegraph(["status", "--json"], projectPath);
  if (exitCode !== 0) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** 全文本搜索记忆（优先使用 CodeGraph，回退到 Vault） */
export async function retrieveCodeMemory(
  query: string,
  opts?: { limit?: number; includeContext?: boolean; projectPath?: string }
): Promise<{ source: "codegraph"; results: string; symbols: CodeGraphSearchResult[] } | null> {
  if (!(await isCodegraphInitialized(opts?.projectPath))) {
    logger.warn("[CodeGraph] Not initialized, skipping code memory retrieval");
    return null;
  }

  // 1. 搜索相关符号
  const symbols = await searchSymbols(query, { limit: opts?.limit ?? 10, projectPath: opts?.projectPath });

  // 2. 构建上下文
  const context = await buildContext(query, {
    maxNodes: opts?.limit ?? 10,
    includeCode: opts?.includeContext ?? true,
    format: "markdown",
    projectPath: opts?.projectPath,
  });

  return {
    source: "codegraph",
    results: context,
    symbols,
  };
}
