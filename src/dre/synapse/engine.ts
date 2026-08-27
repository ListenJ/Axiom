/**
 * SynapseEngine — 神经突触心智模块（确定性核心）
 *
 * 能力（对应需求 2）：
 *   - 突触创建/激活：Hebbian 式增强（激活路径变强），全局轻微衰减（模拟遗忘）。
 *   - 扩散激活（spread activation）：从种子节点沿突触 BFS，强度随跳数衰减
 *     ——"扩散和独立思考"的确定性实现。
 *   - 下一步建议：对"场景 + 目标"做确定性排序（基础强度 + 激活次数 + 新鲜度），
 *     每条建议带可追溯的 via 路径与理由。
 *   - 可校验：所有写操作走 store，verify() 全链可查；本地模型仅作可选增强
 *     （注入 localModelAssist，默认无 → 纯确定性，测试零网络依赖）。
 */

import { logger } from "../../utils/logger.js";
import type { Synapse, SynapseNodeType, SynapseSuggestion, SynapseTrace, SpreadResult } from "./types.js";
import { SynapseStore, makeSynapse, computeTraceHash, GENESIS_HASH, synapseId } from "./store.js";

export interface SynapseEngineOptions {
  /** 每次激活时对"非激活路径"突触的全局衰减量（默认 0.01） */
  decayPerActivation?: number;
  /** 扩散激活每跳衰减系数（默认 0.6） */
  spreadDecay?: number;
  /** 建议默认返回条数（默认 5） */
  suggestTopK?: number;
  /** 权重下限（默认 0.05） */
  minWeight?: number;
  /** 可选本地模型增强：输入确定性建议 + 场景/目标，可重排/增补；默认不启用 */
  localModelAssist?: (
    suggestions: SynapseSuggestion[],
    scene: string,
    goal: string,
  ) => Promise<SynapseSuggestion[]>;
}

export class SynapseEngine {
  private readonly store: SynapseStore;
  private readonly opts: Required<Omit<SynapseEngineOptions, "localModelAssist">> & Pick<SynapseEngineOptions, "localModelAssist">;

  constructor(store: SynapseStore, opts: SynapseEngineOptions = {}) {
    this.store = store;
    this.opts = {
      decayPerActivation: opts.decayPerActivation ?? 0.01,
      spreadDecay: opts.spreadDecay ?? 0.6,
      suggestTopK: opts.suggestTopK ?? 5,
      minWeight: opts.minWeight ?? 0.05,
      localModelAssist: opts.localModelAssist,
    };
  }

  // ── 写路径：带验证链 ──────────────────────────────────────────────

  /** 创建一条突触（已存在则幂等返回现有） */
  createSynapse(
    sourceId: string,
    targetId: string,
    opts: { sourceType?: SynapseNodeType; targetType?: SynapseNodeType; weight?: number } = {},
  ): Synapse {
    const existing = this.store.findByPair(sourceId, targetId);
    if (existing) return existing;
    const s = makeSynapse(
      sourceId,
      targetId,
      opts.sourceType ?? "concept",
      opts.targetType ?? "skill",
      clamp01(opts.weight ?? 0.5),
    );
    this.store.upsert(s);
    this.appendTrace(s, "create", s.weight, "createSynapse", Date.now());
    return s;
  }

  /**
   * 激活一条突触：强度 +delta、激活次数 +1，其余突触全局轻微衰减。
   * 返回被增强的突触（可能多条 sourceId 出边同时增强）。
   *
   * 全局衰减采用 epoch 增量（写时结算 + 读时惰性）：
   *   - 仅当本次确实增强出边且未禁用衰减时，全局 epoch 才 +1；
   *   - direct 出边豁免本次衰减（decayEpoch 对齐到新 epoch）；
   *   - 非激活突触的衰减通过「effectiveWeight = weight - decay × (epoch - decayEpoch)」惰性表达，
   *     读取时才结算，避免每次激活全表遍历（原实现 O(n) DB 写放大）。
   */
  activate(sourceId: string, event: string, opts: { delta?: number; decay?: boolean } = {}): Synapse[] {
    const delta = clamp01(opts.delta ?? 0.15);
    const now = Date.now();
    const direct = this.store.listBySource(sourceId);
    const enhanced: Synapse[] = [];
    const oldEpoch = this.store.getGlobalEpoch();
    const willDecay = this.opts.decayPerActivation > 0 && opts.decay !== false;
    // 有出边增强且需衰减时推进 epoch；否则 epoch 不变（不触发无谓的全局遗忘）
    const newEpoch = (direct.length > 0 && willDecay) ? this.store.incrementGlobalEpoch() : oldEpoch;

    for (const s of direct) {
      const next = this.store.updateActivation(s.id, {
        // 按旧 epoch 结算历史衰减（direct 出边不因本次衰减而减），再增强
        weight: clamp01(this.effectiveWeight(s, oldEpoch) + delta),
        activationCount: s.activationCount + 1,
        lastActivatedAt: now,
        decayEpoch: newEpoch,
      });
      if (next) {
        enhanced.push(next);
        this.appendTrace(next, "activate", delta, event, now);
      }
    }
    // 全局轻微衰减（遗忘）：仅当本次激活确实增强了出边时发生——无操作激活不应触发全局遗忘。
    // 增量衰减：不逐条写库；仅记录汇总衰减 trace 在首个非激活突触上（O(1) 索引查询，非全表遍历）。
    if (enhanced.length > 0 && willDecay) {
      const firstOther = this.store.listFirstNotBySource(sourceId);
      if (firstOther) {
        this.appendTrace(firstOther, "decay", -this.opts.decayPerActivation, `global decay (epoch=${newEpoch})`, now);
      }
    }
    return enhanced;
  }

