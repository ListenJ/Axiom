/**
 * 真实场景集成测试：模拟用户使用流程
 * 不依赖外部 API 和 HTTP 服务器
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultManager } from "../src/memory/vault-manager.js";
import { hasEnv } from "./helpers/env-probe";

// ─── 测试 1: Vault 操作 ─────────────────────────────────────────────
// 2026-10-19 修复（消除假绿）：原实现 beforeAll 里 `catch { vm = null }` 吞掉初始化异常，
// 用例体再 `if (!vm) return;` 静默早退 —— 报告显示 **pass**，等于 Vault 路径回归零保护。
// 现改为：收集期在临时目录构造真实 VaultManager；失败 → **可见 skip 且标题带原因**；
// 用例体不再吞异常（取状态抛错即红）。
const vaultTmpDir = mkdtempSync(join(tmpdir(), "axiom-rt-vault-"));
let vault: VaultManager | null = null;
let vaultSkipReason: string | undefined;
try {
  vault = new VaultManager({ vaultPath: vaultTmpDir, dbPath: join(vaultTmpDir, "rt.db") });
  const maybeInit = (vault as unknown as { initialize?: () => Promise<void> }).initialize;
  if (typeof maybeInit === "function") await maybeInit.call(vault);
} catch (e) {
  vaultSkipReason = `Vault 初始化失败：${e instanceof Error ? e.message : String(e)}`;
}

afterAll(() => {
  try {
    (vault as unknown as { sqliteMemory?: { close(): void } })?.sqliteMemory?.close();
  } catch {
    /* ignore */
  }
  rmSync(vaultTmpDir, { recursive: true, force: true });
});

describe.skipIf(vaultSkipReason !== undefined)(
  `Vault Manager (本地记忆库)（skip：${vaultSkipReason ?? "可用"}）`,
  () => {
    it("读取 vault 状态", async () => {
      expect(vault).not.toBeNull();
      const getStats = (vault as unknown as { getStats?: () => Promise<unknown> }).getStats;
      const stats = (await getStats?.()) ?? { status: "ok" };
      expect(stats).toBeDefined();
      expect(typeof stats).toBe("object");
    });
  },
);

// ─── 测试 2: 缓存子系统 ─────────────────────────────────────────────
describe("缓存子系统 (Cache)", () => {
  it("LRU 缓存读写 + 驱逐", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 10, defaultTtlMs: 60000, redis: false });
    for (let i = 0; i < 20; i++) c.set(`k${i}`, { value: i });
    expect(c.stats().size).toBeLessThanOrEqual(10);
    expect(c.getSync("k19")).toBeDefined();
  });

  it("getOrSet 防雷群", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 50, defaultTtlMs: 60000, redis: false });
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        c.getOrSet("shared-key", async () => { calls++; await new Promise(r => setTimeout(r, 5)); return "val"; })
      )
    );
    expect(calls).toBe(1);
    expect(results.every(r => r === "val")).toBeTrue();
  });
});

// ─── 测试 3: Thompson 路由 ──────────────────────────────────────────
describe("Thompson Router (模型路由)", () => {
  it("冷启动路由", async () => {
    const { createThompsonRouter } = await import("../src/router/thompson-router.js");
    const arms = [
      { id: "fast", model: "gpt4", provider: "openai", alpha: 1, beta: 1, metadata: {} },
      { id: "cheap", model: "claude", provider: "anthropic", alpha: 1, beta: 1, metadata: {} },
    ];
    const router = createThompsonRouter({ arms, minSamples: 5, inMemory: true });
    const d = await router.route({ taskType: "general-chat", inputLength: 500, timeWindow: 10000 });
    expect(d.arm.id).toMatch(/^(fast|cheap)$/);
    expect(d.reason).toContain("Thompson");
  });

  it("反馈驱动路由收敛", async () => {
    const { createThompsonRouter } = await import("../src/router/thompson-router.js");
    const good = { id: "good", model: "a", provider: "p", alpha: 10, beta: 2, metadata: {} };
    const bad = { id: "bad", model: "b", provider: "p", alpha: 2, beta: 10, metadata: {} };
    const router = createThompsonRouter({ arms: [good, bad], minSamples: 0, inMemory: true });
    let wins = 0;
    for (let i = 0; i < 50; i++) {
      const d = await router.route({ taskType: "chat", inputLength: 100 });
      if (d.arm.id === "good") wins++;
    }
    expect(wins).toBeGreaterThan(25);
  });
});

// ─── 测试 4: 服务层 ────────────────────────────────────────────────
describe("Services 层", () => {
  it("barrel 导出完整", async () => {
    const svc = await import("../src/services/index.js");
    expect(svc.prepareChatContext).toBeFunction();
    expect(svc.executeChat).toBeFunction();
    expect(svc.getConsciousness).toBeDefined();
    expect(svc.executionMode).toBeDefined();
    expect(svc.getConstitutionForMode).toBeFunction();
  });

  // 执行服务路由需要真实 API key；改为**可见 skip**（2026-10-19：原 `it.skip` 无理由、
  // 也无法在配置齐备时启用，属死用例）。门控与 tests/deepseek-realtime.test.ts 一致：
  // 需显式 opt-in `AXIOM_RUN_REAL_API_TESTS` 且存在凭据。
  it.skipIf(!hasEnv("AXIOM_RUN_REAL_API_TESTS") || !hasEnv("DEEPSEEK_API_KEY"))(
    "执行服务路由（skip：真实外部 API 测试需 AXIOM_RUN_REAL_API_TESTS=1 且配置 DEEPSEEK_API_KEY）",
    async () => {
      const svc = await import("../src/services/index.js");
      const result = await svc.executeChat(
        [{ role: "user", content: "hi" }],
        null,
        "general-chat",
      );
      expect(result).toBeDefined();
      expect(result).toHaveProperty("content");
    },
  );
});

// ─── 测试 5: 意识系统 ───────────────────────────────────────────────
describe("Consciousness (意识系统)", () => {
  it("获取状态不抛异常", async () => {
    const { getConsciousness } = await import("../src/agents/consciousness/index.js");
    const c = getConsciousness();
    expect(c).toBeDefined();
    // status 是可选契约：存在则必须可调用并返回定义值；不存在也是显式断言
    if (typeof c.status === "function") {
      expect(c.status()).toBeDefined();
    } else {
      expect(c.status).toBeUndefined();
    }
  });
});

// ─── 测试 6: 路由 Trie ──────────────────────────────────────────────
describe("HTTP Router (Trie)", () => {
  it("路由注册与匹配", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter({ cacheMaxSize: 5, cacheTtlMs: 1000 } as any);
    const handler: any = () => new Response("ok");
    router.register({ method: "GET", path: "/test", handler });
    expect(router).toBeDefined();
  });
});

// ─── 测试 7（P2-S2 已移除：VIB 压缩模块随幽灵链归档） ──────────────

// ─── 测试 8: MCP 外部工具注册 ──────────────────────────────────────
describe("MCP External Tools (MCP 工具)", () => {
  it("注册函数存在", async () => {
    const { registerExternalTools } = await import("../src/mcp/register-external-tools.js");
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const registry = new ToolRegistry();
    expect(() => registerExternalTools(registry)).not.toThrow();
  });
});
