/**
 * DRE 三段甄别流水线
 *
 * 阶段 1: Go 高并发预筛 (规则引擎 + 向量召回)
 * 阶段 2: 网络检索校验 (Playwright + 多源验证)
 * 阶段 3: 本地 LLM 自推理校验 (强约束 + 拒绝采样)
 *
 * 风险评分路由:
 * - risk_score < 0.3 → 直接入库
 * - risk_score ∈ [0.3, 0.7] → 阶段 2
 * - risk_score > 0.7 → 阶段 3 + 告警
 */

import type { KnowledgeStore } from "../storage/knowledge-store.js";
import type { LLMClient } from "../llm/client.js";

/** 知识条目输入 */
export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  domain: string;
  paradigm: "fact" | "rule" | "procedure" | "concept" | "behavior" | "prediction" | "hypothesis";
  sourceType: "manual" | "web" | "llm" | "ocr" | "kg";
  sourceUri?: string;
  embedding?: number[];
}

/** 风险报告 */
export interface RiskReport {
  nodeId: string;
  riskScore: number;
  conflicts: string[];     // 与本地知识冲突的 node_id
  flags: string[];          // regex/blacklist/structure
  nextStage: 0 | 2 | 3;    // 0=直接入库, 2=网络校验, 3=LLM自推理
}

/** 证据 */
export interface Evidence {
  source: string;           // wikipedia/baidu/arxiv
  url: string;
  title: string;
  snippet: string;
  score: number;
}

/** 验证结果 */
export interface VerificationResult {
  verdict: "accept" | "reject" | "need_more";
  confidence: number;
  chain: string[];          // 推理链
  evidenceRefs: string[];   // 本地知识库 node_id
  corrected?: string;       // 修正版本
  reasoning: string;
}

/** Raw LLM response shape from generateConstrained (snake_case keys). */
interface LLMVerificationResponse {
  verdict: string;
  confidence: number;
  chain: string[];
  evidence_refs: string[];
  corrected?: string;
}

/**
 * 三段甄别流水线
 */
export class Pipeline {
  private knowledgeStore: KnowledgeStore;
  private llmClient: LLMClient;
  private rules: PipelineRule[] = [];

  constructor(knowledgeStore: KnowledgeStore, llmClient: LLMClient) {
    this.knowledgeStore = knowledgeStore;
    this.llmClient = llmClient;

    // 注册默认规则
    this.rules.push(new BlacklistRule());
    this.rules.push(new LengthRule());
    this.rules.push(new SourceTypeRule());
  }

  /**
   * 处理知识条目
   */
  async process(item: KnowledgeItem): Promise<{
    accepted: boolean;
    riskReport: RiskReport;
    verification?: VerificationResult;
  }> {
    // 阶段 1: 预筛
    const riskReport = await this.stage1Prefilter(item);

    if (riskReport.nextStage === 0) {
      // 直接入库
      this.writeToStore(item, riskReport, "stage1");
      return { accepted: true, riskReport };
    }

    // 阶段 2: 网络校验
    if (riskReport.nextStage === 2) {
      const evidence = await this.stage2WebVerify(item);
      const agreement = this.calculateAgreement(evidence, item.content);

      if (agreement > 0.8) {
        this.writeToStore(item, riskReport, "stage2");
        return { accepted: true, riskReport };
      }

      // 升级到阶段 3
      riskReport.nextStage = 3;
    }

    // 阶段 3: LLM 自推理校验
    const verification = await this.stage3LLMVerify(item, riskReport);

    if (verification.verdict === "accept" && verification.confidence >= 0.6) {
      this.writeToStore(item, riskReport, "stage3");
      return { accepted: true, riskReport, verification };
    }

    return { accepted: false, riskReport, verification };
  }

  /**
   * 阶段 1: 预筛
   */
  private async stage1Prefilter(item: KnowledgeItem): Promise<RiskReport> {
    const report: RiskReport = {
      nodeId: item.id,
      riskScore: 0,
      conflicts: [],
      flags: [],
      nextStage: 0,
    };

    // 1. 规则匹配
    for (const rule of this.rules) {
      const result = rule.check(item);
      if (result.flagged) {
        report.flags.push(result.flag);
        report.riskScore += result.score;
      }
    }

    // 2. 向量召回本地相似知识
    if (item.embedding) {
      const similar = this.knowledgeStore.search(item.title, { limit: 5 });
      for (const node of similar) {
        if (node.contentHash !== this.hashContent(item.content)) {
          report.conflicts.push(node.nodeId);
          report.riskScore += 0.2;
        }
      }
    }

    // 3. 来源风险
    if (item.sourceType === "llm") {
      report.riskScore += 0.1;
    }

    // 4. 路由决策
    report.riskScore = Math.min(report.riskScore, 1.0);

    if (report.riskScore < 0.3) {
      report.nextStage = 0;
    } else if (report.riskScore < 0.7) {
      report.nextStage = 2;
    } else {
      report.nextStage = 3;
    }

    return report;
  }

