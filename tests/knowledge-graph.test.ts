import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import KnowledgeGraph, { type Entity, type EntityType, type RelationType } from "../src/kg/graph.js";

// Use in-memory database for tests
function createTestGraph(): KnowledgeGraph {
  return new KnowledgeGraph(":memory:");
}

describe("KnowledgeGraph - Entity Management", () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  afterEach(() => {
    graph.close();
  });

  test("should create an entity with basic properties", () => {
    const entity = graph.createEntity("test-entity", "concept", { name: "Test Entity", description: "A test entity" });

    expect(entity).toBeDefined();
    expect(entity.id).toBeGreaterThan(0);
    expect(entity.name).toBe("test-entity");
    expect(entity.type).toBe("concept");
    expect(entity.properties).toBeDefined();
    expect((entity.properties as any)?.name).toBe("Test Entity");
    expect((entity.properties as any)?.description).toBe("A test entity");
    expect(entity.createdAt).toBeInstanceOf(Date);
  });

  test("should create entity without properties", () => {
    const entity = graph.createEntity("simple", "concept");
    expect(entity.id).toBeGreaterThan(0);
    expect(entity.name).toBe("simple");
    expect(entity.properties).toBeUndefined();
  });

  test("should retrieve entity by ID", () => {
    const created = graph.createEntity("retrievable", "concept", { name: "Retrievable" });
    const found = graph.getEntity(created.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe("retrievable");
  });

  test("should return null for non-existent entity", () => {
    const found = graph.getEntity(99999);
    expect(found).toBeNull();
  });

  test("should retrieve entity by name", () => {
    graph.createEntity("by-name", "concept", { info: "test" });
    const found = graph.getEntityByName("by-name");

    expect(found).toBeDefined();
    expect(found?.name).toBe("by-name");
  });

  test("should update entity properties", () => {
    const created = graph.createEntity("updatable", "concept", { name: "Original" });
    const updated = graph.updateEntity(created.id, { properties: { name: "Updated", added: "field" } });

    expect(updated).toBeDefined();
    expect((updated?.properties as any)?.name).toBe("Updated");
    expect((updated?.properties as any)?.added).toBe("field");
  });

  test("should update entity name", () => {
    const created = graph.createEntity("old-name", "concept");
    const updated = graph.updateEntity(created.id, { name: "new-name" });

    expect(updated).toBeDefined();
    expect(updated?.name).toBe("new-name");

    // Should be findable by new name
    const found = graph.getEntityByName("new-name");
    expect(found).toBeDefined();
  });

  test("should delete entity", () => {
    const created = graph.createEntity("delete-me", "concept");
    graph.deleteEntity(created.id);

    const found = graph.getEntity(created.id);
    expect(found).toBeNull();
  });

  test("should find entities by type", () => {
    graph.createEntity("concept-1", "concept", { name: "Concept 1" });
    graph.createEntity("person-1", "person", { name: "Person 1" });
    graph.createEntity("concept-2", "concept", { name: "Concept 2" });
    graph.createEntity("tool-1", "tool", { name: "Tool 1" });

    const concepts = graph.findEntities("concept");
    expect(concepts.length).toBe(2);
    expect(concepts.every((e: Entity) => e.type === "concept")).toBe(true);

    const persons = graph.findEntities("person");
    expect(persons.length).toBe(1);

    const all = graph.findEntities();
    expect(all.length).toBe(4);
  });

  test("should search entities by name query", () => {
    graph.createEntity("Machine Learning", "concept");
    graph.createEntity("Deep Learning", "concept");
    graph.createEntity("Data Science", "concept");
    graph.createEntity("Statistics", "concept");

    const results = graph.searchEntities("learning");
    expect(results.length).toBe(2);
    expect(results.some((e: Entity) => e.name === "Machine Learning")).toBe(true);
    expect(results.some((e: Entity) => e.name === "Deep Learning")).toBe(true);
  });

  test("should support all entity types", () => {
    const types: EntityType[] = ["person", "org", "concept", "tool", "file", "project", "topic"];

    for (const type of types) {
      const entity = graph.createEntity(`type-${type}`, type, { category: type });
      expect(entity.type).toBe(type);
    }

    const all = graph.findEntities();
    expect(all.length).toBe(types.length);
  });

  test("should enforce unique entity names", () => {
    graph.createEntity("unique", "concept");
    // Creating with same name should update existing (INSERT OR REPLACE)
    const updated = graph.createEntity("unique", "topic", { updated: true });
    
    const found = graph.getEntityByName("unique");
    expect(found?.type).toBe("topic");
    expect((found?.properties as any)?.updated).toBe(true);
  });
});

