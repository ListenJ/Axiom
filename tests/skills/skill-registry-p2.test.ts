import { describe, expect, it, spyOn } from "bun:test";
import { getSkillRegistry } from "../../src/skills/skill-registry.js";
import { router } from "../../src/services/index.js";

function skill(id: string, name: string): Parameters<ReturnType<typeof getSkillRegistry>["register"]>[0] {
  return { id, name, description: "d", triggers: [name], promptTemplate: "prompt {{input}}", requiredTools: [], outputFormat: "text" as const, version: "1.0", source: "hermes" as const };
}

describe("skill-registry P2 (reload preserve + execute options)", () => {
  it("preserves runtime hermes skills across reload", () => {
    const reg = getSkillRegistry();
    reg.register(skill("auto-fix-test-reload", "reload-x"));
    reg.reload();
    expect(reg.get("auto-fix-test-reload")).toBeDefined();
  });

  it("forwards maxTokens/timeout/signal to router.executeWithRole", async () => {
    const reg = getSkillRegistry();
    const spy = spyOn(router, "executeWithRole").mockImplementation(async () => ({
      role: "general-chat", model: "m", provider: "p", endpoint: "", content: "ok", latency_ms: 1, fallback_used: false,
    }));
    const signal = new AbortController().signal;
    reg.register(skill("auto-fix-test-opt", "opt-x"));
    await reg.executeById("auto-fix-test-opt", {}, undefined, { maxTokens: 128, timeout: 9000, signal });
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.maxTokens).toBe(128);
    expect(opts.timeout).toBe(9000);
    expect(opts.signal).toBe(signal);
    spy.mockRestore();
  });
});
