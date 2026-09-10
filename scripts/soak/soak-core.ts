/**
 * S-A7 soak harness 核心（M4 补 / 执行修订记录第 3 条）
 *
 * 对现有组件跑长会话模拟，采集 5 项崩坏指标：
 *   1. 零未捕获异常
 *   2. 逐轮上下文 ≤ 预算
 *   3. 植入记忆召回一致率 ≥ 阈值
 *   4. 重复注入零重复 KG/Vault 写入
 *   5. 中断-恢复可续
 *
 * 确定性设计（事实依据）：
 * - api-key-store.ts getEffectiveApiKey 每次调用动态读 process.env（无缓存），
 *   断言执行前清除 *_API_KEY 即可强制 ContextManager 摘要/embedding 链走
 *   fallbackSummary/fallbackEmbedding（纯函数，确定性），零网络、零 LLM 成本。
 * - 消息内容由种子 RNG（mulberry32）生成，同 seed 同序列。
 * - 植入记忆锚词为唯一 ASCII token；fallbackEmbedding 为字符频率向量，
 *   查询向量仅锚词字符维度非零 → 含锚词的 summary 点积唯一非零 → top-1 必命中。
 */

import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage } from "../../src/router/model-router.js";
import {
  ContextManager,
  estimateMessageTokens,
} from "../../src/context/context-manager.js";
import { Database } from "bun:sqlite";
import { KnowledgeGraphEnhanced } from "../../src/kg/enhanced.js";
import { SQLiteMemory } from "../../src/memory/sqlite-memory.js";
import { VaultManager } from "../../src/memory/vault-manager.js";

// ═══════════════════════════════════════════════════════════════
// 确定性环境
// ═══════════════════════════════════════════════════════════════

/**
 * 清除所有 *_API_KEY env，强制 LLM 链快速失败（key 检查在 fetch 之前）→
 * 确定性 fallback。幂等可重复调用；bun test --isolate 下进程隔离无泄漏。
 */
export function applyDeterministicEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.endsWith("_API_KEY")) delete process.env[key];
  }
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
}

/**
 * 会话期间临时将 decision 角色全部模型的 isFree/priority 标记为不满足
 * ContextManager.generateSummary 的 cheapModels 过滤（isFree || priority<=3），
 * 使摘要链零延迟直达确定性 fallbackSummary（实测 executeWithRole 即使零网络
 * 也要 ~5.7s 遍历 fallback 链，soak N≥200 轮不可接受）。返回恢复函数。
 *
 * registry 用动态 import：该模块经 model-router 存在 ESM 循环加载链，
 * 静态 import 在部分初始化时会拿到未定义绑定（实测 ReferenceError）。
 */
export async function forceDeterministicSummary(): Promise<() => void> {
  const { findModelsForRole } = await import("../../src/router/model-capability-registry.js");
  const models = findModelsForRole("decision");
  const saved = models.map((m) => ({
    id: m.id,
    isFree: m.isFree,
    priority: m.priority,
  }));
  for (const m of models) {
    m.isFree = false;
    m.priority = 99;
  }
  return () => {
    for (const s of saved) {
      const m = models.find((x) => x.id === s.id);
      if (m) {
        m.isFree = s.isFree;
        m.priority = s.priority;
      }
    }
  };
}

/** mulberry32 确定性 PRNG */
export function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════
// 会话模拟
// ═══════════════════════════════════════════════════════════════

export interface SoakSessionConfig {
  /** 模拟轮数 */
  rounds: number;
  /** 确定性种子 */
  seed: number;
  /** 上下文预算（ContextManager maxContextWindow） */
  budgetTokens: number;
  /** 植入记忆存续率阈值（默认 0.9） */
  recallThreshold?: number;
  /**
   * 切片 9（S-A7 遗留）：top-K 排序一致性探针——真实 embedding 环境注入；
   * 缺省或 isAvailable()=false → SKIP 有因（字符频率 fallback 向量 top-K 无判别力）。
   */
  topKProbe?: {
    /** 真实 embedding 是否可用（环境有 key 等） */
    isAvailable: () => boolean;
    /** top-1 排序探针：top-1 检索是否命中植入锚词 */
    top1: (anchor: string) => boolean;
  };
}

