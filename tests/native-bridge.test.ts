import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import {
  detectEdition,
  initNativeBridge,
  stopNativeBridge,
  nativeSearch,
  nativeRouterPerf,
  nativeStats,
  isNativeReady,
  getNativeEdition,
  type NativeEdition,
} from "../src/native-bridge.js";

describe("Native Bridge v2.3", () => {
  afterAll(() => {
    stopNativeBridge();
  });

  it("should detect edition from env", () => {
    const original = process.env.AXIOM_EDITION;
    process.env.AXIOM_EDITION = "cloud";
    expect(detectEdition()).toBe("cloud");
    process.env.AXIOM_EDITION = "local";
    expect(detectEdition()).toBe("local");
    delete process.env.AXIOM_EDITION;
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    expect(detectEdition()).toBe("local");
    if (original) process.env.AXIOM_EDITION = original;
  });

  it("should detect cloud edition from DATABASE_URL", () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test";
    expect(detectEdition()).toBe("cloud");
    if (original) process.env.DATABASE_URL = original;
    else delete process.env.DATABASE_URL;
  });

  it("should not be ready before init", () => {
    expect(isNativeReady()).toBe(false);
  });

  it("should return edition even when not ready", () => {
    expect(getNativeEdition()).toBe("local"); // default
  });

  it("should return empty array when native not ready", async () => {
    const results = await nativeSearch("test");
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it("should return null when native not ready", async () => {
    const perf = await nativeRouterPerf();
    expect(perf).toBeNull();
    const stats = await nativeStats();
    expect(stats).toBeNull();
  });

  it("should init with enabled=false return false", async () => {
    const result = await initNativeBridge({ enabled: false });
    expect(result).toBe(false);
  });

  it("should init and detect missing binary gracefully", async () => {
    const result = await initNativeBridge({
      edition: "local",
      port: 19999,
      enabled: true,
      vaultPath: "./axiom-memory",
    });
    // Binary not built yet, should return false but not throw
    expect(typeof result).toBe("boolean");
    stopNativeBridge();
  }, 10000);
});

describe("Native Bridge Types", () => {
  it("should have correct type exports", () => {
    const edition: NativeEdition = "local";
    expect(edition).toBe("local");
  });
});
