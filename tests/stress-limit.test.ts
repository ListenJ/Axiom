/**
 * 极限压力测试
 */
import { describe, it, expect } from "bun:test";

function fmtOps(n: number, ms: number): string {
  const o = n / (ms / 1000);
  return o > 1_000_000 ? `${(o/1_000_000).toFixed(1)}M/s` : o > 1000 ? `${(o/1000).toFixed(1)}K/s` : `${o.toFixed(0)}/s`;
}

describe("Router", () => {
  it("10K routes + 1K concurrent", async () => {
    const mod = await import("../src/core/http-router.js");
    const r = new mod.HttpRouter({ cacheMaxSize: 5000 } as any);
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++)
      r.register({ method: "GET", path: `/a/${i}`, handler: async () => new Response("ok") });
    console.log(`  reg: ${(performance.now()-t0).toFixed(0)}ms`);
    const t1 = performance.now();
    const res = await Promise.all(Array.from({length:1000}, (_,i) => {
      const ctx: any = { url: new URL(`http://h/a/${i}`), req: new Request(`http://h/a/${i}`), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d:any)=>d };
      return r.execute(ctx).catch(() => null);
    }));
    console.log(`  match: ${(performance.now()-t1).toFixed(0)}ms hit=${res.filter(Boolean).length}`);
    expect(res.filter(Boolean).length).toBe(1000);
  }, 30000);

  it("100 depth x 1K", async () => {
    const mod = await import("../src/core/http-router.js");
    const r = new mod.HttpRouter({ cacheMaxSize: 1000 } as any);
    const p = "/"+"a/".repeat(100).slice(0,-1);
    r.register({ method: "GET", path: p, handler: async () => new Response("ok") });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const ctx: any = { url: new URL(`http://h${p}`), req: new Request(`http://h${p}`), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d:any)=>d };
      await r.execute(ctx);
    }
    console.log(`  depth: ${(performance.now()-t0).toFixed(0)}ms`);
  }, 10000);
});

describe("Cache", () => {
  it("100K ops", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 1000, defaultTtlMs: 60000, redis: false });
    const t0 = performance.now();
    for (let i = 0; i < 100000; i++) { c.set(`k${i%2000}`, i); if (i%2===0) c.getSync(`k${(i-1)%2000}`); }
    console.log(`  100K: ${(performance.now()-t0).toFixed(0)}ms size=${c.stats().size}`);
  }, 30000);

  it("1K concurrent dedup", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 100, defaultTtlMs: 60000, redis: false });
    let n = 0;
    const f = async () => { n++; await new Promise(x => setTimeout(x,50)); return "v"; };
    const t0 = performance.now();
    await Promise.all(Array.from({length:1000}, () => c.getOrSet("hot", f)));
    console.log(`  dedup: ${(performance.now()-t0).toFixed(0)}ms factory=${n}`);
    expect(n).toBe(1);
  }, 15000);

  it("500K x 1KB", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 500000, defaultTtlMs: 60000, redis: false });
    const t0 = performance.now();
    for (let i = 0; i < 500000; i++) c.set(`b${i}`, { i, p: "x".repeat(1024) });
    console.log(`  500K: ${(performance.now()-t0).toFixed(0)}ms size=${c.stats().size}`);
    expect(c.stats().size).toBe(500000);
  }, 60000);

  it("1M ops", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 5000, defaultTtlMs: 60000, redis: false });
    const t0 = performance.now();
    for (let i = 0; i < 1_000_000; i++) c.set(`m${i%10000}`, i);
    const e = performance.now() - t0;
    console.log(`  1M: ${e.toFixed(0)}ms (${fmtOps(1_000_000, e)})`);
    expect(e).toBeLessThan(10000);
  }, 30000);
});

