/**
 * 共识引擎 — 基于加权多数算法 (Weighted Majority Algorithm) 的多智能体共识系统
 *
 * 数学基础:
 *   1. WMA 后悔界:        M_T ≤ (M*·ln(1/β) + ln N) / (1-β)
 *   2. Brier 分数分解:    BS = Reliability − Resolution + Uncertainty
 *   3. 一致性度量:        agreementLevel = 1 − H(vote_distribution)
 *
 * 三种共识模式:
 *   - wma:      加权多数算法，提供后悔保证
 *   - majority: 简单多数投票（样本不足时回退）
 *   - weighted: 基于 Brier 校准分数的加权投票
 */

import { logger } from "../utils/logger.js";

// ─── 类型定义 ────────────────────────────────────────────────────────────────

/** 单次投票 */
export interface Vote {
  /** 决策: approve | reject | abstain */
  decision: "approve" | "reject" | "abstain";
  /** 置信度 0-1，1 为完全确定 */
  confidence: number;
  /** 推理说明 */
  reasoning: string;
}

/** 参与共识的智能体接口 */
export interface ConsensusAgent {
  id: string;
  name: string;
  /** 对提案进行投票 */
  vote(proposal: string, context?: ConsensusContext): Promise<Vote>;
}

/** 共识上下文 */
export interface ConsensusContext {
  /** 领域标识 */
  domain?: string;
  /** 约束列表 */
  constraints?: string[];
}

/** 共识结果 */
export interface ConsensusResult {
  /** 最终决策 */
  decision: "approve" | "reject" | "abstain";
  /** 决策置信度 0-1 */
  confidence: number;
  /** 参与投票的智能体数量 */
  voterCount: number;
  /** 赞成比例: approvecount / totalNonAbstain */
  approvalRatio: number;
  /** 一致性水平: 1 − 投票分布的熵 */
  agreementLevel: number;
  /** WMA 后悔界 (仅 wma 模式有效，否则为 NaN) */
  regretBound: number;
}

/** Brier 分数分解结果 */
export interface BrierDecomposition {
  /** Brier 分数 BS */
  brier: number;
  /** 可靠性 REL */
  reliability: number;
  /** 分辨率 RES */
  resolution: number;
  /** 不确定性 UNC */
  uncertainty: number;
}

/** 共识模式 */
export type ConsensusMode = "wma" | "majority" | "weighted";

/** 引擎配置 */
export interface ConsensusEngineConfig {
  agents: ConsensusAgent[];
  /** WMA 衰减因子 β ∈ (0, 1)，默认 0.5 */
  beta?: number;
  /** 共识模式，默认 "wma" */
  mode?: ConsensusMode;
}

// ─── 内部记录类型 ────────────────────────────────────────────────────────────

interface PredictionRecord {
  /** 预测概率 (agent confidence 折算) */
  probability: number;
  /** 实际结果 (0 或 1，仅在 reportOutcome 后可知) */
  actual?: number;
}

interface AgentRecord {
  agent: ConsensusAgent;
  /** WMA 权重，初始 1.0 */
  weight: number;
  /** 累计错误次数 */
  mistakes: number;
  /** 预测历史 (用于 Brier 分数计算) */
  history: PredictionRecord[];
}

// ─── 共识引擎 ────────────────────────────────────────────────────────────────

export class ConsensusEngine {
  private agents: ConsensusAgent[];
  private beta: number;
  private mode: ConsensusMode;
  private records: Map<string, AgentRecord>;

  /** 全局最小错误数 M* = min_i mistakes_i */
  private globalMinMistakes = 0;
  /** 全局总轮数 T */
  private totalRounds = 0;