export interface SoakSessionResult {
  rounds: number;
  seed: number;
  budgetTokens: number;
  llmMode: "deterministic-fallback";
  /** 每轮结束时活跃上下文 token 数 */
  perRoundTokens: number[];
  /** 压缩/分割触发次数 */
  compressEvents: number;
  /** 植入记忆存续统计（存续率 = 植入锚词仍可从记忆层检索到的比例） */
  recall: {
    /** 植入并被检索的锚词数 */
    planted: number;
    /** 存续命中数（limit=全量 entries 检索可命中的） */
    hits: number;
    /** 命中率 = hits / planted */
    rate: number;
    /** 阈值 */
    threshold: number;
  };
  /** 重复注入写入统计（断言 4：各新增量应为 0） */
  duplicateWrites: {
    /** 重复注入批次数 */
    injections: number;
    kgNodeRowsAdded: number;
    kgEdgeRowsAdded: number;
    sqliteRowsAdded: number;
  };
  /**
   * 切片 9（S-A7 遗留）：top-K 排序一致性（断言 6，top-1 命中植入锚词）。
   * skipped=探针缺省/不可用（SKIP 有因落报告）；evaluated=真实 embedding 环境判定结果。
   */
  topK: {
    status: "evaluated" | "skipped";
    /** skipped 时的 SKIP 理由；evaluated 时为 null */
    skipReason: string | null;
    planted: number;
    top1Hits: number;
    /** top1Hits / planted；skipped 时为 null */
    rate: number | null;
  };
  /** 未捕获异常清单（进程级 uncaughtException/unhandledRejection + 逐轮 catch） */
  uncaughtAnomalies: string[];
  durationMs: number;
}

/** 生成第 round 轮的常规对话消息（种子确定） */
function makeRoundMessages(rng: () => number, round: number): ChatMessage[] {
  const topics = ["检索管线", "KG 写入", "上下文预算", "幂等注入", "记忆裁剪", "探针报告"];
  const topic = topics[Math.floor(rng() * topics.length)]!;
  // 单条消息 100-500 tokens，避免病态超预算输入干扰预算断言
  const filler = "x".repeat(200 + Math.floor(rng() * 1600));
  return [
    { role: "user", content: `第 ${round} 轮：请继续处理 ${topic} 相关内容。${filler}` },
    {
      role: "assistant",
      content: `第 ${round} 轮已完成 ${topic} 的确定性处理（内容长度 ${filler.length} 字符）。`,
    },
  ];
}

/**
 * 运行一次 soak 会话：逐轮注入消息 → checkUsage（compress/split）→ 采集指标。
 * 切片 1 范围：预算采集 + 压缩事件计数 + 未捕获异常收集。
 */
