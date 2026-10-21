/**
 * P1.3：LLM 出站统一守卫接线测试。
 *
 * 覆盖全部四类「携带凭证的 LLM 出站」：
 *   1. chat 主出站（非流式）        —— src/router/provider-caller.ts callProvider
 *   2. chat 主出站（native stream） —— src/router/provider-caller.ts callProviderNativeStream
 *   3. embeddings 出站              —— src/router/model-router.ts embeddings（默认 local-embed → 127.0.0.1:9001）
 *   4. computer-use 视觉出站        —— src/agents/computer-use-agent.ts callVisionModel
 *
 * 断言要点：被拒时 **fetch 未被调用**（不是请求后补救），错误文案含恢复路径
 * （AXIOM_SSRF_ALLOWLIST）；公网/显式 allowlist 端点不被误伤。
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { callProvider, callProviderNativeStream } from "../../src/router/provider-caller.js";
import { MultiPlatformRouter } from "../../src/router/model-router.js";
import { ComputerUseAgent } from "../../src/agents/computer-use-agent.js";
import { registerModel, unregisterModel } from "../../src/router/model-capability-registry.js";
import type { ModelProvider, TaskRole } from "../../src/router/models.js";

const LOOPBACK = "http://127.0.0.1:11434/v1";
const PUBLIC_LITERAL = "https://198.51.100.10/v1";
const CU_MODEL_ID = "p13-ssrf-vision-test";

interface Counter {
  calls: number;
}

function mockFetch(counter: Counter, payload: unknown): ReturnType<typeof spyOn> {
  return spyOn(globalThis, "fetch").mockImplementation((async () => {
    counter.calls++;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch);
}

afterEach(() => {
  delete process.env.AXIOM_SSRF_ALLOWLIST;
  delete process.env.LOCAL_EMBED_API_KEY;
  unregisterModel(CU_MODEL_ID);
});

describe("P1.3 chat 主出站（callProvider）", () => {
  test("loopback 端点被拒：不发请求，错误含 allowlist 恢复路径", async () => {
    const counter: Counter = { calls: 0 };
    const spy = mockFetch(counter, { choices: [{ message: { content: "hi" } }] });
    try {
      await expect(
        callProvider(
          "p13-outbound-test",
          "m",
          [{ role: "user", content: "x" }],
          5000,
          0.7,
          undefined,
          undefined,
          { apiKey: "sk-test-123456", baseURL: LOOPBACK },
        ),
      ).rejects.toThrow("AXIOM_SSRF_ALLOWLIST");
      expect(counter.calls).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("公网字面量端点不被误伤（正常调用一次并返回内容）", async () => {
    const counter: Counter = { calls: 0 };
    const spy = mockFetch(counter, { choices: [{ message: { content: "hi" } }] });
    try {
      const result = await callProvider(
        "p13-outbound-test",
        "m",
        [{ role: "user", content: "x" }],
        5000,
        0.7,
        undefined,
        undefined,
        { apiKey: "sk-test-123456", baseURL: PUBLIC_LITERAL },
      );
      expect(result.content).toBe("hi");
      expect(counter.calls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("P1.3 chat 主出站（callProviderNativeStream）", () => {
  test("loopback 端点被拒：不发请求", async () => {
    const counter: Counter = { calls: 0 };
    const spy = mockFetch(counter, {});
    try {
      await expect(
        callProviderNativeStream(
          "p13-outbound-test",
          "m",
          [{ role: "user", content: "x" }],
          5000,
          0.7,
          () => {},
          undefined,
          undefined,
          undefined,
          { apiKey: "sk-test-123456", baseURL: LOOPBACK },
        ),
      ).rejects.toThrow("AXIOM_SSRF_ALLOWLIST");
      expect(counter.calls).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("P1.3 embeddings 出站（默认 local-embed → 127.0.0.1:9001）", () => {
  test("默认 loopback 端点被拒：不发请求", async () => {
    process.env.LOCAL_EMBED_API_KEY = "sk-local-embed-test";
    const counter: Counter = { calls: 0 };
    const spy = mockFetch(counter, { data: [{ embedding: [0.1, 0.2] }] });
    try {
      await expect(new MultiPlatformRouter().embeddings(["hello"])).rejects.toThrow(
        "AXIOM_SSRF_ALLOWLIST",
      );
      expect(counter.calls).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("P1.3 computer-use 视觉出站（callVisionModel）", () => {
  test("loopback 端点被拒：不发请求", async () => {
    process.env.LOCAL_EMBED_API_KEY = "sk-local-embed-test";
    registerModel({
      id: CU_MODEL_ID,
      provider: "local-embed" as ModelProvider,
      model: "vl-test",
      roles: ["computer-use"] as TaskRole[],
      contextWindow: 8192,
      tags: ["vision"],
    });
    const counter: Counter = { calls: 0 };
    const spy = mockFetch(counter, { choices: [{ message: { content: "{}" } }] });
    try {
      const agent = new ComputerUseAgent();
      await expect(
        agent.analyze({ task: "click login", imageBase64: "iVBORw0KGgo=", modelId: CU_MODEL_ID }),
      ).rejects.toThrow("AXIOM_SSRF_ALLOWLIST");
      expect(counter.calls).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