  constructor(config: ConsensusEngineConfig) {
    this.agents = config.agents;
    this.beta = this.validateBeta(config.beta ?? 0.5);
    this.mode = config.mode ?? "wma";
    this.records = new Map();

    for (const agent of this.agents) {
      this.records.set(agent.id, {
        agent,
        weight: 1.0,
        mistakes: 0,
        history: [],
      });
    }

    logger.info("[ConsensusEngine] 初始化完成", {
      agentCount: this.agents.length,
      beta: this.beta,
      mode: this.mode,
      agentIds: this.agents.map((a) => a.id),
    });
  }

  // ── 公共 API ─────────────────────────────────────────────────────────────

  /**
   * 对提案达成共识
   *
   * @param proposal  提案内容
   * @param context   可选的上下文信息
   * @returns ConsensusResult 包含决策、置信度、一致性等
   */
  async reachConsensus(
    proposal: string,
    context?: ConsensusContext,
  ): Promise<ConsensusResult> {
    logger.debug("[ConsensusEngine] 开始共识轮次", {
      proposal: proposal.slice(0, 120),
      mode: this.mode,
    });

    // 1. 收集所有智能体投票
    const votes = await this.collectVotes(proposal, context);
    const voterCount = votes.length;

    if (voterCount === 0) {
      logger.warn("[ConsensusEngine] 无智能体参与投票，默认弃权");
      return this.emptyResult();
    }

    // 2. 根据模式计算决策
    const result = this.computeResult(votes);

    // 3. 更新全局轮数
    this.totalRounds++;

    logger.info("[ConsensusEngine] 共识结果", {
      decision: result.decision,
      confidence: result.confidence.toFixed(3),
      approvalRatio: result.approvalRatio.toFixed(3),
      agreementLevel: result.agreementLevel.toFixed(3),
      regretBound: Number.isFinite(result.regretBound)
        ? result.regretBound.toFixed(3)
        : "N/A",
    });

    return result;
  }

  /**
   * 上报真实结果以更新权重
   *
   * @param agentId    智能体 ID
   * @param prediction 智能体的预测概率 (0-1 表示 approve 的可能性)
   * @param actual     实际结果 (0 = reject, 1 = approve)
   */
  reportOutcome(
    agentId: string,
    prediction: number,
    actual: number,
  ): void {
    const record = this.records.get(agentId);
    if (!record) {
      logger.warn("[ConsensusEngine] 未知智能体 ID", { agentId });
      return;
    }

    // 记录预测历史 (用于 Brier 分数)
    record.history.push({ probability: prediction, actual });

    // WMA 更新: 若预测错误则衰减权重
    const predictedDecision = prediction >= 0.5 ? 1 : -1;
    const actualDecision = actual >= 0.5 ? 1 : -1;
    const isWrong = predictedDecision !== actualDecision;

    if (isWrong && this.mode === "wma") {
      record.mistakes++;
      record.weight *= this.beta;
      logger.debug("[ConsensusEngine] 权重衰减", {
        agentId,
        mistakes: record.mistakes,
        newWeight: record.weight.toFixed(6),
      });
    }

    // 更新全局最小错误数 M*
    this.globalMinMistakes = this.computeMinMistakes();

    logger.debug("[ConsensusEngine] outcome 已记录", {
      agentId,
      prediction,
      actual,
      isWrong,
      globalMinMistakes: this.globalMinMistakes,
    });
  }

  /** 获取当前智能体权重 */
  getAgentWeights(): Map<string, number> {
    const result = new Map<string, number>();
    for (const [id, record] of this.records) {
      result.set(id, roundTo(record.weight, 6));
    }
    return result;
  }

  /** 获取各智能体的 Brier 分数分解 */
  getBrierScores(): Map<string, BrierDecomposition> {
    const result = new Map<string, BrierDecomposition>();
    for (const [id, record] of this.records) {
      result.set(id, this.computeBrierDecomposition(record.history));
    }
    return result;
  }

  // ── 私有: 投票收集 ──────────────────────────────────────────────────────

