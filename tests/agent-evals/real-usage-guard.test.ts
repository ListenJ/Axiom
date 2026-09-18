import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { captureRealUsageTrace, flushRealUsageTraces, clearRealUsageTraces } from "../../src/agent-evals/real-usage.js";

/**
 * 测试流量守卫 — 防止 chat 路由测试（mock model m1 驱动真实 handleChat）污染
 * 生产 real-usage JSONL。bun test 设 NODE_ENV=test，capture 在生产默认落点（省略 filePath）
 * 时应跳过；显式 filePath（单元测试/自定义落点）不受守卫影响。
 */

describe("real-usage 测试流量守卫", () => {
  const prodPath = path.join(process.cwd(), ".tmp", "test-real-usage-prod.jsonl");
  const explicitPath = path.join(process.cwd(), ".tmp", "test-real-usage-explicit.jsonl");

  beforeEach(async () => {
    process.env.NODE_ENV = "test"; // 模拟 bun test 环境
    process.env.REAL_USAGE_PATH = prodPath; // "生产默认落点"安全解析到临时文件，绝不碰真实 data/
    await clearRealUsageTraces(prodPath);
    await clearRealUsageTraces(explicitPath);
  });

  afterEach(async () => {
    await clearRealUsageTraces(prodPath);
    await clearRealUsageTraces(explicitPath);
    try { fs.unlinkSync(prodPath); } catch {}
    try { fs.unlinkSync(explicitPath); } catch {}
    delete process.env.NODE_ENV;
    delete process.env.REAL_USAGE_PATH;
  });

  test("NODE_ENV=test 且省略 filePath → 跳过采集，生产落点不写入", async () => {
    await captureRealUsageTrace({ id: "t1", task: "should be skipped", success: true } as any);
    await flushRealUsageTraces(prodPath);
    expect(fs.existsSync(prodPath)).toBe(false); // 跳过 → 文件未被创建
  });

  test("NODE_ENV=test 但显式 filePath → 正常采集", async () => {
    await captureRealUsageTrace({ id: "t2", task: "explicit path writes", success: true } as any, explicitPath);
    await flushRealUsageTraces(explicitPath);
    expect(fs.existsSync(explicitPath)).toBe(true);
    const content = fs.readFileSync(explicitPath, "utf-8");
    expect(content).toContain("explicit path writes");
  });

  test("NODE_ENV=TEST（大写）省略 filePath → 跳过（大小写鲁棒，防 CI 大写绕过）", async () => {
    process.env.NODE_ENV = "TEST";
    await captureRealUsageTrace({ id: "t3", task: "uppercase test env", success: true } as any);
    await flushRealUsageTraces(prodPath);
    expect(fs.existsSync(prodPath)).toBe(false); // 跳过 → 文件未被创建
  });

  test("NODE_ENV=production 省略 filePath → 正常采集（生产行为不受守卫阻断）", async () => {
    process.env.NODE_ENV = "production";
    await captureRealUsageTrace({ id: "t4", task: "production default path", success: true } as any);
    await flushRealUsageTraces(prodPath);
    expect(fs.existsSync(prodPath)).toBe(true);
    const content = fs.readFileSync(prodPath, "utf-8");
    expect(content).toContain("production default path");
  });
});