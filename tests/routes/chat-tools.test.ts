import { describe, it, expect } from "bun:test";
import { buildWebToolSurfaces, buildChatToolConfig } from "../../src/routes/chat.js";

const mockPipeline = {
  crawlStructured: async (url: string) => ({
    url, title: "Example", description: "Desc",
    markdown: "# Full markdown content here\n\nBody text for the model to read.",
    headings: [{ text: "h" }], tables: [], codeBlocks: [], images: [], links: [], chunks: [], fetchedAt: "", meta: {}, structuredData: null,
  }),
  searchMulti: async () => [{ position: 1, title: "R1", link: "https://x.com", displayedUrl: "", snippet: "s", source: "", engine: "duckduckgo" }],
} as any;

describe("buildWebToolSurfaces（联网工具面）", () => {
  it("web_fetch 返回正文 content（模型可读，不再只有元数据）", async () => {
    const tools = buildWebToolSurfaces(mockPipeline);
    const wf = tools.find((t) => t.name === "web_fetch")!;
    const out = (await wf.handler({ url: "https://example.com" })) as any;
    expect(out.content).toContain("Full markdown content");
    expect(out.title).toBe("Example");
  });
  it("web_search handler 调用 pipeline.searchMulti 返回结果", async () => {
    const tools = buildWebToolSurfaces(mockPipeline);
    const ws = tools.find((t) => t.name === "web_search")!;
    const out = (await ws.handler({ query: "test", num: 5 })) as any[];
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].title).toBe("R1");
  });
});

describe("buildChatToolConfig", () => {
  it("工具面包含 skill 与 web 工具", () => {
    const cfg = buildChatToolConfig(mockPipeline);
    const names = cfg.tools.map((t) => t.function.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).toContain("skill_list");
  });
  it("executeTool 将 web_search 派发到 web handler", async () => {
    const cfg = buildChatToolConfig(mockPipeline);
    const out = (await cfg.executeTool("web_search", { query: "x" })) as any[];
    expect(out[0].title).toBe("R1");
  });
});
