/**
 * 基于 Bun TCP 的轻量 Redis 客户端
 *
 * 支持基本的 get/set/del/expire/flushdb 命令
 * 协议: RESP2 (Redis Serialization Protocol)
 *
 * 使用方式:
 *   const redis = await RedisClient.connect("redis://localhost:6379");
 *   await redis.set("key", "value", 60); // TTL 60s
 *   const val = await redis.get("key");
 *   await redis.del("key");
 */

import { logger } from "./logger.js";

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  connectTimeout?: number;
  keyPrefix?: string;
}

export class RedisClient {
  private socket: any | null = null;
  private config: RedisConfig;
  private connected = false;
  // FIFO queue of in-flight commands, in the order they were written to the
  // socket. RESP2 replies arrive strictly in request order on a single
  // connection, so resolving from the front of the queue is correct.
  private pendingQueue: Array<{
    cmdId: number;
    resolve: (val: unknown) => void;
    reject: (err: Error) => void;
  }> = [];
  private cmdId = 0;
  private buffer = "";
  private pushHandler?: (channel: string, message: string) => void;

  constructor(config: RedisConfig) {
    this.config = {
      connectTimeout: 5000,
      keyPrefix: "axiom:",
      ...config,
    };
  }

  static async connect(url?: string): Promise<RedisClient | null> {
    const config = parseRedisUrl(url || process.env.REDIS_URL);
    if (!config) return null;

    const client = new RedisClient(config);
    try {
      await client._connect();
      return client;
    } catch (err) {
      logger.warn("[Redis] Connection failed, falling back to local cache", {
        error: (err as Error).message,
      });
      return null;
    }
  }

