/**
 * 知识质量评估器 (Task 3.3)
 *
 * 三维评分（各 0-1，加权综合）：
 *   - accuracy (权重 0.4)：与既有事实库一致性（调 ConformalHallucinationDetector.verify
 *     取 `pValue` 在 summary + sections 上的均值；pValue 越大越可信；无 factBase 时给中位分 0.5）
 *   - completeness (权重 0.3)：必填字段覆盖率（title/summary/keywords/sections/entities）
 *   - consistency (权重 0.3)：内部一致性（keywords 出现在 sections 中、entities 在 sections 中被提及）
 *
 * API: assessQuality(structured, factBase?): QualityReport
 *
 * 降级策略：评估失败返回 overall=0 + issues 描述，调用方应丢弃该数据。
 */
import { ConformalHallucinationDetector, type FactEntry } from "../memory/hallucination-detector.js";
import type { StructuredKnowledge } from "./types.js";

/** 质量评估报告 */
export interface QualityReport {
  /** 与事实库一致性 ∈ [0, 1] */
  accuracy: number;
  /** 必填字段覆盖率 ∈ [0, 1] */
  completeness: number;
  /** 内部一致性 ∈ [0, 1] */
  consistency: number;
  /** 加权综合得分 ∈ [0, 1] */
  overall: number;
  /** 质量问题描述（用于日志 / 调试） */
  issues: string[];
}

/** 权重（accuracy + completeness + consistency = 1.0） */
const WEIGHTS = {
  accuracy: 0.4,
  completeness: 0.3,
  consistency: 0.3,
} as const;

// ============================================================================
// 维度 1：accuracy — 与事实库一致性
// ============================================================================

/**
 * 计算 accuracy：在 summary + 各 section.content 上调 ConformalHallucinationDetector.verify，
 * 取 `pValue` 的均值（pValue 越大越可信）。
 *
 * 无 factBase 或所有验证失败时返回 0.5（中位分，不奖不罚）。
 */
function computeAccuracy(structured: StructuredKnowledge, factBase?: FactEntry[]): number {
  if (!factBase || factBase.length === 0) return 0.5;

  try {
    const detector = new ConformalHallucinationDetector({
      alpha: 0.1,
      factBase,
    });

    const statements: string[] = [];
    if (structured.summary && structured.summary.trim().length > 0) {
      statements.push(structured.summary);
    }
    for (const section of structured.sections) {
      if (section.content && section.content.trim().length > 0) {
        statements.push(section.content);
      }
    }

    if (statements.length === 0) return 0.5;

    let sum = 0;
    let count = 0;
    for (const stmt of statements) {
      try {
        const verdict = detector.verify(stmt);
        // pValue 越大越可信，直接作为该 statement 的 accuracy 贡献
        sum += verdict.pValue;
        count++;
      } catch {
        // 单条验证失败不影响整体
      }
    }

    if (count === 0) return 0.5;
    return Math.max(0, Math.min(1, sum / count));
  } catch {
    return 0.5;
  }
}

// ============================================================================
// 维度 2：completeness — 必填字段覆盖率
// ============================================================================

function computeCompleteness(structured: StructuredKnowledge): { score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;

  // title: 非空
  if (structured.title && structured.title.trim().length > 0) {
    score += 0.2;
  } else {
    issues.push("title 缺失或为空");
  }

  // summary: 非空且 >= 50 字符
  if (structured.summary && structured.summary.trim().length >= 50) {
    score += 0.2;
  } else if (structured.summary && structured.summary.trim().length > 0) {
    score += 0.1;
    issues.push("summary 过短（< 50 字符）");
  } else {
    issues.push("summary 缺失");
  }

  // keywords: >= 3 项
  if (Array.isArray(structured.keywords)) {
    if (structured.keywords.length >= 3) {
      score += 0.2;
    } else if (structured.keywords.length > 0) {
      score += 0.1;
      issues.push(`keywords 数量不足（${structured.keywords.length} < 3）`);
    } else {
      issues.push("keywords 为空数组");
    }
  } else {
    issues.push("keywords 字段非数组");
  }

  // sections: >= 1 个 section 且 content >= 20 字符
  if (Array.isArray(structured.sections)) {
    const validSections = structured.sections.filter(
      (s) => s.heading && s.content && s.content.trim().length >= 20,
    );
    if (validSections.length >= 1) {
      score += 0.2;
    } else if (structured.sections.length > 0) {
      score += 0.1;
      issues.push("sections 内容过短（content < 20 字符）");
    } else {
      issues.push("sections 为空数组");
    }
  } else {
    issues.push("sections 字段非数组");
  }

  // entities: >= 1 个 entity
  if (Array.isArray(structured.entities)) {
    if (structured.entities.length >= 1) {
      score += 0.2;
    } else {
      issues.push("entities 为空数组");
    }
  } else {
    issues.push("entities 字段非数组");
  }

  return { score: Math.max(0, Math.min(1, score)), issues };
}

