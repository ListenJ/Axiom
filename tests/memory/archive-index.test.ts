import { afterAll, describe, expect, it } from "bun:test";
import { SQLiteMemory } from "../../src/memory/sqlite-memory.js";

const mem = new SQLiteMemory(":memory:");

afterAll(() => {
  mem.close();
});

describe("native archive index sync", () => {
  it("moves a note path and category to archives in SQLite", () => {
    const source = "04-Conversations/2026/08/test-session.md";
    const archived = "05-Archives/04-Conversations/2026/08/test-session.md";
    mem.upsertNote({
      path: source,
      title: "Test session",
      content: "hello archived memory",
      excerpt: "hello archived memory",
      tags: ["conversation"],
      paraCategory: "conversations",
      type: "conversation-log",
      confidence: 0.9,
      createdAt: 0,
      updatedAt: 0,
    });

    expect(mem.archiveNotePath(source, archived)).toBe(true);
    expect(mem.getByPath(source)).toBeNull();

    const row = mem.getByPath(archived);
    expect(row).not.toBeNull();
    expect(row?.paraCategory).toBe("archives");

    const results = mem.search("archived");
    expect(results.some((r) => r.record.path.startsWith("05-Archives/"))).toBe(true);
  });
});