  private async collectVotes(
    proposal: string,
    context?: ConsensusContext,
  ): Promise<Array<{ agentId: string; vote: Vote }>> {
    const votePromises = this.agents.map(async (agent) => {
      try {
        const vote = await agent.vote(proposal, context);
        return { agentId: agent.id, vote };
      } catch (err) {
        logger.warn("[ConsensusEngine] 智能体投票异常", {
          agentId: agent.id,
          error: String(err),
        });
        // 异常时视为弃权
        return {
          agentId: agent.id,
          vote: {
            decision: "abstain" as const,
            confidence: 0,
            reasoning: `投票异常: ${String(err)}`,
          },
        };
      }
    });

    const results = await Promise.all(votePromises);

    // 过滤掉弃权票 (仅在 majority 模式下保留弃权用于计数)
    const activeVotes = results.filter(
      (r) => r.vote.decision !== "abstain",
    );

    logger.debug("[ConsensusEngine] 投票收集完成", {
      total: results.length,
      active: activeVotes.length,
      abstained: results.length - activeVotes.length,
    });

    return results;
  }

  // ── 私有: 结果计算 ──────────────────────────────────────────────────────

  private computeResult(
    votes: Array<{ agentId: string; vote: Vote }>,
  ): ConsensusResult {
    switch (this.mode) {
      case "wma":
        return this.computeWMA(votes);
      case "majority":
        return this.computeMajority(votes);
      case "weighted":
        return this.computeWeighted(votes);
      default:
        return this.computeWMA(votes);
    }
  }

  /**
   * 加权多数算法 (WMA) — 带后悔界保证
   *
   * D^t = sign(Σ w_i · d_i^t)  where d_i^t ∈ {+1, −1}
   */
  private computeWMA(
    votes: Array<{ agentId: string; vote: Vote }>,
  ): ConsensusResult {
    const N = this.agents.length;
    let weightedSum = 0;
    let totalWeight = 0;
    let approveCount = 0;
    let rejectCount = 0;

    for (const { agentId, vote } of votes) {
      if (vote.decision === "abstain") continue;

      const record = this.records.get(agentId);
      const weight = record ? record.weight : 1.0;
      const direction = vote.decision === "approve" ? 1 : -1;

      weightedSum += weight * direction;
      totalWeight += weight;

      if (vote.decision === "approve") approveCount++;
      else rejectCount++;
    }

    const nonAbstain = approveCount + rejectCount;

    // 决策: sign(Σ w_i · d_i)
    let decision: "approve" | "reject" | "abstain";
    if (nonAbstain === 0) {
      decision = "abstain";
    } else if (weightedSum > 0) {
      decision = "approve";
    } else if (weightedSum < 0) {
      decision = "reject";
    } else {
      // 平局: 按未加权多数决定
      decision = approveCount >= rejectCount ? "approve" : "reject";
    }

    // 置信度: |weightedSum| / totalWeight 归一化到 [0,1]
    const confidence =
      totalWeight > 0
        ? Math.abs(weightedSum) / totalWeight
        : 0;

    const approvalRatio = nonAbstain > 0 ? approveCount / nonAbstain : 0;
    const agreementLevel = this.computeAgreementLevel(votes);
    const regretBound = this.computeRegretBound();

    return {
      decision,
      confidence: roundTo(confidence, 4),
      voterCount: votes.length,
      approvalRatio: roundTo(approvalRatio, 4),
      agreementLevel: roundTo(agreementLevel, 4),
      regretBound: roundTo(regretBound, 4),
    };
  }