describe("Thompson", () => {
  it("10K routes", async () => {
    const mod = await import("../src/router/thompson-router.js");
    const r = mod.createThompsonRouter({ arms: Array.from({length:10},(_,i)=>({id:`m${i}`,model:`m${i}`,provider:"p",alpha:1+i*3,beta:1+(9-i)*2,metadata:{}})), minSamples: 3, inMemory: true });
    const t0 = performance.now();
    const res = await Promise.all(Array.from({length:10000}, (_,i) => r.route({ taskType: "chat", inputLength: i%1000 })));
    console.log(`  10K: ${(performance.now()-t0).toFixed(0)}ms`);
    expect(res.length).toBe(10000);
  }, 30000);

  it("100K feedback", async () => {
    const mod = await import("../src/router/thompson-router.js");
    const r = mod.createThompsonRouter({ arms: [{id:"g",model:"g",provider:"p",alpha:100,beta:10,metadata:{}},{id:"b",model:"b",provider:"p",alpha:10,beta:100,metadata:{}}], minSamples: 0, inMemory: true });
    const t0 = performance.now();
    for (let i = 0; i < 100000; i++) r.reportFeedback(i%10===0?"b":"g", i%7!==0);
    const s = r.getArmStats();
    console.log(`  100K fb: ${(performance.now()-t0).toFixed(0)}ms`);
    expect(s.find(x=>x.id==="g")!.mean).toBeGreaterThan(s.find(x=>x.id==="b")!.mean);
  }, 30000);

  it("50 arms x 1K", async () => {
    const mod = await import("../src/router/thompson-router.js");
    const r = mod.createThompsonRouter({ arms: Array.from({length:50},(_,i)=>({id:`a${i}`,model:`m${i}`,provider:"p",alpha:1+i,beta:1,metadata:{}})), minSamples: 5, inMemory: true });
    const t0 = performance.now();
    await Promise.all(Array.from({length:1000}, () => r.route({ taskType: "chat", inputLength: 500 })));
    console.log(`  50x1K: ${(performance.now()-t0).toFixed(0)}ms`);
  }, 15000);
});

describe("VIB", () => {
  it("10K items", async () => {
    const mod = await import("../src/memory/vib-compressor.js");
    const c = new mod.VIBCompressor({ capacity: 500, existingMemory: Array.from({length:100},(_,i)=>`b${i} x `.repeat(i%10+1)) });
    const items = Array.from({length:10000}, (_,i) => ({ id:`m${i}`, content:`item ${i} `.repeat((i%50)+1)+"uniq", timestamp: Date.now()+i, source:"t" }));
    const t0 = performance.now();
    const r = await c.compress(items);
    console.log(`  10K: ${(performance.now()-t0).toFixed(0)}ms kept=${r.retained.length}`);
    expect(r.retained.length).toBe(500);
  }, 30000);

  it("1MB text", async () => {
    const mod = await import("../src/memory/vib-compressor.js");
    const c = new mod.VIBCompressor({ capacity: 10 });
    const r = await c.compress([{ id:"h", content:"uniq"+"x".repeat(1_000_000)+"end", timestamp: Date.now(), source:"t" }, { id:"s", content:"short uniq", timestamp: Date.now(), source:"t" }]);
    console.log(`  1MB: kept=${r.retained.length}`);
  }, 60000);
});

describe("Mixed", () => {
  it("1K combined load", async () => {
    const [mR,mC,mT] = await Promise.all([import("../src/core/http-router.js"), import("../src/utils/cache.js"), import("../src/router/thompson-router.js")]);
    const hr = new mR.HttpRouter({ cacheMaxSize: 100 } as any);
    for (let i = 0; i < 100; i++) hr.register({ method: "GET", path: `/e/${i}`, handler: async () => new Response("ok") });
    const cache = new mC.Cache({ maxSize: 1000, defaultTtlMs: 60000, redis: false });
    const ts = mT.createThompsonRouter({ arms: Array.from({length:5},(_,i)=>({id:`a${i}`,model:`m${i}`,provider:"p",alpha:10-i,beta:1+i,metadata:{}})), minSamples: 0, inMemory: true });
    const t0 = performance.now();
    await Promise.all(Array.from({length:1000}, async (_,i) => {
      const ctx: any = { url: new URL(`http://h/e/${i%100}`), req: new Request(`http://h/e/${i%100}`), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d:any)=>d };
      await Promise.all([hr.execute(ctx), cache.set(`m${i}`, i), ts.route({ taskType: "chat", inputLength: i })]);
    }));
    console.log(`  mixed: ${(performance.now()-t0).toFixed(0)}ms`);
  }, 30000);
});

describe("Memory", () => {
  it("100 rounds create/destroy", async () => {
    const mC = await import("../src/utils/cache.js");
    const mV = await import("../src/memory/vib-compressor.js");
    const t0 = performance.now();
    for (let r = 0; r < 100; r++) {
      const c = new mC.Cache({ maxSize: 10000, defaultTtlMs: 100, redis: false });
      for (let i = 0; i < 1000; i++) c.set(`t${r}-${i}`, { r, i, p: "x".repeat(500) });
      const v = new mV.VIBCompressor({ capacity: 100, existingMemory: ["test"] });
      await v.compress(Array.from({length:200}, (_,i) => ({ id:`${r}-${i}`, content:`item${i}uniq`, timestamp: Date.now(), source:"t" })));
    }
    console.log(`  100 rounds: ${(performance.now()-t0).toFixed(0)}ms`);
  }, 60000);
});
