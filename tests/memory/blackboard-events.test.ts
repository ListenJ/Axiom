import { describe, expect, it } from "bun:test";
import { SharedBlackboard } from "../../src/memory/blackboard.js";

function makeBb(): SharedBlackboard {
  return new SharedBlackboard();
}

describe("blackboard session event broadcast", () => {
  it("publish delivers to subscribers, unsubscribe stops delivery", () => {
    const bb = makeBb();
    const received: unknown[] = [];
    const unsub = bb.subscribe("workspace:w1:new-note", (p) => received.push(p));
    bb.publish("workspace:w1:new-note", { id: "n1" });
    bb.publish("workspace:w1:new-note", { id: "n2" });
    expect(received).toHaveLength(2);
    unsub();
    bb.publish("workspace:w1:new-note", { id: "n3" });
    expect(received).toHaveLength(2);
  });

  it("subscriber errors do not break broadcast", () => {
    const bb = makeBb();
    let threw = false;
    bb.subscribe("t", () => { threw = true; throw new Error("boom"); });
    bb.subscribe("t", (p) => { received2.push(p); });
    bb.publish("t", { ok: true });
    expect(threw).toBe(true);
    expect(received2).toHaveLength(1);
  });

  it("write automatically publishes blackboard:write:<key> (cross-session awareness)", () => {
    const bb = makeBb();
    const received: unknown[] = [];
    bb.subscribe("blackboard:write:order:123", (p) => received.push(p));
    bb.write("order:123", "PAID", "session-a", { confidence: 0.95, status: "verified" });
    expect(received).toHaveLength(1);
    const evt = received[0] as { key: string; sourceId: string; status: string };
    expect(evt.key).toBe("order:123");
    expect(evt.sourceId).toBe("session-a");
    expect(evt.status).toBe("verified");
    // 未订阅的 key 不打扰
    bb.write("order:999", "X", "session-b");
    expect(received).toHaveLength(1);
  });
});
const received2: unknown[] = [];