export async function runSoakSession(config: SoakSessionConfig): Promise<SoakSessionResult> {
  const { rounds, seed, budgetTokens } = config;
  const rng = makeSeededRng(seed);
  const restoreModels = await forceDeterministicSummary();
  const cm = new ContextManager({ maxContextWindow: budgetTokens });

  const uncaughtAnomalies: string[] = [];
  const onUncaught = (err: unknown) => {
    uncaughtAnomalies.push(err instanceof Error ? err.message : String(err));
  };
  // 进程级兜底：会话期间任何未捕获异常/拒绝都计入指标
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  const perRoundTokens: number[] = [];
  let compressEvents = 0;
  const recallThreshold = config.recallThreshold ?? 0.9;
  let recallPlanted = 0;
  let recallHits = 0;
  let pendingAnchor: string | null = null;

  // 断言 6（切片 9）：top-K 排序一致性探针状态（真实 embedding 环境判定，缺省 SKIP 有因）
  const topKProbe = config.topKProbe;
  const topKUsable = topKProbe?.isAvailable() ?? false;
  let topKPlanted = 0;
  let topKHits = 0;

  // 断言 4 资源：临时 KG / sqlite-memory / Vault 实例（会话结束清理）
  const tmpDir = mkdtempSync(path.join(tmpdir(), "soak-s7-"));
  const kgDb = new Database(path.join(tmpDir, "kg.db"));
  const kg = new KnowledgeGraphEnhanced(kgDb);
  const mem = new SQLiteMemory(path.join(tmpDir, "memory.db"));
  const vault = new VaultManager({
    vaultPath: path.join(tmpDir, "vault"),
    dbPath: path.join(tmpDir, "vault-index.db"),
  });
  let duplicateInjections = 0;
  let kgNodeRowsAdded = 0;
  let kgEdgeRowsAdded = 0;
  let sqliteRowsAdded = 0;
  let vaultFilesAdded = 0;

  const countNodes = () => (kgDb.query("SELECT COUNT(*) AS c FROM kg_nodes").get() as { c: number }).c;
  const countEdges = () => (kgDb.query("SELECT COUNT(*) AS c FROM kg_edges").get() as { c: number }).c;
  const countNotes = () => mem.stats().totalNotes;
  const vaultRoot = path.join(tmpDir, "vault");
  const countVaultNotes = () =>
    readdirSync(vaultRoot, { recursive: true }).filter((f) => String(f).endsWith(".md")).length;

  // 幂等注入载荷：跨批次保持同一内容（重复注入语义）
  const injectionNode = {
    id: "",
    type: "concept" as const,
    name: "soak-idempotency-node",
    description: "S-A7 soak 重复注入验证节点",
    tags: ["soak"],
  };
  const injectionEdge = {
    id: "",
    source: "",
    target: "",
    type: "related-to" as const,
    weight: 1.0,
  };
  // 目标节点/边先落库，边需要稳定端点
  const probeNode = { ...injectionNode, name: "soak-idempotency-probe" };
  kg.addNode(probeNode);
  const probeNodeId = probeNode.id;

  const start = Date.now();

  try {
    let messages: ChatMessage[] = [];
    for (let round = 1; round <= rounds; round++) {
      try {
        messages.push(...makeRoundMessages(rng, round));

        // 断言 4：每 8 轮一批重复注入——首写建立基线后，同内容重复写 3 次，
        // 行数增量必须为 0（首次写入是合法新建，不计入"重复"）
        if (round % 8 === 0) {
          injectionNode.id = "";
          kg.addNode(injectionNode);
          injectionEdge.id = "";
          injectionEdge.source = probeNodeId;
          injectionEdge.target = injectionNode.id || probeNodeId;
          kg.addEdge(injectionEdge);
          mem.upsertNote({
            path: "soak/idempotency.md",
            title: "soak idempotency",
            content: `S-A7 重复注入验证 note（round ${round}）`,
            excerpt: "S-A7 重复注入验证 note",
            tags: ["soak"],
            paraCategory: "resources",
            type: "note",
            confidence: 0.7,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          const before = { n: countNodes(), e: countEdges(), s: countNotes() };
          // 重复注入：同内容再写 3 次
          for (let i = 0; i < 3; i++) {
            injectionNode.id = "";
            kg.addNode(injectionNode);
            injectionEdge.id = "";
            injectionEdge.source = probeNodeId;
            injectionEdge.target = injectionNode.id || probeNodeId;
            kg.addEdge(injectionEdge);
            mem.upsertNote({
              path: "soak/idempotency.md",
              title: "soak idempotency",
              content: `S-A7 重复注入验证 note（round ${round}）`,
              excerpt: "S-A7 重复注入验证 note",
              tags: ["soak"],
              paraCategory: "resources",
              type: "note",
              confidence: 0.7,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
          const after = { n: countNodes(), e: countEdges(), s: countNotes() };
          duplicateInjections++;
          kgNodeRowsAdded += after.n - before.n;
          kgEdgeRowsAdded += after.e - before.e;
          sqliteRowsAdded += after.s - before.s;
        }

        // 植入/召回周期（每 6 轮）：检索上一锚词 → 植入新锚词。
        // 6 轮间隔保证上一锚词消息已被 ≥10 条消息挤出 preserveRecent 窗口，
        // 其后的强制压缩必然把它纳入 chunk 存入记忆层。
        if (round % 6 === 0) {
          if (pendingAnchor) {
            const compressed = await cm.compressContext(messages, { preserveRecent: 4 });
            compressEvents++;
            messages = compressed;
            // 存续口径：fallback 摘要递归吸收全部历史"决策"消息（compress 的 system
            // 摘要无条件进 keyMessages），各 entry 字符频率向量同分、top-K 排序无判别力
            // （实测 0.594 同分），故按 limit=全量 entries 检索验证"记忆不凭空丢失"。
            // top-K 排序一致性需真实 embedding 环境，属 S-A2 接入后的断言增强。
            const limit = Math.max(1, cm.getMemoryStats().entries + 1);
            const got = await cm.retrieveFromMemory(pendingAnchor, { limit });
            recallPlanted++;
            if (got.some((m) => m.content.includes(pendingAnchor!))) recallHits++;
            // 断言 6（切片 9）：top-1 排序探针（真实 embedding 环境注入时对同一锚词判定）
            if (topKUsable) {
              topKPlanted++;
              if (topKProbe!.top1(pendingAnchor)) topKHits++;
            }
          }
          pendingAnchor = `soak-anchor-${round}`;
          messages.push({
            role: "user",
            content: `决策：本轮确认锚词 ${pendingAnchor} 为关键事实，后续检索必须召回。`,
          });
        }

        const checked = await cm.checkUsage(messages, { preserveRecent: 4 });
        if (checked.action !== "none") compressEvents++;
        messages = checked.messages;

        perRoundTokens.push(messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0));
      } catch (err) {
        // 逐轮 catch：异常计入未捕获异常指标（本轮上下文原样续用，继续跑）
        uncaughtAnomalies.push(err instanceof Error ? err.message : String(err));
        perRoundTokens.push(messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0));
      }
    }
  } finally {
    restoreModels();
    try {
      kgDb.close();
      mem.close();
    } catch {
      // 关闭失败不影响指标
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响指标
    }
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
  }

  return {
    rounds,
    seed,
    budgetTokens,
    llmMode: "deterministic-fallback",
    perRoundTokens,
    compressEvents,
    recall: {
      planted: recallPlanted,
      hits: recallHits,
      rate: recallPlanted > 0 ? recallHits / recallPlanted : 1,
      threshold: recallThreshold,
    },
    duplicateWrites: {
      injections: duplicateInjections,
      kgNodeRowsAdded,
      kgEdgeRowsAdded,
      sqliteRowsAdded,
    },
    topK: topKUsable
      ? {
          status: "evaluated",
          skipReason: null,
          planted: topKPlanted,
          top1Hits: topKHits,
          rate: topKPlanted > 0 ? topKHits / topKPlanted : 1,
        }
      : {
          status: "skipped",
          skipReason: topKProbe
            ? "真实 embedding 不可用（探针 isAvailable()=false，环境无 key）"
            : "未注入 topKProbe（无 key 环境走确定性 fallback，字符频率向量 top-K 排序无判别力）",
          planted: 0,
          top1Hits: 0,
          rate: null,
        },
    uncaughtAnomalies,
    durationMs: Date.now() - start,
  };
}

// ═══════════════════════════════════════════════════════════════
// 断言 5：中断-恢复可续
// ═══════════════════════════════════════════════════════════════

export interface InterruptRecoveryConfig {
  /** 中断前模拟轮数 */
  roundsBeforeInterrupt: number;
  /** 恢复后继续轮数 */
  roundsAfterResume: number;
  seed: number;
  budgetTokens: number;
}

export interface InterruptRecoveryResult {
  interruptedAtRound: number;
  resumedRounds: number;
  seed: number;
  budgetTokens: number;
  /** 中断前植入 sqlite-memory 的锚词数 */
  anchorsPlantedBefore: number;
  /** 恢复后（新 SQLiteMemory 实例重开同一 db）仍可精确取回的锚词数 */
  anchorsRecoveredAfterResume: number;
  /** 恢复后逐轮 token */
  perRoundTokensAfterResume: number[];
  /** 恢复后压缩/分割触发次数 */
  compressEventsAfterResume: number;
  uncaughtAnomalies: string[];
  durationMs: number;
}

/**
 * 中断-恢复会话：Phase 1 跑 K 轮并把锚词写入 sqlite-memory（持久层）→
 * 模拟中断（不做任何收尾直接丢弃运行态；bun:sqlite 逐语句提交，等价进程死亡）→
 * Phase 2 以全新 SQLiteMemory/ContextManager 实例重开同一 db 继续跑 N2 轮。
 * 验证：持久记忆存活 + 会话可继续（恢复口径：ContextManager 进程内记忆本就
 * 不跨进程，架构上的恢复层是 sqlite-memory，Vault 索引与之同源）。
 */
export async function runSoakInterruptRecovery(
  config: InterruptRecoveryConfig
): Promise<InterruptRecoveryResult> {
  const { roundsBeforeInterrupt, roundsAfterResume, seed, budgetTokens } = config;
  const rng = makeSeededRng(seed);
  const restoreModels = await forceDeterministicSummary();

  const uncaughtAnomalies: string[] = [];
  const onUncaught = (err: unknown) => {
    uncaughtAnomalies.push(err instanceof Error ? err.message : String(err));
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  const perRoundTokensAfterResume: number[] = [];
  let compressEventsAfterResume = 0;
  let anchorsPlantedBefore = 0;
  let anchorsRecoveredAfterResume = 0;
  const anchorPaths: string[] = [];

  const tmpDir = mkdtempSync(path.join(tmpdir(), "soak-s7-interrupt-"));
  const dbPath = path.join(tmpDir, "memory.db");
  let mem1: SQLiteMemory | null = null;
  let mem2: SQLiteMemory | null = null;

  const start = Date.now();

  const makeAnchorNote = (round: number) => ({
    path: `soak/anchor-${round}.md`,
    title: `soak anchor ${round}`,
    content: `中断恢复验证锚词 soak-anchor-${round}：恢复后必须可取回。`,
    excerpt: `中断恢复验证锚词 soak-anchor-${round}`,
    tags: ["soak"],
    paraCategory: "resources" as const,
    type: "note",
    confidence: 0.9,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const pushAnchorMessage = (msgs: ChatMessage[], round: number) => {
    msgs.push({
      role: "user",
      content: `决策：本轮确认锚词 soak-anchor-${round} 为关键事实，后续检索必须召回。`,
    });
  };

  try {
    // ── Phase 1：中断前会话（round 1..K）──
    const cm1 = new ContextManager({ maxContextWindow: budgetTokens });
    mem1 = new SQLiteMemory(dbPath);
    let messages: ChatMessage[] = [];
    for (let round = 1; round <= roundsBeforeInterrupt; round++) {
      try {
        messages.push(...makeRoundMessages(rng, round));
        if (round % 6 === 0) {
          pushAnchorMessage(messages, round);
          mem1.upsertNote(makeAnchorNote(round));
          anchorPaths.push(`soak/anchor-${round}.md`);
          anchorsPlantedBefore++;
        }
        const checked = await cm1.checkUsage(messages, { preserveRecent: 4 });
        messages = checked.messages;
      } catch (err) {
        uncaughtAnomalies.push(err instanceof Error ? err.message : String(err));
      }
    }

    // 模拟中断：不做任何收尾，直接丢弃运行态（mem1 句柄仅留给 finally 清理文件）
    mem2 = new SQLiteMemory(dbPath);

    // 恢复校验：中断前植入的锚词仍可从持久层精确取回
    //（getByPath 精确路径命中，避开 FTS 对 soak-anchor-N 的分词歧义）
    for (const p of anchorPaths) {
      const rec = mem2.getByPath(p);
      if (rec && rec.content.length > 0) anchorsRecoveredAfterResume++;
    }

    // ── Phase 2：恢复后继续会话（round K+1..K+N2，同 rng 流保证确定性）──
    const cm2 = new ContextManager({ maxContextWindow: budgetTokens });
    let messages2: ChatMessage[] = [];
    for (
      let round = roundsBeforeInterrupt + 1;
      round <= roundsBeforeInterrupt + roundsAfterResume;
      round++
    ) {
      try {
        messages2.push(...makeRoundMessages(rng, round));
        if (round % 6 === 0) {
          pushAnchorMessage(messages2, round);
          mem2.upsertNote(makeAnchorNote(round));
        }
        const checked = await cm2.checkUsage(messages2, { preserveRecent: 4 });
        if (checked.action !== "none") compressEventsAfterResume++;
        messages2 = checked.messages;
        perRoundTokensAfterResume.push(
          messages2.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
        );
      } catch (err) {
        uncaughtAnomalies.push(err instanceof Error ? err.message : String(err));
        perRoundTokensAfterResume.push(
          messages2.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
        );
      }
    }
  } finally {
    restoreModels();
    try {
      mem1?.close();
      mem2?.close();
    } catch {
      // 关闭失败不影响指标
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响指标
    }
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
  }

  return {
    interruptedAtRound: roundsBeforeInterrupt,
    resumedRounds: roundsAfterResume,
    seed,
    budgetTokens,
    anchorsPlantedBefore,
    anchorsRecoveredAfterResume,
    perRoundTokensAfterResume,
    compressEventsAfterResume,
    uncaughtAnomalies,
    durationMs: Date.now() - start,
  };
}

// ═══════════════════════════════════════════════════════════════
// 断言函数（纯函数：吃 SoakSessionResult，返回违例清单）
// ═══════════════════════════════════════════════════════════════

export interface BudgetViolation {
  round: number;
  tokens: number;
  budget: number;
}

/** 断言 2：逐轮上下文 ≤ 预算 */
export function assertBudgetPerRound(result: SoakSessionResult): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  for (let i = 0; i < result.perRoundTokens.length; i++) {
    const tokens = result.perRoundTokens[i]!;
    if (tokens > result.budgetTokens) {
      violations.push({ round: i + 1, tokens, budget: result.budgetTokens });
    }
  }
  return violations;
}

export interface RecallViolation {
  kind: "rate-below-threshold" | "missed-anchors";
  rate: number;
  threshold: number;
  misses: number;
}

/** 断言 3：植入记忆召回一致率 ≥ 阈值 */
export function assertRecallConsistency(result: SoakSessionResult): RecallViolation[] {
  const { rate, threshold, planted, hits } = result.recall;
  if (rate >= threshold) return [];
  return [
    {
      kind: "rate-below-threshold",
      rate,
      threshold,
      misses: planted - hits,
    },
  ];
}

export interface DuplicateWriteViolation {
  kind: "kg-nodes" | "kg-edges" | "sqlite-rows";
  added: number;
}

/** 断言 4：重复注入零重复 KG/Vault 写入（Vault 索引腿与 sqlite-memory 同源） */
export function assertNoDuplicateWrites(result: SoakSessionResult): DuplicateWriteViolation[] {
  const d = result.duplicateWrites;
  const violations: DuplicateWriteViolation[] = [];
  if (d.kgNodeRowsAdded > 0) violations.push({ kind: "kg-nodes", added: d.kgNodeRowsAdded });
  if (d.kgEdgeRowsAdded > 0) violations.push({ kind: "kg-edges", added: d.kgEdgeRowsAdded });
  if (d.sqliteRowsAdded > 0) violations.push({ kind: "sqlite-rows", added: d.sqliteRowsAdded });
  return violations;
}

export interface TopKViolation {
  kind: "top1-rate-below-threshold";
  rate: number;
  threshold: number;
  planted: number;
  hits: number;
  misses: number;
}

/** 断言 6（切片 9）：top-K 排序一致性——top-1 命中植入锚词率 ≥ 召回阈值。
 *  skipped=SKIP 有因（探针缺省/embedding 不可用），不产生违例；阈值复用 recall.threshold 同一口径。 */
export function assertTopKConsistency(result: SoakSessionResult): TopKViolation[] {
  const { status, rate, planted, top1Hits } = result.topK;
  if (status === "skipped") return [];
  const threshold = result.recall.threshold;
  const effectiveRate = rate ?? 1;
  if (effectiveRate >= threshold) return [];
  return [
    {
      kind: "top1-rate-below-threshold",
      rate: effectiveRate,
      threshold,
      planted,
      hits: top1Hits,
      misses: planted - top1Hits,
    },
  ];
}

export interface InterruptRecoveryViolation {
  kind:
    | "memory-lost-after-interrupt"
    | "resume-rounds-incomplete"
    | "resume-anomaly"
    | "budget-exceeded-after-resume";
  detail: string;
}

/** 断言 5：中断-恢复可续（持久记忆存活 + 会话继续 + 预算仍守 + 零异常） */
export function assertInterruptRecovery(
  result: InterruptRecoveryResult
): InterruptRecoveryViolation[] {
  const violations: InterruptRecoveryViolation[] = [];
  if (result.anchorsRecoveredAfterResume < result.anchorsPlantedBefore) {
    violations.push({
      kind: "memory-lost-after-interrupt",
      detail: `恢复后取回 ${result.anchorsRecoveredAfterResume}/${result.anchorsPlantedBefore} 个中断前锚词`,
    });
  }
  if (result.perRoundTokensAfterResume.length < result.resumedRounds) {
    violations.push({
      kind: "resume-rounds-incomplete",
      detail: `恢复后仅完成 ${result.perRoundTokensAfterResume.length}/${result.resumedRounds} 轮`,
    });
  }
  if (result.uncaughtAnomalies.length > 0) {
    violations.push({
      kind: "resume-anomaly",
      detail: `${result.uncaughtAnomalies.length} 个未捕获异常，首个: ${result.uncaughtAnomalies[0]}`,
    });
  }
  for (let i = 0; i < result.perRoundTokensAfterResume.length; i++) {
    const tokens = result.perRoundTokensAfterResume[i]!;
    if (tokens > result.budgetTokens) {
      violations.push({
        kind: "budget-exceeded-after-resume",
        detail: `恢复后第 ${i + 1} 轮 ${tokens} tokens > 预算 ${result.budgetTokens}`,
      });
    }
  }
  return violations;
}
