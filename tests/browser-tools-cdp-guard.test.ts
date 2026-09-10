/**
 * Task 4 / 审计 B3（2026-08-29）：browser-tools cdpUrl 未校验修复
 *
 * 证据：src/mcp/server/browser-tools.ts 三处工具入参 cdpUrl 直通下游 fetch：
 *   browser_guide(:28) / browser_locate(:69) / frontend_visual_review(:130)
 * 修复契约：三处入参经 utils/url-safety assertSafeCdpUrl 校验（与 routes/agents.ts:213
 * 同一守卫、同一 AXIOM_ALLOW_REMOTE_CDP 豁免开关），不合法抛错 → MCP 层包装为工具错误
 * （tool-registry.ts:157-171 isError）。
 *
 * 行为测试经 ToolRegistry 直调 handler（guard 注入 no-op，避免拉起复核依赖链）；
 * 红线：默认回环 cdpUrl（含缺省）不受影响。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import { registerBrowserTools } from "../src/mcp/server/browser-tools.js";

function getHandler(name: string) {
  const registry = new ToolRegistry({ guard: async () => {} });
  registerBrowserTools(registry);
  const tool = registry
    .filterByExposure(["external", "safe-external", "internal"])
    .find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler;
}

/** 守卫缺失时未修复代码会真连 cdpUrl（内网 SYN 可能长时间挂起）——
 *  harness 侧硬超时把挂起转成确定性失败（红）；修复后守卫在连接前抛错，恒快路径。 */
function withTimeout<T>(p: Promise<T>, label: string, ms = 8000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`cdpUrl guard missing (harness timeout): ${label}`)), ms),
    ),
  ]);
}

describe("[T4-②] browser-tools cdpUrl 守卫（审计 B3）", () => {
  it("browser_guide 恶意 cdpUrl（云元数据 169.254.169.254）被拒", async () => {
    const handler = getHandler("browser_guide");
    await expect(
      withTimeout(handler({ task: "probe", cdpUrl: "http://169.254.169.254:9222" }), "guide-metadata"),
    ).rejects.toThrow(/remote cdpUrl blocked/i);
  });

  it("browser_locate 私网 cdpUrl（192.168.x）被拒", async () => {
    const handler = getHandler("browser_locate");
    await expect(
      withTimeout(handler({ cdpUrl: "http://192.168.0.150:9222", text: "x" }), "locate-private"),
    ).rejects.toThrow(/remote cdpUrl blocked/i);
  });

  it("frontend_visual_review 非 http 协议（file:）被拒", async () => {
    const handler = getHandler("frontend_visual_review");
    await expect(
      withTimeout(handler({ url: "http://127.0.0.1:3000", cdpUrl: "file:///etc/passwd" }), "review-file"),
    ).rejects.toThrow(/cdpUrl protocol not allowed/i);
  });

  it("红线：缺省 cdpUrl 走默认回环，正常返回（不误伤）", async () => {
    const handler = getHandler("browser_guide");
    const r = (await withTimeout(handler({ task: "smoke" }), "guide-default", 20000)) as {
      cdpConnected?: boolean;
    };
    expect(r).toHaveProperty("cdpConnected");
  });

  it("红线：显式回环 cdpUrl 放行（不被守卫拦截，下游错误透出）", async () => {
    const handler = getHandler("browser_locate");
    try {
      const r = await withTimeout(handler({ cdpUrl: "http://127.0.0.1:9222", text: "x" }), "locate-loopback", 20000);
      expect(r).toBeDefined();
    } catch (e) {
      // 本机无 CDP 监听 → 下游连接错误透出；关键是错误不含守卫拒绝语义
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toMatch(/remote cdpUrl blocked|invalid cdpUrl|protocol not allowed/i);
      expect(msg).toMatch(/CDP|cdp|fetch|connect|target|network|ECONNREFUSED|refused/i);
    }
  });

  it("静态断言：三处入参均经 safeCdpUrl（assertSafeCdpUrl 包装）", () => {
    const src = readFileSync(path.join(import.meta.dir, "../src/mcp/server/browser-tools.ts"), "utf-8");
    expect(src).toMatch(/import\s*\{[^}]*assertSafeCdpUrl[^}]*\}\s*from\s*"\.\.\/\.\.\/utils\/url-safety\.js"/);
    const calls = src.match(/safeCdpUrl\(args\.cdpUrl\)/g) ?? [];
    expect(calls.length, "三处 cdpUrl 入参必须全部过守卫").toBe(3);
  });
});
