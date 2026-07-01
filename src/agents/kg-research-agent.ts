/**
 * Hermes 深度研究增强 — 知识图谱驱动的确定性分析
 *
 * 将 CodeGraph 知识图谱作为 Hermes 研究时的"硬证据"，
 * 避免 LLM 对项目架构的猜测。工作流程:
 *
 *   1. 接收研究任务 (如 "分析项目的多智能体架构")
 *   2. 从知识图谱提取相关实体和关系
 *   3. 构建包含代码结构的增强 prompt
 *   4. 调用 Hermes 或 OpenRouter API 进行深度研究
 *   5. 将研究结果回写到知识图谱 (自动知识积累)
 *
 * 确定性保证:
 *   - 代码结构信息来自 AST 分析 (tree-sitter/codegraph)，非 LLM 推断
 *   - 关系图来自实际代码调用关系，非语义猜测
 *   - 模型仅负责"解读"而非"发现"代码结构
 */
import { logger } from "../utils/logger.js";
import { internalAgent } from "./internal-agent.js";
import { isPgAvailable, getPG } from "../db/pg-client.js";
import {
  buildResearchContext,
  type KGEntity,
} from "../memory/knowledge-graph-builder.js";

// ========== 类型定义 ==========

export interface ResearchTask {
  /** 研究主题/问题 */
  query: string;
  /** 项目路径 (用于知识图谱查询) */
  projectPath?: string;
  /** 项目名称 */
  projectName?: string;
  /** 研究深度: quick (快速) | deep (深度) | exhaustive (穷尽) */
  depth?: "quick" | "deep" | "exhaustive";
  /** 额外上下文 (手动补充) */
  additionalContext?: string;
  /** 使用的模型 (默认使用 Hermes 或免费模型) */
  model?: string;
  /** 超时 (ms) */
  timeout?: number;
}

export interface ResearchResult {
  /** 研究结论 (Markdown) */
  conclusion: string;
  /** 引用的知识图谱实体 */
  referencedEntities: KGEntity[];
  /** 引用的代码关系 */
  referencedRelationships: Array<{
    source: string;
    target: string;
    type: string;
  }>;
  /** 置信度评分 (0-1) */
  confidence: number;
  /** 研究耗时 (ms) */
  durationMs: number;
  /** 使用的模型 */
  model: string;
  /** 补充发现 (新实体/关系，可回写到图谱) */
  newFindings: {
    entities: KGEntity[];
    relationships: Array<{ sourceName: string; targetName: string; relationType: string }>;
  };
}

// ========== 研究执行器 ==========

/**
 * 执行知识图谱增强的深度研究
 */
export async function runKnowledgeGraphResearch(
  task: ResearchTask,
): Promise<ResearchResult> {
  const startTime = Date.now();
  const {
    query,
    projectName = "current",
    depth = "deep",
    model = "nousresearch/hermes-3-llama-3.1-405b:free",
    timeout = 120000,
  } = task;

  logger.info("[KGResearch] Starting research", { query, depth, model });

  // Step 1: 从知识图谱获取上下文
  const kgContext = await buildResearchContext(query, {
    projectName: task.projectName,
    maxEntities: depth === "quick" ? 20 : depth === "deep" ? 50 : 100,
    maxDepth: depth === "quick" ? 1 : depth === "deep" ? 2 : 3,
  });

  logger.info("[KGResearch] KG context built", {
    entities: kgContext.entities.length,
    relationships: kgContext.relationships.length,
  });

  // Step 2: 构建增强 prompt
  const enhancedPrompt = buildEnhancedPrompt(query, kgContext, task.additionalContext);

  // Step 3: 调用模型
  const conclusion = await callResearchModel(model, enhancedPrompt, timeout);

  // Step 4: 解析结果中的新发现
  const newFindings = extractNewFindings(conclusion, kgContext);

  // Step 5: 回写新发现到知识图谱 (异步)
  if (newFindings.entities.length > 0 || newFindings.relationships.length > 0) {
    writeFindingsToKG(newFindings).catch((err) => {
      logger.warn("[KGResearch] Failed to write findings to KG", { error: (err as Error).message });
    });
  }

  const durationMs = Date.now() - startTime;

  const result: ResearchResult = {
    conclusion,
    referencedEntities: kgContext.entities,
    referencedRelationships: kgContext.relationships,
    confidence: computeConfidence(kgContext, conclusion),
    durationMs,
    model,
    newFindings,
  };

  logger.info("[KGResearch] Research complete", {
    durationMs,
    referencedEntities: kgContext.entities.length,
    newEntities: newFindings.entities.length,
    confidence: result.confidence,
  });

  return result;
}

