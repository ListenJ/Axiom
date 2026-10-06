import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getEffectiveBaseURL, getProviderConfig } from "../../src/utils/api-key-store.js";
import { findModelsForRole } from "../../src/router/model-capability-registry.js";
import { snapshotEnv } from "../../src/utils/env.js";

const ENV = ["AXIOM_ALLOW_DEV_MODELS", "LOCAL_EMBED_BASE_URL", "LOCAL_EMBED_API_KEY"];
let snap: { restore: () => void };

beforeEach(() => {
  snap = snapshotEnv(ENV);
  delete process.env.AXIOM_ALLOW_DEV_MODELS;
  delete process.env.LOCAL_EMBED_BASE_URL;
  delete process.env.LOCAL_EMBED_API_KEY;
});

afterEach(() => {
  snap.restore();
});

describe("local-embed provider", () => {
  it("is registered with a local OpenAI-compatible endpoint and key env", () => {
    const cfg = getProviderConfig("local-embed");
    expect(cfg).toBeDefined();
    expect(cfg!.apiKeyEnv).toBe("LOCAL_EMBED_API_KEY");
    expect(cfg!.baseURL).toBe("http://127.0.0.1:9001/v1");
  });

  it("uses LOCAL_EMBED_BASE_URL as an explicit override", () => {
    process.env.LOCAL_EMBED_BASE_URL = "http://127.0.0.1:19001/v1";
    const cfg = getProviderConfig("local-embed")!;
    expect(getEffectiveBaseURL("local-embed", cfg.apiKeyEnv, cfg.baseURL)).toBe(
      "http://127.0.0.1:19001/v1",
    );
  });

  it("prefers local BGE-M3 in the release embedding route", () => {
    const models = findModelsForRole("embedding");
    expect(models[0]?.id).toBe("local-bge-m3");
    expect(models.filter((m) => m.provider === "siliconflow")).toEqual([]);
    expect(models.some((m) => m.provider === "local-embed" && m.model === "BAAI/bge-m3")).toBe(true);
  });
});
