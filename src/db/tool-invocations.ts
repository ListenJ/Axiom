import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface ToolInvocationInput {
  sessionId?: string | null;
  tool: string;
  args?: unknown;
  result?: unknown;
  status: "success" | "error";
  latencyMs?: number;
  resultRef?: string | null;
}

export interface ToolInvocationRow {
  id: number;
  session_id: string | null;
  tool: string;
  args_hash: string;
  result_hash: string | null;
  args_preview: string | null;
  result_ref: string | null;
  status: string;
  latency_ms: number | null;
  output_bytes: number | null;
  created_at: number;
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function preview(value: unknown, maxBytes = 512): string {
  const text = JSON.stringify(value ?? null);
  return text.length <= maxBytes ? text : `${text.slice(0, maxBytes)}...`;
}

export function ensureToolInvocationTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS tool_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tool TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      result_hash TEXT,
      args_preview TEXT,
      result_ref TEXT,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      output_bytes INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tool_inv_session ON tool_invocations(session_id, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tool_inv_tool ON tool_invocations(tool, created_at DESC)`);
}

export function recordToolInvocation(db: Database, input: ToolInvocationInput): number {
  ensureToolInvocationTable(db);
  const now = Math.floor(Date.now() / 1000);
  const resultHash = input.result === undefined ? null : hashPayload(input.result);
  const outputBytes = input.result === undefined
    ? null
    : Buffer.byteLength(JSON.stringify(input.result), "utf8");
  const result = db.run(
    `INSERT INTO tool_invocations
       (session_id, tool, args_hash, result_hash, args_preview, result_ref, status, latency_ms, output_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.sessionId ?? null,
      input.tool,
      hashPayload(input.args),
      resultHash,
      preview(input.args),
      input.resultRef ?? null,
      input.status,
      input.latencyMs ?? null,
      outputBytes,
      now,
    ],
  );
  return Number(result.lastInsertRowid);
}

export function listToolInvocations(
  db: Database,
  sessionId?: string | null,
  limit = 50,
): ToolInvocationRow[] {
  ensureToolInvocationTable(db);
  const rows = sessionId
    ? db.query(
        `SELECT id, session_id, tool, args_hash, result_hash, args_preview, result_ref, status, latency_ms, output_bytes, created_at
         FROM tool_invocations
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      ).all(sessionId, limit)
    : db.query(
        `SELECT id, session_id, tool, args_hash, result_hash, args_preview, result_ref, status, latency_ms, output_bytes, created_at
         FROM tool_invocations
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      ).all(limit);
  return rows as ToolInvocationRow[];
}