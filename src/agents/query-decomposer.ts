/**
 * 查询分解器 — MeMo 式多阶段知识检索协议
 *
 * Stage 1 (Grounding): 将复杂查询分解为原子子查询
 * Stage 2 (Entity ID): 通过子查询定位相关实体和笔记
 * Stage 3 (Synthesis): 综合检索结果构建知识上下文
 */

import { logger } from "../utils/logger.js";

/** 子查询 */
export interface SubQuery {
  query: string;
  type: "factual" | "entity" | "relationship" | "procedural";
  priority: number;
}

/** 分解后的查询 */
export interface DecomposedQuery {
  originalQuery: string;
  subQueries: SubQuery[];
  entities: string[];
  strategy: "simple" | "multi-hop" | "comparative";
}

/** 知识片段 */
export interface KnowledgeFragment {
  source: string;
  title: string;
  excerpt: string;
  score: number;
  matchedSubQuery: string;
}

/** 综合上下文 */
export interface SynthesizedContext {
  fragments: KnowledgeFragment[];
  entityMap: Record<string, string[]>;
  crossDocLinks: Array<{ from: string; to: string; relation: string }>;
  summary: string;
  confidence: number;
}

/** 多跳查询关键词 */
const MULTI_HOP_KEYWORDS = ["如何", "为什么", "关系", "比较", "区别", "影响", "导致", "原因", "结果"];

/** 比较查询关键词 */
const COMPARATIVE_KEYWORDS = ["vs", "对比", "比较", "哪个好", "优劣", "差异"];

/** 中文连接词 */
const CONJUNCTIONS = ["和", "与", "以及", "同时", "还有", "或者"];

/**
 * 检测查询复杂度
 */
function detectComplexity(query: string): "simple" | "multi-hop" | "comparative" {
  const lower = query.toLowerCase();

  if (COMPARATIVE_KEYWORDS.some(kw => lower.includes(kw))) {
    return "comparative";
  }
  if (MULTI_HOP_KEYWORDS.some(kw => lower.includes(kw))) {
    return "multi-hop";
  }
  if (query.length < 15 && !CONJUNCTIONS.some(c => query.includes(c))) {
    return "simple";
  }

  return "multi-hop";
}

/**
 * 提取实体
 * 识别中文专有名词（2-4 字符）和英文大写词
 */
function extractEntities(query: string): string[] {
  const entities: string[] = [];

  const chinesePattern = /[\u4e00-\u9fa5]{2,4}(?=(是什么|的|如何|为什么))/g;
  const chineseMatches = query.match(chinesePattern) || [];
  entities.push(...chineseMatches);

  const englishPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
  const englishMatches = query.match(englishPattern) || [];
  entities.push(...englishMatches);

  const quotedPattern = /["「」](.+?)["「」]/g;
  const quotedMatches = [...query.matchAll(quotedPattern)].map(m => m[1]);
  entities.push(...quotedMatches);

  return [...new Set(entities)].filter(e => e.length >= 2);
}

/**
 * 生成子查询
 */
function generateSubQueries(query: string, strategy: "simple" | "multi-hop" | "comparative", entities: string[]): SubQuery[] {
  const subQueries: SubQuery[] = [];

  if (strategy === "simple") {
    subQueries.push({
      query,
      type: "factual",
      priority: 1.0,
    });
    return subQueries;
  }

  const parts = query.split(new RegExp(`[${CONJUNCTIONS.join("")}]`)).filter(p => p.trim());

  if (strategy === "comparative" && entities.length >= 2) {
    entities.forEach((entity, idx) => {
      subQueries.push({
        query: entity,
        type: "entity",
        priority: 1.0 - idx * 0.1,
      });
    });

    subQueries.push({
      query: entities.join(" 对比 "),
      type: "relationship",
      priority: 0.8,
    });
  } else {
    parts.forEach((part, idx) => {
      const trimmed = part.trim();
      if (trimmed.length < 2) return;

      let type: "factual" | "entity" | "relationship" | "procedural" = "factual";
      if (part.includes("如何") || part.includes("怎么")) {
        type = "procedural";
      } else if (part.includes("关系") || part.includes("联系")) {
        type = "relationship";
      } else if (entities.some(e => part.includes(e))) {
        type = "entity";
      }

      subQueries.push({
        query: trimmed,
        type,
        priority: Math.max(0.5, 1.0 - idx * 0.2),
      });
    });

    if (subQueries.length === 0) {
      subQueries.push({
        query,
        type: "factual",
        priority: 1.0,
      });
    }
  }

  return subQueries.slice(0, 4);
}

