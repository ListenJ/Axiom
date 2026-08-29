/**
 * SQLiteMemory — SQLite FTS5 记忆索引层
 *
 * 设计原则：
 * - SQLite 作为快速查询索引，Vault Markdown 作为原件备份（防AI幻觉）
 * - 写入时双写：Vault（原件）+ SQLite（索引）
 * - 搜索时 SQLite FTS5 优先，Vault 确定性搜索作为后备
 * - 支持全文搜索、标签过滤、PARA分类浏览
 *
 * 防AI幻觉机制：
 * - SQLite 中存储内容摘要 + 原始路径
 * - 需要原文时从 Vault 读取 Markdown 原件
 * - 所有 AI 生成内容都经过 Vault 原件校验
 */

import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

/**
 * SQLite 记忆库 DB 路径的唯一解析源（审计 E-1 / R3 Task 3.2）。
 * 此前 kb-backend.ts 自行默认 ./data/kg.db，与 vault 工具的 ./data/agent.db
 * 分裂（split-brain）：KAL 在 kg.db 里查不存在的 memory_notes 表且被静默吞掉，
 * 插件部署下 vault 腿恒为空。KAL/vault/KG 必须同库；KB_DB_PATH 仅作为
 * 显式覆盖出口保留在 kb-backend 侧。
 */
export function resolveSqliteMemoryDbPath(): string {
  return readString("SQLITE_MEMORY_DB") || readString("DATABASE_PATH", "./data/agent.db");
}

