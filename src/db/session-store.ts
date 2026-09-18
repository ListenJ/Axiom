import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { refreshSessionLineage } from "./session-lineage.js";

export interface PersistedChatMessage {
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  agentId?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  tokensUsed?: number;
  latencyMs?: number;
}

export interface ConversationRow {
  id: number;
  session_id: string;
  agent_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_results: string | null;
  tokens_used: number | null;
  latency_ms: number | null;
  created_at: number;
}

export function normalizeSessionId(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : randomUUID();
}

export function upsertChatSession(db: Database, sessionId: string, title = ""): void {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO chat_sessions (session_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       title = excluded.title,
       updated_at = excluded.updated_at`,
    [sessionId, title, now, now],
  );
}

export function persistChatMessage(db: Database, message: PersistedChatMessage): void {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO conversations
       (session_id, agent_id, role, content, tool_calls, tool_results, tokens_used, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.sessionId,
      message.agentId ?? "default",
      message.role,
      message.content,
      message.toolCalls?.length ? JSON.stringify(message.toolCalls) : null,
      message.toolResults?.length ? JSON.stringify(message.toolResults) : null,
      message.tokensUsed ?? 0,
      message.latencyMs ?? 0,
      now,
    ],
  );
  refreshSessionLineage(db, message.sessionId);
}

export function getSessionMessages(
  db: Database,
  sessionId: string,
  limit = 50,
  offset = 0,
): ConversationRow[] {
  return db.query(
    `SELECT id, session_id, agent_id, role, content, tool_calls, tool_results, tokens_used, latency_ms, created_at
     FROM conversations
     WHERE session_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT ? OFFSET ?`,
  ).all(sessionId, limit, offset) as ConversationRow[];
}