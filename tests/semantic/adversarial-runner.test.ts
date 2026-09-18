/**
 * S-A8 切片 8：对抗样例集全量拦截（S-A2 收口）
 *
 * 计划口径（docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md 第三节切片 8）：
 * - eval/semantic-validation/adversarial/：畸形/对抗样例 ≥30 例（V1-V7 每类 ≥3 + 组合畸形 ≥9，
 *   含注入风格字段、超深嵌套、超大 payload）；
 * - runner 断言 100% 被拦截且每例有原因码；
 * - 样例集 JSON 化、确定性可复现。
 *
 * 判定走 ValidationPipeline 公共接口（S-A2 语义），依赖注入空 KG/空 memory 假件——
 * 语法合法样例的实体/溯源锚必然不可解析（级 2 fail-closed 兜底），全程零网络零写入。
 */
import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  loadAdversarialSamples,
  makeEmptyDeps,
  runAdversarialSuite,
} from "../../eval/semantic-validation/tools/adversarial-runner.js";

const adversarialDir = path.resolve("eval/semantic-validation/adversarial");

describe("S-A8 切片 8：对抗样例集全量拦截", () => {
  const samples = loadAdversarialSamples(adversarialDir);

  it("样例集 ≥30 例且类别分布达标（V1-V7 每类 ≥3、COMBO ≥9）", () => {
    expect(samples.length).toBeGreaterThanOrEqual(30);
    for (const cat of ["V1", "V2", "V3", "V4", "V5", "V6", "V7"]) {
      const n = samples.filter((s) => s.category === cat).length;
      expect(n).toBeGreaterThanOrEqual(3);
    }
    const combo = samples.filter((s) => s.category === "COMBO").length;
    expect(combo).toBeGreaterThanOrEqual(9);
  });

  it("runner 判定：100% 拦截且每例有原因码", () => {
    const report = runAdversarialSuite(samples, makeEmptyDeps());
    expect(report.total).toBe(samples.length);
    expect(report.blocked).toBe(report.total);
    expect(report.blockRate).toBe(1);
    expect(report.allHaveReasonCode).toBe(true);
    for (const c of report.cases) {
      expect(c.blocked).toBe(true);
      expect(c.reasonCode).not.toBeNull();
    }
  });

  it("runner 判定语义：非对象输入级 1 not-an-object；语法合法样例级 2 unresolved-entity 兜底", () => {
    const report = runAdversarialSuite(
      [
        { id: "t-1", category: "V7", variant: "null-input", mr: null },
        {
          id: "t-2",
          category: "COMBO",
          variant: "legal-syntax-unresolvable",
          mr: {
            propositions: [
              {
                id: "p-1",
                text: "语法完全合法但实体在空 KG 中不可解析。",
                confidence: 0.9,
                sourceAnchor: "vault:docs/architecture.md",
                entityIds: ["e-sqlite"],
              },
            ],
            entities: [{ id: "e-sqlite", name: "SQLite" }],
            relations: [],
          },
        },
      ],
      makeEmptyDeps(),
    );
    expect(report.blocked).toBe(2);
    const byId = new Map(report.cases.map((c) => [c.id, c]));
    expect(byId.get("t-1")!.reasonCode).toBe("not-an-object");
    expect(byId.get("t-2")!.reasonCode).toBe("unresolved-entity");
  });
});
