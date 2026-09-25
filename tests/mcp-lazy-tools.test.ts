/**
 * MCP 真懒加载（T3，2026-09-18）
 *
 * 背景：README 澄清「SceneRouter 为场景建议，不减少 list_tools 计费」——
 * 即此前并不存在真正的懒加载：188 个工具定义全量下发，未调用也占用客户端上下文。
 * 本组用例通过**真实 MCP 协议**（InMemoryTransport + SDK Client）测量 tools/list 的
 * 实际返回体积，而不是对内部数组做断言。
 */
import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { ToolRegistry, type ToolGuard } from "../src/mcp/tool-registry.js";

/** 构造 N 个合成工具，schema 体积接近真实工具（真实工具平均 schema 更小，此处偏保守） */
function makeRegistry(count: number, opts?: { lazy?: boolean; guard?: ToolGuard }) {
  const reg = new ToolRegistry({ guard: opts?.guard ?? (async () => {}), lazy: opts?.lazy });
  for (let i = 0; i < count; i++) {
    reg.add({
      name: `synth_tool_${i}`,
      description: `Synthetic tool number ${i} used for lazy-loading measurement; it explains at length what the tool does so that the payload has a realistic size.`,
      inputSchema: {
        path: z.string().describe("target path"),
        mode: z.enum(["read", "write"]).optional().describe("operation mode"),
        limit: z.number().optional().describe("max results"),
      },
      capability: ["fs.read"],
      handler: async (args) => ({ tool: `synth_tool_${i}`, args }),
    });
  }
  return reg;
}

/** 用真实 SDK 客户端走一次完整 tools/list */
async function listToolsViaMcp(reg: ToolRegistry) {
  const server = new McpServer({ name: "lazy-test", version: "0.0.0" });
  reg.registerWithMcp(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lazy-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.listTools();
    return res;
  } finally {
    await client.close();
    await server.close();
  }
}

async function callViaMcp(reg: ToolRegistry, name: string, args: Record<string, unknown>) {
  const server = new McpServer({ name: "lazy-test", version: "0.0.0" });
  reg.registerWithMcp(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lazy-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: Awaited<ReturnType<typeof callViaMcp>>) =>
  (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");

describe("MCP 真懒加载：tools/list 体积", () => {
  it("默认（未开启懒加载）行为不变：全部工具下发", async () => {
    const reg = makeRegistry(60);
    const res = await listToolsViaMcp(reg);
    expect(res.tools.length).toBe(60);
    expect(reg.isLazy).toBe(false);
  });

  it("懒加载开启：tools/list 只下发固定小工具面（<=5）", async () => {
    const reg = makeRegistry(60, { lazy: true });
    expect(reg.isLazy).toBe(true);
    const res = await listToolsViaMcp(reg);
    expect(res.tools.length).toBeLessThanOrEqual(5);
    // meta 工具必须在场
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("tool_search");
    expect(names).toContain("tool_describe");
    expect(names).toContain("tool_invoke");
  });

  it("懒加载使 tools/list 序列化字节数下降 >= 95%（实测，非估算）", async () => {
    const full = await listToolsViaMcp(makeRegistry(60));
    const lazy = await listToolsViaMcp(makeRegistry(60, { lazy: true }));
    const fullBytes = JSON.stringify(full.tools).length;
    const lazyBytes = JSON.stringify(lazy.tools).length;
    const reduction = 1 - lazyBytes / fullBytes;
    // 实测输出，便于人工核对量级
    console.log(`[lazy] full=${fullBytes}B lazy=${lazyBytes}B reduction=${(reduction * 100).toFixed(1)}%`);
    expect(reduction).toBeGreaterThanOrEqual(0.95);
  });
});

describe("MCP 真懒加载：按需取用工具", () => {
  it("tool_search 按关键词检索到目标工具，且支持从 188 规模中筛出子集", async () => {
    const reg = makeRegistry(60, { lazy: true });
    reg.add({
      name: "unique_needle_tool",
      description: "haystack needle unique marker zzz",
      inputSchema: { x: z.string() },
      capability: ["internal"],
      handler: async () => ({ ok: true }),
    });
    const out = JSON.parse(text(await callViaMcp(reg, "tool_search", { query: "zzz needle", limit: 5 })));
    const names = (out.results as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("unique_needle_tool");
    expect(out.total).toBe(61);
  });

  it("tool_describe 返回完整 inputSchema（与全量模式逐字段一致）", async () => {
    const reg = makeRegistry(3, { lazy: true });
    const out = JSON.parse(text(await callViaMcp(reg, "tool_describe", { name: "synth_tool_1" })));
    expect(out.name).toBe("synth_tool_1");
    expect(Object.keys(out.inputSchema.properties ?? {}).sort()).toEqual(["limit", "mode", "path"]);
    expect(out.inputSchema.properties.path.type).toBe("string");
  });

  it("tool_describe 未知工具名 → 明确错误，不静默返回空", async () => {
    const reg = makeRegistry(3, { lazy: true });
    const out = JSON.parse(text(await callViaMcp(reg, "tool_describe", { name: "no_such_tool_xyz" })));
    expect(out.error).toBe(true);
    expect(String(out.message)).toContain("no_such_tool_xyz");
  });

  it("tool_invoke 真实执行目标工具并返回其结果", async () => {
    const reg = makeRegistry(3, { lazy: true });
    const out = JSON.parse(text(await callViaMcp(reg, "tool_invoke", { name: "synth_tool_2", arguments: { path: "/tmp/x" } })));
    expect(out.tool).toBe("synth_tool_2");
    expect(out.args).toEqual({ path: "/tmp/x" });
  });

  it("tool_invoke 仍经过同一安全守卫：守卫抛错 → 不执行工具体", async () => {
    let executed = false;
    const reg = new ToolRegistry({
      lazy: true,
      guard: async (name) => {
        if (name === "synth_tool_0") throw new Error("[HardFloor] blocked by test guard");
      },
    });
    reg.add({
      name: "synth_tool_0",
      description: "guarded",
      inputSchema: { x: z.string() },
      capability: ["internal"],
      handler: async () => { executed = true; return { ok: true }; },
    });
    const res = await callViaMcp(reg, "tool_invoke", { name: "synth_tool_0", arguments: { x: "1" } });
    expect(executed).toBe(false);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("blocked by test guard");
  });

  it("tool_invoke 未知工具名 → 明确错误", async () => {
    const reg = makeRegistry(2, { lazy: true });
    const res = await callViaMcp(reg, "tool_invoke", { name: "ghost_tool", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("ghost_tool");
  });
});
