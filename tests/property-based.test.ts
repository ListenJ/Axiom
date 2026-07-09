/**
 * Property-based tests + extreme scenarios
 */
import { describe, it, expect } from "bun:test";

function rand(max: number): number { return Math.floor(Math.random() * max); }
function randStr(len: number): string {
  const c = "abcdefghij0123456789";
  return Array.from({length: len}, () => c[rand(c.length)]).join("");
}

// 1. Cache invariants
describe("PBT Cache", () => {
  it("INV1: set->get returns same value", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 1000, defaultTtlMs: 60000, redis: false });
    for (let i = 0; i < 1000; i++) {
      c.set(`k${i}`, { index: i, data: randStr(20) });
      expect((c.getSync(`k${i}`) as any).index).toBe(i);
    }
  });

  it("INV2: capacity never exceeded", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 50, defaultTtlMs: 60000, redis: false });
    for (let i = 0; i < 10000; i++) c.set(`k${i % 200}`, i);
    expect(c.stats().size).toBeLessThanOrEqual(50);
  });

  it("INV3: LRU keeps recent entries", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 10, defaultTtlMs: 60000, redis: false });
    for (let i = 0; i < 10; i++) c.set(`k${i}`, i);
    for (let i = 0; i < 100; i++) c.getSync("k0");
    for (let i = 10; i < 15; i++) c.set(`k${i}`, i);
    expect(c.getSync("k0")).toBe(0);
  });

  it("INV4: delete removes entry", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 100, redis: false } as any);
    c.set("temp", "val");
    expect(c.getSync("temp")).toBe("val");
    c.delete("temp");
    expect(c.getSync("temp")).toBeUndefined();
  });

  it("INV5: 1000 concurrent sets same key", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 100, defaultTtlMs: 60000, redis: false });
    await Promise.all(Array.from({ length: 1000 }, (_, i) => c.set("concurrent-key", { thread: i })));
    expect(c.getSync("concurrent-key")).toBeDefined();
  });

  it("INV6: getOrSet only calls factory once", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 10, defaultTtlMs: 60000, redis: false });
    let count = 0;
    const factory = async () => { count++; await new Promise(r => setTimeout(r, rand(10))); return { ok: true }; };
    const results = await Promise.all(Array.from({ length: 500 }, () => c.getOrSet("atomic", factory)));
    expect(count).toBe(1);
    expect(results.length).toBe(500);
  }, 15000);

  it("INV7: TTL expires entry", async done => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 10, defaultTtlMs: 20000, redis: false });
    c.set("ttl", "val", 10);
    expect(c.getSync("ttl")).toBe("val");
    setTimeout(() => {
      expect(c.getSync("ttl")).toBeUndefined();
      done();
    }, 50);
  });

  it("INV8: clear empties store", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 100, redis: false } as any);
    for (let i = 0; i < 50; i++) c.set(`x${i}`, i);
    c.clear();
    expect(c.stats().size).toBe(0);
  });

  it("INV9: double delete no error", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 10, redis: false } as any);
    c.set("a", 1);
    c.delete("a");
    c.delete("a");
    c.delete("nonexistent");
  });
});