  /**
   * 阶段 2: 网络校验
   */
  private async stage2WebVerify(item: KnowledgeItem): Promise<Evidence[]> {
    // 简化实现：返回空证据
    // 实际实现应调用 Playwright 搜索引擎
    return [];
  }

  /**
   * 阶段 3: LLM 自推理校验
   */
  private async stage3LLMVerify(
    item: KnowledgeItem,
    riskReport: RiskReport
  ): Promise<VerificationResult> {
    // 获取本地证据
    const localEvidence = this.knowledgeStore.search(item.title, { limit: 3 });

    // 构建提示
    const prompt = this.buildVerificationPrompt(item, localEvidence, riskReport);

    // 调用 LLM (强约束)
    const result = await this.llmClient.generateConstrained(prompt, {
      type: "object",
      required: ["verdict", "confidence", "chain", "evidence_refs"],
      properties: {
        verdict: { enum: ["accept", "reject", "need_more"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        chain: { type: "array", minItems: 5, maxItems: 7, items: { type: "string" } },
        evidence_refs: { type: "array", items: { type: "string" } },
        corrected: { type: "string" },
      },
    });

    const llmResult = result as unknown as LLMVerificationResponse;
    return {
      verdict: (llmResult.verdict || "reject") as "accept" | "reject" | "need_more",
      confidence: llmResult.confidence || 0,
      chain: llmResult.chain || [],
      evidenceRefs: llmResult.evidence_refs || [],
      corrected: llmResult.corrected,
      reasoning: llmResult.chain?.join("\n") || "",
    };
  }

  /**
   * 写入知识库
   */
  private writeToStore(item: KnowledgeItem, riskReport: RiskReport, stage: string): void {
    this.knowledgeStore.write({
      nodeId: item.id,
      title: item.title,
      content: item.content,
      schemaVersion: 1,
      domain: item.domain,
      paradigm: item.paradigm,
      confidence: 1 - riskReport.riskScore,
      sourceType: item.sourceType,
      sourceUri: item.sourceUri,
      isVerified: true,
    });
  }

  /**
   * 构建验证提示
   */
  private buildVerificationPrompt(
    item: KnowledgeItem,
    localEvidence: Array<{ nodeId: string; title: string; content: string }>,
    riskReport: RiskReport
  ): string {
    return `你是一个严格的事实校验器。请按以下流程推理：
1. 复述待验证声明
2. 列出本地知识库中相关证据（必须引用 node_id）
3. 列出网络证据摘要
4. 检查逻辑一致性
5. 给出修正版本（若需要）
6. 输出最终判定
7. 给出置信度

【硬性约束】
- 输出必须是合法 JSON，符合给定 Schema
- chain 必须包含 5-7 步
- confidence < 0.6 时 verdict 必须为 reject 或 need_more
- 严禁编造 node_id，无法引用则留空数组
- 严禁输出 Schema 外字段

待验证声明：${item.title} - ${item.content.slice(0, 200)}
本地证据：${localEvidence.map((e) => `[${e.nodeId}] ${e.title}`).join(", ")}
风险标记：${riskReport.flags.join(", ")}

请输出 JSON：`;
  }

  /**
   * 计算内容哈希
   */
  private hashContent(content: string): string {
    // 简化实现
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  /**
   * 计算证据一致性
   */
  private calculateAgreement(evidence: Evidence[], claim: string): number {
    if (evidence.length === 0) return 0;

    // 简化实现：基于证据数量和分数
    const totalScore = evidence.reduce((sum, e) => sum + e.score, 0);
    return Math.min(totalScore / evidence.length, 1.0);
  }
}

/**
 * 规则接口
 */
interface RuleCheckResult {
  flagged: boolean;
  flag: string;
  score: number;
}

interface PipelineRule {
  check(item: KnowledgeItem): RuleCheckResult;
}

/**
 * 黑名单规则
 */
class BlacklistRule implements PipelineRule {
  private blacklist = ["虚假信息", "未经证实", "谣言", "假新闻"];

  check(item: KnowledgeItem): RuleCheckResult {
    const content = `${item.title} ${item.content}`.toLowerCase();

    for (const word of this.blacklist) {
      if (content.includes(word)) {
        return { flagged: true, flag: `blacklist:${word}`, score: 0.3 };
      }
    }

    return { flagged: false, flag: "", score: 0 };
  }
}

/**
 * 长度规则
 */
class LengthRule implements PipelineRule {
  check(item: KnowledgeItem): RuleCheckResult {
    if (item.content.length < 10) {
      return { flagged: true, flag: "too_short", score: 0.2 };
    }

    if (item.content.length > 100000) {
      return { flagged: true, flag: "too_long", score: 0.1 };
    }

    return { flagged: false, flag: "", score: 0 };
  }
}

/**
 * 来源类型规则
 */
class SourceTypeRule implements PipelineRule {
  check(item: KnowledgeItem): RuleCheckResult {
    if (item.sourceType === "llm") {
      return { flagged: true, flag: "llm_generated", score: 0.1 };
    }

    return { flagged: false, flag: "", score: 0 };
  }
}