describe("KnowledgeGraph - Relationship Management", () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  afterEach(() => {
    graph.close();
  });

  test("should create relationship between entities", () => {
    const src = graph.createEntity("src", "concept");
    const dst = graph.createEntity("dst", "concept");

    const rel = graph.createRelationship(src.id, dst.id, "related_to", { strength: 0.8 });

    expect(rel).toBeDefined();
    expect(rel.id).toBeGreaterThan(0);
    expect(rel.sourceEntity).toBe(src.id);
    expect(rel.targetEntity).toBe(dst.id);
    expect(rel.relationType).toBe("related_to");
    expect((rel.properties as any)?.strength).toBe(0.8);
  });

  test("should retrieve entity relationships", () => {
    const center = graph.createEntity("center", "concept");
    const a = graph.createEntity("a", "concept");
    const b = graph.createEntity("b", "concept");

    graph.createRelationship(center.id, a.id, "related_to", {});
    graph.createRelationship(center.id, b.id, "part_of", {});

    const rels = graph.getRelationships(center.id);
    expect(rels.length).toBe(2);
  });

  test("should filter relationships by direction", () => {
    const center = graph.createEntity("dir-center", "concept");
    const a = graph.createEntity("dir-a", "concept");
    const b = graph.createEntity("dir-b", "concept");

    graph.createRelationship(center.id, a.id, "uses", {});
    graph.createRelationship(b.id, center.id, "depends_on", {});

    const outRels = graph.getRelationships(center.id, "out");
    expect(outRels.length).toBe(1);
    expect(outRels[0].other.name).toBe("dir-a");

    const inRels = graph.getRelationships(center.id, "in");
    expect(inRels.length).toBe(1);
    expect(inRels[0].other.name).toBe("dir-b");

    const bothRels = graph.getRelationships(center.id, "both");
    expect(bothRels.length).toBe(2);
  });

  test("should delete relationship", () => {
    const src = graph.createEntity("del-src", "concept");
    const dst = graph.createEntity("del-dst", "concept");
    const rel = graph.createRelationship(src.id, dst.id, "related_to", {});

    graph.deleteRelationship(rel.id);

    const rels = graph.getRelationships(src.id);
    expect(rels.length).toBe(0);
  });

  test("should include related entity in relationship results", () => {
    const src = graph.createEntity("rel-src", "concept", { info: "source" });
    const dst = graph.createEntity("rel-dst", "person", { info: "target" });
    graph.createRelationship(src.id, dst.id, "created_by", { date: "2024-01-01" });

    const rels = graph.getRelationships(src.id);
    expect(rels.length).toBe(1);
    expect(rels[0].other).toBeDefined();
    expect(rels[0].other.name).toBe("rel-dst");
    expect(rels[0].other.type).toBe("person");
  });

  test("should support all relation types", () => {
    const types: RelationType[] = ["uses", "depends_on", "part_of", "mentions", "created_by", "related_to", "contains", "references"];
    const src = graph.createEntity("rel-src", "concept");

    for (const type of types) {
      const dst = graph.createEntity(`rel-dst-${type}`, "concept");
      const rel = graph.createRelationship(src.id, dst.id, type, {});
      expect(rel.relationType).toBe(type);
    }

    const rels = graph.getRelationships(src.id);
    expect(rels.length).toBe(types.length);
  });
});

