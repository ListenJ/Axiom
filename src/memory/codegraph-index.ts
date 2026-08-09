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
import { readFileSync, statSync } from "fs";
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
  // 尝试在 node_modules 中找到平台特定的二进制文件。
  // Windows 上优先 .exe shim —— 无需 shell 即可执行（.cmd 批处理必须要 shell，
  // 会引入分词与命令注入问题，见 runCodegraph）
  const candidates = [
    path.resolve("node_modules/.bin/codegraph.exe"),
    path.resolve("node_modules/@colbymchenry/codegraph-win32-x64/bin/codegraph.cmd"),
    path.resolve("node_modules/@colbymchenry/codegraph-darwin-x64/bin/codegraph"),
    path.resolve("node_modules/@colbymchenry/codegraph-darwin-arm64/bin/codegraph"),
    path.resolve("node_modules/@colbymchenry/codegraph-linux-x64/bin/codegraph"),
    path.resolve("node_modules/@colbymchenry/codegraph-linux-arm64/bin/codegraph"),
    "codegraph", // PATH 中的全局安装
  ];
  for (const c of candidates) {
    try {
      statSync(c);
      codegraphBin = c;
      return c;
    } catch { /* ignore */ }
  }
  throw new Error("CodeGraph binary not found. Run: npm install -g @colbymchenry/codegraph");
}