// ========== Prompt 构建 ==========

function buildEnhancedPrompt(
  query: string,
  kgContext: Awaited<ReturnType<typeof buildResearchContext>>,
  additionalContext?: string,
): string {
  const sections: string[] = [];

  sections.push("# Research Task");
  sections.push(query);
  sections.push("");

  // 注入确定性代码结构信息
  if (kgContext.summary) {
    sections.push("# Verified Code Structure (from static analysis, NOT speculation)");
    sections.push("The following information is extracted directly from the codebase via AST analysis.");
    sections.push("Use this as ground truth — do NOT guess about project structure.");
    sections.push("");
    sections.push(kgContext.summary);
    sections.push("");
  }

  // 注入实体详情
  if (kgContext.entities.length > 0) {
    sections.push("## Relevant Code Entities");
    const grouped: Record<string, typeof kgContext.entities> = {};
    for (const e of kgContext.entities) {
      if (!grouped[e.type]) grouped[e.type] = [];
      grouped[e.type].push(e);
    }
    for (const [type, entities] of Object.entries(grouped)) {
      sections.push(`\n### ${type} (${entities.length})`);
      for (const e of entities.slice(0, 15)) {
        const desc = e.description ? ` — ${e.description}` : "";
        const props = Object.keys(e.properties || {}).length > 0
          ? ` [${Object.entries(e.properties).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(", ")}]`
          : "";
        sections.push(`- **${e.name}**${desc}${props}`);
      }
    }
    sections.push("");
  }

  // 注入关系
  if (kgContext.relationships.length > 0) {
    sections.push("## Code Relationships (verified call/dependency graph)");
    for (const rel of kgContext.relationships.slice(0, 30)) {
      sections.push(`- ${rel.source} --[${rel.type}]--> ${rel.target}`);
    }
    sections.push("");
  }

  // 项目结构概览
  if (kgContext.codeStructure.files > 0) {
    sections.push("## Project Structure Overview");
    sections.push(`- Files: ${kgContext.codeStructure.files}`);
    sections.push(`- Functions/Methods: ${kgContext.codeStructure.functions}`);
    sections.push(`- Classes/Interfaces: ${kgContext.codeStructure.classes}`);
    if (kgContext.codeStructure.dependencies.length > 0) {
      sections.push(`- Dependencies: ${kgContext.codeStructure.dependencies.join(", ")}`);
    }
    sections.push("");
  }

  if (additionalContext) {
    sections.push("# Additional Context");
    sections.push(additionalContext);
    sections.push("");
  }

  sections.push("# Instructions");
  sections.push("Based on the verified code structure above, provide a thorough analysis.");
  sections.push("Focus on:");
  sections.push("1. Architecture patterns and design decisions evident in the code");
  sections.push("2. Potential issues, anti-patterns, or improvement opportunities");
  sections.push("3. How the code structure relates to the research question");
  sections.push("4. Concrete, actionable recommendations backed by the code evidence");
  sections.push("");
  sections.push("IMPORTANT: Base your analysis ONLY on the verified structure above.");
  sections.push("Do NOT speculate about code you cannot see. If information is insufficient, say so explicitly.");
  sections.push("Cite specific entities and relationships when making claims.");

  return sections.join("\n");
}

// ========== 模型调用 ==========

/**
 * 通过 model-router 路由研究任务。`model` 参数被映射为 role（向后兼容）：
 *   - 当提供具体模型 ID 时，记录在 `trackAs` 中以便 token 追踪可识别
 *   - 按 `research` role 选择模型，享受重试/降级/超时
 */
async function callResearchModel(
  model: string,
  prompt: string,
  timeout: number,
): Promise<string> {
  // model-router 通过 role 选择实际模型；传入的 `model` 名称用于追踪标签
  const result = await internalAgent.executeWithRole("research", [
    {
      role: "system",
      content: `You are a senior software architect performing code analysis.
You have been given verified code structure data from static analysis.
Your task is to analyze and interpret this data accurately.
Always cite specific entities and relationships from the provided data.
Never fabricate or speculate about code structure.
Respond in the same language as the research question.`,
    },
    { role: "user", content: prompt },
  ], { maxTokens: 4096, temperature: 0.3, timeout, trackAs: `kg-research:${model}` });

  return result.content || "[No response from research model]";
}