describe("KnowledgeGraph - Graph Traversal", () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  afterEach(() => {
    graph.close();
  });

  test("should find shortest path between connected entities", () => {
    // Create a simple chain: A -> B -> C -> D
    const a = graph.createEntity("path-a", "concept");
    const b = graph.createEntity("path-b", "concept");
    const c = graph.createEntity("path-c", "concept");
    const d = graph.createEntity("path-d", "concept");

    graph.createRelationship(a.id, b.id, "related_to");
    graph.createRelationship(b.id, c.id, "related_to");
    graph.createRelationship(c.id, d.id, "related_to");

    // Also create a longer path: A -> X -> Y -> D
    const x = graph.createEntity("path-x", "concept");
    const y = graph.createEntity("path-y", "concept");
    graph.createRelationship(a.id, x.id, "related_to");
    graph.createRelationship(x.id, y.id, "related_to");
    graph.createRelationship(y.id, d.id, "related_to");

    const path = graph.shortestPath(a.id, d.id);
    expect(path).toBeDefined();
    expect(path).not.toBeNull();
    expect(path!.nodes.length).toBe(4); // A -> B -> C -> D
    expect(path!.nodes[0].name).toBe("path-a");
    expect(path!.nodes[3].name).toBe("path-d");
    expect(path!.edges.length).toBe(3);
  });

  test("should return null for disconnected entities", () => {
    const a = graph.createEntity("dis-a", "concept");
    const b = graph.createEntity("dis-b", "concept");

    const path = graph.shortestPath(a.id, b.id);
    expect(path).toBeNull();
  });

  test("should return single node for same entity", () => {
    const a = graph.createEntity("self", "concept");
    const path = graph.shortestPath(a.id, a.id);
    expect(path).toBeDefined();
    expect(path!.nodes.length).toBe(1);
    expect(path!.nodes[0].name).toBe("self");
    expect(path!.edges.length).toBe(0);
  });

  test("should perform BFS traversal from starting entity", () => {
    // Create a small network
    const center = graph.createEntity("bfs-center", "concept");
    const n1 = graph.createEntity("bfs-1", "concept");
    const n2 = graph.createEntity("bfs-2", "concept");
    const n1_1 = graph.createEntity("bfs-1-1", "concept");

    graph.createRelationship(center.id, n1.id, "related_to");
    graph.createRelationship(center.id, n2.id, "related_to");
    graph.createRelationship(n1.id, n1_1.id, "related_to");

    const subgraph = graph.bfs(center.id, 2);
    expect(subgraph.entities.length).toBe(4); // center + 2 level-1 + 1 level-2
    expect(subgraph.relationships.length).toBeGreaterThanOrEqual(3); // may include traversed edges from both directions

    // Check center is included
    expect(subgraph.entities.some((e: Entity) => e.name === "bfs-center")).toBe(true);
  });

  test("should respect maxDepth in BFS", () => {
    const d0 = graph.createEntity("depth-0", "concept");
    const d1 = graph.createEntity("depth-1", "concept");
    const d2 = graph.createEntity("depth-2", "concept");

    graph.createRelationship(d0.id, d1.id, "related_to");
    graph.createRelationship(d1.id, d2.id, "related_to");

    const subgraph1 = graph.bfs(d0.id, 1);
    expect(subgraph1.entities.length).toBe(2); // depth-0 + depth-1

    const subgraph2 = graph.bfs(d0.id, 2);
    expect(subgraph2.entities.length).toBe(3); // depth-0 + depth-1 + depth-2
  });

  test("should filter BFS by relation type", () => {
    const center = graph.createEntity("filter-center", "concept");
    const a = graph.createEntity("filter-a", "concept");
    const b = graph.createEntity("filter-b", "concept");
    const c = graph.createEntity("filter-c", "concept");

    graph.createRelationship(center.id, a.id, "uses");
    graph.createRelationship(center.id, b.id, "part_of");
    graph.createRelationship(b.id, c.id, "uses");

    const usesOnly = graph.bfs(center.id, 2, ["uses"]);
    expect(usesOnly.entities.length).toBe(2); // center + a
    expect(usesOnly.entities.some((e: Entity) => e.name === "filter-a")).toBe(true);
    expect(usesOnly.entities.some((e: Entity) => e.name === "filter-b")).toBe(false);
  });
});

