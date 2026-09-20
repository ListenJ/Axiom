/**
 * embedding 授权门 + 消耗估算 + 披露文案（知识库语义层计划 · 切片 3）
 *
 * ## 为什么要有"授权门"
 * 语义检索需要把知识库内容发给 embedding 模型（消耗 Token / 配额）。用户裁定：
 * **须先告知存在该服务与消耗、给出基于本地知识库的估算范围；用户同意后才使用**；
 * 不同意则须明确告知"缺失什么能力、有什么影响"。
 *
 * ## 本模块只做"纯决策"，不发起任何调用
 * 全部为**纯函数 / 常量**：不读文件、不发网络、不读时钟。真正的调用点（切片 4）负责：
 *   1. `resolveEmbeddingConsent()` 取用户意愿；
 *   2. `ask` → 用 `buildEmbeddingConsentPrompt()` 向用户披露并**保持确定性路径**；
 *   3. `no`  → 用 `buildEmbeddingDenialImpact()` 告知缺口，**零网络请求**；
 *   4. 仅 `yes` 才允许调用 embedding。
 *
 * ## 与"确定性优先"的关系
 * 未授权时**不发起任何网络请求** ⇒ 与 2026-09-17 移除的"**默认、静默**回落远端"性质不同：
 * 这里是**显式授权**，且"未授权即零请求"可被测试断言（见 tests/unit/embedding-consent.test.ts）。
 */
import { readString } from "../utils/env.js";

/** 授权状态：`ask` = 未表态（默认，需向用户披露并询问）；`yes` = 已授权；`no` = 明确拒绝 */
export type EmbeddingConsentMode = "ask" | "yes" | "no";

/** env 变量名（口径单一出处） */
export const EMBEDDING_CONSENT_ENV = "AXIOM_EMBEDDING_CONSENT";

/** 默认值：**ask** —— 未表态即不得静默调用 */
export const EMBEDDING_CONSENT_DEFAULT: EmbeddingConsentMode = "ask";

/** 读取用户授权状态。**非法/未设置一律回落 `ask`**（保守：宁可多问一次，不可静默放行）。 */
export function resolveEmbeddingConsent(): EmbeddingConsentMode {
  const raw = readString(EMBEDDING_CONSENT_ENV, "").trim().toLowerCase();
  if (raw === "yes" || raw === "no" || raw === "ask") return raw;
  return EMBEDDING_CONSENT_DEFAULT;
}

// ============================================================================
// 消耗估算（纯函数）
// ============================================================================

/**
 * 估算用的字符/Token 边界。**具名常量**，来源与取值理由写在这里，避免散落魔法数。
 *
 * - `CHARS_PER_TOKEN_MIN = 1`：CJK 为主时的保守下界（约 1 字 ≈ 1 token 量级）；
 * - `CHARS_PER_TOKEN_MAX = 4`：英文为主时的常见上界（约 4 字符 ≈ 1 token）。
 * 真实值取决于所用模型的**分词器**；本函数给出的是**区间**，且文档/文案必须写明"估算、非计费依据"。
 */
export const CHARS_PER_TOKEN_MIN = 1;
export const CHARS_PER_TOKEN_MAX = 4;

/** 每次查询自身的预估开销（查询串 + 比对上下文）——与"全库一次性嵌入"分开计 */
export const PER_QUERY_TOKEN_ESTIMATE = 64;

export interface KnowledgeBaseStats {
  /** 文档/条目数 */
  docCount: number;
  /** 全部内容字符数（不含标题等元数据的口径由调用方说明） */
  totalChars: number;
}

export interface EmbeddingTokenEstimate {
  /** 一次性把全库嵌入的 Token 区间下界 */
  minTokens: number;
  /** 上界 */
  maxTokens: number;
  /** 每次查询的增量估算（单查询） */
  perQueryTokens: number;
  /** 口径说明（必须随估算一起展示，防止被当成账单） */
  method: string;
}

/** 非负整数化；非法输入按 0 处理（不抛错——估算失败不该阻断主流程） */
function safeCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 由**本地知识库统计**推导一次性全库嵌入的 Token 区间。纯函数：同输入同输出。
 */
