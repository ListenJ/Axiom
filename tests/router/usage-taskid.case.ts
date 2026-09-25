/**
 * A4 端到端：`router.execute({taskId})` → `trackCall` → TokenTracker 落库
 *
 * 为什么单独放 case 文件：本文件在**加载期** `mock.module` 掉 `provider-caller`，
 * 而 Bun 先加载全部测试文件再执行 ⇒ 同进程会污染其它用例（本仓库已有先例与教训）。
 * 故由兄弟文件 `usage-taskid.test.ts` 用 spawnSync 在**独立进程**中运行本文件。
 *
 * 为什么之前只能断言到"路由收到 taskId"：`getTokenTracker()` 原为单例且 DB 路径不可注入，
 * 测试会写生产 ./data/token-usage.db。现已加 `TOKEN_USAGE_DB` env 注入（缺省行为不变）。
 */
import { describe, it, expect, mock, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const DB_DIR = mkdtempSync(join(tmpdir(), "usage-taskid-"));
process.env.TOKEN_USAGE_DB = join(DB_DIR, "token-usage.db");
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "test-key-for-usage-taskid";

// 打桩 provider：让 execute() 走真实 trackCall，但不发网络请求
mock.module(path.join(ROOT, "src", "router", "provider-caller.js"), () => ({
  callProvider: async () => ({
    content: "stub-ok",
    model: "stub-model",
    provider: "deepseek",
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }),
  callProviderNativeStream: async () => ({ content: "stub", usage: { total_tokens: 1 } }),
}));

afterAll(() => {
  try { rmSync(DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("A4 端到端：taskId 进入 token 记录", () => {
  it("router.execute({taskId}) 的记录可在 TokenTracker 中按 taskId 读回", async () => {
    const { router } = await import("../../src/router/model-router.js");
    const { getTokenTracker } = await import("../../src/router/token-tracker.js");

    const taskId = "task-e2e-aaa";
    await router.chat("coding", [{ role: "user", content: "hi" }], { taskId });
    await getTokenTracker().flush();

    const rows = getTokenTracker().getRecentUsage(20);
    const hit = rows.find((r) => r.taskId === taskId);
    expect(hit, "应有一条带该 taskId 的 token 记录").toBeDefined();
    expect(hit!.totalTokens).toBeGreaterThan(0);
  });
});
