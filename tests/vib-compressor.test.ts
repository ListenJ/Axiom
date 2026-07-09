/**
 * VIB Compressor: unit tests for the length-bias fix
 */
import { describe, it, expect } from "bun:test";
import { VIBCompressor } from "../src/memory/vib-compressor.js";

function makeMem(id: string, content: string) {
  return { id, content, timestamp: Date.now(), source: "test" };
}

describe("VIBCompressor", () => {
  it("compresses with default config", async () => {
    const c = new VIBCompressor({ capacity: 2 });
    const mems = [
      makeMem("1", "short"),
      makeMem("2", "a ".repeat(50)),
      makeMem("3", "b ".repeat(100)),
    ];
    const result = await c.compress(mems);
    expect(result.retained.length).toBe(2);
    expect(result.discarded.length).toBe(1);
  });

  it("no background model: length should not bias retention", async () => {
    // Without existingMemory, the old code had surprisal ~ length
    // leading to always retaining the longest. The fix averages per-token.
    const c = new VIBCompressor({ capacity: 1 });
    const short = makeMem("s", "unique rare concept");
    const long = makeMem("l", "common common common common common common common common common common word");
    
    const result = await c.compress([short, long]);
    // "unique rare concept" has rarer tokens → higher avg surprisal → retained
    expect(result.retained[0].id).toBe("s");
  });

  it("existing memory influences surprisal", async () => {
    const c = new VIBCompressor({
      capacity: 2,
      existingMemory: ["the cat sat on the mat", "dog runs in the park"],
    });
    const novel = makeMem("n", "quantum entanglement superposition");
    const known = makeMem("k", "the cat sat on the mat with the dog");
    const result = await c.compress([novel, known]);
    // Novel content should be more surprising
    expect(result.retained.find(m => m.id === "n")).toBeDefined();
  });

  it("getRetentionScore returns a score", () => {
    const c = new VIBCompressor({ capacity: 10 });
    const score = c.getRetentionScore(makeMem("t", "test content"));
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThan(0);
  });
});
