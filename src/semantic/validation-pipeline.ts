/**
 * S-A2：多级校验流水线（S-A8 切片 3 起逐步落地）
 *
 * 计划口径（docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md 第二节接口面）：
 * new ValidationPipeline({ kg, memory }).validate(mr) → PipelineVerdict { pass, level, reasonCode, detail }
 * 依赖全部注入（规则 8）；级 1 为薄透传，复用 S-A1 validateMeaningRepresentation。
 *
 * 级别语义：1=语法级（S-A1 透传）；2=结构级·实存性（实体 KG 可解析 + 溯源 anchor 双前缀可解析）。
 * 生产依赖为同步接口（KnowledgeGraphEnhanced.getNode / SQLiteMemory.getByPath），故 validate 同步。
 */
import {
  validateMeaningRepresentation,
  type MeaningRepresentation,
} from "./meaning-schema.js";

export interface PipelineVerdict {
  pass: boolean;
  /** 判定级：fail=拦截所在级；pass=到达的最深层级 */
  level: number;
  reasonCode: string | null;
  detail: string;
}

/** 级 2+ 依赖接口（结构对齐生产实现：KnowledgeGraphEnhanced.getNode / SQLiteMemory.getByPath） */
export interface ValidationPipelineDeps {
  kg: { getNode(id: string): unknown };
  memory: { getByPath(path: string): unknown };
}

export class ValidationPipeline {
  constructor(private readonly deps: ValidationPipelineDeps) {}

  /** 多级校验入口（fail-closed：任一级拦截即拒绝） */
  validate(mr: unknown): PipelineVerdict {
    // 级 1：语法级薄透传（复用 S-A1）
    const l1 = validateMeaningRepresentation(mr);
    if (!l1.ok) {
      return {
        pass: false,
        level: 1,
        reasonCode: l1.reasonCodes[0],
        detail: `级 1 语法级拦截: ${l1.reasonCodes.join(",")}`,
      };
    }
    // 级 2：实存性校验（fail-closed 收集原因码）
    // ① 声明实体必须在 KG 可解析；② 溯源 anchor 双前缀可解析：vault:→memory.getByPath，kg:→kg.getNode
    const parsed = mr as MeaningRepresentation;
    const codes = new Set<string>();
    const offenders: string[] = [];
    for (const entity of parsed.entities) {
      if (this.deps.kg.getNode(entity.id) == null) {
        codes.add("unresolved-entity");
        offenders.push(`unresolved-entity:${entity.id}`);
      }
    }
    for (const p of parsed.propositions) {
      const anchor = p.sourceAnchor; // 级 1 已保证 vault:/kg: 双前缀
      const resolved = anchor.startsWith("vault:")
        ? this.deps.memory.getByPath(anchor.slice("vault:".length)) != null
        : this.deps.kg.getNode(anchor.slice("kg:".length)) != null;
      if (!resolved) {
        codes.add("unresolvable-provenance");
        offenders.push(`unresolvable-provenance:${anchor}`);
      }
    }
    if (codes.size > 0) {
      return {
        pass: false,
        level: 2,
        reasonCode: [...codes][0],
        detail: `级 2 实存性校验失败: ${offenders.join(", ")}`,
      };
    }
    return { pass: true, level: 2, reasonCode: null, detail: "级 1-2 通过" };
  }
}