  private async _connect(): Promise<void> {
    const { host, port, connectTimeout } = this.config;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Redis connection timeout after ${connectTimeout}ms`));
      }, connectTimeout);

      const socket = (Bun as any).connect({
        hostname: host,
        port: port,
        socket: {
          data: (_socket: any, data: Uint8Array) => {
            this.buffer += new TextDecoder().decode(data);
            this.processBuffer();
          },
          open: (_socket: any) => {
            clearTimeout(timer);
            this.connected = true;
            logger.info("[Redis] Connected", { host, port });
            resolve();
          },
          close: () => {
            this.connected = false;
            logger.warn("[Redis] Connection closed");
          },
          error: (_socket: any, err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        },
      });

      this.socket = socket as any;
    });
  }

  // ---------------------------------------------------------------------------
  // 核心命令
  // ---------------------------------------------------------------------------

  async get(key: string): Promise<string | null> {
    const result = await this.sendCommand("GET", this.prefix(key));
    return result === null ? null : String(result);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.sendCommand("SETEX", this.prefix(key), String(ttlSeconds), value);
    } else {
      await this.sendCommand("SET", this.prefix(key), value);
    }
  }

  async del(key: string): Promise<void> {
    await this.sendCommand("DEL", this.prefix(key));
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.sendCommand("EXISTS", this.prefix(key));
    return result === 1;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.sendCommand("EXPIRE", this.prefix(key), String(seconds));
  }

  async flushdb(): Promise<void> {
    await this.sendCommand("FLUSHDB");
  }

  async ping(): Promise<string> {
    return String(await this.sendCommand("PING"));
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    const prefixed = keys.map((k) => this.prefix(k));
    const result = await this.sendCommand("MGET", ...prefixed);
    if (Array.isArray(result)) {
      return result.map((r) => (r === null ? null : String(r)));
    }
    return keys.map(() => null);
  }

  async mset(entries: Record<string, string>, ttlSeconds?: number): Promise<void> {
    const args: string[] = [];
    for (const [key, value] of Object.entries(entries)) {
      args.push(this.prefix(key), value);
    }
    await this.sendCommand("MSET", ...args);

    if (ttlSeconds) {
      for (const key of Object.keys(entries)) {
        await this.expire(key, ttlSeconds);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pub/Sub
  // ---------------------------------------------------------------------------

  async publish(channel: string, message: string): Promise<number> {
    const result = await this.sendCommand("PUBLISH", channel, message);
    return Number(result) || 0;
  }

  async subscribe(channel: string, handler: (channel: string, message: string) => void): Promise<void> {
    this.pushHandler = handler;
    await this.sendCommand("SUBSCRIBE", channel);
    logger.info("[Redis] Subscribed", { channel });
  }

  // ---------------------------------------------------------------------------
  // 连接状态
  // ---------------------------------------------------------------------------

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    if (this.socket) {
      (this.socket as any).end?.();
      this.socket = null;
    }
    this.connected = false;
  }

  // ---------------------------------------------------------------------------
  // 私有方法 — RESP2 协议
  // ---------------------------------------------------------------------------

  private prefix(key: string): string {
    return `${this.config.keyPrefix}${key}`;
  }

  private async sendCommand(command: string, ...args: string[]): Promise<unknown> {
    if (!this.connected || !this.socket) {
      throw new Error("Redis not connected");
    }

    const cmdId = ++this.cmdId;

    return new Promise((resolve, reject) => {
      this.pendingQueue.push({ cmdId, resolve, reject });

      // 构建 RESP 命令
      const parts = [command, ...args];
      let resp = `*${parts.length}\r\n`;
      for (const part of parts) {
        const encoded = new TextEncoder().encode(part);
        resp += `$${encoded.length}\r\n${part}\r\n`;
      }

      (this.socket as any).write?.(resp);
    });
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const result = this.parseResponse();
      if (result === undefined) break; // 数据不完整，等待更多数据

      // Pub/Sub push message: ["message", channel, payload]
      if (Array.isArray(result)) {
        const cmd = String(result[0]);
        if (cmd === "message" && result.length >= 3) {
          this.pushHandler?.(String(result[1]), String(result[2]));
          continue;
        }
        if (cmd === "subscribe" || cmd === "unsubscribe") {
          continue;
        }
      }

      // Resolve the oldest in-flight command (FIFO — matches RESP2 ordering).
      const pending = this.pendingQueue.shift();
      if (pending) {
        const { resolve, reject } = pending;
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      }
    }
  }

  private parseResponse(): unknown | Error | undefined {
    if (this.buffer.length === 0) return undefined;

    const type = this.buffer[0];

    // 简单字符串 (+)
    if (type === "+") {
      const end = this.buffer.indexOf("\r\n");
      if (end === -1) return undefined;
      const val = this.buffer.slice(1, end);
      this.buffer = this.buffer.slice(end + 2);
      return val;
    }

    // 错误 (-)
    if (type === "-") {
      const end = this.buffer.indexOf("\r\n");
      if (end === -1) return undefined;
      const msg = this.buffer.slice(1, end);
      this.buffer = this.buffer.slice(end + 2);
      return new Error(msg);
    }

    // 整数 (:)
    if (type === ":") {
      const end = this.buffer.indexOf("\r\n");
      if (end === -1) return undefined;
      const val = parseInt(this.buffer.slice(1, end), 10);
      this.buffer = this.buffer.slice(end + 2);
      return val;
    }

    // 批量字符串 ($)
    if (type === "$") {
      const lenEnd = this.buffer.indexOf("\r\n");
      if (lenEnd === -1) return undefined;
      const len = parseInt(this.buffer.slice(1, lenEnd), 10);
      if (len === -1) {
        this.buffer = this.buffer.slice(lenEnd + 2);
        return null;
      }
      if (this.buffer.length < lenEnd + 2 + len + 2) return undefined;
      const val = this.buffer.slice(lenEnd + 2, lenEnd + 2 + len);
      this.buffer = this.buffer.slice(lenEnd + 2 + len + 2);
      return val;
    }

    // 数组 (*)
    if (type === "*") {
      const lenEnd = this.buffer.indexOf("\r\n");
      if (lenEnd === -1) return undefined;
      const count = parseInt(this.buffer.slice(1, lenEnd), 10);
      this.buffer = this.buffer.slice(lenEnd + 2);
      if (count === -1) return null;

      const arr: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const item = this.parseResponse();
        if (item === undefined) {
          // 回滚 — 实际上很难做到，这里简化处理
          return undefined;
        }
        arr.push(item);
      }
      return arr;
    }

    // 未知类型，跳过
    this.buffer = this.buffer.slice(1);
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function parseRedisUrl(url: string | undefined): RedisConfig | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "localhost",
      port: parseInt(parsed.port, 10) || 6379,
      password: parsed.password || undefined,
      db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || undefined : undefined,
    };
  } catch {
    // 尝试 host:port 格式
    const parts = url.split(":");
    if (parts.length === 2) {
      return {
        host: parts[0],
        port: parseInt(parts[1], 10) || 6379,
      };
    }
    return { host: url, port: 6379 };
  }
}

// 全局单例
let globalRedis: RedisClient | null = null;
let redisPromise: Promise<RedisClient | null> | null = null;

export async function getRedisClient(): Promise<RedisClient | null> {
  if (globalRedis?.isConnected()) return globalRedis;
  if (redisPromise) return redisPromise;

  redisPromise = RedisClient.connect();
  globalRedis = await redisPromise;
  return globalRedis;
}

export function disconnectRedis(): void {
  globalRedis?.disconnect();
  globalRedis = null;
  redisPromise = null;
}
