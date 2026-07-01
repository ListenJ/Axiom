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
import { logger } from "../utils/logger.js";

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

export class SQLiteMemory {
  private db: Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.SQLITE_MEMORY_DB || "./axiom-memory.db";
    this.db = new Database(this.dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.initSchema();
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

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
        title, content, tags,
        content=memory_notes,
        content_rowid=id,
        tokenize='unicode61'
      )
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memory_notes_ai AFTER INSERT ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memory_notes_ad AFTER DELETE ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(memory_notes_fts, rowid, title, content, tags)
        VALUES('delete', old.id, old.title, old.content, old.tags);
      END
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memory_notes_au AFTER UPDATE ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(memory_notes_fts, rowid, title, content, tags)
        VALUES('delete', old.id, old.title, old.content, old.tags);
        INSERT INTO memory_notes_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_path ON memory_notes(path)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_para ON memory_notes(para_category)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_notes(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_notes(updated_at DESC)`);
  }

  upsertNote(record: Omit<MemoryRecord, "id">): number {
    const now = Date.now();
    const existing = this.db.query("SELECT id FROM memory_notes WHERE path = ?").get(record.path) as { id: number } | null;

    const excerpt = record.content.slice(0, 500).replace(/\n/g, " ");
    const tagsJson = JSON.stringify(record.tags);

    if (existing) {
      this.db.run(`
        UPDATE memory_notes SET
          title = ?, content = ?, excerpt = ?, tags = ?,
          para_category = ?, type = ?, source = ?,
          confidence = ?, updated_at = ?
        WHERE path = ?
      `, [
        record.title, record.content, excerpt, tagsJson,
        record.paraCategory, record.type, record.source || null,
        record.confidence, now, record.path
      ]);
      logger.debug("SQLite note updated", { path: record.path });
      return existing.id;
    } else {
      const result = this.db.run(`
        INSERT INTO memory_notes (path, title, content, excerpt, tags, para_category, type, source, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        record.path, record.title, record.content, excerpt, tagsJson,
        record.paraCategory, record.type, record.source || null,
        record.confidence, now, now
      ]);
      logger.debug("SQLite note inserted", { path: record.path });
      return Number(result.lastInsertRowid);
    }
  }

  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    const limit = opts.limit ?? 10;

    const ftsQuery = query
      .replace(/[^\w\u4e00-\u9fa5\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 0)
      .map(w => `"${w}"*`)
      .join(" OR ");

    if (!ftsQuery) return [];

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
    if (opts.tags && opts.tags.length > 0) {
      for (const tag of opts.tags) {
        sql += ` AND mn.tags LIKE ?`;
        params.push(`%"${tag}"%`);
      }
    }

    sql += ` ORDER BY fts.rank LIMIT ?`;
    params.push(String(limit));

    try {
      const rows = this.db.query(sql).all(...params) as Array<{
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
      }>;

      return rows.map(row => ({
        record: {
          id: row.id,
          path: row.path,
          title: row.title,
          content: row.content,
          excerpt: row.excerpt,
          tags: JSON.parse(row.tags),
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
      tags: JSON.parse(row.tags),
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
      tags: JSON.parse(row.tags),
      paraCategory: row.para_category,
      type: row.type,
      source: row.source || undefined,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listByTag(tag: string, limit = 20): MemoryRecord[] {
    const rows = this.db.query(
      `SELECT * FROM memory_notes WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT ?`
    ).all(`%"${tag}"%`, limit) as Array<{
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
      tags: JSON.parse(row.tags),
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
      tags: JSON.parse(row.tags),
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
