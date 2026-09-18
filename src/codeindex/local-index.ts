/**
 * 专有代码索引（本地 AST → SQLite）
 *
 * 目标：突破对外部 codegraph CLI 的依赖——逐实体 spawn 外部进程慢且脆弱。
 * 本模块用 TypeScript Compiler API 直接解析 TS/JS 系源码，把符号与调用关系
 * 写入本地 SQLite（code-index.db），提供与 codegraph-index.ts 同构的查询接口，
 * 供知识图谱构建与代码工具本地优先使用；非 TS/JS 语言仍回退外部 codegraph。
 */
import { Database } from "bun:sqlite";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

// ── 数据结构（与 codegraph-index 的 CodeGraphNode / CodeGraphSearchResult 对齐） ──
export interface CodeSymbol {
  id: number;
  project: string;
  qualifiedName: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
  language: string;
}

export interface LocalSearchResult {
  node: CodeSymbol;
  score: number;
}

// ── SQLite ──
let _db: Database | null = null;
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".tmp", ".tmp-build", ".tmp-e2e",
  ".venv", "__pycache__", ".cache", "target", ".codegraph", "coverage", "reports", "vendor",
]);

function dbPath(): string {
  // 单一知识库：代码索引直接并入主库（DATABASE_PATH），不再使用独立 code-index.db
  return path.resolve(readString("DATABASE_PATH", "./data/agent.db"));
}

export function getCodeIndexDb(): Database {
  if (_db) return _db;
  _db = new Database(dbPath());
  ensureSchema(_db);
  return _db;
}


