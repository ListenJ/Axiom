/**
 * Laya 决策服务 TS 客户端（HTTP）—— 多语言决策收拢进 TS 运行时
 *
 * 定位：内网 Laya 决策服务（multilingual，CPU 推理，约 4–5 QPS）的**唯一** TS 调用面。
 * 契约唯一来源：`~/.axiom/axiom-secrets/laya-service.contract.md`（用户提供 2026-09-28；
 * 基址属部署拓扑，按规则 11 只经 env 读取、不入库不入日志）。
 *
 * 契约要点（与响应/错误处理强相关，改动前先对齐契约文档）：
 *  - 单条 POST /v1/systemone；批量 POST /v1/systemone/batch（单批 ≤500，results 与输入严格同序，
 *    整体 HTTP 200，单条失败在 results[i].ok=false，不拖垮整批）；
 *  - 服务端对 429/5xx/超时已自动重试 2 次，4xx 不重试 ⇒ 客户端只对**整批请求级**的
 *    网络/5xx 失败做指数退避重试，4xx 一律原样抛出；
 *  - 并发硬顶 8：实测 concurrency>8 吞吐反降（过度订阅）；默认 4；
 *  - 无鉴权（密钥由服务端网关注入）——本模块**永不**发送/存储任何 Key；
 *  - `confidence` 是分布置信度，不是正确率；阈值标定属业务层职责（本模块只如实回传）。
 */
import { readString, readInt } from "../utils/env.js";
import { logger } from "../utils/logger.js";

/** 唯一可用模型（服务端只装 multilingual；请求 english/typed-decisions 会 422）。 */
export const LAYA_MODEL = "multilingual";
/** 并发硬顶：实测 8 以上吞吐反降，超值一律钳制（契约第四节）。 */
export const LAYA_MAX_CONCURRENCY_CAP = 8;
/** 单批上限：服务端 413 BATCH_TOO_LARGE，客户端先分块。 */
export const LAYA_BATCH_LIMIT = 500;
/** 批量整体超时（契约：单条 60s、批量 300s）。 */
export const LAYA_SINGLE_TIMEOUT_MS = 60_000;
export const LAYA_BATCH_TIMEOUT_MS = 300_000;

export type LayaQuestionType = "noul" | "choice" | "score";

/** 与契约同形的问题规格（criteria 仅 choice/score 需要，2–50 个去重标签）。 */
export interface LayaQuestionSpec {
  type: LayaQuestionType;
  instructions: string;
  criteria?: string[];
}

export type LayaQuestionMap = Record<string, LayaQuestionSpec>;

/** 单条响应的 answers 值（与 laya-triage 的 LayaAnswer 兼容超集）。 */
export interface LayaHttpAnswer {
  type: LayaQuestionType;
  noul?: number;
  confidence?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  score?: number;
  legend?: Record<string, string>;
}

export interface LayaSingleResponse {
  model: string;
  answers: Record<string, LayaHttpAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  routing: { model: string };
}

export interface LayaBatchItemResult {
  id: string;
  ok: boolean;
  answers?: Record<string, LayaHttpAnswer>;
  error?: string;
  http_status?: number;
  latency_ms?: number;
  attempts?: number;
}

export interface LayaBatchResponse {
  total: number;
  ok: number;
  failed: number;
  elapsed_ms: number;
  qps: number;
  latency_ms: { min: number; p50: number; p95: number; max: number };
  usage: { input_tokens: number };
  results: LayaBatchItemResult[];
}

export interface LayaHttpConfig {
  baseUrl: string;
  model: string;
  maxConcurrency: number;
  singleTimeoutMs: number;
  batchTimeoutMs: number;
  /** 整批请求级重试上限（仅网络/5xx；默认 2，与服务端自重试叠加后仍然保守）。 */
  maxRetries: number;
}

