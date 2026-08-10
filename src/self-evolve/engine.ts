/**
 * SelfEvolveEngine — 测试时自我进化引擎。
 *
 * 思想来源：OpenRSI（FrontisAI × 清华）的原子算子 Draft/Improve/Debug/Crossover
 * 与 RISE（清华，arXiv 2407.18219）的测试时自我改进。本实现将"模型训练级算子"
 * 降级为"提示词级算子 + 确定性评估"，无训练、无额外基础设施，契合简约主基调。
 *
 * 算子对照：
 *   selfThink     = Draft + 证据检索（强背书资料）+ 置信度精算
 *   selfImprove   = Improve（成功）/ Debug（失败）+ Crossover（历史教训注入）
 *   selfInduce    = 基于历史轨迹的确定性归纳（术语共现 + 成功率）
 *   estimateConfidence = 基于证据的自推理精算（确定性公式，可解释、可测试）
 *
 * 依赖全部注入（规则 8）：think / retrieve / store 均可替换，模块自身不 new 依赖。
 */

import type {
  EvidenceSource,
  Improvement,
  ImproveRequest,
  Induction,
  Message,
  SelfEvolveDeps,
  SelfThought,
  SelfThinkRequest,
  TaskTrace,
} from "./types.js";

const THINK_SYSTEM = [
  "你是自我进化引擎的 Draft 算子。对给定用户输入与执行项目，先依据强背书资料",
  "再输出针对性自我思考：目标、关键假设、执行计划、风险。",
  "只输出 JSON：{\"goal\":\"...\",\"assumptions\":[\"...\"],\"plan\":[\"...\"],\"risks\":[\"...\"]}",
].join("\n");

const IMPROVE_SYSTEM = [
  "你是自我进化引擎的改进算子。给定任务、执行反馈与历史成功教训：",
  "成功时（Improve）：提炼\"什么做对了\"为一条可复用教训，并收紧修订计划；",
  "失败时（Debug）：定位失败原因，给出修订计划，lesson 必须为空字符串。",
  "只输出 JSON：{\"revisedPlan\":[\"...\"],\"lesson\":\"...\"}",
].join("\n");

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "it", "this", "that",
  "my", "your", "our", "their",
]);

