import type { Database } from "bun:sqlite";
import { estimateTokens } from "../context/token-estimator.js";

export interface SessionLineageEntry {
  sessionId: string;
  parentSessionId?: string | null;
  title?: string;
  summary?: string;
  messageCount?: number;
  tokenEstimate?: number;
  status?: "active" | "archived";
  createdAt?: number;
  updatedAt?: number;
}

export interface SessionLineageRef {
  sessionId: string;
  parentSessionId: string | null;
  title: string;
  summary: string;
  messageCount: number;
  tokenEstimate: number;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export function ensureSessionLineage(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS session_lineage (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_lineage_fts USING fts5(
      session_id UNINDEXED,
      title,
      summary,
      tokenize = 'unicode61'
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_session_lineage_updated ON session_lineage(updated_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_session_lineage_parent ON session_lineage(parent_session_id)`);
}

export function upsertSessionLineage(db: Database, entry: SessionLineageEntry): void {
  ensureSessionLineage(db);
  const now = entry.updatedAt ?? Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO session_lineage
       (session_id, parent_session_id, title, summary, message_count, token_estimate, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       parent_session_id = excluded.parent_session_id,
       title = excluded.title,
       summary = excluded.summary,
       message_count = excluded.message_count,
       token_estimate = excluded.token_estimate,
       status = excluded.status,
       updated_at = excluded.updated_at`,
    [
      entry.sessionId,
      entry.parentSessionId ?? null,
      entry.title ?? "",
      entry.summary ?? "",
      entry.messageCount ?? 0,
      entry.tokenEstimate ?? 0,
      entry.status ?? "active",
      entry.createdAt ?? now,
      now,
    ],
  );

  const row = db.query(
    "SELECT rowid, session_id, title, summary FROM session_lineage WHERE session_id = ?",
  ).get(entry.sessionId) as { rowid: number; session_id: string; title: string; summary: string } | undefined;
  if (!row) return;
  db.run("DELETE FROM session_lineage_fts WHERE rowid = ?", [row.rowid]);
  db.run(
    `INSERT INTO session_lineage_fts (rowid, session_id, title, summary)
     VALUES (?, ?, ?, ?)`,
    [row.rowid, row.session_id, row.title, row.summary],
  );
}

export function refreshSessionLineage(db: Database, sessionId: string, title?: string): void {
  ensureSessionLineage(db);
  const meta = db.query(
    "SELECT title FROM chat_sessions WHERE session_id = ?",
  ).get(sessionId) as { title: string } | undefined;
  const first = db.query(
    `SELECT content FROM conversations WHERE session_id = ? AND role = 'user'
     ORDER BY created_at ASC, id ASC LIMIT 1`,
  ).get(sessionId) as { content: string } | undefined;
  const last = db.query(
    `SELECT content FROM conversations WHERE session_id = ? AND role = 'user'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(sessionId) as { content: string } | undefined;
  const stats = db.query(
    "SELECT COUNT(*) as count, COALESCE(SUM(tokens_used), 0) as tokens FROM conversations WHERE session_id = ?",
  ).get(sessionId) as { count: number; tokens: number };

  const safeTitle = title ?? meta?.title ?? "";
  const firstText = first?.content.slice(0, 80) ?? "";
  const lastText = last?.content.slice(0, 80) ?? "";
  const summary = [safeTitle, `${stats.count} msgs`, `first: ${firstText}`, `last: ${lastText}`]
    .filter(Boolean)
    .join(" | ");
  const tokenEstimate = stats.tokens > 0
    ? stats.tokens
    : estimateTokens(summary + firstText + lastText);

  upsertSessionLineage(db, {
    sessionId,
    title: safeTitle,
    summary,
    messageCount: stats.count,
    tokenEstimate,
  });
}

function rowToRef(row: Record<string, unknown>): SessionLineageRef {
  return {
    sessionId: String(row.session_id ?? ""),
    parentSessionId: row.parent_session_id == null ? null : String(row.parent_session_id),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    messageCount: Number(row.message_count ?? 0),
    tokenEstimate: Number(row.token_estimate ?? 0),
    status: String(row.status ?? "active"),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

const REF_COLUMNS = `session_id, parent_session_id, title, summary, message_count, token_estimate, status, created_at, updated_at`;

export function searchSessionLineage(db: Database, query: string, limit = 20): SessionLineageRef[] {
  ensureSessionLineage(db);
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const trimmed = query.trim();
  if (!trimmed) {
    return db.query(
      `SELECT ${REF_COLUMNS} FROM session_lineage ORDER BY updated_at DESC LIMIT ?`,
    ).all(safeLimit).map((row) => rowToRef(row as Record<string, unknown>));
  }

  const ftsQuery = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `${term.replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, "")}*`)
    .filter(Boolean)
    .join(" OR ");
  return db.query(
    `SELECT ${REF_COLUMNS.split(", ").map((c) => `sl.${c}`).join(", ")}
     FROM session_lineage_fts f
     JOIN session_lineage sl ON sl.session_id = f.session_id
     WHERE session_lineage_fts MATCH ?
     ORDER BY f.rank
     LIMIT ?`,
  ).all(ftsQuery, safeLimit).map((row) => rowToRef(row as Record<string, unknown>));
}

export function getSessionLineage(
  db: Database,
  sessionId: string,
): { entry: SessionLineageRef | null; ancestors: SessionLineageRef[]; descendants: SessionLineageRef[] } {
  ensureSessionLineage(db);
  const entryRow = db.query(
    `SELECT ${REF_COLUMNS} FROM session_lineage WHERE session_id = ?`,
  ).get(sessionId) as Record<string, unknown> | undefined;
  const entry = entryRow ? rowToRef(entryRow) : null;

  const ancestors = db.query(
    `WITH RECURSIVE ancestors(id) AS (
       SELECT parent_session_id FROM session_lineage WHERE session_id = ? AND parent_session_id IS NOT NULL
       UNION ALL
       SELECT sl.parent_session_id FROM session_lineage sl JOIN ancestors a ON sl.session_id = a.id
       WHERE sl.parent_session_id IS NOT NULL
     )
     SELECT ${REF_COLUMNS.split(", ").map((c) => `sl.${c}`).join(", ")}
     FROM session_lineage sl JOIN ancestors a ON sl.session_id = a.id`,
  ).all(sessionId).map((row) => rowToRef(row as Record<string, unknown>));

  const descendants = db.query(
    `WITH RECURSIVE descendants(id) AS (
       SELECT session_id FROM session_lineage WHERE parent_session_id = ?
       UNION ALL
       SELECT sl.session_id FROM session_lineage sl JOIN descendants d ON sl.parent_session_id = d.id
     )
     SELECT ${REF_COLUMNS.split(", ").map((c) => `sl.${c}`).join(", ")}
     FROM session_lineage sl JOIN descendants d ON sl.session_id = d.id`,
  ).all(sessionId).map((row) => rowToRef(row as Record<string, unknown>));

  return { entry, ancestors, descendants };
}