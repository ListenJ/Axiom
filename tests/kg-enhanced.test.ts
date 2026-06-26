/**
 * 知识图谱增强模块测试
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeGraphEnhanced } from "../src/kg/enhanced";

describe("KnowledgeGraphEnhanced", () => {
  let db: Database;
  let kg: KnowledgeGraphEnhanced;

  beforeAll(() => {
    db = new Database(":memory:");
    kg = new KnowledgeGraphEnhanced(db);
  });

  afterAll(() => {
    db.close();
  });

  describe("Node Management", () => {
    test("add and get node", () => {
      kg.addNode({
        id: "func-1",
        type: "function",
        name: "handleRequest",
        description: "Handles HTTP requests",
        filePath: "src/server.ts",
        lineNumber: 42,
        signature: "(req: Request) => Response",
        tags: ["http", "handler"],
        importance: 0.8,
      });

      const node = kg.getNode("func-1");
      expect(node).not.toBeNull();
      expect(node?.name).toBe("handleRequest");
      expect(node?.type).toBe("function");
      expect(node?.importance).toBe(0.8);
    });

    test("search nodes by name", () => {
      kg.addNode({
        id: "class-1",
        type: "class",
        name: "UserService",
        description: "Manages user operations",
        tags: ["user", "service"],
      });

      const results = kg.searchNodes("UserService");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe("UserService");
    });

    test("search nodes by description", () => {
      kg.addNode({
        id: "module-1",
        type: "module",
        name: "auth",
        description: "Authentication and authorization module",
      });

      const results = kg.searchNodes("authentication");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    test("search nodes with type filter", () => {
      kg.addNode({
        id: "func-2",
        type: "function",
        name: "authenticate",
        description: "Authenticates user",
      });

      kg.addNode({
        id: "class-2",
        type: "class",
        name: "Authenticator",
        description: "Authentication handler",
      });

      const funcResults = kg.searchNodes("auth", { type: "function" });
      expect(funcResults.every((n) => n.type === "function")).toBe(true);

      const classResults = kg.searchNodes("auth", { type: "class" });
      expect(classResults.every((n) => n.type === "class")).toBe(true);
    });
  });

  describe("Edge Management", () => {
    test("add and get edge", () => {
      kg.addNode({ id: "edge-src", type: "function", name: "caller" });
      kg.addNode({ id: "edge-dst", type: "function", name: "callee" });

      kg.addEdge({
        id: "edge-1",
        source: "edge-src",
        target: "edge-dst",
        type: "calls",
        weight: 1.0,
      });

      const outEdges = kg.getOutEdges("edge-src");
      expect(outEdges.length).toBe(1);
      expect(outEdges[0].target).toBe("edge-dst");

      const inEdges = kg.getInEdges("edge-dst");
      expect(inEdges.length).toBe(1);
      expect(inEdges[0].source).toBe("edge-src");
    });

    test("get neighbors", () => {
      kg.addNode({ id: "nbr-1", type: "function", name: "func1" });
      kg.addNode({ id: "nbr-2", type: "function", name: "func2" });
      kg.addNode({ id: "nbr-3", type: "function", name: "func3" });

      kg.addEdge({ id: "nbr-e1", source: "nbr-1", target: "nbr-2", type: "calls", weight: 1.0 });
      kg.addEdge({ id: "nbr-e2", source: "nbr-1", target: "nbr-3", type: "calls", weight: 1.0 });

      const neighbors = kg.getNeighbors("nbr-1");
      expect(neighbors.length).toBe(2);
    });
  });

  describe("Graph Queries", () => {
    test("subgraph retrieval", () => {
      kg.addNode({ id: "sg-center", type: "class", name: "Center" });
      kg.addNode({ id: "sg-n1", type: "function", name: "Neighbor1" });
      kg.addNode({ id: "sg-n2", type: "function", name: "Neighbor2" });
      kg.addNode({ id: "sg-n3", type: "function", name: "Neighbor3" });

      kg.addEdge({ id: "sg-e1", source: "sg-center", target: "sg-n1", type: "contains", weight: 1.0 });
      kg.addEdge({ id: "sg-e2", source: "sg-center", target: "sg-n2", type: "contains", weight: 1.0 });
      kg.addEdge({ id: "sg-e3", source: "sg-n1", target: "sg-n3", type: "calls", weight: 1.0 });

      const subgraph = kg.subgraph("sg-center", 2);
      expect(subgraph.nodes.length).toBe(4);
      expect(subgraph.edges.length).toBe(3);
    });

    test("shortest path", () => {
      kg.addNode({ id: "sp-a", type: "function", name: "A" });
      kg.addNode({ id: "sp-b", type: "function", name: "B" });
      kg.addNode({ id: "sp-c", type: "function", name: "C" });
      kg.addNode({ id: "sp-d", type: "function", name: "D" });

      kg.addEdge({ id: "sp-e1", source: "sp-a", target: "sp-b", type: "calls", weight: 1.0 });
      kg.addEdge({ id: "sp-e2", source: "sp-b", target: "sp-c", type: "calls", weight: 1.0 });
      kg.addEdge({ id: "sp-e3", source: "sp-c", target: "sp-d", type: "calls", weight: 1.0 });

      const path = kg.shortestPath("sp-a", "sp-d");
      expect(path).toEqual(["sp-a", "sp-b", "sp-c", "sp-d"]);
    });

    test("find paths", () => {
      kg.addNode({ id: "fp-a", type: "function", name: "A" });
      kg.addNode({ id: "fp-b", type: "function", name: "B" });
      kg.addNode({ id: "fp-c", type: "function", name: "C" });

      kg.addEdge({ id: "fp-e1", source: "fp-a", target: "fp-b", type: "calls", weight: 1.0 });
      kg.addEdge({ id: "fp-e2", source: "fp-b", target: "fp-c", type: "calls", weight: 1.0 });
      kg.addEdge({ id: "fp-e3", source: "fp-a", target: "fp-c", type: "calls", weight: 1.0 });

      const paths = kg.findPaths("fp-a", "fp-c", 3);
      expect(paths.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Community Detection", () => {
    test("detect communities", () => {
      // Community 1
      kg.addNode({ id: "cd-1", type: "function", name: "Func1" });
      kg.addNode({ id: "cd-2", type: "function", name: "Func2" });
      kg.addEdge({ id: "cd-e1", source: "cd-1", target: "cd-2", type: "calls", weight: 1.0 });

      // Community 2
      kg.addNode({ id: "cd-3", type: "class", name: "Class1" });
      kg.addNode({ id: "cd-4", type: "class", name: "Class2" });
      kg.addEdge({ id: "cd-e2", source: "cd-3", target: "cd-4", type: "contains", weight: 1.0 });

      const communities = kg.detectCommunities();
      expect(communities.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Visualization Data", () => {
    test("generate ECharts data", () => {
      kg.addNode({ id: "ec-1", type: "function", name: "Func1", importance: 0.8 });
      kg.addNode({ id: "ec-2", type: "class", name: "Class1", importance: 0.6 });
      kg.addEdge({ id: "ec-e1", source: "ec-1", target: "ec-2", type: "calls", weight: 1.0 });

      const data = kg.toEChartsData({ maxNodes: 100 });
      expect(data.nodes.length).toBeGreaterThanOrEqual(2);
      expect(data.categories.length).toBeGreaterThanOrEqual(2);
      expect(data.nodes[0].symbolSize).toBeGreaterThan(0);
    });

    test("generate D3 data", () => {
      kg.addNode({ id: "d3-1", type: "function", name: "Func1", importance: 0.8 });
      kg.addNode({ id: "d3-2", type: "class", name: "Class1", importance: 0.6 });
      kg.addEdge({ id: "d3-e1", source: "d3-1", target: "d3-2", type: "calls", weight: 1.0 });

      const data = kg.toD3Data({ maxNodes: 100 });
      expect(data.nodes.length).toBeGreaterThanOrEqual(2);
      expect(data.links.length).toBeGreaterThanOrEqual(1);
      expect(data.nodes[0].radius).toBeGreaterThan(0);
    });
  });

  describe("Statistics", () => {
    test("get stats", () => {
      const stats = kg.getStats();
      expect(stats.totalNodes).toBeGreaterThan(0);
      expect(stats.totalEdges).toBeGreaterThan(0);
      expect(stats.nodesByType).toBeDefined();
      expect(stats.edgesByType).toBeDefined();
      expect(stats.avgDegree).toBeGreaterThanOrEqual(0);
    });
  });
});
