import { describe, it, expect, beforeEach } from "bun:test";
import { ActivityTracker } from "../src/agents/consciousness/activity-tracker.js";

describe("ActivityTracker", () => {
  let tracker: ActivityTracker;

  beforeEach(() => {
    tracker = new ActivityTracker();
  });

  it("starts with zero turns", () => {
    expect(tracker.getTurnCount()).toBe(0);
  });

  it("increments turn count on bump", () => {
    tracker.bumpUserActivity("hello", { intent: "chat", agentName: "General" });
    tracker.bumpUserActivity("code this", { intent: "code", agentName: "Code" });
    expect(tracker.getTurnCount()).toBe(2);
  });

  it("detects topic shift after 6 different intents", () => {
    // No shift with < 6 intents
    tracker.bumpUserActivity("a", { intent: "code", agentName: "A" });
    tracker.bumpUserActivity("b", { intent: "code", agentName: "A" });
    tracker.bumpUserActivity("c", { intent: "code", agentName: "A" });
    expect(tracker.detectTopicShift()).toBe(false);

    // Add 3 research intents (different from code)
    tracker.bumpUserActivity("d", { intent: "research", agentName: "B" });
    tracker.bumpUserActivity("e", { intent: "research", agentName: "B" });
    tracker.bumpUserActivity("f", { intent: "research", agentName: "B" });

    // Now recent 3 are research, previous 3 are code → shift
    expect(tracker.detectTopicShift()).toBe(true);
  });

  it("no topic shift when intents overlap", () => {
    for (let i = 0; i < 6; i++) {
      tracker.bumpUserActivity("msg", { intent: "code", agentName: "A" });
    }
    expect(tracker.detectTopicShift()).toBe(false);
  });

  it("getDominantIntent returns most frequent", () => {
    tracker.bumpUserActivity("a", { intent: "code", agentName: "A" });
    tracker.bumpUserActivity("b", { intent: "code", agentName: "A" });
    tracker.bumpUserActivity("c", { intent: "research", agentName: "B" });
    expect(tracker.getDominantIntent()).toBe("code");
  });

  it("getDominantIntent returns null when empty", () => {
    expect(tracker.getDominantIntent()).toBeNull();
  });

  it("getIdleMs returns Infinity when no activity", () => {
    expect(tracker.getIdleMs()).toBe(Number.POSITIVE_INFINITY);
  });

  it("getIdleMs returns finite after activity", () => {
    tracker.bumpUserActivity("hi", { intent: "chat", agentName: "General" });
    expect(tracker.getIdleMs()).toBeLessThan(1000);
  });

  it("resetCounters clears patterns but keeps activity", () => {
    tracker.bumpUserActivity("a", { intent: "code", agentName: "A" });
    tracker.resetCounters();
    expect(tracker.snapshot().length).toBe(0);
    expect(tracker.getIdleMs()).toBeLessThan(1000);
  });
});