  /** 简单多数投票 (回退模式) */
  private computeMajority(
    votes: Array<{ agentId: string; vote: Vote }>,
  ): ConsensusResult {
    let approveCount = 0;
    let rejectCount = 0;

    for (const { vote } of votes) {
      if (vote.decision === "approve") approveCount++;
      else if (vote.decision === "reject") rejectCount++;
    }

    const nonAbstain = approveCount + rejectCount;
    let decision: "approve" | "reject" | "abstain";

    if (nonAbstain === 0) {
      decision = "abstain";
    } else if (approveCount > rejectCount) {
      decision = "approve";
    } else if (rejectCount > approveCount) {
      decision = "reject";
    } else {
      decision = "reject"; // 平局默认拒绝 (保守策略)
    }

    const confidence = nonAbstain > 0
      ? Math.max(approveCount, rejectCount) / nonAbstain
      : 0;

    const approvalRatio = nonAbstain > 0 ? approveCount / nonAbstain : 0;
    const agreementLevel = this.computeAgreementLevel(votes);

    return {
      decision,
      confidence: roundTo(confidence, 4),
      voterCount: votes.length,
      approvalRatio: roundTo(approvalRatio, 4),
      agreementLevel: roundTo(agreementLevel, 4),
      regretBound: NaN, // majority 模式无后悔界
    };
  }

  /** 基于 Brier 校准分数的加权投票 */
  private computeWeighted(
    votes: Array<{ agentId: string; vote: Vote }>,
  ): ConsensusResult {
    // 获取 Brier 分数，分数越低 (校准越好) 权重越高
    const brierScores = this.getBrierScores();
    let weightedSum = 0;
    let totalWeight = 0;
    let approveCount = 0;
    let rejectCount = 0;

    for (const { agentId, vote } of votes) {
      if (vote.decision === "abstain") continue;

      // 权重 = 1 / (1 + Brier)，Brier → 0 时权重 → 1，Brier → ∞ 时权重 → 0
      const brierInfo = brierScores.get(agentId);
      const brier = brierInfo ? brierInfo.brier : 0.25; // 默认 0.25 (随机猜测)
      const weight = 1 / (1 + brier);

      const direction = vote.decision === "approve" ? 1 : -1;
      weightedSum += weight * direction;
      totalWeight += weight;

      if (vote.decision === "approve") approveCount++;
      else rejectCount++;
    }

    const nonAbstain = approveCount + rejectCount;

    let decision: "approve" | "reject" | "abstain";
    if (nonAbstain === 0) {
      decision = "abstain";
    } else if (weightedSum > 0) {
      decision = "approve";
    } else if (weightedSum < 0) {
      decision = "reject";
    } else {
      decision = approveCount >= rejectCount ? "approve" : "reject";
    }

    const confidence =
      totalWeight > 0 ? Math.abs(weightedSum) / totalWeight : 0;
    const approvalRatio = nonAbstain > 0 ? approveCount / nonAbstain : 0;
    const agreementLevel = this.computeAgreementLevel(votes);

    return {
      decision,
      confidence: roundTo(confidence, 4),
      voterCount: votes.length,
      approvalRatio: roundTo(approvalRatio, 4),
      agreementLevel: roundTo(agreementLevel, 4),
      regretBound: NaN, // weighted 模式无 WMA 后悔界
    };
  }

  // ── 私有: 数学工具 ──────────────────────────────────────────────────────

  /**
   * 计算 Brier 分数及其分解
   *
   * BS = (1/N) Σ (f_i − o_i)²
   *
   * 分解 (Murphy 1973):
   *   BS = REL − RES + UNC
   *   REL = (1/N) Σ_k n_k (f_k − o_k)²    可靠性 (reliability)
   *   RES = (1/N) Σ_k n_k (o_k − o)²      分辨率 (resolution)
   *   UNC = o(1 − o)                       不确定性 (uncertainty)
   */
  private computeBrierDecomposition(
    history: PredictionRecord[],
  ): BrierDecomposition {
    const N = history.length;
    if (N === 0) {
      return { brier: NaN, reliability: NaN, resolution: NaN, uncertainty: NaN };
    }

    // Brier 分数
    let brierSum = 0;
    for (const { probability, actual } of history) {
      brierSum += (probability - (actual ?? 0)) ** 2;
    }
    const brier = brierSum / N;

    // 全局平均结果 o
    let outcomeSum = 0;
    for (const { actual } of history) {
      outcomeSum += actual ?? 0;
    }
    const meanOutcome = outcomeSum / N;
    const uncertainty = meanOutcome * (1 - meanOutcome);

    // 可靠性: 将预测按区间分箱 (10 个箱)
    const bins = this.binPredictions(history);
    let reliability = 0;
    let resolution = 0;

    for (const bin of bins) {
      if (bin.count === 0) continue;
      const binMeanForecast = bin.forecastSum / bin.count;
      const binMeanOutcome = bin.outcomeSum / bin.count;
      const binFrac = bin.count / N;

      reliability += binFrac * (binMeanForecast - binMeanOutcome) ** 2;
      resolution += binFrac * (binMeanOutcome - meanOutcome) ** 2;
    }

    return {
      brier: roundTo(brier, 6),
      reliability: roundTo(reliability, 6),
      resolution: roundTo(resolution, 6),
      uncertainty: roundTo(uncertainty, 6),
    };
  }

