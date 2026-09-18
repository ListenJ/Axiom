/**
 * 语义答案缓存 + 默认确定性温度测试
 *
 * 覆盖：
 *   - defaultTemperatureForRole：确定性角色默认 0，其余 undefined（保持现状 0.7）
 *   - semanticCacheKey：归一化后不同措辞同 key，不同意图隔离
 *   - cacheFirstRoute/writeCache：写入后可命中；SEMANTIC_CACHE_ENABLED=0 关闭
 */
import { describe, it, expect, afterEach } from "bun:test";
import { defaultTemperatureForRole } from "../src/router/reasoning-effort.js";
import { cacheFirstRoute, writeCache, semanticCacheKey, isSemanticCacheEnabled } from "../src/services/cache-router.js";
import { semanticAnswerCache } from "../src/utils/cache.js";

afterEach(() => {
  semanticAnswerCache.clear();
  delete process.env.SEMANTIC_CACHE_ENABLED;
});

describe("defaultTemperatureForRole", () => {
  it("确定性角色默认 0", () => {
    expect(defaultTemperatureForRole("english")).toBe(0);
    expect(defaultTemperatureForRole("translation")).toBe(0);
    expect(defaultTemperatureForRole("localization")).toBe(0);
    expect(defaultTemperatureForRole("evaluation")).toBe(0);
  });
  it("非确定性角色返回 undefined（保持 provider 默认）", () => {
    expect(defaultTemperatureForRole("general-chat")).toBeUndefined();
    expect(defaultTemperatureForRole("code-generation")).toBeUndefined();
    expect(defaultTemperatureForRole("research")).toBeUndefined();
  });
});

describe("semanticCacheKey", () => {
  it("归一化：不同措辞同 key，不同意图隔离", () => {
    expect(semanticCacheKey("What is the capital of France?", "english"))
      .toBe(semanticCacheKey("CAPITAL OF FRANCE", "english"));
    expect(semanticCacheKey("What is the capital of France?", "english"))
      .not.toBe(semanticCacheKey("What is the capital of France?", "translation"));
  });
});

describe("cacheFirstRoute / writeCache", () => {
  it("写入后相同语义命中，返回 fromCache=true", async () => {
    writeCache("What is the capital of France?", "english", "Paris");
    const hit = await cacheFirstRoute("CAPITAL OF FRANCE", "english");
    expect(hit).not.toBeNull();
    expect(hit?.answer).toBe("Paris");
    expect(hit?.fromCache).toBe(true);
  });

  it("未写入时 miss；不同意图 miss", async () => {
    expect(await cacheFirstRoute("What is Rust?", "english")).toBeNull();
    writeCache("What is Rust?", "english", "systems language");
    expect(await cacheFirstRoute("What is Rust?", "translation")).toBeNull();
  });

  it("SEMANTIC_CACHE_ENABLED=0 时关闭（写入与读取都无效）", async () => {
    process.env.SEMANTIC_CACHE_ENABLED = "0";
    expect(isSemanticCacheEnabled()).toBe(false);
    writeCache("hello world", "english", "hi");
    expect(await cacheFirstRoute("hello world", "english")).toBeNull();
  });
});
