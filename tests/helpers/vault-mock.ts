import type { SearchResult, VaultNote } from "../../src/memory/deterministic-search.js";

export interface MockCallRecord {
  method: string;
  args: unknown[];
  timestamp: number;
}

export class MockVaultManager {
  public calls: MockCallRecord[] = [];
  public notes = new Map<string, VaultNote>();

  private makeNote(path: string, content: string): VaultNote {
    return {
      path,
      title: path.split("/").pop()?.replace(".md", "") ?? path,
      content,
      frontmatter: {},
      tags: [],
      wikiLinks: [],
      backlinks: [],
      wordCount: content.split(/\s+/).length,
      modifiedAt: Date.now(),
    };
  }

  search(query: string, opts?: { limit?: number; types?: string[]; tags?: string[]; paraCategory?: string }): SearchResult[] {
    this.calls.push({ method: "search", args: [query, opts], timestamp: Date.now() });
    const limit = opts?.limit ?? 10;
    const results: SearchResult[] = [];
    for (const [path, note] of this.notes) {
      if (results.length >= limit) break;
      if (note.content.includes(query) || note.title.includes(query)) {
        results.push({ note, score: 1, reasons: ["mock-match"], excerpt: note.content.slice(0, 100) });
      }
    }
    return results;
  }

  readNote(path: string): { content: string; frontmatter: Record<string, unknown> } | null {
    this.calls.push({ method: "readNote", args: [path], timestamp: Date.now() });
    const note = this.notes.get(path);
    return note ? { content: note.content, frontmatter: note.frontmatter } : null;
  }

  async writeNote(path: string, content: string, opts?: Record<string, unknown>): Promise<string> {
    this.calls.push({ method: "writeNote", args: [path, content, opts], timestamp: Date.now() });
    this.notes.set(path, this.makeNote(path, content));
    return path;
  }

  async writeAtomicNote(title: string, idea: string, opts?: { context?: string; relatedNotes?: string[]; tags?: string[] }): Promise<string> {
    this.calls.push({ method: "writeAtomicNote", args: [title, idea, opts], timestamp: Date.now() });
    const path = `04-Conversations/${title.replace(/\s+/g, "-")}.md`;
    this.notes.set(path, this.makeNote(path, `# ${title}\n\n${idea}`));
    return path;
  }

  browsePara(category: string): VaultNote[] {
    this.calls.push({ method: "browsePara", args: [category], timestamp: Date.now() });
    return Array.from(this.notes.values()).filter(n => n.path.startsWith(category));
  }

  browseTag(tag: string): VaultNote[] {
    this.calls.push({ method: "browseTag", args: [tag], timestamp: Date.now() });
    return Array.from(this.notes.values()).filter(n => n.tags.includes(tag));
  }

  getNetwork(_path: string, depth = 1): { notes: VaultNote[]; relationships: Array<{ from: string; to: string }> } {
    this.calls.push({ method: "getNetwork", args: [_path, depth], timestamp: Date.now() });
    return { notes: Array.from(this.notes.values()), relationships: [] };
  }

  stats(): { totalNotes: number; totalTags: number; categories: Record<string, number> } {
    this.calls.push({ method: "stats", args: [], timestamp: Date.now() });
    return { totalNotes: this.notes.size, totalTags: 0, categories: {} };
  }

  indexCode(): Promise<{ indexed: number; errors: string[] }> {
    this.calls.push({ method: "indexCode", args: [], timestamp: Date.now() });
    return Promise.resolve({ indexed: 0, errors: [] });
  }

  appendNote(_path: string, _content: string): Promise<void> {
    this.calls.push({ method: "appendNote", args: [_path, _content], timestamp: Date.now() });
    return Promise.resolve();
  }

  getSqliteMemory(): unknown {
    this.calls.push({ method: "getSqliteMemory", args: [], timestamp: Date.now() });
    return null;
  }

  ensureDailyNote(): Promise<string> {
    this.calls.push({ method: "ensureDailyNote", args: [], timestamp: Date.now() });
    return Promise.resolve("daily.md");
  }

  writeCrawlResult(_result: unknown): Promise<void> {
    this.calls.push({ method: "writeCrawlResult", args: [_result], timestamp: Date.now() });
    return Promise.resolve();
  }

  writeSerpApiResult(_result: unknown): Promise<void> {
    this.calls.push({ method: "writeSerpApiResult", args: [_result], timestamp: Date.now() });
    return Promise.resolve();
  }

  reset(): void {
    this.calls = [];
    this.notes.clear();
  }

  callCount(method: string): number {
    return this.calls.filter(c => c.method === method).length;
  }
}
