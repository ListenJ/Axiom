/**
 * LLM Cache — 高性能缓存集成测试
 *
 * 验证维度：
 *   A. 缓存命中：相同输入第二次调用走缓存（不触发 factory）
 *   B. 缓存未命中：不同输入触发 factory
 *   C. 确定性条件：temperature=0 缓存，temperature>0 不缓存
 *   D. 缓存 key 隔离：不同 provider/model 独立缓存
 *   E. 持久化：L3 SQLite 落盘后可跨实例命中
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Cache, llmCacheKey, type CachedLLMResponse } from "../src/utils/cache.js";

describe("A. LLM Cache 命中", () => {
  let cache: Cache<CachedLLMResponse>;

  beforeEach(() => {
    cache = new Cache<CachedLLMResponse>({
      namespace: "llm-test",
      maxSize: 100,
      defaultTtlMs: 60_000,
      redis: false,
      persistent: false,
    });
  });

  afterEach(() => {
    cache.destroy();
  });

  test("相同输入第二次调用走缓存", async () => {
    let factoryCalls = 0;
    const factory = async (): Promise<CachedLLMResponse> => {
      factoryCalls++;
      return {
        content: "cached response",
        model: "test-model",
        provider: "test-provider",
        usage: { total_tokens: 10 },
      };
    };

    const key = "test-key-1";
    const r1 = await cache.getOrSet(key, factory);
    const r2 = await cache.getOrSet(key, factory);

    expect(factoryCalls).toBe(1); // factory 只调用一次
    expect(r1.content).toBe("cached response");
    expect(r2.content).toBe("cached response");
  });

  test("缓存命中时 latency 显著降低", async () => {
    const factory = async (): Promise<CachedLLMResponse> => {
      await new Promise((r) => setTimeout(r, 50)); // 模拟 API 延迟
      return { content: "slow", model: "m", provider: "p" };
    };

    const key = "latency-test";
    const start1 = Date.now();
    await cache.getOrSet(key, factory);
    const coldMs = Date.now() - start1;

    const start2 = Date.now();
    await cache.getOrSet(key, factory);
    const hotMs = Date.now() - start2;

    expect(hotMs).toBeLessThan(coldMs);
    expect(hotMs).toBeLessThan(10); // 缓存命中应 <10ms
  });
});

describe("B. LLM Cache 未命中", () => {
  let cache: Cache<CachedLLMResponse>;

  beforeEach(() => {
    cache = new Cache<CachedLLMResponse>({
      namespace: "llm-test-miss",
      maxSize: 100,
      defaultTtlMs: 60_000,
      redis: false,
      persistent: false,
    });
  });

  afterEach(() => {
    cache.destroy();
  });

  test("不同 key 触发 factory", async () => {
    let calls = 0;
    const factory = async (): Promise<CachedLLMResponse> => {
      calls++;
      return { content: `resp-${calls}`, model: "m", provider: "p" };
    };

    await cache.getOrSet("key-a", factory);
    await cache.getOrSet("key-b", factory);

    expect(calls).toBe(2);
  });
});

describe("C. LLM Cache 确定性条件", () => {
  test("llmCacheKey temperature=0 与 temperature=0.7 产生不同 key", () => {
    const base = {
      provider: "deepseek",
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
    };
    const key0 = llmCacheKey({ ...base, temperature: 0 });
    const key07 = llmCacheKey({ ...base, temperature: 0.7 });
    expect(key0).not.toBe(key07);
  });

  test("llmCacheKey 相同输入产生相同 key", () => {
    const opts = {
      provider: "glm",
      model: "glm-4-flash",
      messages: [{ role: "user", content: "test prompt" }],
      temperature: 0,
    };
    const key1 = llmCacheKey(opts);
    const key2 = llmCacheKey(opts);
    expect(key1).toBe(key2);
  });

  test("llmCacheKey 不同 prompt 产生不同 key", () => {
    const base = {
      provider: "ollama",
      model: "qwen2.5",
      temperature: 0,
    };
    const key1 = llmCacheKey({ ...base, messages: [{ role: "user", content: "prompt A" }] });
    const key2 = llmCacheKey({ ...base, messages: [{ role: "user", content: "prompt B" }] });
    expect(key1).not.toBe(key2);
  });
});

describe("D. LLM Cache key 隔离", () => {
  test("不同 provider 产生不同 key", () => {
    const base = {
      model: "shared-model",
      messages: [{ role: "user", content: "same prompt" }],
      temperature: 0,
    };
    const key1 = llmCacheKey({ ...base, provider: "deepseek" });
    const key2 = llmCacheKey({ ...base, provider: "glm" });
    expect(key1).not.toBe(key2);
  });

  test("不同 model 产生不同 key", () => {
    const base = {
      provider: "deepseek",
      messages: [{ role: "user", content: "same prompt" }],
      temperature: 0,
    };
    const key1 = llmCacheKey({ ...base, model: "deepseek-chat" });
    const key2 = llmCacheKey({ ...base, model: "deepseek-coder" });
    expect(key1).not.toBe(key2);
  });

  test("system prompt 影响缓存 key", () => {
    const base = {
      provider: "p",
      model: "m",
      messages: [{ role: "user", content: "prompt" }],
      temperature: 0,
    };
    const key1 = llmCacheKey({ ...base, system: "system A" });
    const key2 = llmCacheKey({ ...base, system: "system B" });
    expect(key1).not.toBe(key2);
  });
});

describe("E. LLM Cache 持久化 (L3 SQLite)", () => {
  const dbPath = "./data/test-llm-cache.db";

  afterEach(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs");
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {
      // 忽略
    }
  });

  test("写入 L3 后新实例可读取", async () => {
    const cache1 = new Cache<CachedLLMResponse>({
      namespace: "llm-persist-test",
      maxSize: 100,
      defaultTtlMs: 60_000,
      redis: false,
      persistent: true,
      dbPath,
    });

    await cache1.getOrSet("persist-key", async () => ({
      content: "persisted",
      model: "m",
      provider: "p",
    }));

    // L3 写入是去抖异步的（pendingL3 + setTimeout(0)）：destroy() 内部**先 flush 再关库**，
    // 并清除 5 分钟清理定时器 —— 这正是必须走 destroy() 而非直接 db.close() 的原因：
    // 直接关库会留下孤儿定时器，约 5 分钟后在 cache.ts 的清理回调里访问已关闭 db，
    // 抛出的未捕获异常会被 bun 归咎给当时正在跑的**无关测试**。
    // （2026-10-19 实测：全量无隔离时随机砸在 tests/stress/audit-regression-stress.test.ts 的 S2；
    //  `--isolate` 全量 0/1 复现，时间差与 5 分钟周期吻合。）
    cache1.destroy();

    // 新实例从同一 L3 恢复
    const cache2 = new Cache<CachedLLMResponse>({
      namespace: "llm-persist-test",
      maxSize: 100,
      defaultTtlMs: 60_000,
      redis: false,
      persistent: true,
      dbPath,
    });

    const cached = await cache2.get("persist-key");
    expect(cached).toBeDefined();
    expect(cached!.content).toBe("persisted");

    cache2.destroy();
  });

  test("destroy() 只冲刷不清理，新实例可读到已写入条目", async () => {
    const cache1 = new Cache<CachedLLMResponse>({
      namespace: "llm-destroy-test",
      maxSize: 100,
      defaultTtlMs: 60_000,
      redis: false,
      persistent: true,
      dbPath,
    });

    await cache1.getOrSet("destroy-key", async () => ({
      content: "survives-destroy",
      model: "m",
      provider: "p",
    }));

    // 销毁实例 ≠ 清库：destroy 只 flush + 关库，L3 数据保留给后续实例
    cache1.destroy();

    const cache2 = new Cache<CachedLLMResponse>({
      namespace: "llm-destroy-test",
      maxSize: 100,
      defaultTtlMs: 60_000,
      redis: false,
      persistent: true,
      dbPath,
    });

    const cached = await cache2.get("destroy-key");
    expect(cached).toBeDefined();
    expect(cached!.content).toBe("survives-destroy");

    cache2.destroy();
  });
});
