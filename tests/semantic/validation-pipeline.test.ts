/**
 * S-A8 切片 3：ValidationPipeline 级 1 语法级薄透传（复用 S-A1）（TDD RED）
 *
 * 计划口径（docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md 第三节切片 3）：
 * - 流水线对非法 schema 输入返回 level=1 + 对应原因码，不进入后续级；
 * - 反向断言：合法输入必然穿过级 1（后续级被调用的可观测证据）。
 *
 * 依赖注入 spy 假件（规则 8），结构对齐生产实现：
 * KnowledgeGraphEnhanced.getNode / SQLiteMemory.getByPath（均同步）。
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ValidationPipeline,
  type ValidationPipelineDeps,
} from "../../src/semantic/validation-pipeline.js";
import type { MeaningRepresentation } from "../../src/semantic/meaning-schema.js";
import { KnowledgeGraphEnhanced } from "../../src/kg/enhanced.js";
import { SQLiteMemory } from "../../src/memory/sqlite-memory.js";

/** 合法输入基样例（与切片 1 golden 1 同构：单实体+单命题，无关系） */
const legalMr: MeaningRepresentation = {
  propositions: [
    {
      id: "p-1",
      text: "Axiom-Agent 使用 SQLite 作为唯一持久化数据库。",
      confidence: 0.95,
      sourceAnchor: "vault:docs/architecture.md",
      entityIds: ["e-sqlite"],
    },
  ],
  entities: [{ id: "e-sqlite", name: "SQLite" }],
  relations: [],
};

/** 变体构造辅助：深克隆后自由变异（模拟外部脏输入） */
const mutable = (mr: MeaningRepresentation): Record<string, any> =>
  JSON.parse(JSON.stringify(mr)) as Record<string, any>;

/** spy 依赖：记录级 2+ 的调用证据（假件恒可解析返回占位记录——切片 4 起级 2 有拒绝语义，恒 null 会误拒合法输入） */
function makeSpyDeps(): {
  deps: ValidationPipelineDeps;
  kgCalls: string[];
  memoryCalls: string[];
} {
  const kgCalls: string[] = [];
  const memoryCalls: string[] = [];
  return {
    kgCalls,
    memoryCalls,
    deps: {
      kg: {
        getNode: (id: string) => {
          kgCalls.push(id);
          return { id };
        },
        getOutEdges: () => [],
        addNode: () => {},
        addEdge: () => {},
      },
      memory: {
        getByPath: (path: string) => {
          memoryCalls.push(path);
          return { path };
        },
      },
    },
  };
}

describe("S-A8 切片 3：ValidationPipeline 级 1 语法级薄透传", () => {
  it("非法 schema 输入 → level=1 + 精确原因码，且不进入后续级（spy 零调用）", () => {
    const noAnchor = mutable(legalMr);
    delete noAnchor.propositions[0].sourceAnchor;
    const overConfidence = mutable(legalMr);
    overConfidence.propositions[0].confidence = 1.5;
    const noProps = mutable(legalMr);
    noProps.propositions = [];

    const cases: Array<{ name: string; input: unknown; code: string }> = [
      { name: "V7 非对象", input: null, code: "not-an-object" },
      { name: "V1 缺溯源头", input: noAnchor, code: "missing-provenance" },
      { name: "V3 类型错配", input: overConfidence, code: "type-mismatch" },
      { name: "V6 空命题集", input: noProps, code: "empty-propositions" },
    ];
    for (const c of cases) {
      const { deps, kgCalls, memoryCalls } = makeSpyDeps();
      const verdict = new ValidationPipeline(deps).validate(c.input);
      expect(verdict.pass).toBe(false);
      expect(verdict.level).toBe(1);
      expect(verdict.reasonCode).toBe(c.code);
      expect(kgCalls).toEqual([]); // 不进入后续级
      expect(memoryCalls).toEqual([]);
    }
  });

  it("合法输入穿过级 1：级 2 被调用的可观测证据（kg.getNode 触发）且放行", () => {
    const { deps, kgCalls } = makeSpyDeps();
    const verdict = new ValidationPipeline(deps).validate(legalMr);
    expect(verdict.pass).toBe(true);
    expect(kgCalls).toContain("e-sqlite"); // 级 2 实存性解析已被触发
  });
});

