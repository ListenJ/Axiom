/**
 * S-A2：多级校验流水线（S-A8 切片 3 起逐步落地）
 *
 * 计划口径（docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md 第二节接口面）：
 * new ValidationPipeline({ kg, memory }).validate(mr) → PipelineVerdict { pass, level, reasonCode, detail }
 * 依赖全部注入（规则 8）；级 1 为薄透传，复用 S-A1 validateMeaningRepresentation。
 *
 * 级别语义：1=语法级（S-A1 透传）；2=结构级·实存性（切片 4 补全拒绝语义）。
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
    // 级 2 入口：实存性解析（切片 4 补全拒绝语义；本切片仅建立"穿过级 1"的可观测调用）
    const parsed = mr as MeaningRepresentation;
    for (const entity of parsed.entities) {
      this.deps.kg.getNode(entity.id);
    }
    return { pass: true, level: 2, reasonCode: null, detail: "级 1 通过，级 2 实存性解析已触发" };
  }
}
