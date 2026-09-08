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
