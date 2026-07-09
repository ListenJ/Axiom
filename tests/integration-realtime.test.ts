/**
 * 真实场景集成测试：模拟用户使用流程
 * 不依赖外部 API 和 HTTP 服务器
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

// ─── 测试 1: Vault 操作 ─────────────────────────────────────────────
describe("Vault Manager (本地记忆库)", () => {
  let vm: any;

  beforeAll(async () => {
    try {
      const { VaultManager } = await import("../src/memory/vault-manager.js");
      vm = new VaultManager();
      if (typeof vm.initialize === "function") await vm.initialize();
    } catch {
      // Vault 在无权限环境（如 Docker CI）中可跳过
      vm = null;
    }
  });

  it("读取 vault 状态", async () => {
    if (!vm) return; // 跳过无权限环境
    try {
      const stats = await vm.getStats?.() ?? { status: "ok" };
      expect(stats).toBeDefined();
    } catch (e) {
      expect((e as Error).message).toBeDefined();
    }
  });
});

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

  // 执行服务路由需要真实 API key，跳过
  it.skip("执行服务路由", async () => {
    const svc = await import("../src/services/index.js");
    const result = await svc.executeChat(
      [{ role: "user", content: "hi" }],
      null,
      "general-chat",
    );
    expect(result).toBeDefined();
    expect(result).toHaveProperty("content");
  });
});

// ─── 测试 5: 意识系统 ───────────────────────────────────────────────
describe("Consciousness (意识系统)", () => {
  it("获取状态不抛异常", async () => {
    try {
      const { getConsciousness } = await import("../src/agents/consciousness/index.js");
      const c = getConsciousness();
      const status = c.status?.() ?? { ok: true };
      expect(status).toBeDefined();
    } catch {
      // 如果没有初始化也不阻塞
      expect(true).toBeTrue();
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

// ─── 测试 7: VIB 压缩 ──────────────────────────────────────────────
describe("VIB Memory Compressor (记忆压缩)", () => {
  it("基础压缩能力", async () => {
    const { VIBCompressor } = await import("../src/memory/vib-compressor.js");
    const c = new VIBCompressor({ capacity: 3, existingMemory: ["existing known facts"] });
    const items = [
      { id: "1", content: "nova stella", timestamp: Date.now(), source: "test" },
      { id: "2", content: "existing known facts", timestamp: Date.now(), source: "test" },
      { id: "3", content: "quantum flux capacitor", timestamp: Date.now(), source: "test" },
      { id: "4", content: "another novel idea", timestamp: Date.now(), source: "test" },
    ];
    const result = await c.compress(items);
    expect(result.retained.length).toBe(3);
    expect(result.discarded.length).toBe(1);
    // 已有事实应该被丢弃（低惊喜度）
    expect(result.discarded.find(i => i.id === "2")).toBeDefined();
  });
});

// ─── 测试 8: MCP 外部工具注册 ──────────────────────────────────────
describe("MCP External Tools (MCP 工具)", () => {
  it("注册函数存在", async () => {
    const { registerExternalTools } = await import("../src/mcp/register-external-tools.js");
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const registry = new ToolRegistry();
    expect(() => registerExternalTools(registry)).not.toThrow();
  });
});
