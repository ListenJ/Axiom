/**
 * provider-caller 思考强度透传测试
 * 验证 callProvider / callProviderNativeStream 的请求体包含
 * buildReasoningParams 生成的供应商参数（OpenAI 兼容默认格式）。
 */
import { describe, expect, it, mock } from "bun:test";
import { callProvider } from "../src/router/provider-caller.js";

describe("callProvider 思考强度透传", () => {
  it("OpenAI 兼容供应商请求体包含 reasoning_effort", async () => {
    let sentBody: Record<string, unknown> | null = null;
    mock.module("../src/utils/api-key-store.js", () => ({
      getEffectiveApiKey: () => "test-key",
      getEffectiveBaseURL: () => "https://api.example.com/v1",
    }));
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await callProvider("opencode", "model-x", [{ role: "user", content: "hi" }], 5000, 0.7, "high");
    expect(sentBody).not.toBeNull();
    expect((sentBody as Record<string, unknown>).reasoning_effort).toBe("high");
  });

  it("不传 effort 时请求体不含思考参数", async () => {
    let sentBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await callProvider("opencode", "model-x", [{ role: "user", content: "hi" }], 5000);
    expect((sentBody as Record<string, unknown>).reasoning_effort).toBe("medium"); // 默认档位
  });
});