export function estimateEmbeddingTokenRange(stats: KnowledgeBaseStats): EmbeddingTokenEstimate {
  const chars = safeCount(stats.totalChars);
  const docs = safeCount(stats.docCount);
  const maxTokens = Math.ceil(chars / CHARS_PER_TOKEN_MIN);
  const minTokens = Math.ceil(chars / CHARS_PER_TOKEN_MAX);
  return {
    minTokens,
    maxTokens,
    perQueryTokens: PER_QUERY_TOKEN_ESTIMATE,
    method:
      `估算＝全库字符数 ÷ 每 Token 字符数（区间 ${CHARS_PER_TOKEN_MIN}–${CHARS_PER_TOKEN_MAX}）；` +
      `样本：${docs} 条 / ${chars} 字符；每次查询另计约 ${PER_QUERY_TOKEN_ESTIMATE} Token。` +
      `**该数字是估算，不是计费依据**（真实消耗取决于所用模型的分词器与供应商计价）。`,
  };
}

// ============================================================================
// 披露文案（同意 / 拒绝两条分支）
// ============================================================================

/** 同意前必须披露的四项要素（顺序固定，便于测试逐项断言） */
export const EMBEDDING_DISCLOSURE_ELEMENTS = [
  "存在一个 embedding 服务，用于语义检索（它不生成文本，只产出向量）",
  "调用会消耗 Token（走你现有的 API key）",
  "消耗量范围见下方估算（基于本地知识库实测统计）",
  "同意 / 拒绝各自的后果见下文",
] as const;

/** 生成"请求授权"的披露文案（含估算区间）。 */
export function buildEmbeddingConsentPrompt(estimate: EmbeddingTokenEstimate): string {
  const lines = [
    "【语义检索需要你的授权】",
    ...EMBEDDING_DISCLOSURE_ELEMENTS.map((e, i) => `${i + 1}. ${e}`),
    `估算范围：一次性全库嵌入约 **${estimate.minTokens} – ${estimate.maxTokens} Token**；每次查询另计约 ${estimate.perQueryTokens} Token。`,
    estimate.method,
    `授权方式：设置 ${EMBEDDING_CONSENT_ENV}=yes（拒绝请设 no；不设置则保持默认 ${EMBEDDING_CONSENT_DEFAULT}，即不调用）。`,
  ];
  return lines.join("\n");
}

/**
 * 生成"拒绝后缺失什么 / 影响什么"的文案。
 *
 * ⚠️ 口径要求（用户明确）：只陈述**可验证的能力差异**；且必须区分【召回质量】与【响应延迟】——
 * 删掉/不启用 embedding **不会变慢**（少了网络往返），**下降的是语义召回**。禁止笼统写"效率降低"。
 */
export function buildEmbeddingDenialImpact(): string {
  return [
    "【未启用语义检索：会缺失什么】",
    "缺失：同义不同词的召回（例：只写了 `memory leak` 的笔记，用「内存泄漏」检索不到）。",
    "缺失：跨语言召回（中文查询命中英文笔记）。",
    "缺失：缩写类召回（查询用缩写、笔记只写全称）。",
    "不受影响：确定性词法检索（FTS5 / BM25）、图遍历、写入、知识图谱、上下文装配。",
    "响应延迟：不变或**略降**（少了网络往返）；下降的是**语义召回**，不是速度。",
  ].join("\n");
}


// ============================================================================
// 授权门 → 真实 embedder（切片 4 第一步）
// ============================================================================

/** 真实 embedding 调用形态（与 `ModelRouter.embeddings(texts)` 一致） */
export type EmbeddingsCall = (texts: string[]) => Promise<number[][]>;

/**
 * 依**授权状态**决定是否交出 embedder：
 * - 非 `yes`（含默认 `ask` / 明确 `no`）→ 返回 `null`，**调用方据此不发起任何网络请求**；
 * - `yes` → 返回一个包装函数，内部调用注入的 `embeddings`；
 *   失败（网络/限流/鉴权）→ **返回 null 表示降级**，不抛错（沿用"边缘增强·失败回退"语义）。
 *
 * 为什么把判断放在这里而不是散在调用点：**"未授权即零请求"必须是一处可测的闸门**，
 * 否则每个调用点各写一遍，迟早漏一处（见 tests/unit/embedding-consent.test.ts 的断言）。
 *
 * 依赖注入（rule 8）：真实实现（`ModelRouter.embeddings`）由调用方传入，本模块不 import 网络层。
 */
export function createConsentedEmbedder(
  deps: { embeddings: EmbeddingsCall },
  opts?: { mode?: EmbeddingConsentMode },
): EmbeddingsCall | null {
  const mode = opts?.mode ?? resolveEmbeddingConsent();
  if (mode !== "yes") return null; // ← 未授权：**连包装函数都不给**，物理上无法发起请求

  return async (texts: string[]): Promise<number[][]> => {
    try {
      return await deps.embeddings(texts);
    } catch (e) {
      // 降级：调用方回落到确定性词法路径（不抛错，不阻断主流程）
      return [];
    }
  };
}
