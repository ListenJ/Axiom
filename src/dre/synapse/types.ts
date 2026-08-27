/**
 * 神经突触心智模块 — 类型定义
 *
 * 心智模块 = 神经突触网络（Synapse Network）：
 *   - Synapse：两个节点（概念/技能/记忆/场景/目标）之间的加权关联，模拟大脑突触。
 *   - 每次创建/激活/扩散/建议都会追加到不可篡改的验证链（chained hash）——
 *     满足"强约束：数据有可以校验的路径，可以追溯实现效果"。
 *   - 全部逻辑确定性、零 LLM 依赖（本地模型仅作可选增强，见 engine.ts）。
 */

/** 突触节点类型 */
export type SynapseNodeType = "concept" | "skill" | "memory" | "scene" | "goal";

/** 一条突触（关联边） */
export interface Synapse {
  /** 确定性 id：sha256(sourceId|targetId) 前 16 位 */
  id: string;
  /** 源节点 id（概念/技能/记忆/场景/目标） */
  sourceId: string;
  /** 目标节点 id */
  targetId: string;
  sourceType: SynapseNodeType;
  targetType: SynapseNodeType;
  /** 基础强度 0-1（存储值；实际强度 = weight - decayPerActivation × (globalEpoch - decayEpoch)） */
  weight: number;
  /** 激活次数（Hebbian 累积） */
  activationCount: number;
  /** 最近激活时间（epoch ms） */
  lastActivatedAt: number;
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 该突触上次结算衰减时的全局 epoch（增量衰减锚点；写时结算，读时惰性；缺省视为 0） */
  decayEpoch?: number;
  /** 校验哈希：sha256 覆盖全部规范字段，篡改即失配（可校验路径） */
  verifyHash: string;
}

/** 突触操作类型 */
export type SynapseOperation = "create" | "activate" | "spread" | "decay" | "suggest";

/** 验证链上的一条记录（追加式、链式哈希 → 防篡改） */
export interface SynapseTrace {
  /** 记录 id：sha256(synapseId|seq|prevHash) 前 16 位 */
  id: string;
  synapseId: string;
  /** 该突触的递增序号 */
  seq: number;
  operation: SynapseOperation;
  /** 本次激活/衰减量（正=增强，负=衰减） */
  activation: number;
  /** 触发事件（场景/目标/查询描述） */
  sourceEvent: string;
  /** 时间戳（epoch ms） */
  timestamp: number;
  /** 上一条哈希（首条为 genesis 哈希） */
  prevHash: string;
  /** 本记录哈希 */
  hash: string;
}

/** 下一步建议（确定性排序结果） */
export interface SynapseSuggestion {
  targetId: string;
  targetType: SynapseNodeType;
  /** 综合得分 0-1：基础强度 + 激活次数 + 新鲜度 */
  score: number;
  /** 人类可读理由（可追溯） */
  reason: string;
  /** 激活路径（sourceId → targetId） */
  via: string[];
}

/** 扩散激活结果 */
export interface SpreadResult {
  /** 被激活的目标节点及强度（hops 表示与种子的距离） */
  activated: Array<{ synapseId: string; targetId: string; activation: number; hops: number }>;
  /** 总激活量 */
  totalActivation: number;
}

/** 统计 */
export interface SynapseStats {
  total: number;
  byType: Record<string, number>;
  traceCount: number;
  totalActivation: number;
}
