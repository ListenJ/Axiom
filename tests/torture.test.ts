/**
 * Chaos torture tests
 */
import { describe, it, expect } from "bun:test";

function rand(max: number): number { return Math.floor(Math.random() * max); }
function randStr(len: number): string {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({length: len}, () => c[rand(c.length)]).join("");
}

// 1. Cache
describe("Chaos Cache", () => {
  it("Monte Carlo 10K ops data integrity", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 100, defaultTtlMs: 60000, redis: false });
    const ref = new Map<string, number>();
    for (let op = 0; op < 10000; op++) {
      const key = `k${rand(200)}`;
      const choice = rand(5);
      if (choice === 0) { c.set(key, op); ref.set(key, op); }
      else if (choice === 1) {
        const got = c.getSync(key);
        const exp = ref.get(key);
        if (got !== undefined && exp !== undefined) expect(got).toBe(exp);
      }
      else if (choice === 2) { c.delete(key); ref.delete(key); }
      else if (choice === 3) { await c.getOrSet(key, async () => op); if (!ref.has(key)) ref.set(key, op); }
      else { c.clear(); ref.clear(); }
    }
    for (const [k, v] of ref) {
      const got = c.getSync(k);
      if (got !== undefined) expect(got).toBe(v);
    }
  }, 30000);

  it("Edge cases: 0 cap / neg TTL / long key", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    // cap=0: second insert evicts first
    const c0 = new Cache({ maxSize: 0, defaultTtlMs: 60000, redis: false });
    c0.set("a", 1);
    c0.set("b", 2);
    expect(c0.getSync("a")).toBeUndefined();
    expect(c0.getSync("b")).toBe(2);
    // TTL=0: expire immediately (next tick to avoid same-ms race)
    const c1 = new Cache({ maxSize: 10, defaultTtlMs: 0, redis: false });
    c1.set("x", "val", 0);
    await new Promise(r => setTimeout(r, 5));
    expect(c1.getSync("x")).toBeUndefined();
    // 10K key
    const c2 = new Cache({ maxSize: 10, redis: false } as any);
    c2.set("x".repeat(10000), "long");
    expect(c2.getSync("x".repeat(10000))).toBe("long");
  });

  it("100 concurrent reads hot key", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 10, defaultTtlMs: 60000, redis: false });
    c.set("hot", "val");
    const r = await Promise.all(Array.from({ length: 100 }, () => c.get("hot")));
    expect(r.every(x => x === "val")).toBeTrue();
  });

  it("1000 concurrent dedup", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 10, defaultTtlMs: 60000, redis: false });
    let n = 0;
    const f = async () => { n++; await new Promise(r => setTimeout(r, 5)); return "v"; };
    const r = await Promise.all(Array.from({ length: 1000 }, () => c.getOrSet("dedup-key", f)));
    expect(n).toBe(1);
    expect(r.every(x => x === "v")).toBeTrue();
  });

  it("Race: 5K concurrent set/get/delete", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 100, defaultTtlMs: 60000, redis: false });
    await Promise.all(Array.from({ length: 5000 }, (_, i) =>
      i % 3 === 0 ? c.set("race", i) : i % 3 === 1 ? Promise.resolve(c.getSync("race")) : c.delete("race")
    ));
  });
});

// 2. Router
describe("Chaos Router", () => {
  it("100K routes + 5K random match", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const r = new HttpRouter({ cacheMaxSize: 50000 } as any);
    const t0 = performance.now();
    for (let i = 0; i < 100000; i++) {
      r.register({
        method: i % 2 === 0 ? "GET" : "POST",
        path: `/v${rand(10)}/r/${i}/${randStr(6)}`,
        handler: async () => new Response("ok"),
      });
    }
    console.log(`  100K reg: ${(performance.now() - t0).toFixed(0)}ms`);
    const t1 = performance.now();
    for (let i = 0; i < 5000; i++) {
      const p = `/v${rand(10)}/r/${rand(100000)}/${randStr(6)}`;
      const ctx: any = {
        url: new URL(`http://h${p}`), req: new Request(`http://h${p}`),
        vault: null, db: null, pipeline: null, healthMonitor: null,
        fileWatcher: null, startupTime: 0, baseHeaders: {},
        jsonResponse: (d: any) => d,
      };
      await r.execute(ctx).catch(() => null);
    }
    console.log(`  5K rand match: ${(performance.now() - t1).toFixed(0)}ms`);
  }, 60000);

  it("Long path 10K chars", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const r = new HttpRouter({ cacheMaxSize: 100 } as any);
    const p = "/" + "x".repeat(10000);
    r.register({ method: "GET", path: p, handler: async () => new Response("ok") });
    const ctx: any = {
      url: new URL(`http://h${p}`), req: new Request(`http://h${p}`),
      vault: null, db: null, pipeline: null, healthMonitor: null,
      fileWatcher: null, startupTime: 0, baseHeaders: {},
      jsonResponse: (d: any) => d,
    };
    const res = await r.execute(ctx);
    expect(res).not.toBeNull();
  }, 10000);
});

