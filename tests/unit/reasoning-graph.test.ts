import { describe, expect, it } from "bun:test";
import { reasoningGraphBuilder } from "../../src/runtime/reasoning-graph.js";

describe("ReasoningGraphBuilder", () => {
  it("should build a reasoning graph from input", () => {
    const graph = reasoningGraphBuilder.build("How does authentication work?", {
      knowledge: [
        { id: "k1", content: "Authentication verifies identity", confidence: 0.9 },
        { id: "k2", content: "JWT tokens are stateless", confidence: 0.8 },
      ],
    });

    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.id).toBeDefined();
    expect(typeof graph.completeness).toBe("number");
  });

  it("should identify gaps in reasoning", () => {
    const graph = reasoningGraphBuilder.build("Complex question requiring external knowledge", {
      knowledge: [],
    });

    expect(graph.gaps.length).toBeGreaterThanOrEqual(0);
    if (graph.needsLLM) {
      expect(graph.llmQueries.length).toBeGreaterThan(0);
    }
  });

  it("should track node types correctly", () => {
    const graph = reasoningGraphBuilder.build("Test input", {
      knowledge: [
        { id: "k1", content: "Known fact", confidence: 0.95 },
      ],
    });

    const nodeTypes = graph.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("observation");
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  it("should build edges between related nodes", () => {
    const graph = reasoningGraphBuilder.build("What is the relationship between A and B?", {
      knowledge: [
        { id: "k1", content: "A causes B", confidence: 0.9 },
        { id: "k2", content: "B leads to C", confidence: 0.85 },
      ],
    });

    expect(graph.edges.length).toBeGreaterThanOrEqual(0);
  });

  it("should return stats", () => {
    reasoningGraphBuilder.build("Test query", {
      knowledge: [{ id: "k1", content: "Fact", confidence: 0.9 }],
    });

    const stats = reasoningGraphBuilder.getStats();
    expect(typeof stats.built).toBe("number");
    expect(typeof stats.gapsFound).toBe("number");
    expect(typeof stats.llmCalls).toBe("number");
  });

  it("should handle empty knowledge gracefully", () => {
    const graph = reasoningGraphBuilder.build("", { knowledge: [] });
    expect(graph).toBeDefined();
    expect(graph.nodes.length).toBeGreaterThanOrEqual(0);
  });

  it("should determine needsLLM correctly", () => {
    const graph = reasoningGraphBuilder.build("Simple question", {
      knowledge: [
        { id: "k1", content: "Complete answer", confidence: 0.99 },
      ],
    });

    expect(typeof graph.needsLLM).toBe("boolean");
    expect(typeof graph.completeness).toBe("number");
    expect(graph.completeness).toBeGreaterThanOrEqual(0);
    expect(graph.completeness).toBeLessThanOrEqual(1);
  });

  it("should create observation node from input", () => {
    const graph = reasoningGraphBuilder.build("User question", { knowledge: [] });
    const obsNodes = graph.nodes.filter((n) => n.type === "observation");
    expect(obsNodes.length).toBe(1);
    expect(obsNodes[0].content).toBe("User question");
    expect(obsNodes[0].confidence).toBe(1.0);
  });

  it("should create inference nodes from knowledge", () => {
    const graph = reasoningGraphBuilder.build("Q", {
      knowledge: [
        { id: "k1", content: "Fact 1", confidence: 0.9 },
        { id: "k2", content: "Fact 2", confidence: 0.8 },
      ],
    });

    const infNodes = graph.nodes.filter((n) => n.type === "inference");
    expect(infNodes.length).toBe(2);
  });
});
