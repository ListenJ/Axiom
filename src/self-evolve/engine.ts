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
  private static readonly MAX_TRACES = 500;
  private readonly traces: TaskTrace[] = [];
  private traceSeq = 0;

  constructor(private readonly deps: SelfEvolveDeps) {}

  /** 针对性自我思考：检索强背书资料 → LLM 结构化思考 → 确定性置信度精算。 */
  async selfThink(req: SelfThinkRequest): Promise<SelfThought> {
    // 第一轮检索：知识库/教训/外部证据
    let evidence = await this.retrieveEvidence(req.input);
    let confidence = this.estimateConfidence(evidence);
    // 信息不足自动升级检索（显式闭环）：置信度 < 0.6 且证据 < 3 条 → 基于已有证据定向补充检索一轮
    if (confidence < 0.6 && evidence.length < 3) {
      const escalationQuery = buildEscalationQuery(req.input, evidence);
      if (escalationQuery && escalationQuery.trim() !== req.input.trim()) {
        const extra = await this.retrieveEvidence(escalationQuery);
        const seen = new Set(evidence.map((e) => e.url || e.title));
        for (const e of extra) {
          const key = e.url || e.title;
          if (!seen.has(key)) { evidence.push(e); seen.add(key); }
        }
        confidence = this.estimateConfidence(evidence);
      }
    }
    const fallback: SelfThought = {
      goal: req.input.slice(0, 200),
      assumptions: [],
      plan: [req.input],
      risks: [],
      confidence,
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
      confidence,
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

    this.recordTrace({
      id: `trace-${this.traceSeq++}`,
      task: req.task,
      plan: revisedPlan,
      success: req.feedback.success,
    });

    return { revisedPlan, lesson, success: req.feedback.success };
  }

  /**
   * 自推理归纳：统计历史轨迹中术语共现与成功率，
   * 仅输出支持度 >= 2 且成功率 >= 0.6 的可复用模式（确定性，无 LLM）。
   */
  selfInduce(traces?: TaskTrace[], topN = 10): Induction[] {
    const source = traces ?? this.traces;
    const counts = new Map<string, { support: number; success: number }>();
    for (const trace of source) {
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

  /** 记录一条执行轨迹（供 selfInduce 归纳；selfImprove 自动调用，亦可手动喂入）。 */
  recordTrace(trace: TaskTrace): void {
    this.traces.push(trace);
    if (this.traces.length > SelfEvolveEngine.MAX_TRACES) {
      this.traces.splice(0, this.traces.length - SelfEvolveEngine.MAX_TRACES);
    }
  }

  /** 读取已记录的执行轨迹（只读快照）。 */
  listTraces(): TaskTrace[] {
    return [...this.traces];
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

/** 升级检索查询：输入 + 已有证据标题中的关键词（确定性，可测试）。 */
export function buildEscalationQuery(input: string, evidence: EvidenceSource[]): string {
  const keywords = evidence
    .slice(0, 3)
    .map((e) => e.title)
    .filter(Boolean)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).slice(0, 4).join(" "))
    .filter(Boolean);
  return [input.trim(), ...keywords].filter(Boolean).join(" ");
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

/**
 * 把自我思考格式化为紧凑的 system 提示文本（供聊天上下文注入）。
 */
export function formatSelfThought(thought: SelfThought): string {
  const lines = [
    `Goal: ${thought.goal.slice(0, 200)}`,
    `Plan: ${thought.plan.slice(0, 3).map((s) => s.slice(0, 120)).join(" → ")}`,
  ];
  if (thought.assumptions.length > 0) {
    lines.push(`Assumptions: ${thought.assumptions.slice(0, 2).map((a) => a.slice(0, 80)).join("; ")}`);
  }
  if (thought.risks.length > 0) {
    lines.push(`Risks: ${thought.risks.slice(0, 2).map((r) => r.slice(0, 80)).join("; ")}`);
  }
  lines.push(`Confidence: ${(thought.confidence * 100).toFixed(0)}%`);
  if (thought.evidence.length > 0) {
    lines.push(
      `Evidence: ${thought.evidence.slice(0, 2).map((e) => `${e.title} (${e.provenance}, ${(e.score * 100).toFixed(0)}%)`).join("; ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * 把针对性自我思考注入消息末尾（路由层接入点，小接口：只需要 selfThink）。
 * 失败 / 未提供 engine / 空输入 → 原样返回，不抛错、不阻断主流程。
 */
export async function applySelfThought(
  messages: Message[],
  input: string,
  engine?: { selfThink(input: SelfThinkRequest): Promise<SelfThought> },
): Promise<Message[]> {
  if (!engine || !input.trim()) return messages;
  try {
    const thought = await engine.selfThink({ input, project: process.cwd() });
    return [...messages, { role: "system", content: "[Self-Thought]\n" + formatSelfThought(thought) }];
  } catch {
    return messages;
  }
}
