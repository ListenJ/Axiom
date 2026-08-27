import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import {
  getSessionMessages,
  normalizeSessionId,
  persistChatMessage,
  upsertChatSession,
} from "../../src/db/session-store.js";

const db = new Database(":memory:");

db.run(`
  CREATE TABLE chat_sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
db.run(`
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    tool_results TEXT,
    tokens_used INTEGER,
    latency_ms INTEGER,
    created_at INTEGER NOT NULL
  )
`);

afterAll(() => {
  db.close();
});

describe("native session store", () => {
  it("normalizes valid session ids and generates missing ones", () => {
    expect(normalizeSessionId("sess-1")).toBe("sess-1");
    expect(normalizeSessionId("  sess-2  ")).toBe("sess-2");
    expect(normalizeSessionId(undefined)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(normalizeSessionId("")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("persists messages and reads them back in order", () => {
    const sessionId = "native-session-1";
    upsertChatSession(db, sessionId, "Native session");
    persistChatMessage(db, { sessionId, role: "user", content: "hello" });
    persistChatMessage(db, {
      sessionId,
      role: "assistant",
      content: "hi",
      tokensUsed: 42,
      latencyMs: 17,
    });
    persistChatMessage(db, {
      sessionId,
      role: "assistant",
      content: "tool result",
      toolCalls: [{ name: "search" }],
      toolResults: [{ ok: true }],
    });

    const rows = getSessionMessages(db, sessionId);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ role: "user", content: "hello" });
    expect(rows[1]).toMatchObject({ role: "assistant", content: "hi", tokens_used: 42, latency_ms: 17 });
    expect(rows[2]?.tool_calls).toContain("search");
    expect(rows[2]?.tool_results).toContain("ok");
  });
});