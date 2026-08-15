/**
 * MindAdvisor — 心智模块 × 自进化闭环
 *
 * 需求 2：DRE 与 LLM 交流、根据场景数据自我进化，并对不同场景/任务目标
 * 自动提供下一步建议。
 *
 * 闭环：
 *   1. self-evolve 归纳出模式（Induction）/ 提炼教训（Improvement）；
 *   2. MindAdvisor.recordInduction / recordImprovement 把这些"场景 → 能力/教训"
 *      写成神经突触（Hebbian 可积累强度，支持度越高权重越高）；
 *   3. 未来出现相似场景/目标时，MindAdvisor.suggest 用突触扩散激活给出
 *      可追溯的下一步建议（via 路径 + 理由）。
 *
 * 依赖注入（规则 8）：SynapseEngine 必传；lessonsProvider 可选（默认无）。
 */

import type { SynapseEngine, SynapseSuggestion } from "../dre/synapse/index.js";
import { tokenize, stableHash } from "./engine.js";
import type { Induction } from "./types.js";

export interface MindAdvisorOptions {
  synapse: SynapseEngine;
  /** 可选：返回自进化教训列表（string[]），用于在建议中附带证据 */
  lessonsProvider?: () => Promise<string[]>;
}

export interface MindSuggestResult {
  suggestions: SynapseSuggestion[];
  /** 命中的教训（lessonsProvider 注入时） */
  lessons: string[];
}

export class MindAdvisor {
  private readonly synapse: SynapseEngine;
  private readonly lessonsProvider?: () => Promise<string[]>;

  constructor(opts: MindAdvisorOptions) {
    this.synapse = opts.synapse;
    this.lessonsProvider = opts.lessonsProvider;
  }

  /**
   * 把一次归纳（模式）写进突触网络：context 中的每个关键词 token
   * → 该模式（targetType=skill）。支持度越高权重越高（Hebbian 积累）。
   */
  recordInduction(induction: Induction, context: string): number {
    const patternId = `induction:${stableHash(induction.pattern)}`;
    const tokens = tokenize(context).slice(0, 8);
    const weight = Math.min(1, 0.4 + induction.support * 0.1);
    let created = 0;
    for (const t of tokens) {
      if (t.length < 2) continue;
      const s = this.synapse.createSynapse(`scene:${t}`, patternId, {
        sourceType: "scene",
        targetType: "skill",
        weight,
      });
      // 支持度越高，激活次数预置越高（突触更"强"）
      if (s.activationCount < induction.support) {
        this.synapse.activate(`scene:${t}`, "recordInduction", { delta: 0.05, decay: false });
      }
      created++;
    }
    return created;
  }

  /** 把一条教训写进突触网络：任务 token → 教训（targetType=memory） */
  recordImprovement(task: string, lesson: string): number {
    if (!lesson.trim()) return 0;
    const lessonId = `lesson:${stableHash(lesson)}`;
    const tokens = tokenize(task).slice(0, 8);
    let created = 0;
    for (const t of tokens) {
      if (t.length < 2) continue;
      this.synapse.createSynapse(`scene:${t}`, lessonId, {
        sourceType: "scene",
        targetType: "memory",
        weight: 0.6,
      });
      created++;
    }
    return created;
  }

  /** 基于场景+目标给出下一步建议（突触扩散激活，可追溯） */
  async suggest(scene: string, goal: string, opts: { limit?: number } = {}): Promise<MindSuggestResult> {
    const suggestions = await this.synapse.suggestNextSteps(scene, goal, { limit: opts.limit ?? 5 });
    let lessons: string[] = [];
    if (this.lessonsProvider) {
      try {
        lessons = await this.lessonsProvider();
      } catch {
        lessons = [];
      }
    }
    return { suggestions, lessons };
  }
}

/** 便捷工厂 */
export function createMindAdvisor(opts: MindAdvisorOptions): MindAdvisor {
  return new MindAdvisor(opts);
}