// 2. Thompson invariants
describe("PBT Thompson", () => {
  it("INV1: route always returns valid arm", async () => {
    const { createThompsonRouter } = await import("../src/router/thompson-router.js");
    const r = createThompsonRouter({ arms: Array.from({length:5},(_,i)=>({id:`a${i}`,model:`m${i}`,provider:"p",alpha:1+i,beta:1,metadata:{}})), minSamples: 0, inMemory: true });
    for (let i = 0; i < 100; i++) {
      const d = await r.route({ taskType: "chat", inputLength: rand(10000) });
      expect(d.arm.id).toMatch(/^a[0-4]$/);
      expect(d.confidence).toBeGreaterThanOrEqual(0);
      expect(d.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("INV2: 0 < mean < 1", async () => {
    const { createThompsonRouter } = await import("../src/router/thompson-router.js");
    const r = createThompsonRouter({ arms: [
      { id: "h", model: "h", provider: "p", alpha: 1000, beta: 1, metadata: {} },
      { id: "l", model: "l", provider: "p", alpha: 1, beta: 1000, metadata: {} },
      { id: "m", model: "m", provider: "p", alpha: 500, beta: 500, metadata: {} },
    ], minSamples: 0, inMemory: true });
    const s = r.getArmStats();
    expect(s.find(x => x.id === "h")!.mean).toBeGreaterThan(0.9);
    expect(s.find(x => x.id === "l")!.mean).toBeLessThan(0.1);
    expect(s.find(x => x.id === "m")!.mean).toBeCloseTo(0.5, 1);
  });

  it("INV3: convergence - good arm wins", async () => {
    const { createThompsonRouter } = await import("../src/router/thompson-router.js");
    const r = createThompsonRouter({ arms: [
      { id: "good", model: "g", provider: "p", alpha: 1, beta: 1, metadata: {} },
      { id: "bad", model: "b", provider: "p", alpha: 1, beta: 1, metadata: {} },
    ], minSamples: 0, inMemory: true });
    for (let i = 0; i < 500; i++) {
      r.reportFeedback("good", Math.random() > 0.1);
      r.reportFeedback("bad", Math.random() > 0.9);
    }
    let wins = 0;
    for (let i = 0; i < 50; i++) {
      const d = await r.route({ taskType: "chat", inputLength: 100 });
      if (d.arm.id === "good") wins++;
    }
    expect(wins).toBeGreaterThan(25);
  }, 15000);

  it("INV4: extreme alpha/beta no NaN", async () => {
    const { createThompsonRouter } = await import("../src/router/thompson-router.js");
    const r = createThompsonRouter({ arms: [
      { id: "e1", model: "e", provider: "p", alpha: 1e9, beta: 1, metadata: {} },
      { id: "e2", model: "e", provider: "p", alpha: 1, beta: 1e9, metadata: {} },
    ], minSamples: 0, inMemory: true });
    r.getArmStats().forEach(x => {
      expect(isNaN(x.mean)).toBeFalse();
      expect(isFinite(x.mean)).toBeTrue();
    });
  });
});

// 3. HttpRouter invariants
describe("PBT HttpRouter", () => {
  it("INV1: registered paths match", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const r = new HttpRouter({ redis: false } as any);
    const paths: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const p = `/a/v${rand(10)}/r/${randStr(8)}/${i}`;
      paths.push(p);
      r.register({ method: "GET", path: p, handler: async () => new Response("ok") });
    }
    for (const p of paths) {
      const ctx: any = { url: new URL(`http://h${p}`), req: new Request(`http://h${p}`), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d: any) => d };
      const res = await r.execute(ctx);
      expect(res).not.toBeNull();
    }
  }, 30000);

  it("INV2: unknown paths return null", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const r = new HttpRouter({ cacheMaxSize: 100 } as any);
    r.register({ method: "GET", path: "/real", handler: async () => new Response("ok") });
    for (const p of ["/nope", "/real/nested", "/unknown"]) {
      const ctx: any = { url: new URL(`http://h${p}`), req: new Request(`http://h${p}`), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d: any) => d };
      expect(await r.execute(ctx)).toBeNull();
    }
  });
});

// 4. Soak test
describe("SOAK", () => {
  it("Cache+Router+TS 5000 iterations", async () => {
    const [mC, mR, mT] = await Promise.all([import("../src/utils/cache.js"), import("../src/core/http-router.js"), import("../src/router/thompson-router.js")]);
    const cache = new mC.Cache({ maxSize: 100, defaultTtlMs: 60000, redis: false });
    const router = new mR.HttpRouter({ redis: false } as any);
    const ts = mT.createThompsonRouter({ arms: Array.from({length:5},(_,i)=>({id:`a${i}`,model:`m${i}`,provider:"p",alpha:10-i,beta:1+i,metadata:{}})), minSamples: 3, inMemory: true });
    for (let i = 0; i < 10; i++) router.register({ method: "GET", path: `/e/${i}`, handler: async () => new Response("ok") });

    const t0 = performance.now();
    for (let it = 0; it < 5000; it++) {
      cache.set(`s${rand(50)}`, { it });
      if (it % 2 === 0) cache.getSync(`s${rand(50)}`);
      if (it % 5 === 0) {
        const ctx: any = { url: new URL(`http://h/e/${rand(10)}`), req: new Request(`http://h/e/${rand(10)}`), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d: any) => d };
        await router.execute(ctx).catch(() => null);
      }
      if (it % 3 === 0) {
        const d = await ts.route({ taskType: ["chat","code","math"][rand(3)], inputLength: rand(1000) });
        ts.reportFeedback(d.arm.id, rand(5) !== 0);
      }
    }
    console.log(`  5000 iter: ${(performance.now()-t0).toFixed(0)}ms`);
  }, 60000);
});

