/**
 * ModelOutputStore — 将模型/API 调用的输出与执行过程持久化到磁盘
 *
 * 设计目标：
 *   - 消除上下文依赖：LLM 响应不再仅存于内存/上下文，而是落盘可检索
 *   - 数据完整性：每次调用产生一个独立 JSON 文件，写入失败不影响主流程
 *   - 高效检索：按日期/提供商/模型分目录，文件名含请求 hash 便于反查
 *   - 非阻塞：异步写入，不阻塞 LLM 调用主路径
 *
 * 存储布局：
 *   data/model-outputs/YYYY-MM-DD/{provider}-{model}-{timestamp}-{shortHash}.json
 *
 * 每个 JSON 文件包含：
 *   - meta: timestamp / provider / model / latencyMs / success
 *   - request: prompt（截断到 2000 字）/ system / messages 摘要
 *   - response: content / usage / finishReason
 *   - error（若失败）: message / stack
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { logger } from "./logger.js";
import { readString } from "./env.js";

/** 持久化记录结构 */
export interface PersistedModelOutput {
  meta: {
    timestamp: number;
    provider: string;
    model: string;
    latencyMs: number;
    success: boolean;
    requestHash: string;
  };
  request: {
    prompt: string;          // 截断到 2000 字
    system?: string;         // 截断到 1000 字
    messageCount: number;
    totalChars: number;
    temperature?: number;
  };
  response?: {
    content: string | null;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    finishReason?: string;
  };
  error?: {
    message: string;
    stack?: string;
  };
}

/** 写入结果 */
export interface PersistResult {
  filePath: string;
  success: boolean;
}

const MAX_PROMPT_CHARS = 2000;
const MAX_SYSTEM_CHARS = 1000;

export class ModelOutputStore {
  private readonly baseDir: string;
  private readonly enabled: boolean;
  private writeQueue: Promise<void> = Promise.resolve();
  private fileCounter = 0;
  private readonly autoPurgeEnabled: boolean;
  private readonly autoPurgeIntervalMs: number;
  private readonly purgeMaxAgeDays: number;
  private lastAutoPurgeAt = 0;

  constructor(opts?: {
    baseDir?: string;
    enabled?: boolean;
    autoPurge?: boolean;
    autoPurgeIntervalMs?: number;
    purgeMaxAgeDays?: number;
  }) {
    this.baseDir = opts?.baseDir ?? "data/model-outputs";
    this.enabled = opts?.enabled ?? true;
    this.autoPurgeEnabled = opts?.autoPurge ?? true;
    this.autoPurgeIntervalMs = opts?.autoPurgeIntervalMs ?? 24 * 60 * 60 * 1000;
    this.purgeMaxAgeDays = opts?.purgeMaxAgeDays ?? 30;
    if (this.enabled) {
      this.ensureDir(this.baseDir);
    }
  }

  /**
   * 持久化一次模型调用的输出。非阻塞——写入在后台队列执行，
   * 调用方无需 await 即可继续主流程。
   *
   * 返回文件路径（写入完成后文件存在），写入失败仅记录日志不抛异常。
   */
  persist(entry: {
    provider: string;
    model: string;
    prompt: string;
    system?: string;
    messages?: Array<{ content?: string }>;
    temperature?: number;
    latencyMs: number;
    success: boolean;
    response?: {
      content: string | null;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      finishReason?: string;
    };
    error?: Error;
  }): PersistResult {
    if (!this.enabled) {
      return { filePath: "", success: false };
    }

    const timestamp = Date.now();
    const requestHash = this.hashRequest(entry.prompt, entry.system, entry.messages);
    const dateStr = new Date(timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
    const dir = path.join(this.baseDir, dateStr);

    const safeProvider = this.sanitize(entry.provider);
    const safeModel = this.sanitize(entry.model);
    const shortHash = requestHash.slice(0, 8);
    const counter = this.fileCounter++;
    const fileName = `${safeProvider}-${safeModel}-${timestamp}-${shortHash}-${counter}.json`;
    const filePath = path.join(dir, fileName);

    const record: PersistedModelOutput = {
      meta: {
        timestamp,
        provider: entry.provider,
        model: entry.model,
        latencyMs: entry.latencyMs,
        success: entry.success,
        requestHash,
      },
      request: {
        prompt: entry.prompt.slice(0, MAX_PROMPT_CHARS),
        ...(entry.system ? { system: entry.system.slice(0, MAX_SYSTEM_CHARS) } : {}),
        messageCount: entry.messages?.length ?? 1,
        totalChars: entry.messages?.reduce((s, m) => s + (m.content?.length ?? 0), 0) ?? entry.prompt.length,
        ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
      },
      ...(entry.response ? { response: entry.response } : {}),
      ...(entry.error ? {
        error: {
          message: entry.error.message,
          ...(entry.error.stack ? { stack: entry.error.stack } : {}),
        },
      } : {}),
    };

    // 串行化写入避免同目录并发 fs 调用（fs 在 Windows 上对并发 createWriteStream
    // 不友好，串行化更可靠且对性能影响可忽略——写入是后台异步的）。
    this.writeQueue = this.writeQueue
      .then(() => this.writeJson(filePath, record))
      .catch(() => { /* 错误已在 writeJson 内记录，不阻塞队列 */ });

    this.maybeAutoPurge();
    return { filePath, success: true };
  }

  /**
   * 按日期范围检索持久化记录。返回文件路径列表。
   */
  listByDate(startDate: string, endDate: string): string[] {
    const results: string[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return results;
    }

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const dir = path.join(this.baseDir, dateStr);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
      results.push(...files.map(f => path.join(dir, f)));
    }
    return results;
  }

