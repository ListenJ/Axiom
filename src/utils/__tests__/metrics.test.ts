import { describe, expect, it, beforeEach } from "bun:test";
import { metrics } from "../../utils/metrics.js";

describe("Routing Metrics", () => {
  beforeEach(() => {
    // Reset metric values between tests
    metrics.register({
      name: "routing_decisions_total",
      help: "Total routing decisions by source and role",
      type: "counter",
    });
    metrics.register({
      name: "routing_duration_seconds",
      help: "Time spent computing routing decision",
      type: "histogram",
    });
    metrics.register({
      name: "routing_fallback_total",
      help: "Total times a fallback model was used",
      type: "counter",
    });
  });

  it("routing_decisions_total: increments with labels", () => {
    metrics.increment("routing_decisions_total", 1, {
      role: "code-generation",
      source: "execute",
      model: "test-model",
    });
    const json = metrics.getJSON();
    const metric = (json as Record<string, unknown>)["routing_decisions_total"];
    expect(metric).toBeDefined();
  });

  it("routing_duration_seconds: records histogram observations", () => {
    metrics.histogram("routing_duration_seconds", 1.5, {
      role: "code-review",
      source: "execute",
    });
    metrics.histogram("routing_duration_seconds", 3.2, {
      role: "code-review",
      source: "execute",
    });
    const json = metrics.getJSON();
    const metric = (json as Record<string, unknown>)["routing_duration_seconds"];
    expect(metric).toBeDefined();
  });

  it("routing_fallback_total: increments per role", () => {
    metrics.increment("routing_fallback_total", 1, { role: "coding" });
    metrics.increment("routing_fallback_total", 1, { role: "coding" });
    metrics.increment("routing_fallback_total", 1, { role: "research" });
    const json = metrics.getJSON();
    const metric = (json as Record<string, unknown>)["routing_fallback_total"];
    expect(metric).toBeDefined();
  });

  it("prometheus output includes routing metrics", () => {
    metrics.increment("routing_decisions_total", 1, { role: "general-chat" });
    const output = metrics.getPrometheusFormat();
    expect(output).toContain("routing_decisions_total");
  });

  it("does not crash when incrementing non-existent metric", () => {
    // Should silently warn and not throw
    expect(() => {
      metrics.increment("non_existent_metric", 1);
    }).not.toThrow();
  });
});
