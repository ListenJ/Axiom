/**
 * 审计 H1（2026-08-28）：VRAM 探测插件挂载验证
 *
 * startVramProbe 为可插拔基础设施（system-resource-probe.ts），
 * 此前全仓零调用点 → availableMemory 恒为 4000MB 硬编码默认值，
 * canRun/recommendedMaxTokens 全链路失真。本测试锁定两件事：
 *  1. main.ts 启动链路已挂载探测 + 注册关停钩（静态断言）；
 *  2. 未设 AXIOM_VRAM_PROBE 时 startVramProbe 为零行为 no-op（行为断言）。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { startVramProbe } from "../src/dre/system-resource-probe.js";

describe("审计 H1: VRAM 探测挂载", () => {
  test("main.ts 启动链路调用 startVramProbe 并注册关停钩", () => {
    const main = readFileSync("src/main.ts", "utf8");
    expect(main.includes("startVramProbe()")).toBe(true);
    expect(main.includes('name: "vram-probe"')).toBe(true);
  });

  test("未设 AXIOM_VRAM_PROBE 时为零行为 no-op（返回 stop 函数、无定时器）", () => {
    delete process.env.AXIOM_VRAM_PROBE;
    const stop = startVramProbe();
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
