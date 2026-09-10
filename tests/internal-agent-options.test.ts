import { describe, expect, it, spyOn } from "bun:test";
import { router } from "../src/services/index.js";
import { internalAgent } from "../src/agents/internal-agent.js";

const MSG = [{ role: "user" as const, content: "hi" }];

describe("option passthrough (P1-2)", () => {
  it("internalAgent.chat forwards maxTokens/timeout/signal/trackAs to router.execute", async () => {
    const spy = spyOn(router, "execute").mockImplementation(async () => ({
      content: "x", model: "m", provider: "p", latencyMs: 1, fallbackUsed: false,
    }));
    const signal = new AbortController().signal;
    await internalAgent.chat(MSG, "general-chat", {
      maxTokens: 512, timeout: 60_000, signal, trackAs: "custom-tag", temperature: 0.2,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const input = spy.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(input.maxTokens).toBe(512);
    expect(input.timeout).toBe(60_000);
    expect(input.signal).toBe(signal);
    expect(input.trackAs).toBe("custom-tag");
    expect(input.temperature).toBe(0.2);
    spy.mockRestore();
  });

  it("internalAgent.executeWithRole forwards maxTokens/timeout/signal/trackAs", async () => {
    const spy = spyOn(router, "executeWithRole").mockImplementation(async () => ({
      role: "general-chat", model: "m", provider: "p", endpoint: "", content: "x", latency_ms: 1, fallback_used: false,
    }));
    const signal = new AbortController().signal;
    await internalAgent.executeWithRole("code-review", MSG, {
      maxTokens: 256, timeout: 30_000, signal, trackAs: "review-tag", excludeModels: ["x/y"],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][2] as unknown as Record<string, unknown>;
    expect(opts.maxTokens).toBe(256);
    expect(opts.timeout).toBe(30_000);
    expect(opts.signal).toBe(signal);
    expect(opts.trackAs).toBe("review-tag");
    expect(opts.excludeModels).toEqual(["x/y"]);
    spy.mockRestore();
  });

  it("router.executeWithRole forwards maxTokens to router.execute", async () => {
    const spy = spyOn(router, "execute").mockImplementation(async () => ({
      content: "x", model: "m", provider: "p", latencyMs: 1, fallbackUsed: false,
    }));
    const signal = new AbortController().signal;
    await router.executeWithRole("general-chat", MSG, { maxTokens: 512, timeout: 60_000, signal, trackAs: "t" });
    expect(spy).toHaveBeenCalledTimes(1);
    const input = spy.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(input.maxTokens).toBe(512);
    expect(input.timeout).toBe(60_000);
    expect(input.signal).toBe(signal);
    expect(input.trackAs).toBe("t");
    spy.mockRestore();
  });
});