/** 从 env 读配置；未设置 LAYA_DECISION_URL 的调用会 fail loud（不静默降级）。 */
export function getLayaHttpConfig(overrides: Partial<LayaHttpConfig> = {}): LayaHttpConfig {
  const baseUrl = (overrides.baseUrl ?? readString("LAYA_DECISION_URL", "")).replace(/\/+$/, "");
  const requested = overrides.maxConcurrency ?? readInt("LAYA_MAX_CONCURRENCY", 4);
  return {
    baseUrl,
    model: overrides.model ?? readString("LAYA_DECISION_MODEL", LAYA_MODEL),
    maxConcurrency: Math.min(Math.max(1, requested), LAYA_MAX_CONCURRENCY_CAP),
    singleTimeoutMs: overrides.singleTimeoutMs ?? readInt("LAYA_SINGLE_TIMEOUT_MS", LAYA_SINGLE_TIMEOUT_MS),
    batchTimeoutMs: overrides.batchTimeoutMs ?? readInt("LAYA_BATCH_TIMEOUT_MS", LAYA_BATCH_TIMEOUT_MS),
    maxRetries: overrides.maxRetries ?? 2,
  };
}

// ---------------------------------------------------------------------------
// 客户端预校验（对齐契约约束，把 4xx 挡在出门之前）
// ---------------------------------------------------------------------------

function assertQuestions(questions: LayaQuestionMap): void {
  const keys = Object.keys(questions);
  if (keys.length < 1 || keys.length > 50) {
    throw new Error(`Laya 契约：questions 必须 1–50 个（当前 ${keys.length}）`);
  }
  for (const [key, q] of Object.entries(questions)) {
    if (!q || typeof q.instructions !== "string" || q.instructions.length < 1 || q.instructions.length > 2000) {
      throw new Error(`Laya 契约：questions.${key}.instructions 必须 1–2000 字符`);
    }
    if (q.type === "choice" || q.type === "score") {
      const c = q.criteria ?? [];
      const uniq = new Set(c.map((s) => s.replace(/\s+/g, "")));
      if (c.length < 2 || c.length > 50 || uniq.size !== c.length) {
        throw new Error(`Laya 契约：questions.${key}.criteria 必须 2–50 个去空格后不重复的标签`);
      }
    }
  }
}

interface BatchRequestBody {
  items?: Array<{ id: string; state: string; questions: LayaQuestionMap }>;
  states?: string[];
  questions?: LayaQuestionMap;
  concurrency?: number;
  ids?: string[];
  model?: string;
}

// ---------------------------------------------------------------------------
// 核心：单条 / 批量（含分块 + 全局并发闸 + 指数退避）
// ---------------------------------------------------------------------------

function requireBaseUrl(cfg: LayaHttpConfig): string {
  if (!cfg.baseUrl) {
    throw new Error(
      "LAYA_DECISION_URL 未配置：Laya 决策链需要显式提供服务基址（部署拓扑按规则 11 不入库，见 ~/.axiom/axiom-secrets/laya-service.contract.md）",
    );
  }
  return cfg.baseUrl;
}

/** postJson 的结构化错误：retryable 显式携带重试语义，不靠消息文本嗅探（2026-09-28 审核修复 R1）。 */
export class LayaHttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LayaHttpError";
  }
}

