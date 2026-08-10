import { describe, it, expect } from "bun:test";
import { ContextAssembler } from "../../src/components/context-assembler.js";
import type {
  ComponentMessage,
  TokenBudgetContract,
} from "../../src/components/contracts.js";

const longMessages: ComponentMessage[] = [
  { role: "system", content: "s".repeat(600) },
  { role: "user", content: "u".repeat(600) },
];

describe("ContextAssembler", () => {
  it("keeps messages unchanged when under budget", async () => {
    const assembler = new ContextAssembler();
    const messages: ComponentMessage[] = [
      { role: "user", content: "hello" },
    ];
    const result = await assembler.assemble({
      messages,
      role: "general-chat",
      budget: 10000,
    });
    expect(result.messages).toEqual(messages);
    expect(result.tokenBudgetReport.mode).toBe("none");
  });

  it("compresses oversized messages", async () => {
    const assembler = new ContextAssembler();
    const result = await assembler.assemble({
      messages: longMessages,
      role: "general-chat",
      budget: 100,
    });
    expect(result.tokenBudgetReport.originalTokens).toBeGreaterThan(
      result.tokenBudgetReport.compressedTokens,
    );
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("falls back to original messages when compression throws", async () => {
    const failingBudget: TokenBudgetContract = {
      estimate: () => 0,
      estimateMessages: () => 0,
      trimMessage: (message) => message,
      compress: async () => {
        throw new Error("compression failed");
      },
      report: () => ({
        originalTokens: 0,
        compressedTokens: 0,
        rate: 0,
        mode: "none",
        itemCount: 0,
        dropped: 0,
        truncated: 0,
        preservedRecent: 0,
      }),
    };
    const assembler = new ContextAssembler(failingBudget);
    const result = await assembler.assemble({
      messages: longMessages,
      role: "general-chat",
      budget: 100,
    });
    expect(result.messages).toEqual(longMessages);
    expect(result.tokenBudgetReport.mode).toBe("none");
  });

  it("exposes lifecycle health", async () => {
    const assembler = new ContextAssembler();
    expect(assembler.id).toBe("context-assembler");
    expect(assembler.dependencies).toContain("token-budget");
    const health = await assembler.health();
    expect(health.ready).toBe(true);
  });

  it("uses adaptive compaction before token budget", async () => {
    let received: ComponentMessage[] = [];
    const fakeBudget: TokenBudgetContract = {
      estimate: () => 0,
      estimateMessages: () => 0,
      trimMessage: (message) => message,
      compress: async (messages) => {
        received = messages;
        return {
          messages,
          mode: "none",
          originalTokens: 0,
          compressedTokens: 0,
          rate: 0,
          itemCount: messages.length,
          dropped: 0,
          truncated: 0,
          preservedRecent: 0,
        };
      },
      report: () => ({
        originalTokens: 0,
        compressedTokens: 0,
        rate: 0,
        mode: "none",
        itemCount: 0,
        dropped: 0,
        truncated: 0,
        preservedRecent: 0,
      }),
    };
    const assembler = new ContextAssembler(fakeBudget);
    const messages: ComponentMessage[] = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `m`.repeat(100) + i }));
    const result = await assembler.assemble({ messages, role: "general-chat", budget: 50 });
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(received.length).toBeLessThan(messages.length);
    expect(result.tokenBudgetReport.mode).toBe("compress");
  });
});
