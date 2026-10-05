import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ContextManager } from "../../src/context/context-manager.js";
import { router, type ChatMessage } from "../../src/router/model-router.js";

function mockRouter(): Array<{ mockRestore: () => void }> {
  return [
    spyOn(router, "executeWithRole").mockResolvedValue({ content: "mock summary" } as never),
    spyOn(router, "embeddings").mockResolvedValue([[1, 0]] as never),
  ];
}

afterEach(() => {
  // Each test restores its own spies in finally; this hook documents that router is never real here.
});

const messages: ChatMessage[] = [
  { role: "system", content: "SYSTEM-RULES" },
  { role: "user", content: "old user" },
  { role: "assistant", content: "old answer" },
  { role: "user", content: "recent user" },
  { role: "assistant", content: "recent answer" },
];

describe("ContextManager system message preservation", () => {
  it("keeps system messages in active messages after splitting", async () => {
    const spies = mockRouter();
    const manager = new ContextManager({ maxContextWindow: 128000 });
    try {
    const result = await manager.splitContext(messages, {
      preserveRecent: 2,
      parallelProcessing: false,
      maxChunkTokens: 1000,
    });

    expect(result.activeMessages[0]).toEqual(messages[0]);
    expect(result.activeMessages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(result.activeMessages.map((m) => m.content)).toEqual([
      "SYSTEM-RULES",
      "recent user",
      "recent answer",
    ]);
    expect(result.archivedChunks.flatMap((chunk) => chunk.messages).some((m) => m.role === "system")).toBe(false);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("replaces the prior compaction summary instead of accumulating it", async () => {
    const spies = mockRouter();
    const manager = new ContextManager({ maxContextWindow: 128000 });
    try {
      const first = await manager.compressContext(messages, { preserveRecent: 2 });
      const withNextTurn = [
        ...first,
        { role: "user" as const, content: "new user" },
        { role: "assistant" as const, content: "new answer" },
      ];
      const second = await manager.compressContext(withNextTurn, { preserveRecent: 2 });
      const summaries = second.filter(
        (m) => m.role === "system" && m.content.includes("Previous conversation summary"),
      );
      expect(summaries).toHaveLength(1);
      expect(second[0]).toEqual(messages[0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("keeps the original system message when compressing", async () => {
    const spies = mockRouter();
    const manager = new ContextManager({ maxContextWindow: 128000 });
    try {
      const compressed = await manager.compressContext(messages, { preserveRecent: 2 });

      expect(compressed[0]).toEqual(messages[0]);
      expect(compressed.some((m) => m.role === "system" && m.content.includes("Previous conversation summary"))).toBe(true);
      expect(compressed.slice(-2).map((m) => m.content)).toEqual(["recent user", "recent answer"]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
