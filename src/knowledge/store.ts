import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { getGlobalVault } from "../memory/vault-manager.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import type { KnowledgeSource, DictionaryEntry } from "./types.js";

export class KnowledgeStore {
  private db: Database;
  private vault = getGlobalVault();

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || readString("KNOWLEDGE_DB_PATH", "./data/knowledge.db");
    this.db = new Database(resolvedPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        domain TEXT NOT NULL,
        subdomain TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        quality REAL NOT NULL DEFAULT 0,
        stored_at INTEGER NOT NULL,
        vault_path TEXT,
        word_count INTEGER DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS dictionary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT NOT NULL UNIQUE,
        pronunciation TEXT,
        part_of_speech TEXT NOT NULL,
        definitions TEXT NOT NULL,
        examples TEXT,
        synonyms TEXT,
        antonyms TEXT,
        etymology TEXT,
        source_url TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_domain ON knowledge_sources(domain, subdomain)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_url ON knowledge_sources(url)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_dictionary_word ON dictionary(word)
    `);

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS dictionary_fts USING fts5(
        word, definitions, examples,
        content=dictionary,
        content_rowid=id,
        tokenize='unicode61'
      )
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS dictionary_ai AFTER INSERT ON dictionary BEGIN
        INSERT INTO dictionary_fts(rowid, word, definitions, examples)
        VALUES (new.id, new.word, new.definitions, COALESCE(new.examples, ''));
      END
    `);
  }

  isCollected(url: string): boolean {
    const row = this.db.query("SELECT 1 FROM knowledge_sources WHERE url = ?").get(url);
    return !!row;
  }

  getSourceByUrl(url: string): KnowledgeSource | null {
    const row = this.db.query(
      "SELECT * FROM knowledge_sources WHERE url = ?"
    ).get(url) as Record<string, unknown> | null;

    if (!row) return null;
    return this.rowToSource(row);
  }

  saveSource(
    source: Omit<KnowledgeSource, "id" | "storedAt"> & { vaultPath?: string; wordCount?: number },
  ): string {
    const id = this.generateId(source.url);
    const now = Date.now();

    this.db.run(
      `INSERT OR IGNORE INTO knowledge_sources (id, title, domain, subdomain, url, quality, stored_at, vault_path, word_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        source.title,
        source.domain,
        source.subdomain,
        source.url,
        source.quality,
        now,
        source.vaultPath || null,
        source.wordCount || 0,
      ],
    );

    return id;
  }

  saveDictionaryEntry(entry: DictionaryEntry, sourceUrl?: string): boolean {
    const now = Date.now();
    try {
      this.db.run(
        `INSERT OR IGNORE INTO dictionary (word, pronunciation, part_of_speech, definitions, examples, synonyms, antonyms, etymology, source_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.word.toLowerCase(),
          entry.pronunciation || null,
          entry.partOfSpeech,
          JSON.stringify(entry.definitions),
          entry.examples ? JSON.stringify(entry.examples) : null,
          entry.synonyms ? JSON.stringify(entry.synonyms) : null,
          entry.antonyms ? JSON.stringify(entry.antonyms) : null,
          entry.etymology || null,
          sourceUrl || null,
          now,
        ],
      );
      return true;
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint")) {
        return false;
      }
      throw e;
    }
  }

  getDictionaryEntry(word: string): DictionaryEntry | null {
    const row = this.db.query(
      "SELECT * FROM dictionary WHERE word = ?"
    ).get(word.toLowerCase()) as Record<string, unknown> | null;

    if (!row) return null;
    return {
      word: row.word as string,
      pronunciation: row.pronunciation as string | undefined,
      partOfSpeech: row.part_of_speech as string,
      definitions: JSON.parse(row.definitions as string),
      examples: row.examples ? JSON.parse(row.examples as string) : undefined,
      synonyms: row.synonyms ? JSON.parse(row.synonyms as string) : undefined,
      antonyms: row.antonyms ? JSON.parse(row.antonyms as string) : undefined,
      etymology: row.etymology as string | undefined,
    };
  }

  searchDictionary(query: string, limit = 10): DictionaryEntry[] {
    const MAX_TERMS = 10;
    const MAX_QUERY_LENGTH = 200;

    let sanitized = query.replace(/[^\w\s]/g, " ");
    if (sanitized.length > MAX_QUERY_LENGTH) sanitized = sanitized.slice(0, MAX_QUERY_LENGTH);

    let words = sanitized.split(/\s+/).filter(Boolean);
    if (words.length > MAX_TERMS) words = words.slice(0, MAX_TERMS);

    const ftsQuery = words
      .map((w) => `"${w}"*`)
      .join(" OR ");

    if (!ftsQuery) return [];

    try {
      const rows = this.db.query(`
        SELECT d.* FROM dictionary_fts fts
        JOIN dictionary d ON d.id = fts.rowid
        WHERE dictionary_fts MATCH ?
        LIMIT ?
      `).all(ftsQuery, limit) as Record<string, unknown>[];

      return rows.map((r) => ({
        word: r.word as string,
        pronunciation: r.pronunciation as string | undefined,
        partOfSpeech: r.part_of_speech as string,
        definitions: JSON.parse(r.definitions as string),
        examples: r.examples ? JSON.parse(r.examples as string) : undefined,
        synonyms: r.synonyms ? JSON.parse(r.synonyms as string) : undefined,
        antonyms: r.antonyms ? JSON.parse(r.antonyms as string) : undefined,
        etymology: r.etymology as string | undefined,
      }));
    } catch {
      return [];
    }
  }

  async storeAsVaultNote(
    title: string,
    content: string,
    opts: {
      domain: "philosophy" | "mathematics" | "computer-science" | "dictionary";
      subdomain: string;
      url: string;
      quality: number;
    },
  ): Promise<string> {
    const vaultPath = `00-Knowledge/${opts.domain}/${opts.subdomain}/${this.slugify(title).slice(0, 60)}.md`;

    await this.vault.writeNote(vaultPath, content, {
      title,
      type: "knowledge",
      source: opts.url,
      paraCategory: "resources",
      tags: ["knowledge", opts.domain, opts.subdomain],
    });

    this.saveSource({
      title,
      domain: opts.domain,
      subdomain: opts.subdomain,
      url: opts.url,
      quality: opts.quality,
      vaultPath,
      wordCount: content.split(/\s+/).length,
    });

    return vaultPath;
  }

  stats(): {
    totalSources: number;
    byDomain: Record<string, number>;
    totalDictionary: number;
  } {
    const total = this.db.query("SELECT COUNT(*) as c FROM knowledge_sources").get() as { c: number };
    const byDomain = this.db.query(
      "SELECT domain, COUNT(*) as c FROM knowledge_sources GROUP BY domain"
    ).all() as Array<{ domain: string; c: number }>;
    const dictCount = this.db.query("SELECT COUNT(*) as c FROM dictionary").get() as { c: number };

    return {
      totalSources: total.c,
      byDomain: Object.fromEntries(byDomain.map((r) => [r.domain, r.c])),
      totalDictionary: dictCount.c,
    };
  }

  private generateId(url: string): string {
    const hash = Number(Bun.hash(url));
    return `know_${Math.abs(hash).toString(36)}`;
  }

  private rowToSource(row: Record<string, unknown>): KnowledgeSource {
    return {
      id: row.id as string,
      title: row.title as string,
      domain: row.domain as 'philosophy' | 'mathematics' | 'computer-science' | 'dictionary',
      subdomain: row.subdomain as string,
      url: row.url as string,
      quality: row.quality as number,
      storedAt: row.stored_at as number,
    };
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80);
  }

  close(): void {
    this.db.close();
  }
}

let _instance: KnowledgeStore | null = null;

export function getKnowledgeStore(dbPath?: string): KnowledgeStore {
  if (!_instance) {
    _instance = new KnowledgeStore(dbPath);
  }
  return _instance;
}