  /**
   * 计算某突触的「有效强度」：存储 weight 扣除自上次结算以来的累计衰减。
   * 纯读，不改库；写路径（updateActivation）会先结算再写。
   */
  private effectiveWeight(s: Synapse, epoch = this.store.getGlobalEpoch()): number {
    const decayed = s.weight - this.opts.decayPerActivation * Math.max(0, epoch - (s.decayEpoch ?? 0));
    return Math.max(this.opts.minWeight, decayed);
  }

  /**
   * 扩散激活：从种子节点沿出边 BFS，激活量随跳数衰减。
   * 访问到的突触同时做 Hebbian 增强（记录 spread trace）。
   */
  spreadActivation(seedIds: string[], event: string, opts: { maxHops?: number } = {}): SpreadResult {
    const maxHops = Math.max(1, opts.maxHops ?? 3);
    const now = Date.now();
    const epoch = this.store.getGlobalEpoch();
    const visited = new Map<string, { activation: number; hops: number }>(); // synapseId -> act
    const queue: Array<{ nodeId: string; hops: number; activation: number }> = seedIds.map((n) => ({ nodeId: n, hops: 0, activation: 1 }));
    const seenNodes = new Set<string>(seedIds);

    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++]!;
      if (cur.hops >= maxHops) continue;
      for (const s of this.store.listBySource(cur.nodeId)) {
        const activation = cur.activation * this.opts.spreadDecay;
        const existing = visited.get(s.id);
        if (!existing || activation > existing.activation) {
          visited.set(s.id, { activation, hops: cur.hops + 1 });
          // Hebbian 增强（基于有效强度结算）
          const next = this.store.updateActivation(s.id, {
            weight: clamp01(this.effectiveWeight(s, epoch) + 0.05),
            activationCount: s.activationCount + 1,
            lastActivatedAt: now,
          });
          if (next) this.appendTrace(next, "spread", activation, `${event} (hops=${cur.hops + 1})`, now);
        }
        if (!seenNodes.has(s.targetId)) {
          seenNodes.add(s.targetId);
          queue.push({ nodeId: s.targetId, hops: cur.hops + 1, activation });
        }
      }
    }

    const activated = Array.from(visited.entries()).map(([synapseId, v]) => ({
      synapseId,
      targetId: this.store.get(synapseId)?.targetId ?? "",
      activation: v.activation,
      hops: v.hops,
    }));
    const totalActivation = activated.reduce((acc, a) => acc + a.activation, 0);
    return { activated, totalActivation };
  }

  /**
   * 下一步建议：对"场景 + 目标"做确定性排序。
   *   score = weight + activationBonus(0.3) + freshness(0.1)
   * 命中方式：场景/目标 token 出现在突触 sourceId 中 → 其 target 为候选；
   * 另把所有 targetType=skill 的突触作为常驻候选。
   */
  async suggestNextSteps(scene: string, goal: string, opts: { limit?: number } = {}): Promise<SynapseSuggestion[]> {
    const limit = opts.limit ?? this.opts.suggestTopK;
    const now = Date.now();
    const epoch = this.store.getGlobalEpoch();
    const sceneTokens = tokenize(scene);
    const goalTokens = tokenize(goal);
    const all = this.store.listAll();

    const candidates = new Map<string, SynapseSuggestion>();
    const candidateSource = new Map<string, string>(); // targetId -> 贡献该建议的 synapseId
    const add = (s: Synapse, match: string) => {
      const existing = candidates.get(s.targetId);
      if (existing) return; // 取第一条 via（更直接）
      const effWeight = this.effectiveWeight(s, epoch);
      const activationBonus = Math.min(s.activationCount, 10) / 10 * 0.3;
      const fresh = s.lastActivatedAt > 0 ? clamp01((now - s.lastActivatedAt) / (24 * 3600 * 1000)) : 0;
      const freshness = (1 - fresh) * 0.1;
      const score = clamp01(effWeight + activationBonus + freshness);
      candidateSource.set(s.targetId, s.id);
      candidates.set(s.targetId, {
        targetId: s.targetId,
        targetType: s.targetType,
        score,
        reason: `via ${s.sourceId} -> ${s.targetId} (weight=${effWeight.toFixed(2)}, activations=${s.activationCount}, match=${match})`,
        via: [s.sourceId, s.targetId],
      });
    };

    for (const s of all) {
      const srcTokens = tokenize(s.sourceId);
      const hitScene = sceneTokens.length > 0 && sceneTokens.some((t) => srcTokens.includes(t) || s.sourceId.includes(t));
      const hitGoal = goalTokens.length > 0 && goalTokens.some((t) => srcTokens.includes(t) || s.sourceId.includes(t));
      if (hitScene || hitGoal) {
        add(s, hitScene ? "scene" : "goal");
      }
    }
    // 常驻候选：技能型目标
    for (const s of all) {
      if (s.targetType === "skill" && !candidates.has(s.targetId)) {
        add(s, "skill");
      }
    }

    const ranked = Array.from(candidates.values()).sort((a, b) => b.score - a.score).slice(0, limit);
    // 记录 suggest trace（记在贡献该建议的突触上，保证追溯准确）
    if (ranked.length > 0) {
      const contributingId = candidateSource.get(ranked[0].targetId);
      const contributing = contributingId ? this.store.get(contributingId) : null;
      if (contributing) this.appendTrace(contributing, "suggest", ranked[0].score, `scene=${truncate(scene, 40)} goal=${truncate(goal, 40)}`, now);
    }
    if (this.opts.localModelAssist) {
      try {
        const assisted = await this.opts.localModelAssist(ranked, scene, goal);
        if (Array.isArray(assisted)) return assisted.slice(0, limit);
      } catch (err) {
        logger.warn("[Synapse] local model assist failed, using deterministic suggestions", { error: (err as Error).message });
      }
    }
    return ranked;
  }

  /** 可校验：单条突触 + 全验证链 */
  verify(synapseIdArg: string): { valid: boolean; reason: string } {
    return this.store.verify(synapseIdArg);
  }

  /** 追溯：某突触的完整验证链 */
  trace(synapseIdArg: string): SynapseTrace[] {
    return this.store.tracesFor(synapseIdArg);
  }

  stats() {
    return this.store.stats();
  }

  storeSnapshot(): Synapse[] {
    // 返回「有效强度」视图（存储 weight 经惰性衰减折算），供调用方/测试观察真实强度。
    const epoch = this.store.getGlobalEpoch();
    return this.store.listAll().map((s) => ({ ...s, weight: this.effectiveWeight(s, epoch) }));
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private appendTrace(s: Synapse, operation: SynapseTrace["operation"], activation: number, sourceEvent: string, timestamp: number): void {
    const prevHash = this.store.lastTraceHash(s.id);
    const seq = this.store.nextSeq(s.id);
    // 记录 id 即记录哈希（确定性、防篡改）
    const hash = computeTraceHash({ synapseId: s.id, seq, operation, activation, sourceEvent, timestamp, prevHash });
    this.store.appendTrace({
      id: hash,
      synapseId: s.id,
      seq,
      operation,
      activation,
      sourceEvent,
      timestamp,
      prevHash,
      hash,
    });
  }
}


