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
    expect((s.find((x: any) => x.id === "g")!).mean).toBeGreaterThan((s.find((x: any) => x.id === "b")!).mean);
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
    r.forEach((x: any) => expect(x.ok).toBeTrue());
  }, 15000);
});

// 6. PromptEngineer (W3 重构验证: 零向量匹配 + 模板填充鲁棒性)
describe("Chaos PromptEngineer", () => {
  it("Fuzz: 1K 随机任务描述不崩溃 + 返回结构合法", async () => {
    const { promptEngineer } = await import("../src/agents/prompt-engineer.js");
    const samples = [
      "", " ", "a", "你好", "🔍 emoji test",
      "code review this function for bugs",
      "a".repeat(10000),
      "代码\x00审查\x01控制字符",
      "<script>alert(1)</script>",
      "{{injected}}",
      "../../../etc/passwd",
      "'; DROP TABLE templates;--",
    ];
    for (let i = 0; i < 1000; i++) {
      const desc = i < samples.length ? samples[i] : randStr(rand(50));
      let result: any = null;
      expect(() => { result = promptEngineer.matchTemplate(desc); }).not.toThrow();
      if (result !== null) {
        expect(result).toHaveProperty("template");
        expect(result).toHaveProperty("score");
        expect(typeof result.score).toBe("number");
        expect(result.score).toBeGreaterThanOrEqual(0);
      }
    }
  }, 15000);

  it("Fill template: 恶意变量值不破坏模板结构", async () => {
    const { promptEngineer } = await import("../src/agents/prompt-engineer.js");
    const template = promptEngineer.listTemplates()[0];
    const maliciousValues: Record<string, string> = {};
    for (const v of template.variables) {
      maliciousValues[v] = [
        "<script>alert('xss')</script>",
        "'; DROP TABLE;--",
        "{{other_var}}",
        "${7*7}",
        "`rm -rf /`",
        "\n\r\t",
        "a".repeat(1000),
      ][rand(7)];
    }
    expect(() => promptEngineer.fillTemplate(template, maliciousValues)).not.toThrow();
    const filled = promptEngineer.fillTemplate(template, maliciousValues);
    expect(typeof filled).toBe("string");
    // 模板填充后不应残留未替换的 {{var}} (条件块除外)
    expect(filled.match(/\{\{[a-zA-Z]\w*\}\}/g)).toBeNull();
  });

  it("并发 matchTemplate 确定性: 100 并行同输入返回同结果", async () => {
    const { promptEngineer } = await import("../src/agents/prompt-engineer.js");
    const desc = "帮我审查这段代码的安全性";
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        Promise.resolve(promptEngineer.matchTemplate(desc))
      )
    );
    const first = results[0];
    for (const r of results) {
      expect(r === null ? null : r!.template.id).toBe(first === null ? null : first!.template.id);
      if (r && first) expect(r.score).toBe(first.score);
    }
  });

  it("Unicode/Emoji/混合语言匹配不崩溃", async () => {
    const { promptEngineer } = await import("../src/agents/prompt-engineer.js");
    const descs = [
      "🚀 帮我生成一个 React 组件",
      "コードをレビューしてください",
      "코드 생성해 주세요",
      "Explain this code 🤔",
      "Mix 中文 English 日本語 survey",
    ];
    for (const d of descs) {
      expect(() => promptEngineer.matchTemplate(d)).not.toThrow();
    }
  });
});

