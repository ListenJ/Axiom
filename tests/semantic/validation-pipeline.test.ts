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
import {
  ValidationPipeline,
  type ValidationPipelineDeps,
} from "../../src/semantic/validation-pipeline.js";
import type { MeaningRepresentation } from "../../src/semantic/meaning-schema.js";

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

describe("S-A8 切片 4：ValidationPipeline 级 2 实存性校验", () => {
  /** Map 内存假件（规则 8：接受依赖）：KG 节点表 + Vault 笔记表，表外一律不可解析 */
  function makeFakeDeps(nodes: string[], notes: string[]): ValidationPipelineDeps {
    const kgMap = new Map(nodes.map((id) => [id, { id }]));
    const noteSet = new Set(notes);
    return {
      kg: { getNode: (id) => kgMap.get(id) ?? null },
      memory: { getByPath: (p) => (noteSet.has(p) ? { path: p } : null) },
    };
  }

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

  it("全部可解析（实体在 KG、vault 笔记存在）→ 通过且 level=2", () => {
    const verdict = new ValidationPipeline(
      makeFakeDeps(["e-sqlite"], ["docs/architecture.md"]),
    ).validate(legalMr);
    expect(verdict.pass).toBe(true);
    expect(verdict.level).toBe(2);
    expect(verdict.reasonCode).toBeNull();
  });
});