  /**
   * 将预测按概率分 10 个等宽箱
   * 箱边界: [0, 0.1), [0.1, 0.2), ..., [0.9, 1.0]
   */
  private binPredictions(history: PredictionRecord[]): Array<{
    count: number;
    forecastSum: number;
    outcomeSum: number;
  }> {
    const BIN_COUNT = 10;
    const bins: Array<{
      count: number;
      forecastSum: number;
      outcomeSum: number;
    }> = Array.from({ length: BIN_COUNT }, () => ({
      count: 0,
      forecastSum: 0,
      outcomeSum: 0,
    }));

    for (const { probability, actual } of history) {
      if (actual === undefined) continue;
      // 找到对应的箱 (clamp 到 [0, BIN_COUNT-1])
      const binIndex = Math.min(
        BIN_COUNT - 1,
        Math.max(0, Math.floor(probability * BIN_COUNT)),
      );
      bins[binIndex].count++;
      bins[binIndex].forecastSum += probability;
      bins[binIndex].outcomeSum += actual;
    }

    return bins;
  }

  /**
   * 计算一致性水平: agreementLevel = 1 − H(p)
   * H(p) = −Σ p_i · log2(p_i)  归一化到 [0,1]: H_norm = H / log2(k)
   */
  private computeAgreementLevel(
    votes: Array<{ agentId: string; vote: Vote }>,
  ): number {
    let approveCount = 0;
    let rejectCount = 0;
    let abstainCount = 0;

    for (const { vote } of votes) {
      if (vote.decision === "approve") approveCount++;
      else if (vote.decision === "reject") rejectCount++;
      else abstainCount++;
    }

    const total = votes.length;
    if (total === 0) return 0;

    // 各分类比例
    const pApprove = approveCount / total;
    const pReject = rejectCount / total;
    const pAbstain = abstainCount / total;

    // 熵 H = −Σ p · log2(p)，跳过 p=0
    let entropy = 0;
    const k = (pApprove > 0 ? 1 : 0) + (pReject > 0 ? 1 : 0) + (pAbstain > 0 ? 1 : 0);

    if (pApprove > 0) entropy -= pApprove * Math.log2(pApprove);
    if (pReject > 0) entropy -= pReject * Math.log2(pReject);
    if (pAbstain > 0) entropy -= pAbstain * Math.log2(pAbstain);

    // 归一化: 最大熵 = log2(k)，k 为实际出现的类别数
    const maxEntropy = k > 1 ? Math.log2(k) : 1;
    const normalizedEntropy = entropy / maxEntropy;

    // agreementLevel ∈ [0, 1]
    return 1 - normalizedEntropy;
  }

