/**
 * 工具运行时依赖注入（P2.1，2026-10-22）
 *
 * 背景（本地未覆盖面审计 2026-10-22 #5 / P2-1）：`createToolContext` 每次只给一个空
 * `localStore`；`src/mcp/adapt-tool.ts` 用它给 MCP 适配的 read/write/query 工具建上下文，
 * 于是 queryTool 拿不到 `vaultManager` / `searchEngine`，本地记忆腿与统一搜索腿被
 * **静默跳过**，工具仍返回 success —— 典型「看起来正常、实际没接线」。
 *
 * 本模块把「依赖探测 + 注入」收敛到一处，并给缺失以 **typed reason**
 * （`ToolRuntimeDepReason`），供结构化日志、`/health` 与单测断言：
 *   - 注入失败不是致命错误（工具仍有回退路径），但必须**可见**，不得静默吞掉；
 *   - 同一 reason 每进程只 warn 一次（避免每次调用刷屏），当前状态始终可读。
 *
 * 不新增配置项：依赖加载路径沿用既有全局单例 / 既有模块。
 */
import type { ProgressCallback, ToolContext } from "./types.js";
import { createToolContext } from "./types.js";
import { logger } from "../utils/logger.js";

/** 运行时依赖缺失的机器可读原因码（日志 / health / 测试断言共用）。 */
export type ToolRuntimeDepReason = "vault-unavailable" | "search-engine-unavailable";

export interface ToolRuntimeDepsStatus {
  vault: "ok" | "unavailable";
  searchEngine: "ok" | "unavailable";
  /** 本次探测中不可用的依赖（空数组 = 全部就绪） */
  degraded: ToolRuntimeDepReason[];
  /** 最近一次探测时间（epoch ms；0 = 从未探测） */
  lastCheckedAt: number;
}

/** 依赖加载器注入缝（测试可替换；默认走真实模块）。 */
export interface ToolRuntimeDepsProviders {
  loadVault?: () => Promise<unknown>;
  loadSearchEngine?: () => Promise<unknown>;
}

const DEPENDENCY_NAME: Record<ToolRuntimeDepReason, string> = {
  "vault-unavailable": "vaultManager",
  "search-engine-unavailable": "searchEngine",
};

const EMPTY_STATUS: ToolRuntimeDepsStatus = {
  vault: "unavailable",
  searchEngine: "unavailable",
  degraded: ["vault-unavailable", "search-engine-unavailable"],
  lastCheckedAt: 0,
};

let currentStatus: ToolRuntimeDepsStatus = {
  ...EMPTY_STATUS,
  degraded: [...EMPTY_STATUS.degraded],
};
/** 同一 reason 每进程只提示一次（避免每调用一条 warn） */
const warnedReasons = new Set<ToolRuntimeDepReason>();

async function defaultLoadVault(): Promise<unknown> {
  const { getGlobalVault } = await import("../memory/vault-manager.js");
  return getGlobalVault();
}

/** 统一搜索通道（与 services/knowledge.ts 原注入形态一致：SearXNG > Bing > DDG + 缓存 + 重排）。 */
async function defaultLoadSearchEngine(): Promise<unknown> {
  const { unifiedSearch } = await import("../crawl/unified-search.js");
  return {
    async search(
      query: string,
      opts?: { limit?: number },
    ): Promise<Array<{ title?: string; snippet?: string; content?: string; url?: string; link?: string }>> {
      const results = await unifiedSearch.search({
        query,
        num: opts?.limit ?? 8,
        cacheTtl: 30,
      });
      return results.map((r) => ({
        title: r.title,
        snippet: r.snippet,
        content: r.snippet,
        url: r.link,
        link: r.link,
      }));
    },
  };
}

function warnOnce(reason: ToolRuntimeDepReason, error: unknown, source: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  logger.warn("[tool-runtime] 依赖不可用（已降级，不静默）", {
    code: reason,
    dependency: DEPENDENCY_NAME[reason],
    source,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * 探测并返回当前工具运行时依赖状态；不抛异常（缺依赖是降级而非致命错误）。
 * @param providers 依赖加载器注入缝（测试用；缺省走真实模块）
 * @param source 日志来源标记（startup / context），便于区分启动校验与逐调用探测
 */
export async function probeToolRuntimeDeps(
  providers: ToolRuntimeDepsProviders = {},
  source: "startup" | "context" = "context",
): Promise<{
  status: ToolRuntimeDepsStatus;
  vault: unknown;
  searchEngine: unknown;
}> {
  const loadVault = providers.loadVault ?? defaultLoadVault;
  const loadSearchEngine = providers.loadSearchEngine ?? defaultLoadSearchEngine;

  const degraded: ToolRuntimeDepReason[] = [];
  let vault: unknown;
  let searchEngine: unknown;

  try {
    vault = await loadVault();
    if (!vault) throw new Error("vault loader returned an empty value");
  } catch (e) {
    degraded.push("vault-unavailable");
    warnOnce("vault-unavailable", e, source);
  }

  try {
    searchEngine = await loadSearchEngine();
    if (!searchEngine) throw new Error("search engine loader returned an empty value");
  } catch (e) {
    degraded.push("search-engine-unavailable");
    warnOnce("search-engine-unavailable", e, source);
  }

  currentStatus = {
    vault: degraded.includes("vault-unavailable") ? "unavailable" : "ok",
    searchEngine: degraded.includes("search-engine-unavailable") ? "unavailable" : "ok",
    degraded,
    lastCheckedAt: Date.now(),
  };

  return { status: { ...currentStatus, degraded: [...currentStatus.degraded] }, vault, searchEngine };
}

/** 最近一次探测状态（供 `/health` 与测试读取；未探测时返回全 unavailable + lastCheckedAt=0）。 */
export function getToolRuntimeDepsStatus(): ToolRuntimeDepsStatus {
  return { ...currentStatus, degraded: [...currentStatus.degraded] };
}

/** 测试接缝：重置 warn-once 标记与状态，避免用例间相互污染。 */
export function resetToolRuntimeDepsForTests(): void {
  warnedReasons.clear();
  currentStatus = { ...EMPTY_STATUS, degraded: [...EMPTY_STATUS.degraded] };
}

/**
 * 创建带运行时依赖的工具上下文：把探测到的 vaultManager / searchEngine 注入 localStore，
 * 并把 typed 降级原因（`runtimeDepsStatus`）一并放入，供工具在输出中如实标注。
 */
export async function createInjectedToolContext(
  requestId?: string,
  opts?: {
    providers?: ToolRuntimeDepsProviders;
    source?: "startup" | "context";
    maxMemoryBytes?: number;
    maxCpuMs?: number;
    onProgress?: ProgressCallback;
  },
): Promise<{ context: ToolContext; status: ToolRuntimeDepsStatus }> {
  const { status, vault, searchEngine } = await probeToolRuntimeDeps(
    opts?.providers ?? {},
    opts?.source ?? "context",
  );
  const context = createToolContext(
    requestId,
    opts?.maxMemoryBytes,
    opts?.maxCpuMs,
    opts?.onProgress,
  );
  if (vault) context.localStore.set("vaultManager", vault);
  if (searchEngine) context.localStore.set("searchEngine", searchEngine);
  context.localStore.set("runtimeDepsStatus", status);
  return { context, status };
}
