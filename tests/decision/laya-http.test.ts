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
  test("结果与输入严格同序；body 并发 ≤8", async () => {
    fetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ id: string }> };
      return new Response(
        JSON.stringify(batchResp(body.items.map((m) => ({ id: m.id, ok: true, answers: { q: { type: "noul", noul: 0.9 } } })))),
        { status: 200 },
      );
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
    expect((fetchCalls[0].body as { concurrency: number }).concurrency).toBeLessThanOrEqual(8);
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