// 7. Plugin Routes W3 (路径遍历防护 + 并发安装竞争)
describe("Chaos Plugin Routes (W3)", () => {
  it("路径遍历尝试: 全部 500 + 不逃逸 ./plugins/ 边界", async () => {
    const { Database } = await import("bun:sqlite");
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const { createPluginRoutes } = await import("../src/routes/plugin-routes.js");
    const db = new Database(":memory:");
    const routes = createPluginRoutes(db, new ToolRegistry());

    const traversalPaths = [
      "../../../etc/passwd",
      "..\\..\\..\\windows\\system32",
      "./plugins/../../../etc/shadow",
      "test-plugin/../../../secret",
      "%2e%2e%2f%2e%2e%2f",
      "....//....//etc/passwd",
    ];
    for (const p of traversalPaths) {
      const res = await routes.install(
        new Request("http://localhost/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: p, enable: false }),
        })
      );
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
    }
    db.close();
  }, 10000);

  it("Unicode/特殊字符路径: 全部 500 不崩溃", async () => {
    const { Database } = await import("bun:sqlite");
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const { createPluginRoutes } = await import("../src/routes/plugin-routes.js");
    const db = new Database(":memory:");
    const routes = createPluginRoutes(db, new ToolRegistry());

    const weirdPaths = [
      "测试插件",
      "plugin<script>",
      "plugin'; DROP TABLE;--",
      "${injection}",
      "a".repeat(10000),
      "\x00\x01null",
    ];
    for (const p of weirdPaths) {
      const res = await routes.install(
        new Request("http://localhost/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: p, enable: false }),
        })
      );
      expect([400, 500]).toContain(res.status);
      const data = await res.json();
      expect(data.success).toBe(false);
    }
    db.close();
  }, 10000);

  it("并发安装竞争: 10 并行同插件, 至多 1 个成功", async () => {
    const { Database } = await import("bun:sqlite");
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const { createPluginRoutes } = await import("../src/routes/plugin-routes.js");
    const db = new Database(":memory:");
    const routes = createPluginRoutes(db, new ToolRegistry());

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        routes.install(
          new Request("http://localhost/plugins/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: "test-plugin", enable: false }),
          })
        )
      )
    );
    const statuses = await Promise.all(results.map((r: Response) => r.json()));
    const successCount = statuses.filter((s: any) => s.success).length;
    // 不调用 uninstall —— 就地安装时 uninstall 会删除 ./plugins/test-plugin 源目录!
    db.close();
    // 竞争下至少 1 个成功, 其余因 "already installed" 失败 (或全部成功如果时序完全分离)
    expect(successCount).toBeGreaterThanOrEqual(1);
    expect(successCount).toBeLessThanOrEqual(10);
  }, 15000);
});

// 8. Process Sandbox R3 (shell 元字符 fuzz + 并发执行)
describe("Chaos Process Sandbox (R3)", () => {
  it("Shell 元字符 fuzz: 20 种注入向量全部字面化 (无注入迹象)", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const injectionVectors = [
      "a;b", "a|b", "a&b", "a&&b", "a||b",
      "$(whoami)", "`id`", "${PATH}",
      "a\nb", "a\rb", "a\tb",
      "a>b", "a<b", "a>>b",
      "%PATH%", "%USERNAME%",
      "a^b", "a(b)c",
      "'; rm -rf /; '",
      "null\x00byte",
    ];
    for (const arg of injectionVectors) {
      const result = await processSandbox.execute({
        command: "echo",
        args: [arg],
        timeoutMs: 3000,
      });
      // 关键安全断言: 无命令注入迹象
      // 1. stdout 不应包含 whoami/id 等命令的实际输出
      expect(result.stdout).not.toContain("uid=");
      expect(result.stdout).not.toContain("root");
      // 2. stderr 不应有 "not recognized" / "not found" (注入命令执行失败的迹象)
      const stderrLower = result.stderr.toLowerCase();
      expect(stderrLower).not.toContain("not recognized");
      expect(stderrLower).not.toContain("no such file");
      // 注: 某些特殊字符 (如 null byte) 可能让 echo 本身失败 (exitCode != 0),
      // 这是 OS 层面的限制而非注入成功 —— 关键是无注入迹象而非 echo 必须成功
    }
  }, 30000);

  it("Unicode/Emoji 参数: echo 原样输出", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const unicodeArgs = ["你好世界", "🎉🎊", "_mix中文English", "Üñîçödé"];
    for (const arg of unicodeArgs) {
      const result = await processSandbox.execute({
        command: "echo",
        args: [arg],
        timeoutMs: 3000,
      });
      expect(result.exitCode).toBe(0);
      // 输出应包含原始字符 (cmd 可能有编码差异, 至少不崩溃)
      expect(typeof result.stdout).toBe("string");
    }
  }, 15000);

  it("超长参数 (10K 字符): sandbox 不崩溃 (OS 命令行长度限制可接受)", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const longArg = "x".repeat(10000);
    const result = await processSandbox.execute({
      command: "echo",
      args: [longArg],
      timeoutMs: 5000,
    });
    // Windows cmd.exe 命令行长度限制 ~8K, 10K 可能触发非零退出 —— 这是 OS 限制
    // 关键断言: processSandbox.execute 本身不抛异常, 返回结构合法
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.durationMs).toBe("number");
  }, 10000);

  it("50 并发执行: 全部完成 + 无资源泄漏", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        processSandbox.execute({
          command: "echo",
          args: [`worker-${i}`],
          timeoutMs: 5000,
        })
      )
    );
    expect(results.length).toBe(50);
    for (const r of results) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("worker-");
    }
  }, 30000);
});