/** Map 内存假件（规则 8：接受依赖）：KG 节点表 + Vault 笔记表，表外一律不可解析；可选注入出边/邻居名/写入记录 */
function makeFakeDeps(
  nodes: string[],
  notes: string[],
  extra?: {
    edges?: Array<{ source: string; target: string }>;
    names?: Record<string, string>;
    writes?: string[];
  },
): ValidationPipelineDeps {
  const kgMap = new Map(nodes.map((id) => [id, { id, name: extra?.names?.[id] ?? id }]));
  const edges = extra?.edges ?? [];
  const noteSet = new Set(notes);
  return {
    kg: {
      getNode: (id) => kgMap.get(id) ?? null,
      getOutEdges: (nodeId) =>
        edges
          .filter((e) => e.source === nodeId)
          .map((e) => ({ target: e.target, type: "related-to" })),
      addNode: (n) => {
        extra?.writes?.push(`addNode:${n.id}`);
      },
      addEdge: (e) => {
        extra?.writes?.push(`addEdge:${e.source}->${e.target}`);
      },
    },
    memory: { getByPath: (p) => (noteSet.has(p) ? { path: p } : null) },
  };
}

describe("S-A8 切片 4：ValidationPipeline 级 2 实存性校验", () => {
  it("实体链接指向不存在 KG 节点 → unresolved-entity 拒绝（level=2）", () => {
    const verdict = new ValidationPipeline(makeFakeDeps([], [])).validate(legalMr);
    expect(verdict.pass).toBe(false);
    expect(verdict.level).toBe(2);
    expect(verdict.reasonCode).toBe("unresolved-entity");
  });

  it("溯源 anchor 不可解析 → unresolvable-provenance 拒绝（vault: 缺笔记 / kg: 缺节点）", () => {
    // vault: 笔记表为空 → getByPath 不可解析
    const vaultMiss = new ValidationPipeline(makeFakeDeps(["e-sqlite"], [])).validate(legalMr);
    expect(vaultMiss.pass).toBe(false);
    expect(vaultMiss.level).toBe(2);
    expect(vaultMiss.reasonCode).toBe("unresolvable-provenance");

    // kg: 锚指向不存在的节点
    const kgAnchorMr = mutable(legalMr);
    kgAnchorMr.propositions[0].sourceAnchor = "kg:node-ghost";
    const kgMiss = new ValidationPipeline(makeFakeDeps(["e-sqlite"], [])).validate(kgAnchorMr);
    expect(kgMiss.pass).toBe(false);
    expect(kgMiss.reasonCode).toBe("unresolvable-provenance");
  });

  it("全部可解析（实体在 KG、vault 笔记存在）→ 通过（level 随切片 5 级 3 落地演进为 3）", () => {
    const verdict = new ValidationPipeline(
      makeFakeDeps(["e-sqlite"], ["docs/architecture.md"]),
    ).validate(legalMr);
    expect(verdict.pass).toBe(true);
    expect(verdict.level).toBe(3);
    expect(verdict.reasonCode).toBeNull();
  });
});

