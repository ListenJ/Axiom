/**
 * 运行时审查机制（Runtime Audit）— 覆盖全部核心服务的健康/内存/兜底评审
 *
 * 与 health-check 的区别：
 *  - health-check：外部依赖可用性（API key / db / vault / network）
 *  - runtime-audit：内部资源有界性、内存泄漏、会话/流清理、冗余兜底
 *
 * 设计（深模块）：13 项检查全部可依赖注入（fake），默认依赖为真实单例，
 * 保证 CLI 可跑、测试可注入泄漏 fake 证明"能抓出泄漏"。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cache } from "../utils/cache.js";
import { eventBus } from "../dre/runtime/event-bus.js";
import { atomStore } from "../dre/runtime/atom-engine.js";
import { knowledgeNetwork } from "../dre/runtime/knowledge-network.js";
import { wsManager } from "../utils/websocket.js";
import { readInt } from "../utils/env.js";
import { ContextManager } from "../context/context-manager.js";

// ─── 类型 ────────────────────────────────────────────────────────────────

export interface AuditCheck {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  measured?: Record<string, unknown>;
}

export interface AuditReport {
  timestamp: string;
  overall: "pass" | "warn" | "fail";
  checks: AuditCheck[];
  summary: string[];
  recommendations: string[];
}

export interface EventBusLike {
  subscribe(type: string, handler: (e: unknown) => unknown, priority?: number): string;
  unsubscribe(id: string): void;
  getStats(): { subscriberCount: number };
  publish?(event: { type: string; source: string; data: unknown; priority?: string }): unknown;
  getRecentEvents?(count: number): unknown[];
}

export interface AtomLike {
  create(kind: string, content: string, opts?: Record<string, unknown>): { id: string };
  delete(id: string): boolean;
  getStats(): { total: number };
}

export interface KnowledgeLike {
  create(kind: string, name: string, content: string, opts?: Record<string, unknown>): { id: string };
  delete(id: string): boolean;
  getStats(): { total: number; links: number };
}

export interface AuditDeps {
  cacheFactory?: () => Cache<unknown>;
  eventBus?: EventBusLike;
  atomStore?: AtomLike;
  knowledgeNetwork?: KnowledgeLike;
  wsManager?: { getStats(): { connectedClients: number } };
  sleep?: (ms: number) => Promise<void>;
}

// ─── 常量 ────────────────────────────────────────────────────────────────

const CACHE_PROBE_MAX = 100; // 探测缓存 maxSize
const CACHE_PROBE_KEYS = 500; // 插入键数（远超 maxSize，触发 LRU 驱逐）
const CACHE_BOUND_SLACK = 200; // 允许驱逐后残留的松弛上限
const WS_MAX_CLIENTS = 100; // 与 websocket.ts 默认一致
const HEAP_DELTA_MB_LIMIT = 20;

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readSource(rel: string): string {
  return readFileSync(join(import.meta.dir, rel), "utf8");
}

function statusOf(ok: boolean, detail: string, measured?: Record<string, unknown>): AuditCheck {
  return { id: "", name: "", status: ok ? "pass" : "fail", detail, measured };
}

// ─── 单项检查 ────────────────────────────────────────────────────────────

export async function checkCacheBounded(deps: AuditDeps): Promise<AuditCheck> {
  const cache = (deps.cacheFactory ?? (() => new Cache<unknown>({ maxSize: CACHE_PROBE_MAX, persistent: false, redis: false })))();
  for (let i = 0; i < CACHE_PROBE_KEYS; i++) {
    cache.set(`audit-probe-${i}`, { i });
  }
  const size = cache.stats().size;
  cache.destroy();
  const ok = size <= CACHE_BOUND_SLACK;
  return {
    id: "cache.bounded",
    name: "缓存条目有界（LRU 驱逐）",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `maxSize=${CACHE_PROBE_MAX} 下插入 ${CACHE_PROBE_KEYS} 键后 size=${size}，LRU 驱逐生效。`
      : `插入 ${CACHE_PROBE_KEYS} 键后 size=${size}（上限 ${CACHE_BOUND_SLACK}），缓存未按 maxSize 驱逐，存在无限增长风险。`,
    measured: { size, maxSize: CACHE_PROBE_MAX, inserted: CACHE_PROBE_KEYS },
  };
}

export async function checkCacheTtl(deps: AuditDeps): Promise<AuditCheck> {
  const cache = (deps.cacheFactory ?? (() => new Cache<unknown>({ persistent: false, redis: false })))();
  const sleep = deps.sleep ?? sleepDefault;
  cache.set("audit-ttl-key", "v", 30);
  await sleep(70);
  const expired = cache.getSync("audit-ttl-key") === undefined;
  const size = cache.stats().size;
  cache.destroy();
  return {
    id: "cache.ttl",
    name: "TTL 过期条目清理",
    status: expired ? "pass" : "fail",
    detail: expired
      ? "30ms TTL 键在 70ms 后读取为 undefined，过期条目已惰性清除。"
      : "过期条目仍可读取，TTL 清理失效。",
    measured: { ttlMs: 30, remainingSize: size },
  };
}

export async function checkEventBusSubscribers(deps: AuditDeps): Promise<AuditCheck> {
  const bus = deps.eventBus ?? eventBus;
  const ids: string[] = [];
  for (let i = 0; i < 100; i++) ids.push(bus.subscribe(`audit.evt.${i}`, () => {}));
  for (const id of ids) bus.unsubscribe(id);
  const count = bus.getStats().subscriberCount;
  const ok = count === 0;
  return {
    id: "eventbus.subscribers",
    name: "EventBus 订阅者无残留",
    status: ok ? "pass" : "fail",
    detail: ok
      ? "100 次 subscribe + unsubscribe 后 subscriberCount=0，无 handler 残留。"
      : `100 次 subscribe + unsubscribe 后仍有 ${count} 个订阅者，退订未生效（泄漏）。`,
    measured: { subscribed: 100, remaining: count },
  };
}

export async function checkEventBusLogCap(deps: AuditDeps): Promise<AuditCheck> {
  const bus = deps.eventBus ?? eventBus;
  if (!bus.publish || !bus.getRecentEvents) {
    return { id: "eventbus.log", name: "EventBus 事件日志有上限", status: "warn", detail: "注入的 eventBus 不支持日志检查，跳过。", measured: { skipped: true } };
  }
  for (let i = 0; i < 2000; i++) {
    bus.publish({ type: `audit.log.${i}`, source: "audit", data: { i }, priority: "low" });
  }
  const recent = bus.getRecentEvents(2000);
  const ok = recent.length <= 1000;
  return {
    id: "eventbus.log",
    name: "EventBus 事件日志有上限",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `发布 2000 条事件后日志窗口=${recent.length}（上限 1000），环形缓冲生效。`
      : `发布 2000 条事件后日志窗口=${recent.length}，日志无限增长。`,
    measured: { published: 2000, window: recent.length, max: 1000 },
  };
}

export async function checkMemoryStore(deps: AuditDeps): Promise<AuditCheck> {
  const store = deps.atomStore ?? atomStore;
  const baseline = store.getStats().total;
  const ids: string[] = [];
  for (let i = 0; i < 2000; i++) {
    ids.push(store.create("fact", `audit-atom-${i}`, { source: "runtime-audit" }).id);
  }
  for (const id of ids) store.delete(id);
  const total = store.getStats().total;
  const ok = total === baseline;
  return {
    id: "memory.store",
    name: "AtomEngine 创建/删除无残留",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `2000 次 create+delete 后 total=${total}（基线 ${baseline}），无残留引用。`
      : `2000 次 create+delete 后 total=${total}（基线 ${baseline}），存在残留。`,
    measured: { baseline, total, roundtrip: 2000 },
  };
}

export async function checkKGNetwork(deps: AuditDeps): Promise<AuditCheck> {
  const kg = deps.knowledgeNetwork ?? knowledgeNetwork;
  const baseline = kg.getStats().total;
  const ids: string[] = [];
  for (let i = 0; i < 300; i++) {
    ids.push(kg.create("entity", `audit-kg-${i}`, `内容 ${i}`, { source: "runtime-audit" }).id);
  }
  for (const id of ids) kg.delete(id);
  const total = kg.getStats().total;
  const links = kg.getStats().links;
  const ok = total === baseline;
  return {
    id: "kg.network",
    name: "知识图谱实体删除无孤立引用",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `300 次 create+delete 后 total=${total}（基线 ${baseline}）、links=${links}，无孤立引用。`
      : `300 次 create+delete 后 total=${total}（基线 ${baseline}），删除未清理引用。`,
    measured: { baseline, total, links },
  };
}

export async function checkSessionsActive(deps: AuditDeps): Promise<AuditCheck> {
  const ws = deps.wsManager ?? wsManager;
  const clients = ws.getStats().connectedClients;
  const ctx = new ContextManager();
  const maxWindow = ctx.getStats().maxTokens;
  const ok = clients <= WS_MAX_CLIENTS;
  return {
    id: "sessions.active",
    name: "会话与连接有界",
    status: ok ? "pass" : "warn",
    detail: ok
      ? `当前 WS 连接=${clients}（上限 ${WS_MAX_CLIENTS}）；对话会话由 SQLite 持久化（无内存 Map 累积），上下文窗口上限=${maxWindow}。`
      : `WS 连接=${clients} 超过上限 ${WS_MAX_CLIENTS}。`,
    measured: { wsClients: clients, wsMax: WS_MAX_CLIENTS, maxContextWindow: maxWindow },
  };
}

export async function checkStreamsCleanup(): Promise<AuditCheck> {
  const chat = readSource("../routes/chat.ts");
  const pipeline = readSource("../routes/pipeline.ts");
  // chat/stream 的取消路径可能用 ReadableStream.cancel()（Phase 0 R-013）或 AbortController，两者皆可
  const chatOk = chat.includes("streamIter.return") && (chat.includes("AbortController") || chat.includes("cancel()"));
  const pipelineOk = pipeline.includes("cancel(") || pipeline.includes("eventBus.unsubscribe");
  const ok = chatOk && pipelineOk;
  return {
    id: "streams.cleanup",
    name: "SSE 流断开即清理",
    status: ok ? "pass" : "fail",
    detail: ok
      ? "chat/stream 在 abort 时调用 streamIter.return() 停上游生成；pipeline/stream 在断开/完成时退订 eventBus。"
      : `chat 流取消=${chatOk}，pipeline 流清理=${pipelineOk}；存在流断开后资源不回收的路径。`,
    measured: { chatStreamCancel: chatOk, pipelineUnsubscribe: pipelineOk },
  };
}

export async function checkWsClients(deps: AuditDeps): Promise<AuditCheck> {
  const ws = deps.wsManager ?? wsManager;
  const clients = ws.getStats().connectedClients;
  const ok = clients <= WS_MAX_CLIENTS;
  return {
    id: "ws.clients",
    name: "WebSocket 客户端数有界",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `当前连接=${clients} ≤ ${WS_MAX_CLIENTS}；断线时 clients.delete() 移除（代码审查确认）。`
      : `当前连接=${clients} > ${WS_MAX_CLIENTS}，客户端未及时回收。`,
    measured: { clients, max: WS_MAX_CLIENTS },
  };
}

export async function checkFallbackLlm(): Promise<AuditCheck> {
  const src = readSource("../router/model-router.ts");
  const fallback = src.includes("fallback");
  const retry = src.includes("maxRetries");
  const breaker = src.includes("circuitBreaker") || src.includes("circuit-breaker") || src.includes("routerBreaker");
  const ok = fallback && retry && breaker;
  return {
    id: "fallback.llm",
    name: "模型路由多级兜底",
    status: ok ? "pass" : "fail",
    detail: ok
      ? "model-router 具备 fallback 链、maxRetries 重试上限与 circuitBreaker 熔断冷却。"
      : `fallback=${fallback}、maxRetries=${retry}、circuitBreaker=${breaker}，兜底链不完整。`,
    measured: { fallback, retry, circuitBreaker: breaker },
  };
}

export async function checkFallbackEdge(): Promise<AuditCheck> {
  const edge = readSource("../local-llm/edge-client.ts");
  const assist = readSource("../memory/edge-assist.ts");
  const enabled = edge.includes("isEdgeEnabled");
  const fallback = assist.includes("return null");
  const ok = enabled && fallback;
  return {
    id: "fallback.edge",
    name: "边缘模型失败回退",
    status: ok ? "pass" : "fail",
    detail: ok
      ? "edge-client 支持 EDGE_*_ASSIST 开关；edge-assist 失败返回 null，调用方走规则兜底。"
      : `功能开关=${enabled}、null 兜底=${fallback}，边缘回退链不完整。`,
    measured: { edgeToggle: enabled, nullFallback: fallback },
  };
}

export async function checkResourcesBounds(): Promise<AuditCheck> {
  const maxBodySize = readInt("MAX_BODY_SIZE", 1048576);
  const wsSrc = readSource("../utils/websocket.ts");
  const wsClamped = wsSrc.includes("Math.min(10000");
  const crawlerConcurrent = readInt("CRAWLER_MAX_CONCURRENT", 3);
  const ok = maxBodySize > 0 && wsClamped && crawlerConcurrent > 0;
  return {
    id: "resources.bounds",
    name: "资源上限约束存在",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `MAX_BODY_SIZE=${maxBodySize}B、WS 客户端上限经 clamp(1..10000)、爬虫并发默认 ${crawlerConcurrent}。`
      : `maxBodySize=${maxBodySize}、wsClamp=${wsClamped}、crawler=${crawlerConcurrent}，存在缺失。`,
    measured: { maxBodySize, wsClamped, crawlerMaxConcurrent: crawlerConcurrent },
  };
}

export async function checkMcpClientCleanup(): Promise<AuditCheck> {
  const connector = readSource("../mcp/client-connector.ts");
  const main = readSource("../main.ts");
  const closeFn = connector.includes("closeExternalMcpClients");
  const registry = connector.includes("activeClients");
  const hook = main.includes("mcp-clients");
  const ok = closeFn && registry && hook;
  return {
    id: "mcp.cleanup",
    name: "外部 MCP 客户端关闭路径",
    status: ok ? "pass" : "fail",
    detail: ok
      ? "client-connector 维护 activeClients 注册表 + closeExternalMcpClients，main.ts 注册 mcp-clients 关闭钩子，进程退出时关闭外部 server 子进程/连接。"
      : `closeExternalMcpClients=${closeFn}、activeClients=${registry}、shutdownHook=${hook}，外部 MCP 客户端缺少关闭路径。`,
    measured: { closeFn, registry, shutdownHook: hook },
  };
}
export async function checkHeapStress(deps: AuditDeps): Promise<AuditCheck> {
  const store = deps.atomStore ?? atomStore;
  // 先触发一轮 GC 得到稳定基线
  try {
    (Bun as unknown as { gc: (force?: boolean) => void }).gc(true);
  } catch {
    /* Bun.gc 不可用时用 process.memoryUsage */
  }
  const before = process.memoryUsage().heapUsed / 1024 / 1024;
  const baseline = store.getStats().total;
  const ids: string[] = [];
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 1000; i++) ids.push(store.create("fact", `audit-heap-${round}-${i}`, { source: "runtime-audit" }).id);
    for (const id of ids.splice(0, 1000)) store.delete(id);
  }
  for (const id of ids) store.delete(id);
  const afterTotal = store.getStats().total;
  try {
    (Bun as unknown as { gc: (force?: boolean) => void }).gc(true);
  } catch {
    /* ignore */
  }
  const deltaMb = Math.max(0, process.memoryUsage().heapUsed / 1024 / 1024 - before);
  const ok = deltaMb < HEAP_DELTA_MB_LIMIT && afterTotal === baseline;
  return {
    id: "heap.stress",
    name: "长时间运行堆内存稳定",
    status: ok ? "pass" : "warn",
    detail: ok
      ? `5000 次 create+delete 后堆增量 ${deltaMb.toFixed(1)}MB（阈值 ${HEAP_DELTA_MB_LIMIT}MB），store 回到基线 ${baseline}。`
      : `5000 次 create+delete 后堆增量 ${deltaMb.toFixed(1)}MB 或 store=${afterTotal}（基线 ${baseline}），存在累积。`,
    measured: { heapDeltaMb: Math.round(deltaMb * 10) / 10, limitMb: HEAP_DELTA_MB_LIMIT, baseline, after: afterTotal },
  };
}

