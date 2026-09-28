/**
 * decide:laya --check 的 HTTP 落点感知（2026-09-28 方向修正收尾）
 *
 * 标准 skill（laya-local-decision-model §10）：LAYA_DECISION_URL 已配置时，
 * 开发流程链（decide:laya / audit:chain）的可用性探测必须先探 HTTP——
 * 不再强求本机 python venv/WSL/权重。探活走 GET /health/live（3s 超时）。
 * 未配置 URL 时保持原 python 探测路径不变。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { checkLayaAvailability } from "../../src/decision/laya-cli.js";

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.LAYA_DECISION_URL;
});

describe("checkLayaAvailability —— HTTP 落点优先", () => {
  test("LAYA_DECISION_URL 已配置且 /health/live 200 ⇒ available=true（不探 python）", async () => {
    process.env.LAYA_DECISION_URL = "http://laya.test:18081";
    let pythonProbed = false;
    globalThis.fetch = (async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch;
    const res = await checkLayaAvailability({
      probePython: async () => {
        pythonProbed = true;
        return { available: false, detail: "should not be called" };
      },
    });
    expect(res.available).toBe(true);
    expect(res.mode).toBe("http");
    expect(res.detail).toContain("/health/live");
    expect(pythonProbed).toBe(false);
  });

  test("URL 已配置但服务不可达 ⇒ available=false 且 detail 指向 URL（不静默回退 python）", async () => {
    process.env.LAYA_DECISION_URL = "http://127.0.0.1:19999";
    const res = await checkLayaAvailability({
      probePython: async () => ({ available: true, detail: "python ok" }),
    });
    expect(res.available).toBe(false);
    expect(res.mode).toBe("http");
    expect(res.detail).toContain("LAYA_DECISION_URL");
  });

  test("URL 未配置 ⇒ 走 python 探测（原路径不变）", async () => {
    let pythonProbed = false;
    const res = await checkLayaAvailability({
      probePython: async () => {
        pythonProbed = true;
        return { available: true, detail: "venv ok" };
      },
    });
    expect(pythonProbed).toBe(true);
    expect(res.mode).toBe("python");
    expect(res.available).toBe(true);
  });
});