export interface MemoryRecord {
  id?: number;
  path: string;
  title: string;
  content: string;
  excerpt: string;
  tags: string[];
  paraCategory: string;
  type: string;
  source?: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface SearchOptions {
  limit?: number;
  tags?: string[];
  paraCategory?: string;
  type?: string;
  minConfidence?: number;
}

export interface SearchResult {
  record: MemoryRecord;
  score: number;
  excerpt: string;
}

/** 按行兜底的 tags 解析：损坏行降级为空数组，不抛错、不拖垮调用方（P0-5） */
function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** LIKE 通配符转义（%/_/\），配合 ESCAPE '\' 使用，防用户输入改变匹配语义（P0-5） */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

/** memory_notes 同步触发器（initSchema 与 trigram 迁移重建共用同一 SQL，P1-S2） */
const MEMORY_NOTES_TRIGGER_SQL = [
  `
      CREATE TRIGGER IF NOT EXISTS memory_notes_ai AFTER INSERT ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END
    `,
  `
      CREATE TRIGGER IF NOT EXISTS memory_notes_ad AFTER DELETE ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(memory_notes_fts, rowid, title, content, tags)
        VALUES('delete', old.id, old.title, old.content, old.tags);
      END
    `,
  `
      CREATE TRIGGER IF NOT EXISTS memory_notes_au AFTER UPDATE ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(memory_notes_fts, rowid, title, content, tags)
        VALUES('delete', old.id, old.title, old.content, old.tags);
        INSERT INTO memory_notes_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END
    `,
];

/** P1-S2 层2：trigram 迁移结果（migrated=false 时 reason 说明跳过/回退原因） */
export interface FtsMigrationResult {
  migrated: boolean;
  reason: string;
}

/**
 * P1-S2 层2：将存量 unicode61 的 memory_notes_fts 迁移为 trigram（SQLite ≥3.34 支持子串匹配，
 * bun:sqlite 打包版本实测 3.53.0）。external content 表（content=memory_notes, content_rowid=id）
 * 重建方式：事务内 ①删三个同步触发器（防 ALTER RENAME 改写其指向）→ ②旧表 RENAME 保底
 * → ③按 trigram 重建新表 → ④INSERT 'rebuild' 全量回填 → ⑤校验行数与源表一致
 * → ⑥删保底表、重建触发器。任一步失败 ROLLBACK，旧表与触发器原样保留，检索降级不中断。
 */
export function migrateMemoryFtsToTrigram(db: Database): FtsMigrationResult {
  let currentSql: string | undefined;
  try {
    currentSql = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_notes_fts'").get() as { sql: string } | undefined)?.sql;
  } catch (e) {
    return { migrated: false, reason: `sqlite_master 查询失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!currentSql) {
    return { migrated: false, reason: "memory_notes_fts 不存在，跳过（新库由 initSchema 直接建 trigram）" };
  }
  if (/trigram/i.test(currentSql)) {
    return { migrated: false, reason: "已是 trigram，无需迁移" };
  }

  try {
    db.exec("BEGIN");
    for (const name of ["memory_notes_ai", "memory_notes_ad", "memory_notes_au"]) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
    db.exec("ALTER TABLE memory_notes_fts RENAME TO memory_notes_fts_old");
    db.exec(`
      CREATE VIRTUAL TABLE memory_notes_fts USING fts5(
        title, content, tags,
        content=memory_notes,
        content_rowid=id,
        tokenize='trigram'
      )
    `);
    db.exec("INSERT INTO memory_notes_fts(memory_notes_fts) VALUES('rebuild')");
    const expected = (db.query("SELECT COUNT(*) AS c FROM memory_notes").get() as { c: number }).c;
    const actual = (db.query("SELECT COUNT(*) AS c FROM memory_notes_fts").get() as { c: number }).c;
    if (actual !== expected) {
      throw new Error(`回填行数不一致：fts=${actual}, source=${expected}`);
    }
    db.exec("DROP TABLE memory_notes_fts_old");
    for (const triggerSql of MEMORY_NOTES_TRIGGER_SQL) {
      db.exec(triggerSql);
    }
    db.exec("COMMIT");
    logger.info("memory_notes_fts 已迁移为 trigram", { rows: actual });
    return { migrated: true, reason: `已迁移为 trigram 并回填 ${actual} 行` };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务未开启（如 BEGIN 即失败）时忽略
    }
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("memory_notes_fts trigram 迁移失败，已回退保留旧表", { error: msg });
    return { migrated: false, reason: `迁移失败已回退：${msg}` };
  }
}

export class SQLiteMemory {
  private db: Database;
  private dbPath: string;
  /** P1-S2 层2：当前 FTS 表是否为 trigram（决定短词 LIKE 兜底腿是否启用） */
  private ftsTrigram = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || resolveSqliteMemoryDbPath();
    this.db = new Database(this.dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.initSchema();
    // P1-S2 层2：存量 unicode61 库升级为 trigram（新库由 initSchema 直接建 trigram，此处幂等跳过）
    const migration = migrateMemoryFtsToTrigram(this.db);
    this.ftsTrigram = /trigram/i.test(
      (this.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_notes_fts'").get() as { sql: string } | undefined)?.sql ?? "",
    );
    if (!this.ftsTrigram && migration.migrated === false && !migration.reason.includes("已是 trigram") && !migration.reason.includes("不存在")) {
      // 迁移失败且当前非 trigram：检索降级（FTS 行为同旧库），不中断启动
      logger.warn("memory_notes_fts 非 trigram 且迁移未生效，FTS 检索按 unicode61 降级", { reason: migration.reason });
    }
    logger.info("SQLiteMemory initialized", { dbPath: this.dbPath });
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        excerpt TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        para_category TEXT NOT NULL DEFAULT 'resources',
        type TEXT NOT NULL DEFAULT 'note',
        source TEXT,
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // P1-S2 层2：新建表直接用 trigram（SQLite ≥3.34 子串匹配；实测 bun:sqlite 3.53.0 支持）。
    // 环境不支持时降级 unicode61 建表，检索仍可用（由 migrateMemoryFtsToTrigram 后续再尝试）。
    try {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
          title, content, tags,
          content=memory_notes,
          content_rowid=id,
          tokenize='trigram'
        )
      `);
    } catch (e) {
      logger.warn("memory_notes_fts trigram 建表失败，降级 unicode61", { error: e instanceof Error ? e.message : String(e) });
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
          title, content, tags,
          content=memory_notes,
          content_rowid=id,
          tokenize='unicode61'
        )
      `);
    }

    for (const triggerSql of MEMORY_NOTES_TRIGGER_SQL) {
      this.db.run(triggerSql);
    }

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_path ON memory_notes(path)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_para ON memory_notes(para_category)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_notes(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_notes(updated_at DESC)`);
  }

  /**
   * Atomic upsert via INSERT ... ON CONFLICT(path) DO UPDATE.
   *
   * The previous SELECT-then-INSERT/UPDATE pattern was not atomic: two
   * concurrent calls with the same `path` could both see no existing row,
   * then both try to INSERT, causing a UNIQUE constraint violation on the
   * second caller. The native UPSERT eliminates this race entirely — the
   * write is a single SQL statement, atomic at the SQLite level.
   *
   * `lastInsertRowid` after ON CONFLICT DO UPDATE is the rowid of the
   * affected row (both insert and update paths), so we can return it
   * directly without a second query.
   */
  upsertNote(record: Omit<MemoryRecord, "id">): number {
    const now = Date.now();
    const excerpt = record.content.slice(0, 500).replace(/\n/g, " ");
    const tagsJson = JSON.stringify(record.tags);

    try {
      const result = this.db.run(`
        INSERT INTO memory_notes (path, title, content, excerpt, tags, para_category, type, source, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          excerpt = excluded.excerpt,
          tags = excluded.tags,
          para_category = excluded.para_category,
          type = excluded.type,
          source = excluded.source,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `, [
        record.path, record.title, record.content, excerpt, tagsJson,
        record.paraCategory, record.type, record.source || null,
        record.confidence, now, now,
      ]);
      logger.debug("SQLite note upserted", { path: record.path, changes: result.changes });
      return Number(result.lastInsertRowid);
    } catch (e) {
      logger.error(
        "SQLite upsertNote failed",
        e instanceof Error ? e : new Error(String(e)),
        { path: record.path },
      );
      throw e;
    }
  }

  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    const limit = opts.limit ?? 10;

    // P1-S2 层2：trigram 最小 3 字符——<3 字的 CJK 短词（常见中文双字词）MATCH 恒空，
    // 在 trigram 库上改走 memory_notes LIKE 兜底腿；≥3 字词保持 FTS 子串匹配。
    // unicode61 库（迁移失败降级）不启用 LIKE 腿，行为与现状一致。
    const words = query
      .replace(/[^\w\u4e00-\u9fa5\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 0);
    // trigram 库：<3 字短词不进 MATCH（恒空）；unicode61 库（降级路径）保持全部词进 MATCH（旧行为）
    const ftsWords = this.ftsTrigram ? words.filter(w => w.length >= 3) : words;
    const shortCjkWords = words.filter(w => w.length < 3 && /[\u4e00-\u9fa5]/.test(w));
    const ftsQuery = ftsWords.map(w => `"${w}"*`).join(" OR ");

    if (!ftsQuery && shortCjkWords.length === 0) return [];

    let sql = `
      SELECT mn.*, fts.rank
      FROM memory_notes_fts fts
      JOIN memory_notes mn ON mn.id = fts.rowid
      WHERE memory_notes_fts MATCH ?
    `;
    const params: string[] = [ftsQuery];

    if (opts.paraCategory) {
      sql += ` AND mn.para_category = ?`;
      params.push(opts.paraCategory);
    }
    if (opts.type) {
      sql += ` AND mn.type = ?`;
      params.push(opts.type);
    }
    if (opts.minConfidence !== undefined) {
      sql += ` AND mn.confidence >= ?`;
      params.push(String(opts.minConfidence));
    }
    // 标签过滤不在 SQL 层做 LIKE（通配符注入 + 子串语义），改为取回后按行精确校验
    const tagFilter = opts.tags && opts.tags.length > 0 ? opts.tags : null;

    sql += ` ORDER BY fts.rank LIMIT ?`;
    params.push(String(limit));

    type FtsRow = {
      id: number;
      path: string;
      title: string;
      content: string;
      excerpt: string;
      tags: string;
      para_category: string;
      type: string;
      source: string | null;
      confidence: number;
      created_at: number;
      updated_at: number;
      rank: number;
    };

    try {
      let rows: FtsRow[] = ftsQuery
        ? (this.db.query(sql).all(...params) as FtsRow[])
        : [];

      if (this.ftsTrigram && shortCjkWords.length > 0) {
        // 短词 LIKE 兜底腿（仅 trigram 库启用；unicode61 库维持旧行为）
        const likeClauses = shortCjkWords
          .map(() => `(mn.title LIKE ? ESCAPE '\\' OR mn.content LIKE ? ESCAPE '\\')`)
          .join(" OR ");
        const likeParams: string[] = [];
        for (const w of shortCjkWords) {
          const pattern = `%${escapeLike(w)}%`;
          likeParams.push(pattern, pattern);
        }
        let likeSql = `
          SELECT mn.*, 0 AS rank
          FROM memory_notes mn
          WHERE (${likeClauses})
        `;
        if (opts.paraCategory) {
          likeSql += ` AND mn.para_category = ?`;
          likeParams.push(opts.paraCategory);
        }
        if (opts.type) {
          likeSql += ` AND mn.type = ?`;
          likeParams.push(opts.type);
        }
        if (opts.minConfidence !== undefined) {
          likeSql += ` AND mn.confidence >= ?`;
          likeParams.push(String(opts.minConfidence));
        }
        likeSql += ` ORDER BY mn.updated_at DESC LIMIT ?`;
        likeParams.push(String(limit));
        const likeRows = this.db.query(likeSql).all(...likeParams) as FtsRow[];
        const seen = new Set(rows.map(r => r.id));
        for (const r of likeRows) {
          if (!seen.has(r.id)) rows.push(r);
        }
      }

      return rows
        .filter(row => {
          if (!tagFilter) return true;
          const noteTags = parseTags(row.tags);
          return tagFilter.every(t => noteTags.includes(t));
        })
        .slice(0, limit)
        .map(row => ({
          record: {
            id: row.id,
            path: row.path,
            title: row.title,
            content: row.content,
            excerpt: row.excerpt,
            tags: parseTags(row.tags),
            paraCategory: row.para_category,
            type: row.type,
            source: row.source || undefined,
            confidence: row.confidence,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
          score: -row.rank,
          excerpt: row.excerpt,
        }));
    } catch (e) {
      logger.warn("SQLite FTS search failed", { query, error: e instanceof Error ? e.message : String(e) });
      return [];
    }
  }

  getByPath(notePath: string): MemoryRecord | null {
    const row = this.db.query("SELECT * FROM memory_notes WHERE path = ?").get(notePath) as {
      id: number;
      path: string;
      title: string;
      content: string;
      excerpt: string;
      tags: string;
      para_category: string;
      type: string;
      source: string | null;
      confidence: number;
      created_at: number;
      updated_at: number;
    } | null;

    if (!row) return null;

    return {
      id: row.id,
      path: row.path,
      title: row.title,
      content: row.content,
      excerpt: row.excerpt,
      tags: parseTags(row.tags),
      paraCategory: row.para_category,
      type: row.type,
      source: row.source || undefined,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listByCategory(category: string, limit = 20): MemoryRecord[] {
    const rows = this.db.query(
      "SELECT * FROM memory_notes WHERE para_category = ? ORDER BY updated_at DESC LIMIT ?"
    ).all(category, limit) as Array<{
      id: number;
      path: string;
      title: string;
      content: string;
      excerpt: string;
      tags: string;
      para_category: string;
      type: string;
      source: string | null;
      confidence: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      path: row.path,
      title: row.title,
      content: row.content,
      excerpt: row.excerpt,
      tags: parseTags(row.tags),
      paraCategory: row.para_category,
      type: row.type,
      source: row.source || undefined,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listByTag(tag: string, limit = 20): MemoryRecord[] {
    // LIKE 仅作预筛（通配符已转义），精确匹配在应用层按解析后的数组判定；
    // LIMIT 在精确过滤后施加，避免预筛假阳性挤掉真命中。
    const rows = this.db.query(
      `SELECT * FROM memory_notes WHERE tags LIKE ? ESCAPE '\\' ORDER BY updated_at DESC`
    ).all(`%"${escapeLike(tag)}"%`) as Array<{
      id: number;
      path: string;
      title: string;
      content: string;
      excerpt: string;
      tags: string;
      para_category: string;
      type: string;
      source: string | null;
      confidence: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows
      .filter(row => parseTags(row.tags).includes(tag))
      .slice(0, limit)
      .map(row => ({
        id: row.id,
        path: row.path,
        title: row.title,
        content: row.content,
        excerpt: row.excerpt,
        tags: parseTags(row.tags),
        paraCategory: row.para_category,
        type: row.type,
        source: row.source || undefined,
        confidence: row.confidence,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  listRecent(limit = 20): MemoryRecord[] {
    const rows = this.db.query(
      "SELECT * FROM memory_notes ORDER BY updated_at DESC LIMIT ?"
    ).all(limit) as Array<{
      id: number;
      path: string;
      title: string;
      content: string;
      excerpt: string;
      tags: string;
      para_category: string;
      type: string;
      source: string | null;
      confidence: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      path: row.path,
      title: row.title,
      content: row.content,
      excerpt: row.excerpt,
      tags: parseTags(row.tags),
      paraCategory: row.para_category,
      type: row.type,
      source: row.source || undefined,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  deleteNote(notePath: string): boolean {
    const result = this.db.run("DELETE FROM memory_notes WHERE path = ?", [notePath]);
    return result.changes > 0;
  }

  archiveNotePath(notePath: string, archivePath: string): boolean {
    const result = this.db.run(
      "UPDATE memory_notes SET path = ?, para_category = 'archives', updated_at = ? WHERE path = ?",
      [archivePath, Date.now(), notePath],
    );
    return result.changes > 0;
  }

  stats(): {
    totalNotes: number;
    byCategory: Record<string, number>;
    byType: Record<string, number>;
    totalWords: number;
  } {
    const total = this.db.query("SELECT COUNT(*) as count FROM memory_notes").get() as { count: number };
    const byCategory = this.db.query(
      "SELECT para_category, COUNT(*) as count FROM memory_notes GROUP BY para_category"
    ).all() as Array<{ para_category: string; count: number }>;
    const byType = this.db.query(
      "SELECT type, COUNT(*) as count FROM memory_notes GROUP BY type"
    ).all() as Array<{ type: string; count: number }>;
    const words = this.db.query(
      "SELECT SUM(LENGTH(content) - LENGTH(REPLACE(content, ' ', '')) + 1) as total FROM memory_notes"
    ).get() as { total: number } | null;

    return {
      totalNotes: total?.count ?? 0,
      byCategory: Object.fromEntries(byCategory.map(r => [r.para_category, r.count])),
      byType: Object.fromEntries(byType.map(r => [r.type, r.count])),
      totalWords: words?.total ?? 0,
    };
  }

  syncFromVault(vaultPath: string): { synced: number; errors: string[] } {
    let synced = 0;
    const errors: string[] = [];

    const walkDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith(".md")) {
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            const relativePath = path.relative(vaultPath, fullPath).replace(/\\/g, "/");
            const { frontmatter, body } = this.parseFrontmatter(content);

            const title = (frontmatter.title as string) || entry.name.replace(/\.md$/, "");
            const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
            const type = (frontmatter.type as string) || "note";
            const source = (frontmatter.source as string) || undefined;
            const confidence = typeof frontmatter.confidence === "number" ? frontmatter.confidence : 0.7;

            let paraCategory = "resources";
            if (relativePath.startsWith("01-Projects")) paraCategory = "projects";
            else if (relativePath.startsWith("02-Areas")) paraCategory = "areas";
            else if (relativePath.startsWith("03-Resources")) paraCategory = "resources";
            else if (relativePath.startsWith("04-Conversations")) paraCategory = "conversations";
            else if (relativePath.startsWith("05-Archives")) paraCategory = "archives";
            else if (relativePath.startsWith("00-Meta")) paraCategory = "meta";
            else if (relativePath.startsWith("memory/")) paraCategory = "memory";

            const stat = fs.statSync(fullPath);
            this.upsertNote({
              path: relativePath,
              title,
              content: body,
              excerpt: body.slice(0, 500).replace(/\n/g, " "),
              tags,
              paraCategory,
              type,
              source,
              confidence,
              createdAt: stat.birthtimeMs || stat.ctimeMs,
              updatedAt: stat.mtimeMs,
            });
            synced++;
          } catch (e) {
            errors.push(`${fullPath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    };

    walkDir(vaultPath);
    logger.info("Vault sync complete", { synced, errors: errors.length });
    return { synced, errors };
  }

  private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { frontmatter: {}, body: content };

    const fm: Record<string, unknown> = {};
    const lines = match[1].split("\n");
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        if (val.startsWith("[") && val.endsWith("]")) {
          fm[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
        } else if (val === "true") {
          fm[key] = true;
        } else if (val === "false") {
          fm[key] = false;
        } else if (/^\d+$/.test(val)) {
          fm[key] = Number(val);
        } else {
          fm[key] = val.replace(/^["']|["']$/g, "");
        }
      }
    }

    return { frontmatter: fm, body: content.slice(match[0].length).trim() };
  }

  close(): void {
    this.db.close();
    logger.info("SQLiteMemory closed");
  }
}

let _instance: SQLiteMemory | null = null;

export function getSqliteMemory(dbPath?: string): SQLiteMemory {
  if (!_instance) {
    _instance = new SQLiteMemory(dbPath);
  }
  return _instance;
}

export default SQLiteMemory;
