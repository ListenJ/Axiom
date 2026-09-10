/**
 * S-A8 切片 1：S-A1 schema——合法样例零误拒（TDD RED）
 *
 * 计划口径（docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md 第三节切片 1）：
 * golden 样例（≥3 个：最小合法、完整命题集+实体链接+溯源、边界值合法）
 * 全部通过——`validateMeaningRepresentation(golden[i]).ok === true` 且 reasonCodes 为空。
 *
 * 溯源 anchor 格式（计划第六节决策点）：`vault:<path>` / `kg:<id>` 双前缀。
 */
import { describe, expect, it } from "bun:test";
import {
  validateMeaningRepresentation,
  type MeaningRepresentation,
} from "../../src/semantic/meaning-schema.js";

/** golden 1：最小合法——单实体 + 单命题，无关系 */
const minimalLegal: MeaningRepresentation = {
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

/** golden 2：完整——多命题 + 实体链接 + 双前缀溯源 + 关系三元组 */
const completeLegal: MeaningRepresentation = {
  propositions: [
    {
      id: "p-1",
      text: "KG addNode 使用 INSERT OR REPLACE 实现内容寻址幂等。",
      confidence: 0.9,
      sourceAnchor: "kg:node-src-kg-enhanced",
      entityIds: ["e-kg", "e-idempotent"],
    },
    {
      id: "p-2",
      text: "知识流水线的 LLM 门默认关闭（KNOWLEDGE_USE_LLM=false）。",
      confidence: 0.85,
      sourceAnchor: "vault:src/knowledge/pipeline.ts",
      entityIds: ["e-pipeline"],
    },
    {
      id: "p-3",
      text: "SQLite 与 KG 同库存储，事务保证一致性。",
      confidence: 0.7,
      sourceAnchor: "vault:docs/architecture.md",
      entityIds: ["e-sqlite", "e-kg"],
    },
  ],
  entities: [
    { id: "e-sqlite", name: "SQLite" },
    { id: "e-kg", name: "KnowledgeGraphEnhanced" },
    { id: "e-idempotent", name: "幂等写入" },
    { id: "e-pipeline", name: "KnowledgePipeline" },
  ],
  relations: [
    { source: "e-pipeline", target: "e-kg", type: "writes-to" },
    { source: "e-kg", target: "e-sqlite", type: "stored-in" },
  ],
};

/** golden 3：边界值合法——confidence 恰好落在 0 与 1、空实体引用列表、多端点关系链 */
const boundaryLegal: MeaningRepresentation = {
  propositions: [
    {
      id: "p-zero",
      text: "置信度下界命题（confidence=0 合法）。",
      confidence: 0,
      sourceAnchor: "vault:notes/boundary.md",
      entityIds: [],
    },
    {
      id: "p-one",
      text: "置信度上界命题（confidence=1 合法）。",
      confidence: 1,
      sourceAnchor: "kg:node-boundary",
      entityIds: ["e-a"],
    },
  ],
  entities: [
    { id: "e-a", name: "A" },
    { id: "e-b", name: "B" },
    { id: "e-c", name: "C" },
  ],
  relations: [
    { source: "e-a", target: "e-b", type: "related-to" },
    { source: "e-b", target: "e-c", type: "related-to" },
  ],
};

const goldenSamples: Array<{ name: string; sample: MeaningRepresentation }> = [
  { name: "最小合法（单实体+单命题，无关系）", sample: minimalLegal },
  { name: "完整（命题集+实体链接+双前缀溯源+关系三元组）", sample: completeLegal },
  { name: "边界值合法（confidence 0/1、空实体引用、关系链）", sample: boundaryLegal },
];

describe("S-A8 切片 1：S-A1 schema 合法样例零误拒", () => {
  it.each(goldenSamples)("golden：%s 全部通过且无原因码", ({ sample }) => {
    const result = validateMeaningRepresentation(sample);
    expect(result.ok).toBe(true);
    expect(result.reasonCodes).toEqual([]);
  });
});

/** 变体构造辅助：深克隆后自由变异（绕过 TS 字段类型，模拟外部脏输入） */
const mutable = (mr: MeaningRepresentation): Record<string, any> =>
  JSON.parse(JSON.stringify(mr)) as Record<string, any>;

describe("S-A8 切片 2：S-A1 非法变体矩阵 fail-closed", () => {
  it("V7：非对象输入（null/字符串/数组/数字）→ not-an-object", () => {
    for (const bad of [null, "mr", [minimalLegal], 42]) {
      const result = validateMeaningRepresentation(bad);
      expect(result.ok).toBe(false);
      expect(result.reasonCodes).toEqual(["not-an-object"]);
    }
  });

  it("V3：类型错配（confidence 越界 / 字段类型不符）→ type-mismatch", () => {
    const overConfidence = mutable(completeLegal);
    overConfidence.propositions[1].confidence = 1.5;
    expect(validateMeaningRepresentation(overConfidence).ok).toBe(false);
    expect(validateMeaningRepresentation(overConfidence).reasonCodes).toEqual(["type-mismatch"]);

    const badText = mutable(completeLegal);
    badText.propositions[0].text = 123;
    expect(validateMeaningRepresentation(badText).reasonCodes).toEqual(["type-mismatch"]);
  });

  it("V6：空命题集 / 空实体集 → empty-propositions / empty-entities", () => {
    const noProps = mutable(completeLegal);
    noProps.propositions = [];
    expect(validateMeaningRepresentation(noProps).reasonCodes).toEqual(["empty-propositions"]);

    const noEntities = mutable(minimalLegal);
    noEntities.entities = [];
    noEntities.propositions[0].entityIds = [];
    expect(validateMeaningRepresentation(noEntities).reasonCodes).toEqual(["empty-entities"]);
  });

  it("V1：缺溯源头引用（缺失 / 前缀非法）→ missing-provenance", () => {
    const noAnchor = mutable(completeLegal);
    delete noAnchor.propositions[1].sourceAnchor;
    expect(validateMeaningRepresentation(noAnchor).reasonCodes).toEqual(["missing-provenance"]);

    const badAnchor = mutable(completeLegal);
    badAnchor.propositions[2].sourceAnchor = "note:nowhere.md";
    expect(validateMeaningRepresentation(badAnchor).reasonCodes).toEqual(["missing-provenance"]);
  });

  it("V2：悬空实体引用（命题引用未声明实体）→ dangling-entity-ref", () => {
    const dangling = mutable(completeLegal);
    dangling.propositions[0].entityIds.push("e-ghost");
    expect(validateMeaningRepresentation(dangling).ok).toBe(false);
    expect(validateMeaningRepresentation(dangling).reasonCodes).toEqual(["dangling-entity-ref"]);
  });

  it("V4：关系端点缺失（端点非已声明实体）→ endpoint-not-declared", () => {
    const badEndpoint = mutable(completeLegal);
    badEndpoint.relations.push({ source: "e-ghost", target: "e-sqlite", type: "related-to" });
    expect(validateMeaningRepresentation(badEndpoint).ok).toBe(false);
    expect(validateMeaningRepresentation(badEndpoint).reasonCodes).toEqual([
      "endpoint-not-declared",
    ]);
  });

  it("V5：循环关系（A→B→A 二环 / A→A 自环）→ cyclic-relation", () => {
    const twoCycle = mutable(completeLegal);
    // 既有 e-kg→e-sqlite，补反向边构成二环
    twoCycle.relations.push({ source: "e-sqlite", target: "e-kg", type: "related-to" });
    expect(validateMeaningRepresentation(twoCycle).ok).toBe(false);
    expect(validateMeaningRepresentation(twoCycle).reasonCodes).toEqual(["cyclic-relation"]);

    const selfLoop = mutable(completeLegal);
    selfLoop.relations.push({ source: "e-pipeline", target: "e-pipeline", type: "related-to" });
    expect(validateMeaningRepresentation(selfLoop).reasonCodes).toEqual(["cyclic-relation"]);
  });
});
