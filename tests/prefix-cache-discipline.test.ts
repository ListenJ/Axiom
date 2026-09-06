/**
 * P1-C 前缀纪律（前缀缓存优化计划）——切片①②：
 * ① prompt-pool CACHE_BOUNDARY marker 去随机化：静态前缀必须跨进程重启字节级稳定
 *   （原 Math.random UUID 使每次重建的前缀字节不同，provider 端前缀缓存全部落空）；
 * ② provider-caller 请求边界工具列表确定性排序：工具定义位于序列化请求前缀，
 *   调用方传入顺序不定会让同前缀请求字节不稳定。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { UserAgentPromptPool } from "../src/agents/prompt-pool.js";
import { orderToolsForCache } from "../src/router/provider-caller.js";
import type { ToolCallDef } from "../src/utils/tool-surface.js";

function tool(name: string): ToolCallDef {
  return { type: "function", function: { name, description: `desc-${name}`, parameters: {} } };
}

describe("P1-C① prompt-pool 静态前缀跨实例字节稳定", () => {
  test("两个独立实例的同角色 staticPrefix 与 cacheControlMarker 逐字节相同", () => {
    const a = new UserAgentPromptPool();
    const b = new UserAgentPromptPool();
    const pa = a.acquire("general_chat", { task_description: "t" });
    const pb = b.acquire("general_chat", { task_description: "t" });
    expect(pa.staticPrefix).toBe(pb.staticPrefix);
    expect(pa.cacheControlMarker).toBe(pb.cacheControlMarker);
    expect(pa.prefixHash).toBe(pb.prefixHash);
  });

  test("同配置重建（updateRoleConfig 传原配置）后 marker 不变", () => {
    const pool = new UserAgentPromptPool();
    const before = pool.acquire("research", { task_description: "t" }).cacheControlMarker;
    pool.updateRoleConfig("research", pool.getRoleConfig("research"));
    const after = pool.acquire("research", { task_description: "t" }).cacheControlMarker;
    expect(after).toBe(before);
  });

  test("marker 为确定性内容 hash（不含随机段）", () => {
    const pool = new UserAgentPromptPool();
    const marker = pool.acquire("tool_use", { task_description: "t" }).cacheControlMarker;
    expect(marker).toMatch(/^<!-- CACHE_BOUNDARY: [0-9a-f]+ -->$/);
  });
});

describe("P1-C② orderToolsForCache 请求边界确定性排序", () => {
  test("乱序输入 → 按 function.name 升序输出", () => {
    const out = orderToolsForCache([tool("web_search"), tool("bash"), tool("edit_file")]);
    expect(out.map((t) => t.function.name)).toEqual(["bash", "edit_file", "web_search"]);
  });

  test("稳定且不原地修改输入数组", () => {
    const input = [tool("b_tool"), tool("a_tool"), tool("b_tool")];
    const snapshot = input.map((t) => t.function.name);
    const out = orderToolsForCache(input);
    expect(input.map((t) => t.function.name)).toEqual(snapshot);
    expect(out.map((t) => t.function.name)).toEqual(["a_tool", "b_tool", "b_tool"]);
  });

  test("空数组安全", () => {
    expect(orderToolsForCache([])).toEqual([]);
  });

  test("callProvider 请求体经 orderToolsForCache（静态断言：两处 tools 展开均接线）", () => {
    const src = readFileSync(new URL("../src/router/provider-caller.ts", import.meta.url), "utf8");
    expect(src).toMatch(/\{ tools: orderToolsForCache\(tools\) \}/);
    expect(src).not.toMatch(/\{ tools \}/);
  });
});