describe("KnowledgeGraph - Graph Analytics", () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  afterEach(() => {
    graph.close();
  });

  test("should calculate centrality", () => {
    // Create a star graph
    const center = graph.createEntity("center", "concept");
    for (let i = 0; i < 5; i++) {
      const leaf = graph.createEntity(`leaf-${i}`, "concept");
      graph.createRelationship(center.id, leaf.id, "related_to");
    }

    const centrality = graph.centrality(10);
    expect(centrality.length).toBe(6); // center + 5 leaves
    expect(centrality[0].entity.name).toBe("center");
    expect(centrality[0].degree).toBe(5);

    // Leaves should have degree 1
    const leafEntry = centrality.find((c: any) => c.entity.name === "leaf-0");
    expect(leafEntry?.degree).toBe(1);
  });

  test("should return empty centrality for empty graph", () => {
    const centrality = graph.centrality();
    expect(centrality.length).toBe(0);
  });

  test("should provide graph stats", () => {
    // Empty graph
    const emptyStats = graph.stats();
    expect(emptyStats.entityCount).toBe(0);
    expect(emptyStats.relationCount).toBe(0);
    expect(Object.keys(emptyStats.typeDistribution).length).toBe(0);

    // Add entities and relationships
    graph.createEntity("stat-1", "concept");
    graph.createEntity("stat-2", "concept");
    graph.createEntity("stat-3", "person");
    const s1 = graph.createEntity("stat-src", "concept");
    const s2 = graph.createEntity("stat-dst", "concept");
    graph.createRelationship(s1.id, s2.id, "related_to");

    const stats = graph.stats();
    expect(stats.entityCount).toBe(5);
    expect(stats.relationCount).toBe(1);
    expect(stats.typeDistribution["concept"]).toBe(4);
    expect(stats.typeDistribution["person"]).toBe(1);
  });
});

describe("KnowledgeGraph - Import/Export", () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  afterEach(() => {
    graph.close();
  });

  test("should import entities and relationships from JSON", () => {
    const data = {
      entities: [
        { name: "Alice", type: "person" as EntityType, properties: { role: "developer" } },
        { name: "Bob", type: "person" as EntityType, properties: { role: "designer" } },
        { name: "Project X", type: "project" as EntityType }
      ],
      relationships: [
        { source: "Alice", target: "Project X", type: "works_on" as RelationType },
        { source: "Bob", target: "Project X", type: "works_on" as RelationType },
        { source: "Alice", target: "Bob", type: "collaborates_with" as RelationType }
      ]
    };

    graph.importJson(data);

    const alice = graph.getEntityByName("Alice");
    expect(alice).toBeDefined();
    expect(alice?.type).toBe("person");

    const project = graph.getEntityByName("Project X");
    expect(project).toBeDefined();

    // Check relationships were created
    const aliceRels = graph.getRelationships(alice!.id);
    expect(aliceRels.length).toBe(2); // works_on + collaborates_with
  });

  test("should merge on import for existing entities", () => {
    graph.createEntity("existing", "concept", { version: 1 });

    const data = {
      entities: [
        { name: "existing", type: "topic" as EntityType, properties: { version: 2 } }
      ],
      relationships: []
    };

    // Should not create duplicate
    graph.importJson(data);

    const all = graph.findEntities();
    expect(all.length).toBe(1); // Still only 1 entity

    // Existing entity is reused (not updated) by importJson
    const found = graph.getEntityByName("existing");
    expect(found?.type).toBe("concept");
  });

  test("should handle empty import", () => {
    graph.importJson({ entities: [], relationships: [] });
    const stats = graph.stats();
    expect(stats.entityCount).toBe(0);
    expect(stats.relationCount).toBe(0);
  });
});

describe("KnowledgeGraph - Text Extraction", () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  afterEach(() => {
    graph.close();
  });

  test("should extract entities mentioned in text", () => {
    graph.createEntity("JavaScript", "concept");
    graph.createEntity("Python", "concept");
    graph.createEntity("Rust", "concept");

    const text = "I love JavaScript and Python, but Rust is also great.";
    const found = graph.extractEntitiesFromText(text);

    expect(found.length).toBe(3);
    expect(found.some((e: Entity) => e.name === "JavaScript")).toBe(true);
    expect(found.some((e: Entity) => e.name === "Python")).toBe(true);
    expect(found.some((e: Entity) => e.name === "Rust")).toBe(true);
  });

  test("should return empty array when no entities match", () => {
    graph.createEntity("React", "tool");
    
    const text = "I only work with Vue and Angular.";
    const found = graph.extractEntitiesFromText(text);
    expect(found.length).toBe(0);
  });

  test("should be case-insensitive", () => {
    graph.createEntity("TypeScript", "concept");
    
    const text = "I use typescript daily.";
    const found = graph.extractEntitiesFromText(text);
    expect(found.length).toBe(1);
    expect(found[0].name).toBe("TypeScript");
  });
});