/**
 * Stage 1: 分解查询
 */
export function decomposeQuery(userQuery: string): DecomposedQuery {
  const strategy = detectComplexity(userQuery);
  const entities = extractEntities(userQuery);
  const subQueries = generateSubQueries(userQuery, strategy, entities);

  return {
    originalQuery: userQuery,
    subQueries,
    entities,
    strategy,
  };
}

/**
 * Stage 2: 搜索知识库
 */
export async function searchKnowledgeBase(
  subQueries: SubQuery[],
  vault: any,
  limit: number = 5
): Promise<KnowledgeFragment[]> {
  const allFragments: KnowledgeFragment[] = [];
  const seen = new Set<string>();

  for (const subQuery of subQueries) {
    try {
      const results = await vault.search(subQuery.query, { limit });

      for (const result of results) {
        const key = result.note.path;
        if (seen.has(key)) continue;
        seen.add(key);

        allFragments.push({
          source: result.note.path,
          title: result.note.title,
          excerpt: result.excerpt || result.note.content.slice(0, 200),
          score: result.score * subQuery.priority,
          matchedSubQuery: subQuery.query,
        });
      }
    } catch (err) {
      logger.debug("Search failed for sub-query", {
        subQuery: subQuery.query,
        error: (err as Error).message,
      });
    }
  }

  return allFragments.sort((a, b) => b.score - a.score);
}

/**
 * Stage 3: 综合结果
 */
export function synthesizeResults(fragments: KnowledgeFragment[], originalQuery: string): SynthesizedContext {
  const entityMap: Record<string, string[]> = {};

  for (const fragment of fragments) {
    const words = fragment.title.split(/[\s\-_]+/);
    for (const word of words) {
      if (word.length >= 2) {
        if (!entityMap[word]) entityMap[word] = [];
        if (!entityMap[word].includes(fragment.source)) {
          entityMap[word].push(fragment.source);
        }
      }
    }
  }

  const crossDocLinks: Array<{ from: string; to: string; relation: string }> = [];
  const entitiesWithMultipleSources = Object.entries(entityMap).filter(([, sources]) => sources.length > 1);

  for (const [entity, sources] of entitiesWithMultipleSources.slice(0, 5)) {
    for (let i = 0; i < sources.length - 1; i++) {
      crossDocLinks.push({
        from: sources[i],
        to: sources[i + 1],
        relation: `共现: ${entity}`,
      });
    }
  }

  const topFragments = fragments.slice(0, 3);
  const summary = topFragments
    .map(f => f.excerpt)
    .join("\n\n")
    .slice(0, 2000);

  const fragmentCount = fragments.length;
  const avgScore = fragmentCount > 0 ? fragments.reduce((sum, f) => sum + f.score, 0) / fragmentCount : 0;
  const entityCoverage = Object.keys(entityMap).length;

  let confidence = 0;
  if (fragmentCount > 0) {
    confidence = Math.min(1.0, (fragmentCount / 10) * 0.4 + avgScore * 0.4 + Math.min(entityCoverage / 5, 1) * 0.2);
  }

  return {
    fragments,
    entityMap,
    crossDocLinks,
    summary,
    confidence,
  };
}

/**
 * 构建知识提示
 */
export function buildKnowledgePrompt(context: SynthesizedContext): string {
  const parts: string[] = [];

  parts.push("=== 知识库上下文 ===\n");

  if (context.fragments.length > 0) {
    parts.push("相关笔记:");
    for (const fragment of context.fragments.slice(0, 5)) {
      parts.push(`\n【${fragment.title}】(${fragment.source})`);
      parts.push(fragment.excerpt);
    }
    parts.push("");
  }

  if (context.crossDocLinks.length > 0) {
    parts.push("关联关系:");
    for (const link of context.crossDocLinks.slice(0, 3)) {
      parts.push(`- ${link.from} ↔ ${link.to} (${link.relation})`);
    }
    parts.push("");
  }

  if (context.summary) {
    parts.push("摘要:");
    parts.push(context.summary);
    parts.push("");
  }

  parts.push(`置信度: ${(context.confidence * 100).toFixed(0)}%`);
  parts.push("\n请基于以上知识库内容回答问题。如果知识库中没有相关信息,请明确说明。");

  return parts.join("\n");
}
