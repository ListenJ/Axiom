import { describe, it, expect, beforeEach } from "bun:test";
import {
  recordTraceEntry,
  getTraceEntries,
  clearTrace,
  analyzeTrace,
} from "../src/agents/consciousness/trace-analyzer.js";
import type { TraceEntry } from "../src/agents/consciousness/trace-analyzer.js";

function makeEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    timestamp: Date.now(),
    stepType: "think",
    inputHash: "in-" + Math.random().toString(36).slice(2, 6),
    outputHash: "out-" + Math.random().toString(36).slice(2, 6),
    confidence: 0.8,
    success: true,
    ...overrides,
  };
}

describe("Trace Analyzer", () => {
  beforeEach(() => {
    clearTrace();
  });

  it("records entries and respects max size", () => {
    for (let i = 0; i < 110; i++) {
      recordTraceEntry(makeEntry());
    }
    expect(getTraceEntries().length).toBeLessThanOrEqual(100);
  });

  it("detects consecutive failures", () => {
    // Add 5 failures in a row
    for (let i = 0; i < 5; i++) {
      recordTraceEntry(makeEntry({ success: false }));
    }
    const anomaly = analyzeTrace();
    expect(anomaly).not.toBeNull();
    expect(anomaly!.type).toBe("consecutive-failures");
    expect(anomaly!.severity).toBeGreaterThan(0);
  });

  it("does not trigger on isolated failures", () => {
    recordTraceEntry(makeEntry({ success: false }));
    recordTraceEntry(makeEntry({ success: true }));
    recordTraceEntry(makeEntry({ success: false }));
    recordTraceEntry(makeEntry({ success: true }));
    const anomaly = analyzeTrace();
    expect(anomaly).toBeNull();
  });

  it("detects output inconsistency in think steps", () => {
    // Same output hash for most think steps
    const sameHash = "same-output-hash";
    for (let i = 0; i < 8; i++) {
      recordTraceEntry(makeEntry({
        stepType: "think",
        outputHash: i < 6 ? sameHash : "different-" + i,
      }));
    }
    const anomaly = analyzeTrace();
    expect(anomaly).not.toBeNull();
    expect(anomaly!.type).toBe("output-inconsistency");
  });

  it("detects confidence variance", () => {
    // Wildly different confidences
    const confidences = [0.1, 0.9, 0.2, 0.8, 0.15, 0.85, 0.1, 0.9];
    for (const confidence of confidences) {
      recordTraceEntry(makeEntry({ confidence }));
    }
    const anomaly = analyzeTrace();
    expect(anomaly).not.toBeNull();
    expect(anomaly!.type).toBe("confidence-variance");
  });

  it("returns null when trace is healthy", () => {
    // Normal entries with varied outputs and stable confidence
    for (let i = 0; i < 10; i++) {
      recordTraceEntry(makeEntry({
        outputHash: "unique-" + i,
        confidence: 0.75 + Math.random() * 0.1,
        success: true,
      }));
    }
    const anomaly = analyzeTrace();
    expect(anomaly).toBeNull();
  });

  it("returns null with too few entries", () => {
    recordTraceEntry(makeEntry());
    expect(analyzeTrace()).toBeNull();
  });
});
