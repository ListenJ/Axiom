import { describe, expect, it } from "bun:test";
import { SQLiteMemory, type MemoryRecord } from "../../src/memory/sqlite-memory.js";

function note(path: string, title = path): Omit<MemoryRecord, "id"> {
  return {
    path,
    title,
    content: `content ${path}`,
    excerpt: "",
    tags: [],
    paraCategory: "resources",
    type: "note",
    confidence: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("SQLiteMemory vault wiki links", () => {
  it("atomically replaces outgoing links and returns deterministic backlinks", () => {
    const mem = new SQLiteMemory(":memory:");
    try {
      mem.upsertNote(note("a.md", "A"));
      mem.upsertNote(note("b.md", "B"));
      mem.upsertNote(note("target.md", "Target"));

      mem.replaceWikiLinks("a.md", [
        { targetText: "Target", targetPath: "target.md" },
        { targetText: "missing", targetPath: null },
      ]);
      mem.replaceWikiLinks("b.md", [{ targetText: "Target", targetPath: "target.md" }]);

      expect(mem.getWikiBacklinks("target.md")).toEqual([
        { path: "a.md", title: "A" },
        { path: "b.md", title: "B" },
      ]);

      mem.replaceWikiLinks("a.md", [{ targetText: "Replacement", targetPath: "target.md" }]);
      expect(mem.getWikiBacklinks("target.md")).toEqual([
        { path: "a.md", title: "A" },
        { path: "b.md", title: "B" },
      ]);
      expect(mem.getWikiBacklinks("missing")).toEqual([]);
    } finally {
      mem.close();
    }
  });

  it("removes outgoing and dangling incoming rows when a note is deleted", () => {
    const mem = new SQLiteMemory(":memory:");
    try {
      mem.upsertNote(note("a.md", "A"));
      mem.upsertNote(note("target.md", "Target"));
      mem.replaceWikiLinks("a.md", [{ targetText: "Target", targetPath: "target.md" }]);
      expect(mem.getWikiBacklinks("target.md")).toEqual([{ path: "a.md", title: "A" }]);

      mem.deleteNote("target.md");
      expect(mem.getWikiBacklinks("target.md")).toEqual([]);
    } finally {
      mem.close();
    }
  });
});
