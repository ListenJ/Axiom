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

/** V5：关系有向图环检测（DFS 三色标记，自环 A→A 亦计为环） */
function hasCyclicRelation(relations: Array<{ source: string; target: string }>): boolean {
  const adjacency = new Map<string, string[]>();
  for (const r of relations) {
    const list = adjacency.get(r.source) ?? [];
    list.push(r.target);
    adjacency.set(r.source, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of adjacency.keys()) {
    if (dfs(node)) return true;
  }
  return false;
}

/**
 * S-A1 公共校验入口（fail-closed）。
 * 类型/字段级校验走 zod；声明闭合、循环等结构级校验由后续切片补充。
 */
export function validateMeaningRepresentation(x: unknown): ValidationResult {
  // V7：非对象输入（null / 原始值 / 数组）在最前置拦截
  if (x === null || typeof x !== "object" || Array.isArray(x)) {
    return { ok: false, reasonCodes: ["not-an-object"] };
  }
  const parsed = meaningRepresentationSchema.safeParse(x);
  if (!parsed.success) {
    // V1/V3：按 issue path 精确归因——溯源头缺失/前缀非法 → missing-provenance，其余类型错配 → type-mismatch
    const codes = new Set<string>();
    for (const issue of parsed.error.issues) {
      codes.add(issue.path.includes("sourceAnchor") ? "missing-provenance" : "type-mismatch");
    }
    return { ok: false, reasonCodes: [...codes] };
  }
  // V6+：结构级闭合检查（原因码收集，全部通过才 ok）
  const mr = parsed.data;
  const codes: string[] = [];
  if (mr.propositions.length === 0) codes.push("empty-propositions");
  if (mr.entities.length === 0) codes.push("empty-entities");
  // V2：命题实体链接必须指向已声明实体
  const declaredEntities = new Set(mr.entities.map((e) => e.id));
  if (mr.propositions.some((p) => p.entityIds.some((id) => !declaredEntities.has(id)))) {
    codes.push("dangling-entity-ref");
  }
  // V4：关系端点必须指向已声明实体（schema 层只查声明闭合，实存性留给流水线级 2）
  if (mr.relations.some((r) => !declaredEntities.has(r.source) || !declaredEntities.has(r.target))) {
    codes.push("endpoint-not-declared");
  }
  // V5：循环关系（A→B→A / 自环）
  if (hasCyclicRelation(mr.relations)) {
    codes.push("cyclic-relation");
  }
  return codes.length > 0 ? { ok: false, reasonCodes: codes } : { ok: true, reasonCodes: [] };
}
