import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import {
  hashPayload,
  listToolInvocations,
  recordToolInvocation,
} from "../../src/db/tool-invocations.js";

const db = new Database(":memory:");

afterAll(() => {
  db.close();
});

describe("native tool invocation ledger", () => {
  it("hashes payloads deterministically", () => {
    expect(hashPayload({ query: "hello" })).toBe(hashPayload({ query: "hello" }));
    expect(hashPayload({ query: "hello" })).not.toBe(hashPayload({ query: "world" }));
  });

  it("records only hashes and previews without full payloads", () => {
    const args = { query: "native tool ledger", secret: "x".repeat(2000) };
    recordToolInvocation(db, {
      sessionId: "tool-session-1",
      tool: "query",
      args,
      result: { results: [], totalFound: 0 },
      status: "success",
      latencyMs: 12,
    });

    const rows = listToolInvocations(db, "tool-session-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe("query");
    expect(rows[0]?.args_hash).toBe(hashPayload(args));
    expect(rows[0]?.args_preview?.length).toBeLessThan(600);
    expect(rows[0]?.args_preview).not.toContain("x".repeat(2000));
    expect(rows[0]?.output_bytes).toBeGreaterThan(0);
  });

  it("lists all invocations when no session is filtered", () => {
    recordToolInvocation(db, {
      tool: "knowledge:stats",
      result: { notes: 1 },
      status: "success",
    });
    expect(listToolInvocations(db).length).toBeGreaterThanOrEqual(2);
  });
});