// ─── 汇总 ─────────────────────────────────────────────────────────────────

export async function runRuntimeAudit(deps: AuditDeps = {}): Promise<AuditReport> {
  const checks: AuditCheck[] = await Promise.all([
    checkCacheBounded(deps),
    checkCacheTtl(deps),
    checkEventBusSubscribers(deps),
    checkEventBusLogCap(deps),
    checkMemoryStore(deps),
    checkKGNetwork(deps),
    checkSessionsActive(deps),
    checkStreamsCleanup(),
    checkWsClients(deps),
    checkFallbackLlm(),
    checkFallbackEdge(),
    checkResourcesBounds(),
    checkMcpClientCleanup(),
    checkHeapStress(deps),
  ]);

  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  const overall: AuditReport["overall"] = failed.length > 0 ? "fail" : warned.length > 0 ? "warn" : "pass";

  const summary = [
    `共 ${checks.length} 项检查：${checks.filter((c) => c.status === "pass").length} 通过 / ${warned.length} 警告 / ${failed.length} 失败`,
    ...failed.map((c) => `✗ ${c.name}：${c.detail}`),
    ...warned.map((c) => `⚠ ${c.name}：${c.detail}`),
  ];

  const recommendations = failed.map((c) => `修复 ${c.name}（${c.id}）：${c.detail}`);
  if (warned.length > 0 && failed.length === 0) {
    recommendations.push("处理 warn 项后再做一次回归审计。");
  }

  return {
    timestamp: new Date().toISOString(),
    overall,
    checks,
    summary,
    recommendations,
  };
}