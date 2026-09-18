/**
 * L4 审计修复：ToolRegistry.add 同名去重（幂等注册语义）
 *
 * 背景：add 原实现直接 push，同名工具注册两次会在 tools 列表产生重复条目，
 * SDK 层（MCP registerTool）遇到重名直接抛错 → 启动期崩溃。
 * Contract：同名已存在 → logger.warn + 跳过，列表保持 1 条；不同名 → 正常追加。
 */
import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import { logger } from "../src/utils/logger.js";

function makeTool(name: string) {
  return { name, description: `tool ${name}`, inputSchema: {}, handler: async () => ({ ok: true }) };
}

describe("L4: ToolRegistry.add 同名去重", () => {
  it("同名注册两次 → tools 仅 1 条 + warn 日志（含工具名）", () => {
    const reg = new ToolRegistry({ guard: async () => {} });
    reg.add(makeTool("dup_tool_l4"));

    const warnings: string[] = [];
    const registry = logger as unknown as { warn: unknown };
    const origWarn = registry.warn;
    registry.warn = (msg: string) => warnings.push(String(msg));
    try {
      reg.add(makeTool("dup_tool_l4"));
    } finally {
      registry.warn = origWarn;
    }

    expect(reg.size).toBe(1);
    expect(reg.getToolNames().filter((n) => n === "dup_tool_l4").length).toBe(1);
    expect(warnings.some((w) => w.includes("dup_tool_l4"))).toBe(true);
  });

  it("不同名仍正常追加；add 返回 this 保持链式", () => {
    const reg = new ToolRegistry({ guard: async () => {} });
    const returned = reg.add(makeTool("tool_a")).add(makeTool("tool_b"));
    expect(returned).toBe(reg);
    expect(reg.size).toBe(2);
    expect(reg.getToolNames()).toEqual(["tool_a", "tool_b"]);
  });

  it("remove 后允许重新注册同名（插件 disable/enable 语义不受影响）", () => {
    const reg = new ToolRegistry({ guard: async () => {} });
    reg.add(makeTool("cycle_tool"));
    expect(reg.remove("cycle_tool")).toBe(true);
    reg.add(makeTool("cycle_tool"));
    expect(reg.size).toBe(1);
  });
});