// 3. Thompson
describe("Chaos Thompson", () => {
  it("100 arms x 500 routes", async () => {
    const mod = await import("../src/router/thompson-router.js");
    const arms = Array.from({ length: 100 }, (_, i) => ({
      id: `a${i}`, model: `m${i}`, provider: "p",
      alpha: Math.max(1, 100 - i), beta: Math.max(1, i), metadata: {},
    }));
    const ts = mod.createThompsonRouter({ arms, minSamples: 5, inMemory: true });
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 500 }, () => ts.route({ taskType: "chat", inputLength: 500 })));
    console.log(`  100a x 500r: ${(performance.now() - t0).toFixed(0)}ms`);
    expect(ts.getArmStats().length).toBe(100);
  }, 30000);

  it("1M feedback loop", () => {
    const mod = require("../src/router/thompson-router.js");
    const ts = mod.createThompsonRouter({
      arms: [{ id:"g", model:"g", provider:"p", alpha:100, beta:10, metadata:{} }, { id:"b", model:"b", provider:"p", alpha:10, beta:100, metadata:{} }],
      minSamples: 0, inMemory: true,
    });
    const t0 = performance.now();
    for (let i = 0; i < 1_000_000; i++) ts.reportFeedback(i % 10 === 0 ? "b" : "g", i % 7 !== 0);
    console.log(`  1M fb: ${(performance.now() - t0).toFixed(0)}ms`);
    const s = ts.getArmStats();
    expect(s.find(x => x.id === "g")!.mean).toBeGreaterThan(s.find(x => x.id === "b")!.mean);
  }, 30000);

  it("decayFactor=0 no crash", () => {
    const mod = require("../src/router/thompson-router.js");
    const ts = mod.createThompsonRouter({
      arms: [{ id:"x", model:"x", provider:"p", alpha:1, beta:1, metadata:{} }],
      minSamples: 0, inMemory: true, decayFactor: 0,
    });
    ts.reportFeedback("x", true);
    ts.reportFeedback("x", false);
    expect(ts.getArmStats()[0].samples).toBeGreaterThan(0);
  });
});

// 4. VIB
describe("Chaos VIB", () => {
  it("Fuzz: empty/huge/unicode/special", async () => {
    const mod = await import("../src/memory/vib-compressor.js");
    const c = new mod.VIBCompressor({ capacity: 50 });
    const items = [
      { id:"e", content:"", timestamp:Date.now(), source:"t" },
      { id:"ws", content:"   \t\n  ", timestamp:Date.now(), source:"t" },
      { id:"s", content:"x", timestamp:Date.now(), source:"t" },
      { id:"u", content:"你好世界🌍🎉unicode", timestamp:Date.now(), source:"t" },
      { id:"big", content:"x".repeat(100000), timestamp:Date.now(), source:"t" },
      { id:"rpt", content:"a a a a a ".repeat(1000), timestamp:Date.now(), source:"t" },
      { id:"sym", content:"!@#$%^&*()_+{}|:\"<>?~`-=[]\\;',./", timestamp:Date.now(), source:"t" },
    ];
    const r = await c.compress(items);
    expect(r.retained.length + r.discarded.length).toBe(items.length);
  }, 15000);

  it("Determinism: same input same output", async () => {
    const mod = await import("../src/memory/vib-compressor.js");
    const items = [
      { id:"a", content:"the cat sat on the mat", timestamp:1000, source:"t" },
      { id:"b", content:"the dog runs in the park", timestamp:1001, source:"t" },
      { id:"c", content:"quantum entanglement is weird", timestamp:1002, source:"t" },
    ];
    const bg = ["existing known facts about the world"];
    const r1 = await (new mod.VIBCompressor({ capacity:2, existingMemory:bg })).compress(items);
    const r2 = await (new mod.VIBCompressor({ capacity:2, existingMemory:bg })).compress(items);
    expect(r1.retained.map(x=>x.id).sort()).toEqual(r2.retained.map(x=>x.id).sort());
  });
});

// 5. Concurrency
describe("Chaos Concurrency", () => {
  it("All three components race 500 workers", async () => {
    const [mC, mT, mR] = await Promise.all([
      import("../src/utils/cache.js"), import("../src/router/thompson-router.js"), import("../src/core/http-router.js"),
    ]);
    const cache = new mC.Cache({ maxSize:100, defaultTtlMs:60000, redis:false });
    const ts = mT.createThompsonRouter({
      arms: Array.from({length:5},(_,i)=>({id:`a${i}`,model:`m${i}`,provider:"p",alpha:10-i,beta:1+i,metadata:{}})),
      minSamples:3, inMemory:true,
    });
    const hr = new mR.HttpRouter({ cacheMaxSize:100 } as any);
    for (let i = 0; i < 10; i++) hr.register({ method:"GET", path:`/e/${i}`, handler:async()=>new Response("ok") });

    await Promise.all(Array.from({ length: 500 }, async (_, i) => {
      for (let j = 0; j < 5; j++) {
        const choice = rand(3);
        if (choice === 0) { cache.set(`s${i}-${j}`, i); cache.getSync(`s${(i+1)%500}-${j}`); }
        else if (choice === 1) { await ts.route({ taskType:["chat","code","math"][rand(3)], inputLength:rand(10000) }); }
        else {
          const ctx: any = {
            url:new URL(`http://h/e/${rand(10)}`), req:new Request(`http://h/e/${rand(10)}`),
            vault:null, db:null, pipeline:null, healthMonitor:null,
            fileWatcher:null, startupTime:0, baseHeaders:{}, jsonResponse:(d:any)=>d,
          };
          await hr.execute(ctx).catch(() => null);
        }
      }
    }));
  }, 30000);

  it("1000 getOrSet random keys", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize:10, defaultTtlMs:60000, redis:false });
    const r = await Promise.all(Array.from({ length: 1000 }, (_, i) =>
      c.getOrSet(`async-${rand(50)}`, async () => {
        await new Promise(x => setTimeout(x, rand(5)));
        return { worker: i, ok: true };
      })
    ));
    expect(r.length).toBe(1000);
    r.forEach(x => expect(x.ok).toBeTrue());
  }, 15000);
});