/** 简易分词：拉丁词按非字母数字切分并过滤停用词；CJK 短语保持整段。 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** 稳定短哈希（djb2），用于教训去重与内存键。 */
export function stableHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 提取文本中的第一个 JSON 对象（支持 ```json 代码块或裸 JSON）。 */
function extractJson<T>(text: string): T | null {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = block ? block[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export class SelfEvolveEngine {
  constructor(private readonly deps: SelfEvolveDeps) {}

  /** 针对性自我思考：检索强背书资料 → LLM 结构化思考 → 确定性置信度精算。 */
  async selfThink(req: SelfThinkRequest): Promise<SelfThought> {
    const evidence = await this.retrieveEvidence(req.input);
    const fallback: SelfThought = {
      goal: req.input.slice(0, 200),
      assumptions: [],
      plan: [req.input],
      risks: [],
      confidence: this.estimateConfidence(evidence),
      evidence,
    };

    let parsed: { goal?: string; assumptions?: string[]; plan?: string[]; risks?: string[] } | null = null;
    try {
      const raw = await this.deps.think([
        { role: "system", content: THINK_SYSTEM },
        { role: "user", content: buildThinkPrompt(req, evidence) },
      ]);
      parsed = extractJson<{ goal?: string; assumptions?: string[]; plan?: string[]; risks?: string[] }>(raw);
    } catch {
      parsed = null; // LLM 失败时降级，不让主流程中断
    }

    if (!parsed) return fallback;
    return {
      goal: parsed.goal?.trim() ? parsed.goal.trim().slice(0, 200) : fallback.goal,
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String) : [],
      plan: Array.isArray(parsed.plan) && parsed.plan.length > 0 ? parsed.plan.map(String) : fallback.plan,
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
      confidence: this.estimateConfidence(evidence),
      evidence,
    };
  }

  /**
   * 自我改进：成功 → Improve（教训写回知识库）；失败 → Debug（修订计划，不写教训）。
   * 历史成功教训注入提示上下文（Crossover 算子）。
   */
  async selfImprove(req: ImproveRequest): Promise<Improvement> {
    let prior: string[] = [];
    if (this.deps.store) {
      try {
        prior = await this.deps.store.list();
      } catch {
        prior = [];
      }
    }

    let parsed: { revisedPlan?: string[]; lesson?: string } | null = null;
    try {
      const raw = await this.deps.think([
        { role: "system", content: IMPROVE_SYSTEM },
        { role: "user", content: buildImprovePrompt(req, prior) },
      ]);
      parsed = extractJson<{ revisedPlan?: string[]; lesson?: string }>(raw);
    } catch {
      parsed = null;
    }

    const revisedPlan =
      parsed?.revisedPlan && parsed.revisedPlan.length > 0
        ? parsed.revisedPlan.map(String)
        : [req.feedback.action];
    const lesson = req.feedback.success ? (parsed?.lesson?.trim() ?? "") : "";

    if (req.feedback.success && lesson && this.deps.store) {
      try {
        await this.deps.store.write(lesson);
      } catch {
        // 知识库写入失败不阻断主流程
      }
    }

    return { revisedPlan, lesson, success: req.feedback.success };
  }

  /**
   * 自推理归纳：统计历史轨迹中术语共现与成功率，
   * 仅输出支持度 >= 2 且成功率 >= 0.6 的可复用模式（确定性，无 LLM）。
   */
  selfInduce(traces: TaskTrace[], topN = 10): Induction[] {
    const counts = new Map<string, { support: number; success: number }>();
    for (const trace of traces) {
      const terms = new Set([
        ...tokenize(trace.task),
        ...(trace.plan ?? []).flatMap((step) => tokenize(step)),
      ]);
      for (const term of terms) {
        const c = counts.get(term) ?? { support: 0, success: 0 };
        c.support++;
        if (trace.success) c.success++;
        counts.set(term, c);
      }
    }

    const result: Induction[] = [];
    for (const [pattern, c] of counts) {
      if (c.support < 2) continue;
      const successRate = c.success / c.support;
      if (successRate < 0.6) continue;
      result.push({
        pattern,
        support: c.support,
        successRate,
        recommendation:
          `Pattern "${pattern}" appeared in ${c.support} traces with ${(successRate * 100).toFixed(0)}% success; prefer it for similar tasks.`,
      });
    }

    return result
      .sort((a, b) => b.successRate - a.successRate || b.support - a.support)
      .slice(0, topN);
  }

  /**
   * 自推理精算：证据 → 0-1 置信度（确定性公式）。
   * 0.4 基线 + 强证据（score>=0.7）每条 +0.1（最多 +0.4）+ 权威证据（score>=0.9）每条 +0.05（最多 +0.15），封顶 0.95。
   */
  estimateConfidence(evidence: EvidenceSource[]): number {
    if (evidence.length === 0) return 0.4;
    const strong = evidence.filter((e) => e.score >= 0.7).length;
    const authoritative = evidence.filter((e) => e.score >= 0.9).length;
    const score = 0.4 + Math.min(0.4, strong * 0.1) + Math.min(0.15, authoritative * 0.05);
    return Math.min(0.95, score);
  }

  /** 证据检索：注入检索器 + 知识库历史教训（按查询词命中打分排序）。 */
  private async retrieveEvidence(query: string): Promise<EvidenceSource[]> {
    const sources: EvidenceSource[] = [];

    if (this.deps.retrieve) {
      try {
        sources.push(...(await this.deps.retrieve(query)));
      } catch {
        // 外部检索失败不阻断
      }
    }

    if (this.deps.store) {
      try {
        const lessons = await this.deps.store.list();
        const tokens = tokenize(query);
        for (const lesson of lessons) {
          const lower = lesson.toLowerCase();
          const hits = tokens.filter((t) => lower.includes(t)).length;
          if (hits === 0) continue;
          sources.push({
            title: lesson.split("\n")[0].slice(0, 120) || "self-evolve lesson",
            url: `memory://self-evolve/lesson/${stableHash(lesson)}`,
            snippet: lesson.slice(0, 300),
            score: Math.min(0.95, 0.55 + hits * 0.1),
            provenance: "self-evolve-memory",
          });
        }
      } catch {
        // 知识库读取失败不阻断
      }
    }

    return sources.sort((a, b) => b.score - a.score).slice(0, 8);
  }
}

function buildThinkPrompt(req: SelfThinkRequest, evidence: EvidenceSource[]): string {
  const evidenceText = evidence.length
    ? evidence
        .map((e, i) => `${i + 1}. [${e.title}](${e.url}) score=${e.score.toFixed(2)} source=${e.provenance}\n   ${e.snippet}`)
        .join("\n")
    : "(无可用证据，请基于常识谨慎输出，并在 risks 中标注不确定性)";
  return [
    `## 用户输入\n${req.input}`,
    `## 执行项目\n${req.project?.trim() || "(未提供)"}`,
    `## 强背书资料（按 score 排序）\n${evidenceText}`,
    `请输出 JSON：{"goal":"...","assumptions":["..."],"plan":["..."],"risks":["..."]}`,
  ].join("\n\n");
}

function buildImprovePrompt(req: ImproveRequest, prior: string[]): string {
  const priorText = prior.length ? prior.map((l, i) => `${i + 1}. ${l}`).join("\n") : "(无)";
  const feedbackText = [
    `动作: ${req.feedback.action}`,
    `结果: ${req.feedback.outcome}`,
    `成功: ${req.feedback.success}`,
  ];
  if (req.feedback.error) feedbackText.push(`错误: ${req.feedback.error}`);
  return [
    `## 任务\n${req.task}`,
    `## 执行反馈\n${feedbackText.join("\n")}`,
    `## 历史成功教训（Crossover 素材）\n${priorText}`,
    `请输出 JSON：{"revisedPlan":["..."],"lesson":"..."}`,
  ].join("\n\n");
}