  /**
   * 计算 WMA 后悔界
   *
   * M_T ≤ (M* · ln(1/β) + ln N) / (1 − β)
   *
   * 其中:
   *   M_T = 算法累计错误数 (上界)
   *   M*  = 最佳专家的错误数
   *   N   = 专家数量
   *   β   = 衰减因子
   */
  private computeRegretBound(): number {
    const N = this.agents.length;
    if (N === 0) return 0;

    const M_star = this.globalMinMistakes;
    const lnInvBeta = Math.log(1 / this.beta);
    const lnN = Math.log(N);

    // 后悔界公式
    const bound = (M_star * lnInvBeta + lnN) / (1 - this.beta);

    return Math.max(0, bound);
  }

  /** 计算当前全局最小错误数 M* */
  private computeMinMistakes(): number {
    let min = Infinity;
    for (const record of this.records.values()) {
      if (record.mistakes < min) {
        min = record.mistakes;
      }
    }
    return min === Infinity ? 0 : min;
  }

  /** 空结果 (无智能体时) */
  private emptyResult(): ConsensusResult {
    return {
      decision: "abstain",
      confidence: 0,
      voterCount: 0,
      approvalRatio: 0,
      agreementLevel: 0,
      regretBound: this.mode === "wma" ? this.computeRegretBound() : NaN,
    };
  }

  /** 验证 β ∈ (0, 1) */
  private validateBeta(value: number): number {
    if (value <= 0 || value >= 1) {
      logger.warn("[ConsensusEngine] β 必须在 (0,1) 范围内，已重置为 0.5", {
        invalidBeta: value,
      });
      return 0.5;
    }
    return value;
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/** 四舍五入到指定位数 */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ─── 简洁版工具函数 (用于单元测试和简单共识场景) ─────────────────────────────

export interface Agent {
  id: string;
  weight: number;
}

export interface AgentPrediction {
  agentId: string;
  prediction: number;
}

export interface SimpleConsensusResult {
  consensusPrediction: number;
  majorityVote: number;
  agentWeights: Record<string, number>;
  regretBound: number;
  brierScores?: Record<string, number>;
  agreementLevel: number;
}

export function weightedMajority(
  predictions: AgentPrediction[],
  agents: Agent[],
  options?: { mode?: "weighted" | "majority" }
): SimpleConsensusResult {
  const mode = options?.mode ?? "weighted";
  if (!predictions.length || !agents.length) {
    return { consensusPrediction: 0, majorityVote: 0, agentWeights: {}, regretBound: 0, agreementLevel: 0 };
  }
  const weights: Record<string, number> = {};
  for (const agent of agents) { weights[agent.id] = agent.weight; }
  const votes = predictions.map((p) => (p.prediction > 0.5 ? 1 : 0));
  const majorityVote = votes.filter((v) => v === 1).length > votes.length / 2 ? 1 : 0;
  if (mode === "majority") {
    return { consensusPrediction: majorityVote, majorityVote, agentWeights: weights, regretBound: 0, agreementLevel: computeAgreement(predictions) };
  }
  let weightedSum = 0; let totalWeight = 0;
  for (const pred of predictions) {
    const w = weights[pred.agentId] ?? 0;
    weightedSum += w * pred.prediction;
    totalWeight += w;
  }
  const cp = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const T = predictions.length; const N = agents.length;
  const rb = T > 0 && N > 1 ? Math.sqrt(T * Math.log(N)) : 0;
  return {
    consensusPrediction: Math.round(cp * 1000) / 1000,
    majorityVote, agentWeights: weights,
    regretBound: Math.round(rb * 100) / 100,
    agreementLevel: computeAgreement(predictions),
  };
}

export function computeBrierScores(
  predictions: AgentPrediction[],
  trueOutcome: number
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const pred of predictions) {
    scores[pred.agentId] = Math.pow(pred.prediction - trueOutcome, 2);
  }
  return scores;
}

export function computeAgreement(predictions: AgentPrediction[]): number {
  if (predictions.length <= 1) return 1;
  const values = predictions.map((p) => p.prediction);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
  const maxVariance = 0.25;
  const agreement = 1 - Math.min(variance / maxVariance, 1);
  return Math.round(agreement * 1000) / 1000;
}