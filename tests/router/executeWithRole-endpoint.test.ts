/**
 * Fix 2 回归测试（MEDIUM）：executeWithRole 的 endpoint 应来自实际执行的模型，
 * 而不是重新调用 assign() 拿到的"首选"候选。当首选模型 A 挂掉、fallback 到 B
 * 成功时，endpoint 必须是 B 的 baseURL。
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as mcr from "../../src/router/model-capability-registry.js";
import { PROVIDER_CONFIG } from "../../src/router/models.js";
import { router } from "../../src/router/model-router.js";
import type { ChatMessage } from "../../src/router/provider-caller.js";

const BASE_A = "https://a.example/v1";
const BASE_B = "https://b.example/v1";

describe("router.executeWithRole endpoint 派生自实际执行的模型", () => {
  let assignSpy: ReturnType<typeof spyOn> | undefined;
  let findSpy: ReturnType<typeof spyOn> | undefined;
  let origFakeA: unknown, origFakeB: unknown;
  let installed = false;

  beforeEach(() => {
    // 直接注入两个虚构 provider 到 PROVIDER_CONFIG（可变 Record，改完即生效）
    const pc = PROVIDER_CONFIG as Record<string, { baseURL: string; apiKeyEnv: string } | undefined | null>;
    origFakeA = pc["fake-a"];
    origFakeB = pc["fake-b"];
    (PROVIDER_CONFIG as Record<string, { baseURL: string; apiKeyEnv: string } | undefined | null>)["fake-a"] = { baseURL: BASE_A, apiKeyEnv: "FAKE_A_KEY" };
    (PROVIDER_CONFIG as Record<string, { baseURL: string; apiKeyEnv: string } | undefined | null>)["fake-b"] = { baseURL: BASE_B, apiKeyEnv: "FAKE_B_KEY" };
    installed = true;

    // assign() 总是返回模型 A（首选）
    assignSpy = spyOn(router, "assign").mockReturnValue({
      role: "general-chat" as never,
      model: {
        id: "fake/model-a",
        model: "model-a",
        provider: "fake-a",
        priority: 1,
        isFree: true,
        maxRetries: 1,
        timeout: 1000,
        baseURL: BASE_A,
      },
      fallbackChain: [
        {
          id: "fake/model-b",
          model: "model-b",
          provider: "fake-b",
          priority: 2,
          isFree: true,
          maxRetries: 1,
          timeout: 1000,
          baseURL: BASE_B,
        },
      ],
      reason: "primary",
    } as never);
  });

  afterEach(() => {
    if (installed) {
      const pc = PROVIDER_CONFIG as Record<string, unknown>;
      if (origFakeA === undefined) delete pc["fake-a"];
      else pc["fake-a"] = origFakeA;
      if (origFakeB === undefined) delete pc["fake-b"];
      else pc["fake-b"] = origFakeB;
      installed = false;
    }
    assignSpy?.mockRestore();
    findSpy?.mockRestore();
  });

  test("A 挂掉 → B 成功时，out.model === B 且 endpoint === B 的 baseURL", async () => {
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([] as never);
    const executeSpy = spyOn(router, "execute").mockResolvedValue({
      content: "ok-from-B",
      model: "model-b",
      provider: "fake-b",
      usage: { total_tokens: 5 },
      latencyMs: 50,
      fallbackUsed: true,
    } as never);

    try {
      const result = await router.executeWithRole(
        "general-chat",
        [{ role: "user", content: "hi" }] as ChatMessage[],
        { excludeModels: ["model-a"] },
      );

      expect(result.model).toBe("model-b");
      expect(result.provider).toBe("fake-b");
      expect(result.endpoint).toBe(BASE_B);
      expect(result.endpoint).not.toBe(BASE_A);
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("单模型场景：首选模型即实际执行模型时，endpoint 正确映射", async () => {
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([] as never);
    const executeSpy = spyOn(router, "execute").mockResolvedValue({
      content: "ok",
      model: "model-a",
      provider: "fake-a",
      usage: { total_tokens: 5 },
      latencyMs: 20,
      fallbackUsed: false,
    } as never);

    try {
      const result = await router.executeWithRole(
        "general-chat",
        [{ role: "user", content: "hi" }] as ChatMessage[],
      );
      expect(result.model).toBe("model-a");
      expect(result.endpoint).toBe(BASE_A);
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("执行模型为未知 provider 时 endpoint 安全留空（不抛错）", async () => {
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([] as never);
    const executeSpy = spyOn(router, "execute").mockResolvedValue({
      content: "ok",
      model: "unknown/model",
      provider: "never-heard-of",
      usage: { total_tokens: 5 },
      latencyMs: 10,
      fallbackUsed: true,
    } as never);

    try {
      const result = await router.executeWithRole("general-chat", [{ role: "user", content: "hi" }] as ChatMessage[]);
      expect(result.model).toBe("unknown/model");
      expect(result.provider).toBe("never-heard-of");
      expect(result.endpoint).toBe("");
    } finally {
      executeSpy.mockRestore();
    }
  });
});
