/**
 * S-A1：语义表示 schema + 结构校验器（层 1 地基）
 *
 * 计划口径（docs/superpowers/plans/2026-09-07-semantic-meaning-runtime-optimization-plan.md A.1 S-A1）：
 * MeaningRepresentation 类型（命题集、实体链接、关系三元组、溯源头引用、置信标记）+ zod 校验。
 * 验收：非法变体 fail-closed；合法样例零误拒。
 *
 * 溯源 anchor 格式：`vault:<path>` / `kg:<id>` 双前缀（S-A8 计划第六节决策点）。
 */
import { z } from "zod";

/** 溯源头引用：vault 笔记路径或 KG 节点 id，双前缀可解析锚 */
const sourceAnchorSchema = z
  .string()
  .regex(/^(vault|kg):.+/u, "anchor 必须以 vault: 或 kg: 前缀开头");

const entitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const propositionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** 置信标记：[0,1] 闭区间 */
  confidence: z.number().min(0).max(1),
  sourceAnchor: sourceAnchorSchema,
  /** 实体链接：引用本表示中已声明的实体 id */
  entityIds: z.array(z.string()),
});

const relationSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1),
});

const meaningRepresentationSchema = z.object({
  propositions: z.array(propositionSchema),
  entities: z.array(entitySchema),
  relations: z.array(relationSchema),
});

export type MeaningRepresentation = z.infer<typeof meaningRepresentationSchema>;

export interface ValidationResult {
  ok: boolean;
  /** fail-closed 原因码数组：ok=false 时非空，ok=true 时为空 */
  reasonCodes: string[];
}

/**
 * S-A1 公共校验入口（fail-closed）。
 * 类型/字段级校验走 zod；声明闭合、循环等结构级校验由后续切片补充。
 */
export function validateMeaningRepresentation(x: unknown): ValidationResult {
  const parsed = meaningRepresentationSchema.safeParse(x);
  if (!parsed.success) {
    // 切片 2 将按非法变体矩阵精化为精确原因码映射
    return { ok: false, reasonCodes: ["schema-invalid"] };
  }
  return { ok: true, reasonCodes: [] };
}
