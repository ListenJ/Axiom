import { Database } from "bun:sqlite";
import { it, expect } from "bun:test";
import * as sl from "../../src/db/session-lineage.js";

it("refreshes compact lineage from conversation metadata", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_results TEXT, tokens_used INTEGER, latency_ms INTEGER, created_at INTEGER NOT NULL);`);
  db.run("INSERT INTO conversations (session_id, agent_id, role, content, tokens_used, created_at) VALUES (?, ?, ?, ?, ?, ?)", ["ctx-1", "test", "user", "hello context", 10, 1000]);
  db.run("INSERT INTO conversations (session_id, agent_id, role, content, tokens_used, created_at) VALUES (?, ?, ?, ?, ?, ?)", ["ctx-1", "test", "assistant", "answer", 20, 1001]);
  sl.refreshSessionLineage(db, "ctx-1", "Context test");
  const results = sl.searchSessionLineage(db, "context", 10);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]?.sessionId).toBe("ctx-1");
  expect(results[0]?.messageCount).toBe(2);
  expect(results[0]?.summary).toContain("hello context");
  expect(results[0]?.summary).not.toContain("assistant answer");
  db.close();
});

it("returns ancestors and descendants", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_results TEXT, tokens_used INTEGER, latency_ms INTEGER, created_at INTEGER NOT NULL);`);
  sl.upsertSessionLineage(db, { sessionId: "parent", title: "Parent" });
  sl.upsertSessionLineage(db, { sessionId: "child", parentSessionId: "parent", title: "Child" });
  sl.upsertSessionLineage(db, { sessionId: "grandchild", parentSessionId: "child", title: "Grandchild" });
  const lineage = sl.getSessionLineage(db, "child");
  expect(lineage.ancestors.map((r) => r.sessionId)).toEqual(["parent"]);
  expect(lineage.descendants.map((r) => r.sessionId)).toEqual(["grandchild"]);
  db.close();
});