describe("KnowledgeGraph - Complex Scenarios", () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  afterEach(() => {
    graph.close();
  });

  test("should handle self-referencing relationships gracefully", () => {
    const self = graph.createEntity("self", "concept");
    graph.createRelationship(self.id, self.id, "related_to");

    const rels = graph.getRelationships(self.id);
    // Self-referencing relationship appears twice (once as source, once as target)
    expect(rels.length).toBe(2);

    // BFS should handle self-reference
    const subgraph = graph.bfs(self.id, 2);
    expect(subgraph.entities.length).toBe(1);
  });

  test("should handle cyclic graphs in shortest path", () => {
    // A -> B -> C -> A (cycle)
    const a = graph.createEntity("cyc-a", "concept");
    const b = graph.createEntity("cyc-b", "concept");
    const c = graph.createEntity("cyc-c", "concept");

    graph.createRelationship(a.id, b.id, "related_to");
    graph.createRelationship(b.id, c.id, "related_to");
    graph.createRelationship(c.id, a.id, "related_to");

    const path = graph.shortestPath(a.id, c.id);
    expect(path).toBeDefined();
    expect(path).not.toBeNull();
    // In undirected traversal, A and C are directly connected (C->A relation)
    expect(path!.nodes.length).toBe(2); // A -> C (direct through C->A edge)
    expect(path!.nodes[0].name).toBe("cyc-a");
    expect(path!.nodes[1].name).toBe("cyc-c");
  });

  test("should handle large graph operations efficiently", () => {
    // Create 20 entities in a chain (default maxDepth is 5, so use a smaller chain)
    let prev = graph.createEntity("large-0", "concept", { index: 0 });
    for (let i = 1; i < 20; i++) {
      const curr = graph.createEntity(`large-${i}`, "concept", { index: i });
      graph.createRelationship(prev.id, curr.id, "related_to");
      prev = curr;
    }

    const allEntities = graph.findEntities();
    expect(allEntities.length).toBe(20);

    const stats = graph.stats();
    expect(stats.entityCount).toBe(20);
    expect(stats.relationCount).toBe(19);

    // Test shortest path with sufficient maxDepth
    const path = graph.shortestPath(
      graph.getEntityByName("large-0")!.id,
      graph.getEntityByName("large-19")!.id,
      25
    );
    expect(path).toBeDefined();
    expect(path).not.toBeNull();
    expect(path!.nodes.length).toBe(20); // All 20 entities in the chain
  });

  test("should maintain referential integrity on entity deletion", () => {
    const a = graph.createEntity("ref-a", "concept");
    const b = graph.createEntity("ref-b", "concept");
    const c = graph.createEntity("ref-c", "concept");

    graph.createRelationship(a.id, b.id, "related_to");
    graph.createRelationship(b.id, c.id, "related_to");
    graph.createRelationship(c.id, a.id, "related_to");

    // Delete middle entity
    graph.deleteEntity(b.id);

    // Remaining relationships should not reference deleted entity
    const aRels = graph.getRelationships(a.id);
    expect(aRels.length).toBe(1); // Only c->a remains

    const cRels = graph.getRelationships(c.id);
    expect(cRels.length).toBe(1); // Only c->a remains

    const bRels = graph.getRelationships(b.id);
    expect(bRels.length).toBe(0);
  });

  test("should handle parallel relationship creation", () => {
    const src = graph.createEntity("parallel-src", "concept");
    const dst1 = graph.createEntity("parallel-dst1", "concept");
    const dst2 = graph.createEntity("parallel-dst2", "concept");

    // Create multiple relationships at once
    graph.createRelationship(src.id, dst1.id, "uses");
    graph.createRelationship(src.id, dst2.id, "uses");
    graph.createRelationship(src.id, dst1.id, "depends_on");

    const rels = graph.getRelationships(src.id);
    expect(rels.length).toBe(3);

    // Should be able to have multiple relationships to same target
    const dst1Rels = rels.filter((r: any) => r.other.name === "parallel-dst1");
    expect(dst1Rels.length).toBe(2);
  });
});
