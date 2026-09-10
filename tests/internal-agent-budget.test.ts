import { describe, it, expect, beforeAll, mock } from "bun:test";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const captured: Array<{ role: string; messages: Array<{ role: string; content: string }> }> = [];

mock.module(path.join(ROOT, "src", "router", "model-router.js"), () => ({
  router: {
    execute: async (input: { role: string; messages: Array<{ role: string; content: string }> }) => {
      captured.push({ role: input.role, messages: input.messages });
      return { content: "ok", model: "m", provider: "p", latencyMs: 0, fallbackUsed: false };
    },
    executeWithRole: async (role: string, messages: Array<{ role: string; content: string }>) => {
      captured.push({ role, messages });
      return { role, model: "m", provider: "p", endpoint: "", content: "ok", latency_ms: 0, fallback_used: false };
    },
    chatStream: async function* (role: string, messages: Array<{ role: string; content: string }>) {
      captured.push({ role, messages });
      yield { type: "done", content: "ok", model: "m", provider: "p", fallbackUsed: false };
    },
  },
}));

describe("internalAgent budget", () => {
  let internalAgent: typeof import("../src/agents/internal-agent.js");
  beforeAll(async () => {
    captured.length = 0;
    internalAgent = await import("../src/agents/internal-agent.js");
  });

  it("compresses chat messages when budget is provided", async () => {
    const original = [{ role: "user" as const, content: "x".repeat(500) }];
    await internalAgent.chat(original, "general-chat", { budget: 64 });
    expect(captured.length).toBe(1);
    const sent = captured[0]!.messages;
    expect(sent[0]!.content.length).toBeLessThan(original[0]!.content.length);
  });

  it("keeps chat messages unchanged without budget", async () => {
    captured.length = 0;
    const original = [{ role: "user" as const, content: "hello" }];
    await internalAgent.chat(original, "general-chat");
    expect(captured[0]!.messages).toEqual(original);
  });

  it("compresses executeWithRole messages when budget is provided", async () => {
    captured.length = 0;
    const original = [{ role: "user" as const, content: "y".repeat(500) }];
    await internalAgent.executeWithRole("general-chat", original, { budget: 64 });
    const sent = captured[0]!.messages;
    expect(sent[0]!.content.length).toBeLessThan(original[0]!.content.length);
  });

  it("compresses stream messages when budget is provided", async () => {
    captured.length = 0;
    const original = [{ role: "user" as const, content: "z".repeat(500) }];
    for await (const _ of internalAgent.stream("general-chat", original, { budget: 64 })) {}
    const sent = captured[0]!.messages;
    expect(sent[0]!.content.length).toBeLessThan(original[0]!.content.length);
  });
});
