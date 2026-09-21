import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildWebToolSurfaces, buildChatToolConfig } from "../../src/routes/chat.js";
import { resetSequences } from "../../src/agents/risk-monitor.js";

// 自 R2-A 起 buildChatToolConfig().executeTool 经 ToolRegistry 派发 ⇒ 真实守卫生效。
// 本文件测的是派发接线，不是风险策略：关掉概率初筛、逐条清空 I4 序列（序列桶是模块级的，
// 并行跑测时会被其他文件的 fs.read 调用填满，进而触发与本主题无关的 chain 升级）。
const origEdge = process.env.EDGE_RISK_MONITOR;
beforeAll(() => {
  process.env.EDGE_RISK_MONITOR = "0";
});
afterAll(() => {
  if (origEdge === undefined) delete process.env.EDGE_RISK_MONITOR;
  else process.env.EDGE_RISK_MONITOR = origEdge;
});
beforeEach(() => resetSequences());

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
  it("executeTool 经守卫派发：被 HardFloor 拒绝的调用不会触达实现（R2-A）", async () => {
    let reached = false;
    const cfg = buildChatToolConfig({
      ...mockPipeline,
      crawlStructured: async () => {
        reached = true;
        return null;
      },
    });
    // web_fetch 声明 fs.write，url 字段被当作路径判定：/etc/shadow 命中硬底线
    await expect(cfg.executeTool("web_fetch", { url: "/etc/shadow" })).rejects.toThrow(/HardFloor/);
    expect(reached).toBe(false);
  });
});
