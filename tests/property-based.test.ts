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

// 4. Vault (Mock) invariants
describe("PBT Vault (Mock)", () => {
  it("INV1: writeNote → readNote returns same content", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    for (let i = 0; i < 500; i++) {
      const path = `test/note-${i}.md`;
      const content = `content-${i}-${Math.random().toString(36).slice(2, 8)}`;
      await vault.writeNote(path, content);
      const read = vault.readNote(path);
      expect(read).not.toBeNull();
      expect(read!.content).toBe(content);
    }
  });

  it("INV2: concurrent writes don't lose data", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    const paths = Array.from({ length: 100 }, (_, i) => `concurrent/n${i}.md`);
    await Promise.all(paths.map((p, i) => vault.writeNote(p, `data-${i}`)));
    for (let i = 0; i < paths.length; i++) {
      const read = vault.readNote(paths[i]);
      expect(read).not.toBeNull();
      expect(read!.content).toBe(`data-${i}`);
    }
    expect(vault.notes.size).toBe(100);
  });

  it("INV3: search finds written notes", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    await vault.writeNote("search-test/alpha.md", "lorem ipsum dolor");
    await vault.writeNote("search-test/beta.md", "consectetur adipiscing");
    await vault.writeNote("search-test/gamma.md", "lorem consectetur");
    const results = vault.search("lorem");
    expect(results.length).toBe(2);
    expect(results.some(r => r.note.path.includes("alpha"))).toBeTrue();
    expect(results.some(r => r.note.path.includes("gamma"))).toBeTrue();
  });

  it("INV4: browsePara returns correct category", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    await vault.writeNote("00-Meta/config.md", "meta config");
    await vault.writeNote("01-Projects/task1.md", "project one");
    await vault.writeNote("01-Projects/task2.md", "project two");
    await vault.writeNote("02-Areas/dev.md", "area dev");
    expect(vault.browsePara("01-Projects").length).toBe(2);
    expect(vault.browsePara("00-Meta").length).toBe(1);
    expect(vault.browsePara("03-Resources").length).toBe(0);
  });

  it("INV5: readNote on non-existent returns null", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    expect(vault.readNote("nonexistent.md")).toBeNull();
    expect(vault.readNote("")).toBeNull();
  });

  it("INV6: stats reflect note count", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    expect(vault.stats().totalNotes).toBe(0);
    await vault.writeNote("test/a.md", "a");
    await vault.writeNote("test/b.md", "b");
    await vault.writeNote("test/c.md", "c");
    expect(vault.stats().totalNotes).toBe(3);
  });

  it("INV7: atomicNote writes a readable note", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    const path = await vault.writeAtomicNote("My Atomic Idea", "core insight here", { tags: ["atomic"] });
    const note = vault.readNote(path);
    expect(note).not.toBeNull();
    expect(note!.content).toContain("My Atomic Idea");
    expect(note!.content).toContain("core insight here");
  });

  it("INV8: getNetwork returns notes and relationships", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    await vault.writeNote("a.md", "alpha");
    await vault.writeNote("b.md", "beta");
    const net = vault.getNetwork("a.md");
    expect(net.notes.length).toBe(2);
    expect(net.relationships).toBeArray();
  });

  it("INV9: reset() clears calls and notes", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    await vault.writeNote("x.md", "content");
    vault.search("x");
    expect(vault.notes.size).toBe(1);
    expect(vault.callCount("writeNote")).toBe(1);
    vault.reset();
    expect(vault.notes.size).toBe(0);
    expect(vault.callCount("writeNote")).toBe(0);
  });

  it("INV10: callCount tracks per-method invocations", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();
    await vault.writeNote("a.md", "a");
    await vault.writeNote("b.md", "b");
    vault.search("test");
    vault.readNote("a.md");
    vault.stats();
    expect(vault.callCount("writeNote")).toBe(2);
    expect(vault.callCount("search")).toBe(1);
    expect(vault.callCount("readNote")).toBe(1);
    expect(vault.callCount("stats")).toBe(1);
  });
});

// 5. ConfigCenter invariants
describe("PBT ConfigCenter", () => {
  it("INV1: get returns what was set", async () => {
    const { getConfigCenter, resetConfigCenter } = await import("../src/core/config-center.js");
    resetConfigCenter();
    const cc = getConfigCenter();
    cc.set("gateway.port", 9999, "test", false);
    const val = cc.get<number>("gateway.port");
    expect(val).toBe(9999);
    expect(cc.getNumber("gateway.port")).toBe(9999);
  });

  it("INV2: getString returns string type", async () => {
    const { getConfigCenter, resetConfigCenter } = await import("../src/core/config-center.js");
    resetConfigCenter();
    const cc = getConfigCenter();
    const val = cc.getString("gateway.bind");
    expect(typeof val).toBe("string");
  });

  it("INV3: getNumber returns number or 0", async () => {
    const { getConfigCenter, resetConfigCenter } = await import("../src/core/config-center.js");
    resetConfigCenter();
    const cc = getConfigCenter();
    const val = cc.getNumber("gateway.port");
    expect(typeof val).toBe("number");
    expect(isNaN(val)).toBeFalse();
  });
});

// 6. Soak test
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