/** 预编译语句缓存：避免每查询重复 prepare（bun:sqlite db.query 会重新编译）。 */
const stmtCache = new Map<string, ReturnType<Database["query"]>>();
function q(db: Database, sql: string): ReturnType<Database["query"]> {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.query(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

function ensureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS code_symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT,
      language TEXT NOT NULL DEFAULT 'ts',
      UNIQUE(project, qualified_name)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_project_kind ON code_symbols(project, kind)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_name ON code_symbols(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_project_name ON code_symbols(project, name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_project_qual ON code_symbols(project, qualified_name)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS code_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      caller_id INTEGER NOT NULL,
      callee_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      UNIQUE(caller_id, callee_id, file_path, line)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_calls_callee ON code_calls(project, callee_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_calls_caller ON code_calls(project, caller_id)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS code_index_meta (
      project TEXT PRIMARY KEY,
      last_indexed_at INTEGER NOT NULL,
      files INTEGER NOT NULL DEFAULT 0,
      symbols INTEGER NOT NULL DEFAULT 0
    )
  `);
}

export function isProjectIndexed(projectName: string): boolean {
  try {
    const db = getCodeIndexDb();
    const row = db.query("SELECT 1 FROM code_index_meta WHERE project = ?").get(projectName);
    return !!row;
  } catch {
    return false;
  }
}

// ── 扫描 ──
function scanSourceFiles(projectPath: string): string[] {
  const out: string[] = [];
  const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!EXCLUDE_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (exts.has(path.extname(e.name))) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(projectPath);
  return out;
}

// ── AST 提取 ──
interface PendingCall {
  callerName: string | null;
  calleeName: string;
  filePath: string;
  line: number;
}

function scriptKindFor(file: string): ts.ScriptKind {
  const ext = path.extname(file);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function sourceTextLine(source: string, startLine: number, endLine: number): string {
  const lines = source.split("\n");
  const slice = lines.slice(startLine - 1, endLine).join(" ").trim();
  return slice.length > 120 ? slice.slice(0, 120) + "…" : slice;
}

interface FileIndexResult {
  symbols: Array<Omit<CodeSymbol, "id">>;
  calls: PendingCall[];
}

function indexFile(file: string, project: string): FileIndexResult {
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const language = path.extname(file).replace(/^\./, "") || "ts";
  const symbols: Array<Omit<CodeSymbol, "id">> = [];
  const calls: PendingCall[] = [];
  let currentContainer: string | null = null;

  function pushSymbol(node: ts.Node, name: string, kind: string): void {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(node.getEnd());
    const qualifiedName = currentContainer && (kind === "method" || kind === "property")
      ? currentContainer + "." + name
      : name;
    symbols.push({
      project,
      qualifiedName,
      name,
      kind,
      filePath: file,
      startLine: pos.line + 1,
      endLine: end.line + 1,
      signature: sourceTextLine(source, pos.line + 1, end.line + 1),
      language,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "function");
      const prev = currentContainer; currentContainer = node.name.text;
      ts.forEachChild(node, visit);
      currentContainer = prev;
      return;
    }
    if (ts.isClassDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "class");
      const prev = currentContainer; currentContainer = node.name.text;
      ts.forEachChild(node, visit);
      currentContainer = prev;
      return;
    }
    if (ts.isInterfaceDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "interface");
      const prev = currentContainer; currentContainer = node.name.text;
      ts.forEachChild(node, visit);
      currentContainer = prev;
      return;
    }
    if (ts.isEnumDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "enum");
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "type");
      return;
    }
    if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name) {
      const name = node.name.getText(sf);
      pushSymbol(node, name, "method");
      // 方法体内调用归属到限定方法（Class.method），而非仅容器类
      const prev = currentContainer;
      currentContainer = currentContainer ? currentContainer + "." + name : name;
      ts.forEachChild(node, visit);
      currentContainer = prev;
      return;
    }
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      // 仅函数/箭头函数初始化的变量作为 function 符号；普通变量是噪音（数量大且无查询价值）
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        pushSymbol(node, node.name.text, "function");
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      let calleeName: string | null = null;
      if (ts.isIdentifier(node.expression)) calleeName = node.expression.text;
      else if (ts.isPropertyAccessExpression(node.expression)) calleeName = node.expression.name.text;
      if (calleeName) calls.push({ callerName: currentContainer, calleeName, filePath: file, line });
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return { symbols, calls };
}

/**
 * 全量索引一个项目（TS/JS 系）。返回统计；非源码目录自动排除。
 */
export function indexProject(projectPath: string, projectName = path.basename(projectPath)): { files: number; symbols: number; calls: number } {
  const files = scanSourceFiles(projectPath);
  const db = getCodeIndexDb();
  const tx = db.transaction(() => {
    db.run("DELETE FROM code_symbols WHERE project = ?", [projectName]);
    db.run("DELETE FROM code_calls WHERE project = ?", [projectName]);
    const symbolInsert = db.prepare(`
      INSERT OR REPLACE INTO code_symbols (project, qualified_name, name, kind, file_path, start_line, end_line, signature, language)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let symbolCount = 0;
    const nameToIds = new Map<string, number[]>();
    for (const file of files) {
      try {
        const { symbols } = indexFile(file, projectName);
        for (const s of symbols) {
          symbolInsert.run(s.project, s.qualifiedName, s.name, s.kind, s.filePath, s.startLine, s.endLine, s.signature ?? null, s.language);
          const id = Number((db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
          symbolCount++;
          const arr = nameToIds.get(s.name) ?? [];
          arr.push(id);
          nameToIds.set(s.name, arr);
        }
      } catch {
        // 单文件解析失败跳过
      }
    }
    const callInsert = db.prepare(`
      INSERT OR IGNORE INTO code_calls (project, caller_id, callee_id, file_path, line)
      VALUES (?, ?, ?, ?, ?)
    `);
    let callCount = 0;
    const qualToId = new Map<string, number>();
    for (const row of db.query("SELECT id, qualified_name FROM code_symbols WHERE project = ?").all(projectName) as Array<{ id: number; qualified_name: string }>) {
      qualToId.set(row.qualified_name, row.id);
    }
    const resolveId = (name: string): number | null => {
      if (qualToId.has(name)) return qualToId.get(name)!;
      const ids = nameToIds.get(name);
      return ids && ids.length > 0 ? ids[0] : null;
    };
    for (const file of files) {
      try {
        const { calls } = indexFile(file, projectName);
        for (const c of calls) {
          const calleeId = resolveId(c.calleeName);
          if (!calleeId) continue;
          const callerId = c.callerName ? resolveId(c.callerName) : null;
          if (callerId === null || callerId === calleeId) continue;
          callInsert.run(projectName, callerId, calleeId, c.filePath, c.line);
          callCount++;
        }
      } catch {
        // 跳过
      }
    }
    db.run(`INSERT OR REPLACE INTO code_index_meta (project, last_indexed_at, files, symbols) VALUES (?, ?, ?, ?)`, [projectName, Date.now(), files.length, symbolCount]);
    return { files: files.length, symbols: symbolCount, calls: callCount };
  });
  const result = tx();
  logger.info("[CodeIndex] Project indexed", { project: projectName, files: result.files, symbols: result.symbols, calls: result.calls });
  return result;
}

/** 本地优先：项目已索引则用本地查询，否则返回 null 让调用方回退。 */
export function tryLocal<T>(projectPath: string | undefined, projectName: string, localFn: () => T): T | null {
  if (!projectPath) return null;
  if (!isProjectIndexed(projectName)) return null;
  try {
    return localFn();
  } catch (e) {
    logger.warn("[CodeIndex] Local query failed, falling back", { error: (e as Error).message });
    return null;
  }
}

export function searchSymbolsLocal(
  query: string,
  projectName: string,
  opts?: { kind?: string; limit?: number },
): LocalSearchResult[] {
  const db = getCodeIndexDb();
  const limit = opts?.limit ?? 100;
  const like = `%${query}%`;
  const rows = opts?.kind
    ? q(db, `SELECT * FROM code_symbols WHERE project = ? AND kind = ? AND (name LIKE ? OR qualified_name LIKE ?) ORDER BY name LIMIT ?`).all(projectName, opts.kind, like, like, limit)
    : q(db, `SELECT * FROM code_symbols WHERE project = ? AND (name LIKE ? OR qualified_name LIKE ?) ORDER BY name LIMIT ?`).all(projectName, like, like, limit);
  return (rows as CodeSymbol[]).map((s) => ({ node: s, score: 1 }));
}

export function getCallersLocal(
  symbolName: string,
  projectName: string,
  opts?: { limit?: number },
): LocalSearchResult[] {
  const db = getCodeIndexDb();
  const limit = opts?.limit ?? 100;
  // 三步查询：先定位 callee id（name/qualified 各走索引，避免 OR 全表扫）→ caller ids → 详情
  const byName = q(db, `SELECT id FROM code_symbols WHERE project = ? AND name = ? LIMIT 50`).all(projectName, symbolName) as Array<{ id: number }>;
  const byQual = q(db, `SELECT id FROM code_symbols WHERE project = ? AND qualified_name = ? LIMIT 50`).all(projectName, symbolName) as Array<{ id: number }>;
  const seen = new Set<number>();
  const calleeRows = [...byName, ...byQual].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  if (calleeRows.length === 0) return [];
  const ids = calleeRows.map((r) => r.id);
  // 单值用 =（避免 SQLite 对 IN(单值) 选错索引导致全表扫）；多值用 IN
  const callerRows = ids.length === 1
    ? q(db, `SELECT DISTINCT caller_id FROM code_calls INDEXED BY idx_calls_callee WHERE project = ? AND callee_id = ? LIMIT ?`).all(projectName, ids[0], limit) as Array<{ caller_id: number }>
    : q(db, `SELECT DISTINCT caller_id FROM code_calls INDEXED BY idx_calls_callee WHERE project = ? AND callee_id IN (${ids.map(() => "?").join(",")}) LIMIT ?`).all(projectName, ...ids, limit) as Array<{ caller_id: number }>;
  if (callerRows.length === 0) return [];
  const callerIds = callerRows.map((r) => r.caller_id);
  const ph2 = callerIds.map(() => "?").join(",");
  const rows = q(db, `SELECT * FROM code_symbols WHERE id IN (${ph2})`).all(...callerIds) as CodeSymbol[];
  return rows.map((s) => ({ node: s, score: 1 }));
}

export function getCalleesLocal(
  symbolName: string,
  projectName: string,
  opts?: { limit?: number },
): LocalSearchResult[] {
  const db = getCodeIndexDb();
  const limit = opts?.limit ?? 100;
  const byName = q(db, `SELECT id FROM code_symbols WHERE project = ? AND name = ? LIMIT 50`).all(projectName, symbolName) as Array<{ id: number }>;
  const byQual = q(db, `SELECT id FROM code_symbols WHERE project = ? AND qualified_name = ? LIMIT 50`).all(projectName, symbolName) as Array<{ id: number }>;
  const seen = new Set<number>();
  const callerRows = [...byName, ...byQual].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  if (callerRows.length === 0) return [];
  const ids = callerRows.map((r) => r.id);
  const calleeRows = ids.length === 1
    ? q(db, `SELECT DISTINCT callee_id FROM code_calls INDEXED BY idx_calls_caller WHERE project = ? AND caller_id = ? LIMIT ?`).all(projectName, ids[0], limit) as Array<{ callee_id: number }>
    : q(db, `SELECT DISTINCT callee_id FROM code_calls INDEXED BY idx_calls_caller WHERE project = ? AND caller_id IN (${ids.map(() => "?").join(",")}) LIMIT ?`).all(projectName, ...ids, limit) as Array<{ callee_id: number }>;
  if (calleeRows.length === 0) return [];
  const calleeIds = calleeRows.map((r) => r.callee_id);
  const ph2 = calleeIds.map(() => "?").join(",");
  const rows = q(db, `SELECT * FROM code_symbols WHERE id IN (${ph2})`).all(...calleeIds) as CodeSymbol[];
  return rows.map((s) => ({ node: s, score: 1 }));
}
