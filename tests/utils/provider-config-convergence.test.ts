/**
 * PROVIDER_CONFIG 收敛护栏 — router 兼容层必须与 api-key-store 唯一事实源一致。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { getProviderConfig } from "../../src/utils/api-key-store.js";
import {
  PROVIDER_CONFIG,
  isProviderConfigured,
  listConfiguredProviders,
} from "../../src/router/models/providers.js";

const SAVED: Record<string, string | undefined> = {};
for (const k of ["DEEPSEEK_API_KEY", "KIMI_API_KEY", "OPENROUTER_API_KEY"]) {
  SAVED[k] = process.env[k];
}
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("PROVIDER_CONFIG convergence", () => {
  test("every router provider resolves in api-key-store with identical values", () => {
    for (const [provider, cfg] of Object.entries(PROVIDER_CONFIG)) {
      const src = getProviderConfig(provider);
      expect(src, `missing in api-key-store: ${provider}`).toBeDefined();
      expect(src!.baseURL, `baseURL mismatch: ${provider}`).toBe(cfg.baseURL);
      expect(src!.apiKeyEnv, `apiKeyEnv mismatch: ${provider}`).toBe(cfg.apiKeyEnv);
    }
  });

  test("listConfiguredProviders reflects env keys", () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.KIMI_API_KEY = "test-key";
    const list = listConfiguredProviders();
    expect(list).toContain("deepseek");
    expect(list).toContain("kimi");
  });

  test("isProviderConfigured is false when key unset", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(isProviderConfigured("openrouter")).toBe(false);
  });
});
