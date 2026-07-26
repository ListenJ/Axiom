/**
 * Axiom Native Bridge v2.3
 * TypeScript ↔ Rust 高性能核心通信层
 *
 * 架构:
 *   - Rust 核心作为 sidecar HTTP 服务运行 (localhost:18790)
 *   - TS 层通过 HTTP/JSON 与 Rust 通信
 *   - 自动降级: Rust 不可用时回退到纯 TS 实现
 *
 * 版本:
 *   - local: 单文件 SQLite, 内存缓存
 *   - cloud: PostgreSQL + Redis, 多节点
 */

import { readString } from "./utils/env.js";
import { logger } from "./utils/logger.js";

export type NativeEdition = "local" | "cloud";

interface NativeConfig {
  edition: NativeEdition;
  port: number;
  vaultPath: string;
  dbPath?: string;
  databaseUrl?: string;
  redisUrl?: string;
  enabled: boolean;
}

let nativeConfig: NativeConfig = {
  edition: "local",
  port: 18790,
  vaultPath: "./axiom-memory",
  dbPath: "./data/agent.db",
  enabled: false,
};

let nativeProcess: Bun.Subprocess | null = null;
let nativeReady = false;

/** 检测当前部署版本 */
export function detectEdition(): NativeEdition {
  const env = readString("AXIOM_EDITION");
  if (env === "cloud") return "cloud";
  if (env === "local") return "local";
  // Auto-detect: cloud if DATABASE_URL or REDIS_URL present
  if (readString("DATABASE_URL", "") || readString("REDIS_URL", "")) return "cloud";
  return "local";
}

/** 初始化 Native Bridge */
export async function initNativeBridge(config?: Partial<NativeConfig>): Promise<boolean> {
  nativeConfig = { ...nativeConfig, ...config, edition: config?.edition ?? detectEdition() };

  if (!nativeConfig.enabled) {
    logger.info("[NativeBridge] Disabled — using pure TypeScript implementation");
    return false;
  }

  const binaryName = nativeConfig.edition === "cloud" ? "axiom-cloud" : "axiom-local";
  const binaryPath = `./native/target/release/${binaryName}`;

  try {
    const { existsSync } = await import("fs");
    if (!existsSync(binaryPath)) {
      logger.warn(`[NativeBridge] Binary not found: ${binaryPath}. Run: cd native && cargo build --release`);
      return false;
    }

    // Start Rust sidecar
    const args = [
      "--port", String(nativeConfig.port),
      "--vault-path", nativeConfig.vaultPath,
      "--log-level", readString("LOG_LEVEL", "info"),
    ];
    if (nativeConfig.edition === "cloud") {
      if (nativeConfig.databaseUrl) args.push("--database-url", nativeConfig.databaseUrl);
      if (nativeConfig.redisUrl) args.push("--redis-url", nativeConfig.redisUrl);
    } else {
      if (nativeConfig.dbPath) args.push("--db-path", nativeConfig.dbPath);
    }

    nativeProcess = Bun.spawn({
      cmd: [binaryPath, ...args],
      stdout: "pipe",
      stderr: "pipe",
      onExit: (_proc, exitCode) => {
        logger.warn(`[NativeBridge] Sidecar exited with code ${exitCode}`);
        nativeReady = false;
      },
    });

    // Wait for health check
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await fetch(`http://127.0.0.1:${nativeConfig.port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) {
          const data = await res.json();
          nativeReady = true;
          logger.info(`[NativeBridge] Rust core ready`, { edition: data.edition, version: data.version });
          return true;
        }
      } catch {
        // continue waiting
      }
    }

    logger.warn("[NativeBridge] Rust core failed to start within timeout");
    return false;
  } catch (e) {
    logger.error("[NativeBridge] Init failed", e as Error);
    return false;
  }
}

/** 调用 Rust 搜索（零向量确定性搜索） */
export async function nativeSearch(
  query: string,
  opts: { limit?: number; tags?: string[]; para?: string } = {}
): Promise<unknown[]> {
  if (!nativeReady) return [];

  try {
    const url = new URL(`http://127.0.0.1:${nativeConfig.port}/native/search`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: opts.limit ?? 10 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results ?? [];
  } catch {
    return [];
  }
}

/** 获取 Rust 路由性能报告 */
export async function nativeRouterPerf(): Promise<unknown> {
  if (!nativeReady) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${nativeConfig.port}/native/router/perf`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Rust sidecar /stats 端点返回的系统状态 */
export interface NativeStats {
  version?: string;
  uptime_secs?: number;
  vault_notes?: number;
  [key: string]: unknown;
}

/** 获取系统状态 */
export async function nativeStats(): Promise<NativeStats | null> {
  if (!nativeReady) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${nativeConfig.port}/stats`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 停止 Native Bridge */
export function stopNativeBridge(): void {
  if (nativeProcess) {
    nativeProcess.kill();
    nativeProcess = null;
  }
  nativeReady = false;
}

/** 是否使用 Rust 核心 */
export function isNativeReady(): boolean {
  return nativeReady;
}

/** 获取当前版本 */
export function getNativeEdition(): NativeEdition {
  return nativeConfig.edition;
}