// ============================================================================
// 维度 3：consistency — 内部一致性
// ============================================================================

function computeConsistency(structured: StructuredKnowledge): { score: number; issues: string[] } {
  const issues: string[] = [];

  // 把所有 sections 的 heading + content 拼成一个 haystack（小写）
  const haystack = structured.sections
    .map((s) => `${s.heading} ${s.content}`)
    .join(" ")
    .toLowerCase();

  if (haystack.trim().length === 0) {
    return { score: 0, issues: ["sections 内容为空，无法评估一致性"] };
  }

  // keywords 在 sections 中出现的比例
  let kwHits = 0;
  let kwTotal = 0;
  for (const kw of structured.keywords) {
    if (!kw || kw.trim().length === 0) continue;
    kwTotal++;
    if (haystack.includes(kw.toLowerCase())) kwHits++;
  }
  const kwRatio = kwTotal > 0 ? kwHits / kwTotal : 0.5; // 无 keywords 时给中位分

  // entities 在 sections 中被提及的比例
  let entHits = 0;
  let entTotal = 0;
  for (const ent of structured.entities) {
    if (!ent.name || ent.name.trim().length === 0) continue;
    entTotal++;
    if (haystack.includes(ent.name.toLowerCase())) entHits++;
  }
  const entRatio = entTotal > 0 ? entHits / entTotal : 0.5; // 无 entities 时给中位分

  // summary 与 sections 主题相关性（用 Jaccard 简单计算）
  const summaryTokens = new Set(structured.summary.toLowerCase().split(/\W+/).filter((t) => t.length > 1));
  const sectionTokens = new Set(haystack.split(/\W+/).filter((t) => t.length > 1));
  let summarySectionOverlap = 0.5;
  if (summaryTokens.size > 0 && sectionTokens.size > 0) {
    let intersection = 0;
    for (const t of summaryTokens) {
      if (sectionTokens.has(t)) intersection++;
    }
    const union = summaryTokens.size + sectionTokens.size - intersection;
    summarySectionOverlap = union > 0 ? intersection / union : 0;
  }

  const score = (kwRatio + entRatio + summarySectionOverlap) / 3;

  if (kwTotal > 0 && kwRatio < 0.3) {
    issues.push(`keywords 在 sections 中出现率低（${kwHits}/${kwTotal}）`);
  }
  if (entTotal > 0 && entRatio < 0.3) {
    issues.push(`entities 在 sections 中出现率低（${entHits}/${entTotal}）`);
  }

  return { score: Math.max(0, Math.min(1, score)), issues };
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 评估 StructureResult 的质量。
 *
 * @param structured GLM 返回并经 zod 校验通过的结构化知识
 * @param factBase 可选事实库（用于 accuracy 维度；缺失时 accuracy 给中位分 0.5）
 */
export function assessQuality(
  structured: StructuredKnowledge,
  factBase?: FactEntry[],
): QualityReport {
  const issues: string[] = [];

  const accuracy = computeAccuracy(structured, factBase);

  const { score: completeness, issues: completenessIssues } = computeCompleteness(structured);
  issues.push(...completenessIssues);

  const { score: consistency, issues: consistencyIssues } = computeConsistency(structured);
  issues.push(...consistencyIssues);

  const overall =
    accuracy * WEIGHTS.accuracy +
    completeness * WEIGHTS.completeness +
    consistency * WEIGHTS.consistency;

  return {
    accuracy: Math.round(accuracy * 1000) / 1000,
    completeness: Math.round(completeness * 1000) / 1000,
    consistency: Math.round(consistency * 1000) / 1000,
    overall: Math.round(overall * 1000) / 1000,
    issues,
  };
}