describe("S-A8 切片 5：ValidationPipeline 级 3 逻辑一致性（同实体对矛盾关系）", () => {
  /**
   * 内存 KG 假件（规则 8）：节点/边表 + INSERT OR REPLACE 写入记录。
   * rows() 模拟 KG 行数，addNode/addEdge 记录写入调用——流水线只读校验，
   * 任何写入调用即违反"不静默覆盖"不变量。
   */
  function makeKgFake(nodes: string[], edges: Array<{ source: string; target: string; type: string }>) {
    const nodeMap = new Map(nodes.map((id) => [id, { id }]));
    const edgeMap = new Map(edges.map((e) => [`${e.source}->${e.target}`, e]));
    const writes: string[] = [];
    const kg = {
      getNode: (id: string) => nodeMap.get(id) ?? null,
      getOutEdges: (nodeId: string) => [...edgeMap.values()].filter((e) => e.source === nodeId),
      addNode: (n: { id: string; name: string; type: string }) => {
        writes.push(`addNode:${n.id}`);
        nodeMap.set(n.id, { id: n.id });
      },
      addEdge: (e: { source: string; target: string; type: string; weight: number }) => {
        writes.push(`addEdge:${e.source}->${e.target}(${e.type})`);
        edgeMap.set(`${e.source}->${e.target}`, e);
      },
    };
    const deps: ValidationPipelineDeps = {
      kg,
      memory: { getByPath: (p: string) => ({ path: p }) },
    };
    return {
      deps,
      writes,
      rows: () => nodeMap.size + edgeMap.size,
    };
  }

  /** 既有 KG：节点 e-a/e-b + 边 (e-a,related-to,e-b)；输入带关系的关系型 MR */
  function conflictMr(type: string): MeaningRepresentation {
    const mr = mutable(legalMr);
    mr.entities.push(
      { id: "e-a", name: "A" },
      { id: "e-b", name: "B" },
    );
    mr.relations.push({ source: "e-a", target: "e-b", type });
    return mr as MeaningRepresentation;
  }

  it("矛盾三元组（mark 默认策略）→ pass=true + conflict 标记 + KG 行数不变且零写入", () => {
    const kg = makeKgFake(
      ["e-sqlite", "e-a", "e-b"],
      [{ source: "e-a", target: "e-b", type: "related-to" }],
    );
    const before = kg.rows();
    const verdict = new ValidationPipeline(kg.deps).validate(conflictMr("located-in"));
    expect(verdict.pass).toBe(true); // 开放世界：宁可标记不拒绝（计划第六节）
    expect(verdict.level).toBe(3);
    expect(verdict.reasonCode).toBeNull();
    expect(verdict.flags).toContain("conflict");
    expect(kg.rows()).toBe(before); // KG 行数不变
    expect(kg.writes).toEqual([]); // 零写入调用（不静默覆盖）
  });

  it("矛盾三元组（reject 策略）→ pass=false level=3 reasonCode=conflict + KG 不变", () => {
    const kg = makeKgFake(
      ["e-sqlite", "e-a", "e-b"],
      [{ source: "e-a", target: "e-b", type: "related-to" }],
    );
    const before = kg.rows();
    const verdict = new ValidationPipeline(kg.deps, { conflictPolicy: "reject" }).validate(
      conflictMr("located-in"),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.level).toBe(3);
    expect(verdict.reasonCode).toBe("conflict");
    expect(kg.rows()).toBe(before);
    expect(kg.writes).toEqual([]);
  });

  it("幂等重放（与既有事实完全相同的三元组）→ 通过无 conflict 标记 + KG 行数不变", () => {
    const kg = makeKgFake(
      ["e-sqlite", "e-a", "e-b"],
      [{ source: "e-a", target: "e-b", type: "related-to" }],
    );
    const before = kg.rows();
    const verdict = new ValidationPipeline(kg.deps).validate(conflictMr("related-to"));
    expect(verdict.pass).toBe(true);
    expect(verdict.flags).not.toContain("conflict"); // 合法幂等重放，非冲突
    expect(kg.rows()).toBe(before);
    expect(kg.writes).toEqual([]);
  });

  it("新事实（实体对无既有关系）→ 通过无标记（开放世界放行）", () => {
    const kg = makeKgFake(["e-sqlite", "e-a", "e-b", "e-c"], []);
    const verdict = new ValidationPipeline(kg.deps).validate(conflictMr("located-in"));
    expect(verdict.pass).toBe(true);
    expect(verdict.flags).toEqual([]);
  });
});

