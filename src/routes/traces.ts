/**
 * 轨迹读取面（A5，2026-09-20）
 *
 * ## 为什么不是"读内存里那张表"就够了
 * `src/utils/agent-trace.ts` 的内存表在 `completeTrace/failTrace` 时**主动删除**条目
 * （B3-Medium 修复：防长进程内无界增长，且**有测试锁定**，见 tests/agent-trace-bounded.test.ts）。
 * 故对**已完成**的任务，`getTrace(id)` 必然返回 null —— 旧实现因此对已完成任务一律 404。
 *
 * ## A5 的做法：按 **taskId** 把三方数据拼起来
 *  1. **内存轨迹**（`agent-trace`）：仅**运行中**任务有 `steps`；
 *  2. **落盘轨迹**（`agent-evals/real-usage` 的 JSONL）：已完成任务的**任务级**信息
 *     （task/success/timestamp/sessionId/source），受 A3 保留策略约束；
 *  3. **token 用量**（`router/token-tracker` 的 SQLite）：**按 category 聚合**，由 A4 贯通、
 *     与上面两者**共用同一个 taskId** —— 这是本条读取面成立的前提。
 *
 * 三者**都不存在**才返回 404；只要任一方有数据就组装返回，并在响应中如实标注来源。
 */
import type { RouteContext } from "./types.js";

/** 列表项：内存与落盘两种来源的公共形状（用 source 标明来自哪一侧） */
interface TraceListEntry {
  id: string;
  source: "in-memory" | "jsonl";
  [k: string]: unknown;
}

export async function handleTraceList(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/traces" || ctx.req.method !== "GET") return null;

  const rawLimit = Number(ctx.url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.floor(rawLimit), 200)) : 50;

  const { getAllTraces } = await import("../utils/agent-trace.js");
  const { loadRecentTraces } = await import("../agent-evals/real-usage.js");
  const { getTokenTracker } = await import("../router/token-tracker.js");

  const running = getAllTraces(limit);
  const persisted = await loadRecentTraces(limit);

  // 合并：同一 id 以"运行中"为准（它带 steps）；两侧各自保序
  const entries = new Map<string, TraceListEntry>();
  for (const t of running) {
    entries.set(t.taskId, {
      id: t.taskId,
      source: "in-memory",
      status: t.status,
      agentName: t.agentName,
      startTime: t.startTime,
      steps: t.steps.length,
    });
  }
  for (const p of persisted) {
    if (entries.has(p.id)) continue;
    entries.set(p.id, {
      id: p.id,
      source: "jsonl",
      task: p.task,
      success: p.success,
      timestamp: p.timestamp,
      traceSource: p.source,
      sessionId: p.sessionId,
    });
  }

  const list = [...entries.values()];
  // 一次查多个 taskId（避免列表页 N+1）
  const usage = getTokenTracker().getUsageByTasks(list.map((e) => e.id));

  return ctx.jsonResponse(
    { traces: list.map((e) => ({ ...e, usage: usage.get(e.id) ?? null })) },
    200,
    ctx.baseHeaders,
  );
}

export async function handleTraceDetail(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/traces\/(.+)$/);
  if (!match || ctx.req.method !== "GET") return null;
  const id = decodeURIComponent(match[1]!);

  const { getTrace } = await import("../utils/agent-trace.js");
  const { findRealUsageTrace } = await import("../agent-evals/real-usage.js");
  const { getTokenTracker } = await import("../router/token-tracker.js");

  const running = getTrace(id);
  // 运行中的条目内存里还有，无需再查盘
  const persisted = running ? null : await findRealUsageTrace(id);
  const usage = getTokenTracker().getUsageByTasks([id]).get(id) ?? null;

  if (!running && !persisted && !usage) {
    return ctx.jsonResponse({ error: "Trace not found" }, 404, ctx.baseHeaders);
  }

  return ctx.jsonResponse(
    {
      id,
      // 运行中：带完整 steps（内存表仍在）
      ...(running
        ? {
            status: running.status,
            agentName: running.agentName,
            startTime: running.startTime,
            steps: running.steps,
            result: running.result,
          }
        : {}),
      // 已完成：轨迹步骤已按 B3-Medium 出表，此处提供任务级信息
      ...(persisted
        ? {
            task: persisted.task,
            success: persisted.success,
            timestamp: persisted.timestamp,
            traceSource: persisted.source,
            sessionId: persisted.sessionId,
          }
        : {}),
      // 按分类的 token 用量（A5 核心；由 A4 的 taskId 与上面两侧对齐）
      usage,
    },
    200,
    ctx.baseHeaders,
  );
}
