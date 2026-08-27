import { describe, expect, it } from "bun:test";
import {
  scoreDistillationCandidate,
  selectDistillationCandidates,
} from "../../src/memory/distillation-priority.js";

describe("distillation priority", () => {
  it("scores by age, confidence and richness", () => {
    const old = scoreDistillationCandidate({ ageDays: 90, confidence: 0.9, contentLength: 4000 });
    const fresh = scoreDistillationCandidate({ ageDays: 5, confidence: 0.9, contentLength: 4000 });
    expect(old.shouldDistill).toBe(true);
    expect(fresh.shouldDistill).toBe(false);
    expect(old.score).toBeGreaterThan(fresh.score);
  });

  it("selects the highest priority candidates within the limit", () => {
    const selected = selectDistillationCandidates([
      { id: "old-high", ageDays: 90, confidence: 0.9, contentLength: 4000 },
      { id: "old-low", ageDays: 90, confidence: 0.4, contentLength: 500 },
      { id: "fresh-high", ageDays: 10, confidence: 0.9, contentLength: 4000 },
    ], 2);
    expect(selected.map((s) => s.id)).toEqual(["old-high", "old-low"]);
  });

  it("weights change ordering", () => {
    const confidenceWeighted = scoreDistillationCandidate(
      { ageDays: 60, confidence: 0.95, contentLength: 100 },
      { age: 0.1, confidence: 0.8, richness: 0.1 },
    );
    const ageWeighted = scoreDistillationCandidate(
      { ageDays: 60, confidence: 0.95, contentLength: 100 },
      { age: 0.8, confidence: 0.1, richness: 0.1 },
    );
    expect(confidenceWeighted.score).toBeGreaterThan(ageWeighted.score);
  });
});