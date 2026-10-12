/**
 * DRE Daemon 客户端 —— 非拥有者进程访问唯一 Kernel 的入口（内核收敛 Step 2）。
 *
 * 决策：唯一 Kernel 拥有者 = DRE daemon。主服务 / MCP 不再 `new Kernel`，改为经本客户端
 * 访问 daemon 的 HTTP 面（端口协议 / 管道运行 / 状态 / 事件流）。
 *
 * 配置：`AXIOM_DRE_DAEMON_URL`（默认 http://127.0.0.1:18790）；`AXIOM_DRE_DAEMON_TOKEN`（可选）。
 */
import type { PortRequest, PortResponse } from "../dre/port/types.js";
import { readString } from "../utils/env.js";

export interface DreDaemonClientOptions {
  baseUrl?: string;
  token?: string;
  /** 单请求超时（ms），默认 30000；事件流不受此限 */
  timeoutMs?: number;
}

export class DreDaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DreDaemonUnavailableError";
  }
}

export class DreDaemonClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: DreDaemonClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? readString("AXIOM_DRE_DAEMON_URL", "http://127.0.0.1:18790")).replace(/\/$/, "");
    this.token = opts.token ?? readString("AXIOM_DRE_DAEMON_TOKEN", "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get url(): string {
    return this.baseUrl;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h["x-axiom-token"] = this.token;
    return h;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, { method: "GET", headers: this.headers() });
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } catch (err) {
      throw new DreDaemonUnavailableError(`DRE daemon unreachable at ${this.baseUrl}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ ok: boolean; state: string; uptime: number }> {
    return this.getJson("/health");
  }

  async status<T = unknown>(): Promise<{ ok: boolean; status: T }> {
    return this.getJson("/dre/status");
  }

  async cognitiveState<T = unknown>(): Promise<{ ok: boolean; state: T }> {
    return this.getJson("/dre/cognitive-state");
  }

  /** 端口协议调用（knowledge.* 等） */
  async port<T = unknown>(req: PortRequest): Promise<PortResponse<T>> {
    return this.postJson<PortResponse<T>>("/api/port", req);
  }

  /** 运行纯确定性认知管道 */
  async run(input: string): Promise<{ ok: boolean; [k: string]: unknown }> {
    return this.postJson("/dre/run", { input });
  }

  /** DRE 确定性检索（知识图谱段）；失败返回 null（调用方静默降级） */
  async retrieve<T = unknown>(query: string, limit?: number): Promise<T | null> {
    try {
      const res = await this.postJson<{ ok: boolean; result?: T }>("/dre/retrieve", { query, limit });
      return res.ok ? (res.result ?? null) : null;
    } catch {
      return null;
    }
  }

  /** 事件流（SSE）——返回上游 Response，调用方负责转发 body */
  async openEvents(): Promise<Response> {
    try {
      // 建连阶段受 timeoutMs 保护（轮 7 审计：裸 fetch 在 daemon 端口假死/半开时
      // 无限挂起；读流阶段本就不受 timeoutMs 限制，语义不变）。
      return await fetch(`${this.baseUrl}/events`, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DreDaemonUnavailableError(`DRE daemon events unreachable at ${this.baseUrl}: ${(err as Error).message}`);
    }
  }
}

/** 便捷构造（复用 env 配置） */
export function createDreDaemonClient(opts?: DreDaemonClientOptions): DreDaemonClient {
  return new DreDaemonClient(opts);
}
