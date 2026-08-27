import { describe, expect, it } from "bun:test";
import {
  compactionTokens,
  planAdaptiveCompaction,
} from "../../src/components/adaptive-compaction.js";

function msg(content: string, role = "user", pairId?: string) {
  return { content, role, pairId };
}

describe("AdaptiveCompaction", () => {
  it("keeps small contexts untouched", () => {
    const messages = [msg("hello")];
    const plan = planAdaptiveCompaction(messages);
    expect(plan.level).toBe("none");
    expect(plan.active).toHaveLength(1);
    expect(plan.archived).toHaveLength(0);
  });

  it("agent compaction archives middle content above threshold", () => {
    const messages = Array.from({ length: 60 }, (_, i) => msg(`message ${i}`));
    const plan = planAdaptiveCompaction(messages, { headTokens: 20, tailMessages: 4, maxContextTokens: 500 });
    expect(plan.level).toBe("agent");
    expect(plan.archived.length).toBeGreaterThan(0);
    expect(plan.activeTokens).toBeLessThan(plan.originalTokens);
  });

  it("keeps tool pair atomic", () => {
    const messages = [
      msg("assistant asks", "assistant", "pair-1"),
      msg("tool result", "tool", "pair-1"),
      ...Array.from({ length: 40 }, (_, i) => msg(`middle ${i}`)),
    ];
    const plan = planAdaptiveCompaction(messages, { headTokens: 20, tailMessages: 2 });
    const pairInActive = plan.active.some((m) => m.pairId === "pair-1");
    const pairInArchived = plan.archived.some((m) => m.pairId === "pair-1");
    expect(pairInActive).not.toBe(pairInArchived);
  });

  it("compactionTokens counts messages", () => {
    expect(compactionTokens([msg("hello")])).toBeGreaterThan(4);
  });

  it("gateway compaction triggers above 85%", () => {
    const messages = Array.from({ length: 60 }, (_, i) => msg(`message ${i}`));
    const plan = planAdaptiveCompaction(messages, { headTokens: 20, tailMessages: 4, maxContextTokens: 300 });
    expect(plan.level).toBe("gateway");
    expect(plan.archived.length).toBeGreaterThan(0);
  });
});
