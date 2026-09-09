/**
 * S-A2：多级校验流水线（S-A8 切片 3 起逐步落地）
 *
 * 计划口径（docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md 第二节接口面）：
 * new ValidationPipeline({ kg, memory }, options?).validate(mr) → PipelineVerdict { pass, level, reasonCode, detail, flags }
 * 依赖全部注入（规则 8）；级 1 为薄透传，复用 S-A1 validateMeaningRepresentation。
 *
 * 级别语义：1=语法级（S-A1 透传）；2=结构级·实存性（实体 KG 可解析 + 溯源 anchor 双前缀可解析）；
 * 3=逻辑一致性（同实体对矛盾关系→conflict，策略可配置：mark 默认放行防误杀 / reject 拒绝）；
 * 4=上下文连贯（输入关键实体与 ctx.keyEntities 重叠度低于阈值→low-confidence 降级标记，不拒绝）。
 * 生产依赖为同步接口（KnowledgeGraphEnhanced.getNode/getOutEdges / SQLiteMemory.getByPath），故 validate 同步。
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
  /** 软标记（如 conflict）：pass=true 时也可能非空，供调用方按策略处置 */
  flags: string[];
}

/** 级 2+ 依赖接口（结构对齐生产实现：KnowledgeGraphEnhanced / SQLiteMemory） */
export interface ValidationPipelineDeps {
  kg: {
    getNode(id: string): unknown;
    getOutEdges(nodeId: string): Array<{ target: string; type: string }>;
  };
  memory: { getByPath(path: string): unknown };
  /** 级 4 可选：文本向量化（生产接真实 embedder，测试注入字符频率假件，计划第四节） */
  embedder?: { embed(text: string): number[] };
}

/** 级 4 上下文（调用方从 vault 笔记原文/对话历史预提取关键实体） */
export interface ValidationContext {
  keyEntities?: string[];
}

export interface ValidationPipelineOptions {
  /** 级 3 conflict 处置策略：mark=放行并标记（默认，开放世界防误杀）；reject=拒绝 */
  conflictPolicy?: "mark" | "reject";
  /** 级 4 重叠度阈值：低于此值打 low-confidence（默认 0.1≈要求至少一个关键实体与上下文有交集） */
  contextOverlapThreshold?: number;
}

/** 级 4 单实体匹配阈值（字符频率向量：同名/近形 ≥0.9，无关词 ≲0.45） */
const ENTITY_SIM_THRESHOLD = 0.5;

/** 余弦相似度（零向量返回 0，fail 向不匹配侧） */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class ValidationPipeline {
  private readonly conflictPolicy: "mark" | "reject";
  private readonly contextOverlapThreshold: number;

  constructor(
    private readonly deps: ValidationPipelineDeps,
    options: ValidationPipelineOptions = {},
  ) {
    this.conflictPolicy = options.conflictPolicy ?? "mark";
    this.contextOverlapThreshold = options.contextOverlapThreshold ?? 0.1;
  }

  /** 多级校验入口（fail-closed：任一级拦截即拒绝；软标记除外） */
  validate(mr: unknown, ctx?: ValidationContext): PipelineVerdict {
    // 级 1：语法级薄透传（复用 S-A1）
    const l1 = validateMeaningRepresentation(mr);
    if (!l1.ok) {
      return {
        pass: false,
        level: 1,
        reasonCode: l1.reasonCodes[0],
        detail: `级 1 语法级拦截: ${l1.reasonCodes.join(",")}`,
        flags: [],
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
        flags: [],
      };
    }
    // 级 3：逻辑一致性——同实体对矛盾关系检测（只读，不写入 KG）
    // 既有同源同向边类型不同 → conflict；类型相同 → 合法幂等重放；无既有边 → 开放世界新事实放行
    const flags = new Set<string>();
    const conflicts: string[] = [];
    for (const rel of parsed.relations) {
      const contradicted = this.deps.kg
        .getOutEdges(rel.source)
        .some((e) => e.target === rel.target && e.type !== rel.type);
      if (contradicted) {
        flags.add("conflict");
        conflicts.push(`${rel.source}->${rel.target}(${rel.type})`);
      }
    }
    if (flags.has("conflict") && this.conflictPolicy === "reject") {
      return {
        pass: false,
        level: 3,
        reasonCode: "conflict",
        detail: `级 3 逻辑一致性冲突: ${conflicts.join(", ")}`,
        flags: [...flags],
      };
    }
    // 级 4：上下文连贯——关键实体重叠度（降级不拒绝）
    // ctx.keyEntities 与 embedder 同时在场才可判定；缺席则级 4 无证据，pass 但 level 停留在已判定层级
    const keyEntities = ctx?.keyEntities;
    const embedder = this.deps.embedder;
    const evaluatedL4 = !!(embedder && keyEntities && keyEntities.length > 0);
    if (evaluatedL4) {
      const ctxVecs = keyEntities.map((name) => embedder.embed(name));
      let matched = 0;
      for (const entity of parsed.entities) {
        const v = embedder.embed(entity.name);
        const maxSim = Math.max(...ctxVecs.map((c) => cosine(v, c)));
        if (maxSim >= ENTITY_SIM_THRESHOLD) matched += 1;
      }
      const overlap = matched / parsed.entities.length;
      if (overlap < this.contextOverlapThreshold) {
        flags.add("low-confidence");
      }
    }
    return {
      pass: true,
      level: evaluatedL4 ? 4 : 3,
      reasonCode: null,
      detail:
        flags.size > 0
          ? `级 1-${evaluatedL4 ? 4 : 3} 通过（含标记: ${[...flags].join(",")}）`
          : `级 1-${evaluatedL4 ? 4 : 3} 通过`,
      flags: [...flags],
    };
  }
}