/** cmd/bat 批处理只能经 shell 执行，此时每个参数必须加引号防止 shell 分词 */
function quoteForShell(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

function runCodegraph(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const bin = getCodegraphBin();
    // 仅 .cmd/.bat 需要 shell；原生二进制/可执行文件用数组形式免 shell。
    // 此前 shell:true 会把含空格的查询分词（"Write bubble sort in Python"
    // 被拆成 5 个位置参数报 "too many arguments"），且查询中的 shell 元字符
    // 会被解释（命令注入面——查询可来自 LLM/用户输入）。
    const shell = /\.(cmd|bat)$/i.test(bin);
    const finalArgs = shell ? args.map(quoteForShell) : args;
    const proc = spawn(bin, finalArgs, { cwd: cwd || process.cwd(), shell });
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
  opts?: { limit?: number; includeContext?: boolean; projectPath?: string; structured?: boolean }
): Promise<
  | { source: "codegraph"; results: string; symbols: CodeGraphSearchResult[] }
  | { source: "codegraph-structured"; data: StructuredContextResult; symbols: CodeGraphSearchResult[] }
  | null
> {
  if (!(await isCodegraphInitialized(opts?.projectPath))) {
    logger.warn("[CodeGraph] Not initialized, skipping code memory retrieval");
    return null;
  }

  // 1. 搜索相关符号
  const symbols = await searchSymbols(query, { limit: opts?.limit ?? 10, projectPath: opts?.projectPath });

  // 2. 构建上下文（结构化或文本）
  if (opts?.structured) {
    const data = await buildStructuredContext(query, {
      maxNodes: opts?.limit ?? 10,
      includeCode: opts?.includeContext ?? true,
      projectPath: opts?.projectPath,
    });

    return {
      source: "codegraph-structured",
      data,
      symbols,
    };
  }

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

// ═══════════════════════════════════════════════════════════════
// P4: 结构化返回接口
// ═══════════════════════════════════════════════════════════════

export interface StructuredContextNode {
  node: CodeGraphNode;
  code?: string;
  relevance: number;
}

export interface StructuredContextRelationship {
  from: string;      // node id
  to: string;        // node id
  type: string;      // calls | imports | extends | implements
  strength: number;  // 0-1
}

export interface StructuredContextResult {
  task: string;
  nodes: StructuredContextNode[];
  relationships: StructuredContextRelationship[];
  summary: string;
  stats: {
    totalNodes: number;
    totalRelationships: number;
    languages: Record<string, number>;
    avgRelevance: number;
  };
}

/**
 * 构建结构化的代码上下文 (P4)
 * 返回类型化的节点和关系数据，供下游程序消费
 */
export async function buildStructuredContext(
  task: string,
  opts?: { maxNodes?: number; includeCode?: boolean; projectPath?: string }
): Promise<StructuredContextResult> {
  const maxNodes = opts?.maxNodes ?? 12;

  // 1. 搜索相关符号
  const symbols = await searchSymbols(task, { limit: maxNodes, projectPath: opts?.projectPath });

  // 2. 获取调用关系
  const relationshipMap = new Map<string, StructuredContextRelationship[]>();
  const allNodeIds = new Set<string>();

  const nodes: StructuredContextNode[] = await Promise.all(
    symbols.map(async (s, idx) => {
      allNodeIds.add(s.node.id);

      // 尝试获取代码片段
      let code: string | undefined;
      if (opts?.includeCode !== false && s.node.filePath) {
        try {
          const content = readFileSync(s.node.filePath, "utf-8");
          const lines = content.split("\n");
          const start = Math.max(0, s.node.startLine - 1);
          const end = Math.min(lines.length, s.node.endLine);
          code = lines.slice(start, end).join("\n");
        } catch { /* ignore */ }
      }

      // 获取调用关系
      try {
        const [callers, callees] = await Promise.all([
          getCallers(s.node.name, { limit: 5, projectPath: opts?.projectPath }),
          getCallees(s.node.name, { limit: 5, projectPath: opts?.projectPath }),
        ]);

        const rels: StructuredContextRelationship[] = [];
        for (const c of callers) {
          rels.push({
            from: c.node.id,
            to: s.node.id,
            type: "calls",
            strength: c.score,
          });
          allNodeIds.add(c.node.id);
        }
        for (const c of callees) {
          rels.push({
            from: s.node.id,
            to: c.node.id,
            type: "calls",
            strength: c.score,
          });
          allNodeIds.add(c.node.id);
        }
        relationshipMap.set(s.node.id, rels);
      } catch { /* ignore */ }

      return {
        node: s.node,
        code,
        relevance: Math.max(0, 1 - idx / maxNodes), // 排名越靠前相关性越高
      };
    })
  );

  // 3. 扁平化关系
  const allRelationships: StructuredContextRelationship[] = [];
  for (const rels of relationshipMap.values()) {
    allRelationships.push(...rels);
  }

  // 4. 生成摘要
  const languages: Record<string, number> = {};
  for (const n of nodes) {
    const lang = n.node.language || "unknown";
    languages[lang] = (languages[lang] || 0) + 1;
  }

  const avgRelevance = nodes.length > 0
    ? nodes.reduce((sum, n) => sum + n.relevance, 0) / nodes.length
    : 0;

  const summary = [
    `Task: ${task}`,
    `Found ${nodes.length} relevant symbols across ${Object.keys(languages).length} languages`,
    `Top symbols: ${nodes.slice(0, 5).map((n) => n.node.name).join(", ")}`,
  ].join("; ");

  return {
    task,
    nodes,
    relationships: allRelationships,
    summary,
    stats: {
      totalNodes: nodes.length,
      totalRelationships: allRelationships.length,
      languages,
      avgRelevance: Math.round(avgRelevance * 100) / 100,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// P3: 统一索引层 — 文件级符号查询 (供 CodeIndexer 使用)
// ═══════════════════════════════════════════════════════════════

export interface FileSymbolInfo {
  kind: string;
  name: string;
  line: number;
  signature?: string;
}

export interface FileImportInfo {
  source: string;
  names: string[];
  line: number;
}

export interface FileIndexData {
  filePath: string;
  exports: FileSymbolInfo[];
  imports: FileImportInfo[];
  summary: string;
  nodeCount: number;
  language: string;
}

/**
 * 从 CodeGraph 获取文件的符号信息 (P3)
 * 替代 code-indexer.ts 中的 regex 解析
 */
export async function getFileSymbolsFromCodeGraph(
  filePath: string,
  opts?: { projectPath?: string }
): Promise<FileIndexData | null> {
  if (!(await isCodegraphInitialized(opts?.projectPath))) {
    return null;
  }

  try {
    // 1. 搜索该文件中的所有符号
    const basename = path.basename(filePath, path.extname(filePath));
    const allSymbols = await searchSymbols(basename, {
      limit: 100,
      projectPath: opts?.projectPath,
    });

    // 过滤出属于该文件的符号
    const fileSymbols = allSymbols.filter(
      (s) => s.node.filePath === filePath || s.node.filePath.endsWith(filePath)
    );

    if (fileSymbols.length === 0) {
      return null;
    }

    // 2. 转换为统一格式
    const exports: FileSymbolInfo[] = fileSymbols.map((s) => ({
      kind: s.node.kind,
      name: s.node.name,
      line: s.node.startLine,
      signature: s.node.signature,
    }));

    // 3. 获取文件信息
    const fileResults = await searchFiles("*", {
      path: filePath,
      limit: 1,
      projectPath: opts?.projectPath,
    });

    const fileInfo = fileResults[0];

    return {
      filePath,
      exports,
      imports: [], // CodeGraph 暂不提供导入信息，下游可补充
      summary: `File: ${filePath}; ${exports.length} symbols; Language: ${fileInfo?.language || "unknown"}`,
      nodeCount: fileSymbols.length,
      language: fileInfo?.language || "unknown",
    };
  } catch (error) {
    logger.debug("[CodeGraph] Failed to get file symbols", { filePath, error });
    return null;
  }
}

/**
 * 批量获取多个文件的符号信息 (P3)
 */
export async function getBatchFileSymbols(
  filePaths: string[],
  opts?: { projectPath?: string }
): Promise<Map<string, FileIndexData>> {
  const results = new Map<string, FileIndexData>();

  await Promise.all(
    filePaths.map(async (fp) => {
      const data = await getFileSymbolsFromCodeGraph(fp, opts);
      if (data) {
        results.set(fp, data);
      }
    })
  );

  return results;
}
