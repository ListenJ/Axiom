import { describe, it, expect } from "bun:test";
import { TokenBudget } from "../../src/components/token-budget.js";
import type { ComponentMessage } from "../../src/components/contracts.js";

describe("TokenBudget", () => {
  it("estimates mixed Chinese and English text", () => {
    const budget = new TokenBudget();
    const tokens = budget.estimate("你好 world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(20);
  });

  it("trims a single message to the token budget", () => {
    const budget = new TokenBudget();
    const message: ComponentMessage = {
      role: "user",
      content: "word ".repeat(1000),
    };
    const trimmed = budget.trimMessage(message, 20);
    expect(trimmed.content.length).toBeLessThan(message.content.length);
    expect(budget.estimateMessages([trimmed])).toBeLessThanOrEqual(20);
  });

  it("does not change messages under budget", async () => {
    const budget = new TokenBudget();
    const messages: ComponentMessage[] = [
      { role: "system", content: "short system" },
      { role: "user", content: "short user" },
    ];
    const result = await budget.compress(messages, 10000);
    expect(result.mode).toBe("none");
    expect(result.messages).toEqual(messages);
    expect(result.originalTokens).toBe(result.compressedTokens);
  });

  it("drops low-value context and preserves recent messages", async () => {
    const budget = new TokenBudget();
    const oldBlocks: ComponentMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: "system",
      content: `retrieval block ${i} ` + "x".repeat(80),
    }));
    const recent: ComponentMessage[] = [
      { role: "user", content: "keep this recent instruction" },
    ];
    const messages = [...oldBlocks, ...recent];
    const result = await budget.compress(messages, 300, { preserveRecent: 1 });

    expect(result.messages.at(-1)?.content).toBe("keep this recent instruction");
    expect(result.compressedTokens).toBeLessThanOrEqual(300);
    expect(result.originalTokens).toBeGreaterThan(result.compressedTokens);
    expect(result.rate).toBeGreaterThan(0);
    expect(result.rate).toBeLessThan(1);
  });

  it("returns a report with compression metadata", async () => {
    const budget = new TokenBudget();
    const messages: ComponentMessage[] = [
      { role: "system", content: "s".repeat(200) },
      { role: "user", content: "u".repeat(200) },
    ];
    await budget.compress(messages, 100);
    const report = budget.report();
    expect(report.originalTokens).toBeGreaterThan(report.compressedTokens);
    expect(report.mode).not.toBe("none");
    expect(report.itemCount).toBe(2);
  });
});