async function postJson<T>(url: string, body: unknown, timeoutMs: number, cfg: LayaHttpConfig): Promise<T> {
  let lastErr: Error = new Error("unreached");
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text().catch(() => "");
      // 4xx 除 429 是请求问题：重试无意义，非 retryable 直接抛（契约 §错误处理）。
      if (res.status !== 429 && res.status < 500) {
        throw new LayaHttpError(`Laya HTTP ${res.status}：${text.slice(0, 200)}`, false, res.status);
      }
      throw new LayaHttpError(`Laya HTTP ${res.status}`, true, res.status);
    } catch (err) {
      // LayaHttpError 按自身 retryable 决定去向；网络错误/超时（AbortSignal.timeout）默认可重试。
      if (err instanceof LayaHttpError) {
        if (!err.retryable) throw err;
        lastErr = err;
      } else {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (attempt < cfg.maxRetries) {
      const backoff = 250 * 2 ** attempt + Math.floor(Math.random() * 120);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/** 单条决策（在线路径，60s 超时）。失败抛错，由调用方决定降级语义。 */
export async function layaDecide(
  state: string,
  questions: LayaQuestionMap,
  config: Partial<LayaHttpConfig> = {},
): Promise<LayaSingleResponse> {
  const cfg = getLayaHttpConfig(config);
  const base = requireBaseUrl(cfg);
  assertQuestions(questions);
  return postJson<LayaSingleResponse>(
    `${base}/v1/systemone`,
    { state, questions, model: cfg.model },
    cfg.singleTimeoutMs,
    cfg,
  );
}

export interface LayaBatchInput {
  items: Array<{ id: string; state: string; questions: LayaQuestionMap }>;
}

export interface LayaBatchSummary {
  total: number;
  ok: number;
  failed: number;
  elapsed_ms: number;
  /** 与输入同序、同 id；失败项含 error（逐条容错，不拖垮整批）。 */
  results: LayaBatchItemResult[];
  /** 客户端追加重试（仅 5xx/超时类失败项，一次补跑）的次数。 */
  clientRetried: number;
}

/** 全局并发闸（进程级，**条目粒度**）：跨分块与跨调用共享，保证整机在飞条目不超限。 */
let inflight = 0;
const waiters: Array<() => void> = [];

/**
 * 预留 n 个条目槽位：原子预留 min(n, 剩余额度)，额度不足以整块推进时挂起等待
 * （放行按 waiters FIFO 逐个重查——唤醒者拿到的额度可能已被更早的 waiter 占用）。
 * 大块（n>limit 不可整块预留）独占等待至额度归零后整块推进，条目守恒不超发。
 * 轮 7 审计 H1 语义修正：契约第四节的并发硬顶 8 是**条目**级吞吐上限
 * （服务端实测 >8 反降），闸必须按条目计数，而不是按批请求数。
 */
async function acquireItems(n: number, limit: number): Promise<void> {
  if (n >= limit) {
    // 整块独占：等全部在飞条目退出后再整块推进（避免饿死与拆块复杂化）。
    while (inflight > 0) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    inflight += n;
    return;
  }
  for (;;) {
    if (inflight + n <= limit) {
      inflight += n;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
}

function releaseItems(n: number): void {
  inflight = Math.max(0, inflight - n);
  // 级联唤醒：释放的额度可能连续满足多个排队 waiter（每个醒来自查推进/续眠），
  // 只唤醒一个会让剩余 waiter 空等到下一次 release（慢请求下吞吐浪费）。
  // 轮 8 审计：原 for+shift 双向收敛只唤醒一半 waiter（i++ 与 length-- 在中间相遇），
  // 末尾 waiter 永久挂起 → 死锁。改 while-drain 全唤醒。
  while (waiters.length > 0) {
    const next = waiters.shift();
    if (next) next();
  }
}

/**
 * 批量决策（推荐链路）：自动分块（≤500/块）+ 全局**条目级**并发闸（≤8，契约第四节，
 * 服务端实测 >8 反降）+ 一次失败项补跑（仅 5xx/超时类）。results 与输入**严格同序**。
 */
export async function layaDecideBatch(
  input: LayaBatchInput,
  config: Partial<LayaHttpConfig> = {},
): Promise<LayaBatchSummary> {
  const cfg = getLayaHttpConfig(config);
  const base = requireBaseUrl(cfg);
  const items = input.items;
  if (items.length === 0) {
    return { total: 0, ok: 0, failed: 0, elapsed_ms: 0, results: [], clientRetried: 0 };
  }
  for (const it of items) {
    if (!it.state || !it.questions) throw new Error(`Laya 契约：item ${it.id} 缺 state 或 questions`);
    assertQuestions(it.questions);
  }

  const started = Date.now();
  const chunks: Array<typeof items> = [];
  for (let i = 0; i < items.length; i += LAYA_BATCH_LIMIT) chunks.push(items.slice(i, i + LAYA_BATCH_LIMIT));

  // 并发语义（契约第四节）：条目级全局硬顶 8——acquireItems 按条目预留额度，
  // 跨分块与跨调用共享进程级计数；body.concurrency 同值交付服务端（契约义务）。
  const results: LayaBatchItemResult[] = new Array(items.length);
  let nextChunk = 0;
  const workers = Array.from({ length: Math.min(2, chunks.length) }, async () => {
    while (nextChunk < chunks.length) {
      const chunkIndex = nextChunk++;
      const chunkStart = chunkIndex * LAYA_BATCH_LIMIT;
      const mine = chunks[chunkIndex];
      await acquireItems(mine.length, cfg.maxConcurrency);
      try {
        const body: BatchRequestBody = {
          items: mine.map((m) => ({ id: m.id, state: m.state, questions: m.questions })),
          concurrency: cfg.maxConcurrency,
          model: cfg.model,
        };
        const resp = await postJson<LayaBatchResponse>(
          `${base}/v1/systemone/batch`,
          body,
          cfg.batchTimeoutMs,
          cfg,
        );
        // 服务端 results 与请求 items 严格同序 ⇒ 按块偏移直填，天然保序。
        // 同序不变式：长度与 id 序列双重校验，服务端违约（漏项/错位）fail-loud 而非静默空洞。
        if (resp.results.length !== mine.length || resp.results.some((r, i) => r.id !== mine[i].id)) {
          const got = resp.results.map((r) => r.id).join(",");
          const want = mine.map((m) => m.id).join(",");
          throw new Error(`Laya 契约违约：batch results 与请求不同序/不等长（got=[${got}] want=[${want}]）`);
        }
        resp.results.forEach((r, i) => { results[chunkStart + i] = r; });
      } finally {
        releaseItems(mine.length);
      }
    }
  });
  await Promise.all(workers);

  // 一次失败项补跑：只补 5xx/超时/网络类（4xx 是请求问题，补跑同样失败）。
  // 判定依据 http_status 字段（服务端回填）而非错误文本；无 status = 网络层失败，可补。
  let clientRetried = 0;
  const retryIdx = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => {
      if (!r || r.ok !== false) return false;
      return r.http_status === undefined || r.http_status === null || r.http_status >= 500;
    })
    .map(({ i }) => i);
  if (retryIdx.length > 0) {
    clientRetried = retryIdx.length;
    const redo = retryIdx.map((i) => items[i]);
    const body: BatchRequestBody = {
      items: redo.map((m) => ({ id: m.id, state: m.state, questions: m.questions })),
      concurrency: cfg.maxConcurrency,
      model: cfg.model,
    };
    // N2：补跑与主路径同受条目级并发闸约束（口径一致）。
    await acquireItems(redo.length, cfg.maxConcurrency);
    let resp: LayaBatchResponse;
    try {
      resp = await postJson<LayaBatchResponse>(`${base}/v1/systemone/batch`, body, cfg.batchTimeoutMs, cfg);
    } finally {
      releaseItems(redo.length);
    }
    if (resp.results.length !== redo.length || resp.results.some((r, i) => r.id !== redo[i].id)) {
      throw new Error(`Laya 契约违约：retry results 与请求不同序/不等长`);
    }
    resp.results.forEach((r, i) => { results[retryIdx[i]] = r; });
  }

  const summary: LayaBatchSummary = {
    total: items.length,
    ok: results.filter((r) => r?.ok).length,
    failed: results.filter((r) => r && !r.ok).length,
    elapsed_ms: Date.now() - started,
    results,
    clientRetried,
  };
  if (summary.failed > 0) {
    logger.warn(`[LayaHTTP] batch partial failure: ${summary.failed}/${summary.total}（失败项含 error，不静默丢数据）`);
  }
  return summary;
}

/** 健康探测（启动时一次；GET /health/live ⇒ 200 {"status":"ok"}）。 */
export async function layaHealth(config: Partial<LayaHttpConfig> = {}, timeoutMs = 3000): Promise<boolean> {
  const cfg = getLayaHttpConfig(config);
  if (!cfg.baseUrl) return false;
  try {
    const res = await fetch(`${cfg.baseUrl}/health/live`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}
