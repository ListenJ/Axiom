/**
 * Q3/A5 端到端：`category` 分类字段**真的被写入** token 记录
 *
 * 为什么必须单独一个 case 文件：本文件在**加载期** `mock.module` 掉
 * `provider-caller` 与 `proxy-fetch`，而 Bun 先加载全部测试文件再执行 ⇒
 * 同进程会污染其它用例（本仓库既有教训，见 `usage-taskid.case.ts` 头部）。
 * 故由兄弟文件 `usage-category.test.ts` 用 spawnSync 在**独立进程**中运行本文件。
 *
 * 这一条为什么值得存在：`category` 字段与 `/traces` 的按分类聚合（A5）此前是
 * **有形状无行为** —— 字段、聚合、展示都在，但**没有任何生产者写入它**，
 * 聚合结果永远只有 `unknown`。本用例就是"生产者确实写入"的门禁。
 */
import { describe, it, expect, mock, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const DB_DIR = mkdtempSync(join(tmpdir(), "usage-category-"));
process.env.TOKEN_USAGE_DB = join(DB_DIR, "token-usage.db");
// 供 chat/tool 路径取到"已配置"的 provider（假 key，不会真的发请求：下面两个模块都打桩了）
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "test-key-for-usage-category";
process.env.SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY ?? "test-key-for-usage-category";
process.env.LOCAL_EMBED_API_KEY = "test-key-for-usage-category";
// embedding 角色在发布默认下**无候选**（devOnly 闸门），本用例显式放行以覆盖 dev/test 路径
process.env.AXIOM_ALLOW_DEV_MODELS = "1";

mock.module(path.join(ROOT, "src", "router", "provider-caller.js"), () => ({
  callProvider: async () => ({
    content: "stub-ok",
    model: "stub-model",
    provider: "deepseek",
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }),
  callProviderNativeStream: async () => ({ content: "stub", usage: { total_tokens: 1 } }),
}));

// embeddings() 走 proxyFetch；打桩避免任何真实网络（并回一个带 usage 的 OpenAI 兼容响应）
mock.module(path.join(ROOT, "src", "utils", "proxy-fetch.js"), () => ({
  proxyFetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }],
      usage: { prompt_tokens: 17, total_tokens: 17 },
    }),
  }),
  proxyFetchWithMeta: async () => ({ response: { ok: true, status: 200 } }),
}));

afterAll(() => {
  try { rmSync(DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("Q3/A5：category 由生产者显式写入", () => {
  it("chat/工具/嵌入各自写入明确的 category，且聚合里不再只有 unknown", async () => {
    const { router } = await import("../../src/router/model-router.js");
    const { getTokenTracker } = await import("../../src/router/token-tracker.js");
    const tracker = getTokenTracker();

    await router.chat("coding", [{ role: "user", content: "hi" }]);
    await router.chat("coding", [{ role: "user", content: "hi" }], { category: "subagent" });
    await router.tool("coding", [{ role: "user", content: "tool please" }]);
    await router.embeddings(["alpha", "beta"]);
    await tracker.flush();

    const rows = tracker.getRecentUsage(50);
    const categories = rows.map((r) => r.category);

    // 1) 主模型路径缺省记为 main
    expect(categories).toContain("main");
    // 2) 子代理等调用方可显式覆盖（**不靠 router 按 role 猜**）
    expect(categories).toContain("subagent");
    // 3) 工具路径记为 tool
    expect(categories).toContain("tool");
    // 4) 嵌入路径记为 embedding —— 此前这笔消耗**完全没落库**
    expect(categories).toContain("embedding");

    // 5) 每条记录都必须带分类（不写 = 聚合里变成 unknown，等于这条观测失效）
    for (const r of rows) {
      expect(r.category, `记录 ${r.model}/${r.taskType} 缺 category`).toBeTruthy();
    }

    // 6) 聚合面确实读得到 embedding 这一桶（A5 的展示依赖它）
    const byCat = tracker.getStatsByCategory();
    const emb = byCat.find((c) => c.category === "embedding");
    expect(emb, "按分类聚合应含 embedding 桶").toBeDefined();
    expect(emb!.totalTokens).toBeGreaterThan(0);
    expect(byCat.some((c) => c.category === "unknown")).toBe(false);
  });
});