  /**
   * 读取一个持久化记录。
   */
  read(filePath: string): PersistedModelOutput | null {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as PersistedModelOutput;
    } catch {
      return null;
    }
  }

  /**
   * 按请求 hash 检索（线性扫描，适用于低频反查场景）。
   */
  findByRequestHash(requestHash: string, dateStr?: string): PersistedModelOutput | null {
    const dirs = dateStr
      ? [path.join(this.baseDir, dateStr)]
      : fs.existsSync(this.baseDir)
        ? fs.readdirSync(this.baseDir).map(d => path.join(this.baseDir, d))
        : [];

    for (const dir of dirs) {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const record = this.read(path.join(dir, f));
        if (record?.meta.requestHash === requestHash) return record;
      }
    }
    return null;
  }

  /**
   * 清理超过 maxAgeDays 天的记录。
   */
  purgeOld(maxAgeDays: number): { deleted: number; errors: number } {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    let errors = 0;

    if (!fs.existsSync(this.baseDir)) return { deleted, errors };

    const dateDirs = fs.readdirSync(this.baseDir);
    for (const d of dateDirs) {
      const dir = path.join(this.baseDir, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const fp = path.join(dir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(fp);
            deleted++;
          }
        } catch {
          errors++;
        }
      }
      // 如果目录已空，删除目录
      try {
        if (fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
      } catch {
        // 忽略
      }
    }
    if (deleted > 0) {
      logger.info("[ModelOutputStore] purged old records", { deleted, errors, maxAgeDays });
    }
    return { deleted, errors };
  }

  /** 计算请求 hash（用于去重与反查） */
  /** 低频自动清理过期模型输出（默认 24h 一次、保留 30 天）。 */
  private maybeAutoPurge(): void {
    if (!this.autoPurgeEnabled) return;
    const now = Date.now();
    if (now - this.lastAutoPurgeAt < this.autoPurgeIntervalMs) return;
    this.lastAutoPurgeAt = now;
    try {
      this.purgeOld(this.purgeMaxAgeDays);
    } catch {
      // 清理失败不影响主流程
    }
  }

  private hashRequest(prompt: string, system?: string, messages?: Array<{ content?: string }>): string {
    const h = createHash("sha256");
    h.update(prompt);
    if (system) h.update(system);
    if (messages) {
      for (const m of messages) {
        h.update(m.content ?? "");
      }
    }
    return h.digest("hex");
  }

  private sanitize(s: string): string {
    return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async writeJson(filePath: string, record: PersistedModelOutput): Promise<void> {
    const dir = path.dirname(filePath);
    this.ensureDir(dir);
    const tmpPath = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      // 写入失败不影响主流程，仅记录
      try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
      if (this.fileCounter % 100 === 0) {
        // 每 100 次失败才记录一次日志，避免日志刷屏
        logger.warn("[ModelOutputStore] write failed", {
          error: e instanceof Error ? e : new Error(String(e)),
          filePath,
        });
      }
    }
  }
}

/** 全局单例 */
let _instance: ModelOutputStore | null = null;

export function getModelOutputStore(): ModelOutputStore {
  if (!_instance) {
    _instance = new ModelOutputStore({
      enabled: readString("MODEL_OUTPUT_PERSIST") !== "0",
    });
  }
  return _instance;
}

/** 测试用：重置单例 */
export function _resetModelOutputStoreForTest(): void {
  _instance = null;
}
