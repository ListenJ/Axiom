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

/** spy 依赖：记录级 2+ 的调用证据（假件恒返回 null = 不可解析） */
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
          return null;
        },
      },
      memory: {
        getByPath: (path: string) => {
          memoryCalls.push(path);
          return null;
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
