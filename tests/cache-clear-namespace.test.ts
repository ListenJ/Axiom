/**
 * Cache.clear 命名空间化测试（B3-Medium，docs/reviews/2026-08-29-joint-verification-audit.md §4）
 *
 * 审计症状：cache.ts:307 clear() 调 redis.flushdb()，把 search/crawl/llm/semantic-answer
 * 共库的其他命名空间一并清掉。
 * 修复：Redis 侧改为 SCAN+DEL 按本模块 key 前缀（<namespace>:*）删除；本地内存 clear 不变。
 *
 * 注：RedisClient.deleteByPattern 的真实 RESP 解析另有一条端到端小测试（伪造 Bun.connect 流）。
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Cache } from "../src/utils/cache.js";

/** 模拟 RedisClient 侧语义：deleteByPattern 自动附加 keyPrefix "axiom:" 后匹配删除 */
class FakeRedis {
  store = new Map<string, string>();
  flushdbCalls = 0;
  patterns: string[] = [];

  async set(_key: string, _value: string, _ttl?: number): Promise<void> {}
  async get(_key: string): Promise<string | null> {
    return null;
  }
  async del(_key: string): Promise<void> {}

  async flushdb(): Promise<void> {
    this.flushdbCalls++;
    this.store.clear();
  }

  async deleteByPattern(pattern: string): Promise<number> {
    this.patterns.push(pattern);
    const full = `axiom:${pattern}`;
    const re = new RegExp(
      "^" + full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*") + "$",
    );
    let deleted = 0;
    for (const k of [...this.store.keys()]) {
      if (re.test(k)) {
        this.store.delete(k);
        deleted++;
      }
    }
    return deleted;
  }
}

function makeCacheWithRedis(ns: string, redis: FakeRedis): Cache<unknown> {
  const cache = new Cache<unknown>({ namespace: ns, redis: false, persistent: false });
  (cache as unknown as { redis: FakeRedis }).redis = redis;
  (cache as unknown as { redisReady: boolean }).redisReady = true;
  return cache;
}

afterEach(() => {
  delete process.env.REDIS_URL;
});

describe("Cache.clear 命名空间化（B3-Medium）", () => {
  it("clear 仅删本命名空间的 redis key，不 flushdb 波及其他命名空间", async () => {
    const redis = new FakeRedis();
    redis.store.set("axiom:nsa:k1", "va");
    redis.store.set("axiom:nsb:k1", "vb"); // 另一个模块（如 llm/search）的 key
    const cacheA = makeCacheWithRedis("nsa", redis);

    cacheA.clear();

    expect(redis.flushdbCalls).toBe(0); // 修复前：flushdb 全库清空
    expect(redis.patterns).toEqual(["nsa:*"]); // 修复后：按本模块前缀删除
    expect(redis.store.has("axiom:nsa:k1")).toBe(false);
    expect(redis.store.has("axiom:nsb:k1")).toBe(true); // 修复前：被 flushdb 一并清掉
  });

  it("本地内存清空行为保持不变", () => {
    const redis = new FakeRedis();
    const cacheA = makeCacheWithRedis("nsa", redis);
    cacheA.set("mem-key", "v");
    expect(cacheA.getSync("mem-key")).toBe("v");
    cacheA.clear();
    expect(cacheA.getSync("mem-key")).toBeUndefined();
  });
});

describe("RedisClient.deleteByPattern（真实 RESP 路径，伪造 socket）", () => {
  it("SCAN 游标 + DEL 仅匹配 key；MATCH 模式自动附加 keyPrefix", async () => {
    const origConnect = Bun.connect;
    let handlers: { data?: (s: unknown, d: Uint8Array) => void; open?: (s: unknown) => void } | null = null;
    let written: string[] = [];
    (Bun as unknown as { connect: unknown }).connect = (opts: { socket: typeof handlers }) => {
      handlers = opts.socket;
      const fake = {
        write(d: string) {
          written.push(d);
          return true;
        },
        end() {},
      };
      queueMicrotask(() => handlers!.open!(fake));
      return Promise.resolve(fake);
    };
    try {
      const { RedisClient } = await import("../src/utils/redis-client.js");
      const client = await RedisClient.connect("redis://127.0.0.1:6399");
      const p = client!.deleteByPattern("nsa:*");
      await new Promise((r) => setTimeout(r, 10));
      // SCAN 应答：cursor "0" + keys ["axiom:nsa:k1"]（$12 = len("axiom:nsa:k1")）
      handlers!.data!(null, new TextEncoder().encode("*2\r\n$1\r\n0\r\n*1\r\n$12\r\naxiom:nsa:k1\r\n"));
      await new Promise((r) => setTimeout(r, 10));
      // DEL 应答：删除 1 个
      handlers!.data!(null, new TextEncoder().encode(":1\r\n"));
      expect(await p).toBe(1);
      const wire = written.join("");
      expect(wire).toContain("MATCH");
      expect(wire).toContain("axiom:nsa:*"); // keyPrefix 已附加到 pattern
      expect(wire).toContain("DEL");
    } finally {
      Bun.connect = origConnect;
    }
  });
});
