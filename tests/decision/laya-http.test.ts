/**
 * Laya HTTP 客户端契约单测（fetch 受控替换，无真网）。
 *
 * 锁住的行为（对齐 ~/.axiom/axiom-secrets/laya-service.contract.md）：
 *  - 单条/批量 URL、model=multilingual、并发钳制 ≤8；
 *  - 4xx（除 429）不重试；429/5xx/网络错误指数退避重试；
 *  - 批量分块（≤500）且结果与输入严格同序；5xx/超时失败项一次补跑（clientRetried）；
 *  - 预校验把 4xx 挡在出门前（questions 数量/criteria 重复/instructions 长度）；
 *  - 未配置 LAYA_DECISION_URL fail loud（不静默降级）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  layaDecide,
  layaDecideBatch,
  layaHealth,
  getLayaHttpConfig,
  LAYA_MAX_CONCURRENCY_CAP,
  LAYA_BATCH_LIMIT,
  type LayaBatchResponse,
} from "../../src/decision/laya-http.js";

const ENV_KEYS = ["LAYA_DECISION_URL", "LAYA_MAX_CONCURRENCY", "LAYA_DECISION_MODEL"] as const;
const originalEnv: Record<string, string | undefined> = {};

const ORIGINAL_FETCH = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: unknown }> = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response("{}", { status: 200 });

beforeEach(() => {
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.LAYA_DECISION_URL = "http://laya.test:18081";
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ url: String(url), body });
    return fetchImpl(String(url), init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

const OK_SINGLE = {
  model: "laya-rl-agent",
  answers: { refund: { type: "noul", noul: 0.9956, confidence: 0.9956 } },
  usage: { input_tokens: 91, output_tokens: 0 },
  routing: { model: "multilingual" },
};

function batchResp(results: LayaBatchResponse["results"]): LayaBatchResponse {
  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    elapsed_ms: 10,
    qps: 4,
    latency_ms: { min: 5, p50: 5, p95: 5, max: 5 },
    usage: { input_tokens: 1 },
    results,
  };
}

describe("getLayaHttpConfig —— 并发钳制与默认值", () => {
  test("并发请求值超过硬顶被钳到 8，低于 1 钳到 1", () => {
    expect(getLayaHttpConfig({ baseUrl: "http://x", maxConcurrency: 16 }).maxConcurrency).toBe(LAYA_MAX_CONCURRENCY_CAP);
    expect(getLayaHttpConfig({ baseUrl: "http://x", maxConcurrency: 0 }).maxConcurrency).toBe(1);
    expect(getLayaHttpConfig({ baseUrl: "http://x" }).maxConcurrency).toBe(4);
  });
});

describe("layaDecide —— 单条与错误分级", () => {
  test("成功：URL/model 正确，answers 原样回传", async () => {
    fetchImpl = async () => new Response(JSON.stringify(OK_SINGLE), { status: 200 });
    const res = await layaDecide("客户要求退款", { refund: { type: "noul", instructions: "是否退款?" } });
    expect(res.routing.model).toBe("multilingual");
    expect(res.answers.refund.noul).toBeCloseTo(0.9956);
    expect(fetchCalls[0].url).toBe("http://laya.test:18081/v1/systemone");
    expect((fetchCalls[0].body as { model: string }).model).toBe("multilingual");
  });

  test("4xx 响应体含重试候选字样仍不重试（结构化分类不被响应体毒化）", async () => {
    // 修复前实现靠错误消息前缀嗅探分支：服务端 body 回显"（重试候选）"会把 4xx 误判成可重试。
    // 本用例锁住 LayaHttpError{retryable:false} 的结构化判定。
    fetchImpl = async () =>
      new Response(JSON.stringify({ error: "请勿重试（重试候选）" }), { status: 422 });
    await expect(layaDecide("s", { a: { type: "noul", instructions: "x" } })).rejects.toThrow(/422/);
    expect(fetchCalls.length).toBe(1);
  });

  test("4xx 不重试：422 只调一次并抛错", async () => {
    fetchImpl = async () => new Response("Request validation failed", { status: 422 });
    await expect(layaDecide("s", { a: { type: "noul", instructions: "x" } })).rejects.toThrow(/422/);
    expect(fetchCalls.length).toBe(1);
  });

  test("5xx 指数退避重试后成功", async () => {
    let n = 0;
    fetchImpl = async () => {
      n++;
      return n === 1 ? new Response("boom", { status: 502 }) : new Response(JSON.stringify(OK_SINGLE), { status: 200 });
    };
    const res = await layaDecide("s", { a: { type: "noul", instructions: "x" } });
    expect(res.routing.model).toBe("multilingual");
    expect(fetchCalls.length).toBe(2);
  });

  test("网络错误重试，仍失败抛最后一次错误", async () => {
    fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(layaDecide("s", { a: { type: "noul", instructions: "x" } })).rejects.toThrow(/ECONNREFUSED/);
    expect(fetchCalls.length).toBe(3); // 1 次原始 + 2 次重试
  });

  test("5xx 重试的退避间隔递增（轮 7 审计：仅断言调用次数时 0ms 退化实现恒绿）", async () => {
    // postJson 退避 = 250 * 2^attempt + jitter(0..120) ⇒ attempt0→[250,370)ms、attempt1→[500,620)ms。
    // 记录每次 fetch 时间戳，断言间隔达到退避下界且递增。
    const stamps: number[] = [];
    fetchImpl = async () => {
      stamps.push(Date.now());
      return new Response("boom", { status: 503 });
    };
    await expect(layaDecide("s", { a: { type: "noul", instructions: "x" } })).rejects.toThrow(/503/);
    expect(stamps.length).toBe(3);
    const gap1 = stamps[1] - stamps[0];
    const gap2 = stamps[2] - stamps[1];
    expect(gap1).toBeGreaterThanOrEqual(250); // attempt0 退避下界（jitter 前）
    expect(gap2).toBeGreaterThanOrEqual(500); // attempt1 退避下界
    expect(gap2).toBeGreaterThan(gap1); // 递增
  }, 20_000);

  test("429 可重试分支：重试后成功（文件头宣称行为的补锁，轮 7 审计缺口）", async () => {
    let n = 0;
    fetchImpl = async () => {
      n++;
      return n === 1 ? new Response("rate-limited", { status: 429 }) : new Response(JSON.stringify(OK_SINGLE), { status: 200 });
    };
    const res = await layaDecide("s", { a: { type: "noul", instructions: "x" } });
    expect(res.answers.refund.noul).toBeCloseTo(0.9956);
    expect(fetchCalls.length).toBe(2); // 429 走重试而非直接抛
  });

  test("429 与 4xx 分级对照：429 重试烧满 / 422 单次（分级判定锁定）", async () => {
    fetchImpl = async () => new Response("rl", { status: 429 });
    await expect(layaDecide("s", { a: { type: "noul", instructions: "x" } })).rejects.toThrow(/429/);
    expect(fetchCalls.length).toBe(3); // 429 可重试：1 原始 + 2 重试
  });

  test("未配置 LAYA_DECISION_URL：fail loud 不发请求", async () => {
    delete process.env.LAYA_DECISION_URL;
    await expect(layaDecide("s", { a: { type: "noul", instructions: "x" } })).rejects.toThrow(/LAYA_DECISION_URL 未配置/);
    expect(fetchCalls.length).toBe(0);
  });
});

describe("契约预校验（挡在出门前）", () => {
  test("questions 为空抛错", async () => {
    await expect(layaDecide("s", {})).rejects.toThrow(/1–50/);
    expect(fetchCalls.length).toBe(0);
  });
  test("choice criteria 重复标签抛错", async () => {
    await expect(
      layaDecide("s", { a: { type: "choice", instructions: "x", criteria: ["p", " p"] } }),
    ).rejects.toThrow(/2–50/);
  });
  test("instructions 超长抛错", async () => {
    await expect(
      layaDecide("s", { a: { type: "noul", instructions: "x".repeat(2001) } }),
    ).rejects.toThrow(/1–2000/);
  });
});

describe("layaDecideBatch —— 分块/保序/补跑", () => {
  test("结果与输入严格同序；在飞批请求峰值 ≤2（槽位真实计量）", async () => {
    // 轮 7 审计 H1 测试面：旧断言只读请求体自报的 concurrency 字段（限流失效时恒绿）。
    // 契约第五节：客户端在飞**批请求**槽 ≤2（条目级 ≤8 是 body.concurrency 契约义务，
    // 由服务端执行）。这里用进入/退出计数计量真实峰值：37 条 → 单块（≤500）但受 2 槽
    // 与单 worker 限制，峰值断言 ≤2；并保持 body.concurrency ≤8 的钳制义务断言。
    let inflight = 0;
    let peak = 0;
    fetchImpl = async (_url, init) => {
      inflight++;
      peak = Math.max(peak, inflight);
      const body = JSON.parse(String(init?.body)) as { items: Array<{ id: string }> };
      const resp = new Response(
        JSON.stringify(batchResp(body.items.map((m) => ({ id: m.id, ok: true, answers: { q: { type: "noul", noul: 0.9 } } })))),
        { status: 200 },
      );
      // 微任务让渡，保证两个 worker 真有机会重叠在飞（否则峰值恒 1 测不出超发）
      await Promise.resolve();
      inflight--;
      return resp;
    };
    const items = Array.from({ length: 37 }, (_, i) => ({
      id: `i${i}`,
      state: `s${i}`,
      questions: { q: { type: "noul" as const, instructions: "x" } },
    }));
    const res = await layaDecideBatch({ items });
    expect(res.total).toBe(37);
    expect(res.ok).toBe(37);
    expect(res.results.map((r) => r.id)).toEqual(items.map((m) => m.id));
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(2); // 真实在飞批请求峰值（契约第五节）
    expect((fetchCalls[0].body as { concurrency: number }).concurrency).toBeLessThanOrEqual(8); // 钳制义务字段
  });

  test("条目级全局闸：服务端可观测并发条目 ≤ maxConcurrency（轮 7 H1 语义修正）", async () => {
    // 契约第四节：并发硬顶 8 是**条目**级吞吐上限（服务端实测 >8 反降）。
    // 轮 7 审计发现旧实现把闸用在"批请求数"上：多个并发调用各自整批出门，
    // 服务端按 body.concurrency 并发执行每个请求 ⇒ 服务端同时处理的条目数
    // = Σ min(items_i, concurrency)，旧闸下随并发请求数线性超发（2 调用 × 4 = 8+）。
    // 本用例让两个 layaDecideBatch 并发跑（各 250 条目、limit=8），计量服务端
    // 可观测并发条目 Σ min(items_i, limit)：条目闸下大块独占（250 ≥ 8 ⇒ 第二调用
    // 等待，服务端任一时刻只执行一个请求的 ≤8 条）；旧批槽实现下两请求叠发（红）。
    let serverConcurrent = 0;
    let serverPeak = 0;
    let batchInflight = 0;
    let batchPeak = 0;
    fetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ id: string }> };
      serverConcurrent += Math.min(body.items.length, 8); // 服务端按 concurrency≤8 执行
      batchInflight++;
      serverPeak = Math.max(serverPeak, serverConcurrent);
      batchPeak = Math.max(batchPeak, batchInflight);
      await new Promise((r) => setTimeout(r, 8)); // 制造重叠窗口
      const resp = new Response(
        JSON.stringify(batchResp(body.items.map((m) => ({ id: m.id, ok: true, answers: { q: { type: "noul", noul: 0.9 } } })))),
        { status: 200 },
      );
      serverConcurrent -= Math.min(body.items.length, 8);
      batchInflight--;
      return resp;
    };
    const mk = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${tag}${i}`,
        state: `s${i}`,
        questions: { q: { type: "noul" as const, instructions: "x" } },
      }));
    const [r1, r2] = await Promise.all([
      layaDecideBatch({ items: mk(250, "a") }, { maxConcurrency: 8 }),
      layaDecideBatch({ items: mk(250, "b") }, { maxConcurrency: 8 }),
    ]);
    expect(r1.ok).toBe(250);
    expect(r2.ok).toBe(250);
    // 大块（250 ≥ limit 8）独占 ⇒ 两请求不重叠（串行化是正确行为）；
    // 服务端任一时刻在处理条目 ≤8（契约第四节硬顶）。
    expect(batchPeak).toBe(1);
    expect(serverPeak).toBeLessThanOrEqual(8);
  });

  test("条目级全局闸：小批跨调用叠发不超 8（额度复用）", async () => {
    // 250 条独占是保守路径；小批（< limit）必须能并行填满额度：4 条 × limit=8
    // ⇒ 理论可 2 个 4 条请求叠发（4+4=8）。计量同上，验证额度不被浪费也不超发。
    let serverConcurrent = 0;
    let serverPeak = 0;
    let batchInflight = 0;
    let batchPeak = 0;
    fetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ id: string }> };
      serverConcurrent += Math.min(body.items.length, 8);
      batchInflight++;
      serverPeak = Math.max(serverPeak, serverConcurrent);
      batchPeak = Math.max(batchPeak, batchInflight);
      await new Promise((r) => setTimeout(r, 8));
      const resp = new Response(
        JSON.stringify(batchResp(body.items.map((m) => ({ id: m.id, ok: true, answers: { q: { type: "noul", noul: 0.9 } } })))),
        { status: 200 },
      );
      serverConcurrent -= Math.min(body.items.length, 8);
      batchInflight--;
      return resp;
    };
    const mk = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${tag}${i}`,
        state: `s${i}`,
        questions: { q: { type: "noul" as const, instructions: "x" } },
      }));
    const rs = await Promise.all([
      layaDecideBatch({ items: mk(4, "a") }, { maxConcurrency: 8 }),
      layaDecideBatch({ items: mk(4, "b") }, { maxConcurrency: 8 }),
      layaDecideBatch({ items: mk(4, "c") }, { maxConcurrency: 8 }),
      layaDecideBatch({ items: mk(4, "d") }, { maxConcurrency: 8 }),
    ]);
    for (const r of rs) expect(r.ok).toBe(4);
    expect(serverPeak).toBeLessThanOrEqual(8); // 硬顶
    expect(batchPeak).toBeGreaterThanOrEqual(2); // 小批允许叠发（额度复用，不退化为串行）
  });

  test("超 500 条自动分块，多块结果保序拼接", async () => {
    fetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ id: string }> };
      return new Response(
        JSON.stringify(batchResp(body.items.map((m) => ({ id: m.id, ok: true, answers: {} })))),
        { status: 200 },
      );
    };
    const items = Array.from({ length: LAYA_BATCH_LIMIT + 3 }, (_, i) => ({
      id: `i${i}`,
      state: `s${i}`,
      questions: { q: { type: "noul" as const, instructions: "x" } },
    }));
    const res = await layaDecideBatch({ items });
    expect(fetchCalls.length).toBe(2);
    expect((fetchCalls[0].body as { items: unknown[] }).items.length).toBe(LAYA_BATCH_LIMIT);
    expect(res.total).toBe(items.length);
    expect(res.results[500]?.id).toBe("i500");
    expect(res.results[502]?.id).toBe("i502");
  });

  test("服务端违约：results 长度 != items 长度 ⇒ fail loud（不静默空洞）", async () => {
    fetchImpl = async (_url, _init) =>
      new Response(JSON.stringify(batchResp([{ id: "only-one", ok: true, answers: {} }])), { status: 200 });
    const items = [
      { id: "a", state: "sa", questions: { q: { type: "noul" as const, instructions: "x" } } },
      { id: "b", state: "sb", questions: { q: { type: "noul" as const, instructions: "x" } } },
    ];
    await expect(layaDecideBatch({ items })).rejects.toThrow(/契约违约/);
  });

  test("服务端违约：results 长度相等但 id 错位 ⇒ fail loud", async () => {
    fetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ id: string }> };
      const rotated = [...body.items.slice(1), body.items[0]];
      return new Response(
        JSON.stringify(batchResp(rotated.map((m) => ({ id: m.id, ok: true, answers: {} })))),
        { status: 200 },
      );
    };
    const items = [
      { id: "a", state: "sa", questions: { q: { type: "noul" as const, instructions: "x" } } },
      { id: "b", state: "sb", questions: { q: { type: "noul" as const, instructions: "x" } } },
    ];
    await expect(layaDecideBatch({ items })).rejects.toThrow(/契约违约/);
  });

  test("5xx 失败项一次补跑后转 ok；4xx 失败项不补跑", async () => {
    fetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ id: string }> };
      if (body.items.length === 2) {
        // 首批：一项 5xx、一项 4xx
        return new Response(
          JSON.stringify(batchResp([
            { id: "a", ok: false, error: "HTTP 502", http_status: 502, attempts: 3 },
            { id: "b", ok: false, error: "HTTP 422", http_status: 422, attempts: 1 },
          ])),
          { status: 200 },
        );
      }
      // 补跑批（只含 a）
      expect(body.items.length).toBe(1);
      expect(body.items[0].id).toBe("a");
      return new Response(
        JSON.stringify(batchResp([{ id: "a", ok: true, answers: { q: { type: "noul", noul: 0.8 } } }])),
        { status: 200 },
      );
    };
    const items = [
      { id: "a", state: "s", questions: { q: { type: "noul" as const, instructions: "x" } } },
      { id: "b", state: "s", questions: { q: { type: "noul" as const, instructions: "x" } } },
    ];
    const res = await layaDecideBatch({ items });
    expect(fetchCalls.length).toBe(2); // 首批 + 仅 5xx 的补跑（4xx 不重试）
    expect(res.clientRetried).toBe(1);
    expect(res.ok).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.results[0].ok).toBe(true);
    expect(res.results[1].ok).toBe(false);
  });

  test("空批次直接返回，不发请求", async () => {
    const res = await layaDecideBatch({ items: [] });
    expect(res.total).toBe(0);
    expect(fetchCalls.length).toBe(0);
  });
});

describe("layaHealth", () => {
  test("200 → true；异常/未配置 → false", async () => {
    fetchImpl = async () => new Response('{"status":"ok"}', { status: 200 });
    expect(await layaHealth()).toBe(true);
    fetchImpl = async () => {
      throw new Error("down");
    };
    expect(await layaHealth()).toBe(false);
    delete process.env.LAYA_DECISION_URL;
    expect(await layaHealth()).toBe(false);
  });
});