describe("S-A8 演进切片 2：ValidationPipeline 级 4 上下文连贯（符号三级判定腿 1+3，降级不拒绝）", () => {
  it("腿 1 归一化精确匹配（同名，大小写变体）→ 通过无标签，level=4", () => {
    const deps = makeFakeDeps(["e-sqlite"], ["docs/architecture.md"]);
    const verdict = new ValidationPipeline(deps).validate(legalMr, {
      keyEntities: ["  sqlite "], // 归一化后 = "sqlite" = normalizeEntity("SQLite")
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.level).toBe(4);
    expect(verdict.flags).toEqual([]);
  });

  it("腿 1 连字符/空格变体归一后相等 → 匹配无标签", () => {
    const deps = makeFakeDeps(["e-sqlite"], ["docs/architecture.md"]);
    const mr = mutable(legalMr);
    mr.entities[0].name = "Post-Gre SQL";
    const verdict = new ValidationPipeline(deps).validate(mr as MeaningRepresentation, {
      keyEntities: ["postgre sql"],
    });
    expect(verdict.level).toBe(4);
    expect(verdict.flags).toEqual([]);
  });

  it("腿 3 Jaccard 近形匹配（postgres~postgresql≈0.778 ≥0.4）→ 匹配无标签", () => {
    const deps = makeFakeDeps(["e-sqlite"], ["docs/architecture.md"]);
    const mr = mutable(legalMr);
    mr.entities[0].name = "postgres";
    const verdict = new ValidationPipeline(deps).validate(mr as MeaningRepresentation, {
      keyEntities: ["PostgreSQL"],
    });
    expect(verdict.level).toBe(4);
    expect(verdict.flags).toEqual([]);
  });

  it("零重叠且低于阈值 → pass=true + low-confidence 标签（降级不拒绝），level=4", () => {
    const deps = makeFakeDeps(["e-sqlite"], ["docs/architecture.md"]);
    const verdict = new ValidationPipeline(deps).validate(legalMr, {
      keyEntities: ["Docker"], // SQLite~Docker Jaccard = 0，远低于 0.4 匹配阈值
    });
    expect(verdict.pass).toBe(true); // 降级不拒绝
    expect(verdict.level).toBe(4);
    expect(verdict.flags).toContain("low-confidence");
  });

  it("无 ctx.keyEntities → 级 4 无证据跳过：pass、level 停留 3、无标签（不再依赖 embedder 在场）", () => {
    const deps = makeFakeDeps(["e-sqlite"], ["docs/architecture.md"]);
    const noCtx = new ValidationPipeline(deps).validate(legalMr);
    expect(noCtx.pass).toBe(true);
    expect(noCtx.level).toBe(3);
    expect(noCtx.flags).toEqual([]);
    // 空 keyEntities 数组同样视为无证据
    const emptyCtx = new ValidationPipeline(deps).validate(legalMr, { keyEntities: [] });
    expect(emptyCtx.level).toBe(3);
    expect(emptyCtx.flags).toEqual([]);
  });

  it("阈值可配置：contextOverlapThreshold=1.0 → 单实体部分匹配仍打 low-confidence", () => {
    const deps = makeFakeDeps(["e-sqlite", "e-docker"], ["docs/architecture.md"]);
    const mr = mutable(legalMr);
    mr.entities.push({ id: "e-docker", name: "Docker" });
    const verdict = new ValidationPipeline(deps, { contextOverlapThreshold: 1 }).validate(
      mr as MeaningRepresentation,
      { keyEntities: ["SQLite"] }, // 2 实体仅 1 匹配 → overlap 0.5 < 1.0
    );
    expect(verdict.level).toBe(4);
    expect(verdict.flags).toContain("low-confidence");
  });
});

describe("S-A8 演进切片 3：级 4 腿 2——KG 一跳邻域匹配（只读，可解释性）", () => {
  it("实体自身名不匹配，但一跳邻居名命中 keyEntities → 匹配（无 low-confidence），level=4", () => {
    const writes: string[] = [];
    // e-sqlite 名 "SQLite" 与 keyEntities ["Docker"] 不匹配；但 e-sqlite 有一条出边指向 e-docker（名 "Docker"）
    const deps = makeFakeDeps(["e-sqlite", "e-docker"], ["docs/architecture.md"], {
      edges: [{ source: "e-sqlite", target: "e-docker" }],
      names: { "e-docker": "Docker" },
      writes,
    });
    const verdict = new ValidationPipeline(deps).validate(legalMr, {
      keyEntities: ["Docker"],
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.level).toBe(4);
    expect(verdict.flags).toEqual([]); // 邻域命中 → 视为语境相关
    expect(writes).toEqual([]); // 级 4 只读，零写入
  });

  it("无出边（getOutEdges 返回空）→ 退回腿 1+3 行为：不匹配则 low-confidence", () => {
    const deps = makeFakeDeps(["e-sqlite", "e-docker"], ["docs/architecture.md"], {
      edges: [], // e-sqlite 无出边
      names: { "e-docker": "Docker" },
    });
    const verdict = new ValidationPipeline(deps).validate(legalMr, {
      keyEntities: ["Docker"],
    });
    expect(verdict.level).toBe(4);
    expect(verdict.flags).toContain("low-confidence"); // 邻域无邻居，SQLite~Docker 腿 1/3 均不匹配
  });

  it("邻居名经归一化匹配（大小写/变体）：邻居 'PostgreSQL' ~ keyEntity 'postgres'", () => {
    const deps = makeFakeDeps(["e-sqlite", "e-pg"], ["docs/architecture.md"], {
      edges: [{ source: "e-sqlite", target: "e-pg" }],
      names: { "e-pg": "PostgreSQL" },
    });
    const mr = mutable(legalMr);
    mr.entities[0].name = "Redis"; // 自身与 postgres 不匹配（腿 1/3 均否）
    const verdict = new ValidationPipeline(deps).validate(mr as MeaningRepresentation, {
      keyEntities: ["postgres"],
    });
    expect(verdict.level).toBe(4);
    expect(verdict.flags).toEqual([]); // 邻居 PostgreSQL Jaccard(postgres)≈0.778 命中
  });

  it("入边邻居不计入（仅 getOutEdges 出边）：仅有指向实体的入边 → 不匹配", () => {
    // e-docker -> e-sqlite（反向），实体 e-sqlite 的出边集为空 → 腿 2 无命中
    const deps = makeFakeDeps(["e-sqlite", "e-docker"], ["docs/architecture.md"], {
      edges: [{ source: "e-docker", target: "e-sqlite" }],
      names: { "e-docker": "Docker" },
    });
    const verdict = new ValidationPipeline(deps).validate(legalMr, {
      keyEntities: ["Docker"],
    });
    expect(verdict.flags).toContain("low-confidence");
  });
});

describe("S-A8 切片 7：端到端 fail-closed 铁律（真实临时 KG + SQLiteMemory）", () => {
  const rowCount = (db: Database, table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

  /** 真实依赖（沿用 soak 惯例：内存 SQLite，零外部副作用） */
  function makeReal(): { db: Database; kg: KnowledgeGraphEnhanced; mem: SQLiteMemory } {
    const db = new Database(":memory:");
    const kg = new KnowledgeGraphEnhanced(db);
    const mem = new SQLiteMemory(":memory:");
    mem.upsertNote({
      path: "docs/architecture.md",
      title: "架构",
      content: "Axiom-Agent 使用 SQLite 作为唯一持久化数据库。",
      excerpt: "",
      tags: [],
      paraCategory: "resources",
      type: "note",
      confidence: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { db, kg, mem };
  }

  /** 关系型合法 MR：e-sqlite + e-a + e-b 三实体、一条 related-to 边 */
  function relationMr(): MeaningRepresentation {
    const mr = mutable(legalMr);
    mr.entities.push({ id: "e-a", name: "A" }, { id: "e-b", name: "B" });
    mr.relations.push({ source: "e-a", target: "e-b", type: "related-to" });
    return mr as MeaningRepresentation;
  }

  it("任一级失败 → fail + 原因码，KG/memory 行数前后不变（零写入）", () => {
    const { db, kg, mem } = makeReal();
    const pipeline = new ValidationPipeline({ kg, memory: mem });
    const before = {
      nodes: rowCount(db, "kg_nodes"),
      edges: rowCount(db, "kg_edges"),
      notes: mem.stats().totalNotes, // memory_notes 在 SQLiteMemory 自身 :memory: 库
    };

    // 级 1 失败：非对象输入
    const v1 = pipeline.ingest(null);
    expect(v1.pass).toBe(false);
    expect(v1.level).toBe(1);
    expect(v1.reasonCode).toBe("not-an-object");
    expect(v1.writtenNodes).toBe(0);
    expect(v1.writtenEdges).toBe(0);

    // 级 2 失败：实体不在 KG
    const v2 = pipeline.ingest(legalMr);
    expect(v2.pass).toBe(false);
    expect(v2.reasonCode).toBe("unresolved-entity");

    expect(rowCount(db, "kg_nodes")).toBe(before.nodes);
    expect(rowCount(db, "kg_edges")).toBe(before.edges);
    expect(mem.stats().totalNotes).toBe(before.notes);
  });

  it("全绿 → 唯一入库通道写入成功（实体+关系入 KG）；幂等重放行数不变", () => {
    const { db, kg, mem } = makeReal();
    kg.addNode({ id: "e-sqlite", type: "entity", name: "SQLite" });
    kg.addNode({ id: "e-a", type: "entity", name: "A" });
    kg.addNode({ id: "e-b", type: "entity", name: "B" });
    const pipeline = new ValidationPipeline({ kg, memory: mem });
    const beforeNodes = rowCount(db, "kg_nodes");
    const beforeEdges = rowCount(db, "kg_edges");
    const beforeNotes = mem.stats().totalNotes;

    const v = pipeline.ingest(relationMr());
    expect(v.pass).toBe(true);
    expect(v.writtenNodes).toBe(3);
    expect(v.writtenEdges).toBe(1);
    expect(rowCount(db, "kg_nodes")).toBe(beforeNodes); // INSERT OR REPLACE 幂等
    expect(rowCount(db, "kg_edges")).toBe(beforeEdges + 1);
    expect(mem.stats().totalNotes).toBe(beforeNotes); // memory 不回写

    // 幂等重放：同 MR 二次入库，行数不变
    const v2 = pipeline.ingest(relationMr());
    expect(v2.pass).toBe(true);
    expect(rowCount(db, "kg_nodes")).toBe(beforeNodes);
    expect(rowCount(db, "kg_edges")).toBe(beforeEdges + 1);
  });

  it("stub resolver 抛错 → internal-error fail-closed + onAlert 触发 + 零写入不放行", () => {
    const { db, kg, mem } = makeReal();
    kg.addNode({ id: "e-sqlite", type: "entity", name: "SQLite" });
    const beforeNodes = rowCount(db, "kg_nodes");
    const beforeEdges = rowCount(db, "kg_edges");
    const alerts: Array<{ level: number; error: string }> = [];
    const deps: ValidationPipelineDeps = {
      kg: {
        getNode: () => {
          throw new Error("db locked");
        },
        getOutEdges: () => {
          throw new Error("db locked");
        },
        addNode: () => {},
        addEdge: () => {},
      },
      memory: {
        getByPath: () => {
          throw new Error("db locked");
        },
      },
    };
    const pipeline = new ValidationPipeline(deps, {
      onAlert: (event) => alerts.push(event),
    });
    const v = pipeline.ingest(legalMr);
    expect(v.pass).toBe(false);
    expect(v.reasonCode).toBe("internal-error");
    expect(alerts.length).toBe(1);
    expect(alerts[0].error).toContain("db locked");
    expect(rowCount(db, "kg_nodes")).toBe(beforeNodes); // 零写入
    expect(rowCount(db, "kg_edges")).toBe(beforeEdges);
  });
});