/** 归一化 token：小写字母数字 + 下划线，按非字母数字切分 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = (text ?? "").toLowerCase();
  const segments = lower.match(/[a-z0-9_]+|[\u4e00-\u9fa5]+/g) ?? [];
  for (const seg of segments) {
    if (/[\u4e00-\u9fa5]/.test(seg)) {
      if (seg.length >= 2) {
        for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
      } else {
        out.push(seg);
      }
    } else if (seg.length >= 1) {
      out.push(seg);
    }
  }
  return Array.from(new Set(out));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * 本地模型增强工厂（可选）：OpenAI 兼容端点 + 强约束 JSON 输出。
 * 仅在配置了 MIND_LOCAL_LLM_URL 时由调用方启用；不配置则心智模块纯确定性。
 */
export function createLocalModelAssist(opts: { baseUrl: string; apiKey?: string; model?: string; timeoutMs?: number }): (suggestions: SynapseSuggestion[], scene: string, goal: string) => Promise<SynapseSuggestion[]> {
  return async (suggestions, scene, goal) => {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model ?? "local-model",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "你是心智模块的本地辅助层。只能对给定的候选建议做重排/裁剪，不得新增事实。返回 JSON 数组，每项 {targetId, score, reason}。",
          },
          { role: "user", content: JSON.stringify({ scene, goal, candidates: suggestions }) },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`local model HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content ?? "[]";
    const parsed = JSON.parse(content) as SynapseSuggestion[];
    if (!Array.isArray(parsed)) return suggestions;
    return parsed;
  };
}

/** 便捷工厂：创建内存/文件突触引擎 */
export function createSynapseEngine(dbPath: string, opts: SynapseEngineOptions = {}): SynapseEngine {
  return new SynapseEngine(new SynapseStore(dbPath), opts);
}