// ========== 新发现提取 ==========

function extractNewFindings(
  conclusion: string,
  existingContext: Awaited<ReturnType<typeof buildResearchContext>>,
): ResearchResult["newFindings"] {
  const findings: ResearchResult["newFindings"] = {
    entities: [],
    relationships: [],
  };

  // 从结论中提取概念性实体
  // (简单模式匹配，高级场景可用 LLM 提取)
  const existingNames = new Set(existingContext.entities.map((e: KGEntity) => e.name.toLowerCase()));

  // 提取 "X 模式", "X 架构", "X 策略" 等概念
  const patternMatches = conclusion.matchAll(/\b(\w+(?:\s+\w+){0,2})\s+(?:模式|架构|策略|设计|框架|协议|机制|pipeline|pattern|architecture|strategy)/gi);
  for (const match of patternMatches) {
    const name = match[1].trim();
    if (name.length > 2 && !existingNames.has(name.toLowerCase())) {
      findings.entities.push({
        name: `concept:${name}`,
        type: "concept",
        description: `Identified from research: ${match[0]}`,
        properties: { discoveredBy: "kg-research" },
        source: "hermes",
      });
      existingNames.add(name.toLowerCase());
    }
  }

  return findings;
}

async function writeFindingsToKG(findings: ResearchResult["newFindings"]): Promise<void> {
  if (!(await isPgAvailable())) return;
  const pg = getPG();

  for (const entity of findings.entities) {
    try {
      await pg`
        INSERT INTO kg_entities (name, type, description, properties, source)
        VALUES (${entity.name}, ${entity.type}, ${entity.description || null}, ${pg.json(entity.properties)}, ${entity.source})
        ON CONFLICT (name) DO NOTHING
      `;
    } catch { /* ignore */ }
  }

  // 关系需要 entity id，这里简化处理
  // 实际使用时需要先查找 name → id 映射
}

// ========== 置信度评估 ==========

function computeConfidence(
  kgContext: Awaited<ReturnType<typeof buildResearchContext>>,
  conclusion: string,
): number {
  let confidence = 0.5;

  // 知识图谱覆盖率越高，置信度越高
  if (kgContext.entities.length > 20) confidence += 0.15;
  else if (kgContext.entities.length > 10) confidence += 0.1;
  else if (kgContext.entities.length > 5) confidence += 0.05;

  if (kgContext.relationships.length > 10) confidence += 0.1;
  else if (kgContext.relationships.length > 5) confidence += 0.05;

  // 结论引用了具体实体名称
  const entityNames = kgContext.entities.map((e: KGEntity) => e.name.toLowerCase());
  const citedCount = entityNames.filter((name: string) => conclusion.toLowerCase().includes(name)).length;
  const citationRatio = entityNames.length > 0 ? citedCount / entityNames.length : 0;
  confidence += citationRatio * 0.2;

  return Math.min(1.0, Math.round(confidence * 100) / 100);
}

// ========== Hermes CLI 集成 (备选方案) ==========

/**
 * 通过 Hermes CLI 执行研究 (当 API 不可用时的回退方案)
 */
export async function runHermesCLIResearch(
  task: ResearchTask,
): Promise<ResearchResult> {
  const startTime = Date.now();
  const { query, depth = "deep" } = task;

  // 构建 KG 上下文
  const kgContext = await buildResearchContext(query, {
    projectName: task.projectName,
    maxEntities: 30,
    maxDepth: 2,
  });

  // 构建增强 prompt
  const enhancedPrompt = buildEnhancedPrompt(query, kgContext, task.additionalContext);

  try {
    const { runHermesTask } = await import("../agents/hermes-agent.js");
    const result = await runHermesTask({
      prompt: enhancedPrompt,
      timeoutMs: task.timeout || 300000,
    });

    return {
      conclusion: result.stdout || "[No output from Hermes]",
      referencedEntities: kgContext.entities,
      referencedRelationships: kgContext.relationships,
      confidence: computeConfidence(kgContext, result.stdout || ""),
      durationMs: Date.now() - startTime,
      model: "hermes-cli",
      newFindings: { entities: [], relationships: [] },
    };
  } catch (err) {
    return {
      conclusion: `Hermes CLI research failed: ${(err as Error).message}`,
      referencedEntities: kgContext.entities,
      referencedRelationships: kgContext.relationships,
      confidence: 0,
      durationMs: Date.now() - startTime,
      model: "hermes-cli",
      newFindings: { entities: [], relationships: [] },
    };
  }
}
