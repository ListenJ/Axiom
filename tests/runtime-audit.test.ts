/**
 * 运行时审查机制测试 — runtime-audit
 *
 * 验证：
 *  - 默认依赖下 13 项检查全部可运行、不抛错、字段齐全
 *  - 注入"泄漏 fake"时对应检查能抓出 fail（证明机制有效）
 *  - 注入正常 fake 时为 pass
 *  - package.json 暴露 audit:runtime 脚本
 */
import { describe, it, expect } from "bun:test";
import { runRuntimeAudit, type AuditDeps } from "../src/core/runtime-audit.js";
import { Cache } from "../src/utils/cache.js";
import { readFileSync } from "node:fs";

describe("运行时审查机制", () => {
  it("默认依赖下返回完整 14 项检查且不抛错", async () => {
    const report = await runRuntimeAudit();
    expect(report.checks.length).toBe(14);
    for (const check of report.checks) {
      expect(typeof check.id).toBe("string");
      expect(check.id.length).toBeGreaterThan(0);
      expect(typeof check.name).toBe("string");
      expect(["pass", "warn", "fail"]).toContain(check.status);
      expect(typeof check.detail).toBe("string");
    }
    expect(["pass", "warn", "fail"]).toContain(report.overall);
    expect(Array.isArray(report.summary)).toBe(true);
  });

  it("注入泄漏 fake cache → cache.bounded 检查为 fail（机制能抓泄漏）", async () => {
    // fake cache：set 不遵守 maxSize（store 无限增长）→ 应被抓出
    let leaked = 0;
    const leakingCache = {
      stats: () => ({ size: leaked, hits: 0, misses: 0, hitRate: 0, redisHits: 0, redisMisses: 0, redisHitRate: 0, redisConnected: false }),
      set: () => { leaked++; },
      getSync: () => undefined,
      get: async () => undefined,
      delete: () => {},
      clear: () => {},
      destroy: () => {},
    };
    const deps: AuditDeps = {
      cacheFactory: () => leakingCache as unknown as Cache<unknown>,
    };
    const report = await runRuntimeAudit(deps);
    const bounded = report.checks.find((c) => c.id === "cache.bounded");
    expect(bounded).toBeDefined();
    expect(bounded!.status).toBe("fail");
  });

  it("注入正常 fake cache → cache.bounded 为 pass", async () => {
    const okCache = {
      stats: () => ({ size: 100, hits: 0, misses: 0, hitRate: 0, redisHits: 0, redisMisses: 0, redisHitRate: 0, redisConnected: false }),
      set: () => {},
      getSync: () => undefined,
      get: async () => undefined,
      delete: () => {},
      clear: () => {},
      destroy: () => {},
    };
    const deps: AuditDeps = {
      cacheFactory: () => okCache as unknown as Cache<unknown>,
    };
    const report = await runRuntimeAudit(deps);
    const bounded = report.checks.find((c) => c.id === "cache.bounded");
    expect(bounded!.status).toBe("pass");
  });

  it("注入泄漏 fake eventBus → eventbus.subscribers 为 fail", async () => {
    let subCount = 0;
    const leakingBus = {
      subscribe: () => { subCount++; return "id"; },
      unsubscribe: () => {}, // 不删除 → 泄漏
      getStats: () => ({ published: 0, handled: 0, errors: 0, subscriberCount: subCount }),
      publish: () => {},
      getRecentEvents: () => [],
    };
    const deps: AuditDeps = {
      eventBus: leakingBus as unknown as Parameters<typeof runRuntimeAudit>[0] extends { eventBus: infer T } ? T : never,
    };
    const report = await runRuntimeAudit(deps);
    const subs = report.checks.find((c) => c.id === "eventbus.subscribers");
    expect(subs).toBeDefined();
    expect(subs!.status).toBe("fail");
  });

  it("资源边界检查包含 MAX_BODY_SIZE 与 WS 客户端上限", async () => {
    const report = await runRuntimeAudit({});
    const bounds = report.checks.find((c) => c.id === "resources.bounds");
    expect(bounds).toBeDefined();
    expect(bounds!.status).not.toBe("fail");
    const measured = bounds!.measured as Record<string, unknown> | undefined;
    expect(measured).toBeDefined();
    expect((measured!.maxBodySize as number) ?? 0).toBeGreaterThan(0);
  });

  it("package.json 暴露 audit:runtime 脚本", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["audit:runtime"]).toBe("bun run scripts/runtime-audit.ts");
  });
});