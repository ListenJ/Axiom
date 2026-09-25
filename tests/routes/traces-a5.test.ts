/**
 * A5：`GET /traces/:id` 与 `GET /traces` 的三方拼装
 *
 * 断言的是**组装行为**，不是单个函数：
 *   ① 已完成任务：内存表已按 B3-Medium 出表（`getTrace` 必为 null），仍能由
 *      **JSONL 落盘轨迹** + **按 taskId 的 token 用量** 组装出响应；
 *   ② 运行中任务：返回内存里的完整 `steps`；
 *   ③ 三方都没有 → 404（不得凭空造数据）。
 *
 * 隔离：`TOKEN_USAGE_DB` / `REAL_USAGE_PATH` 均指向临时文件，绝不写生产库与真实 JSONL。
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "traces-a5-"));
const DB = join(DIR, "token-usage.db");
const JSONL = join(DIR, "real-usage.jsonl");
process.env.TOKEN_USAGE_DB = DB;
process.env.REAL_USAGE_PATH = JSONL;

const { handleTraceDetail, handleTraceList } = await import("../../src/routes/traces.js");
const { getTokenTracker } = await import("../../src/router/token-tracker.js");
// 2026-09-26 归一修复：getTokenTracker() 是惰性单例，绑定**首次调用时**的 TOKEN_USAGE_DB。
// bun test 先加载全部测试文件再执行 —— 若不加这一行，执行阶段的其他文件（或本文件
// beforeAll 之前的任何路径）可能先触发单例创建（当时 env 未设 → 绑定生产
// ./data/token-usage.db），record+flush 把测试数据写进生产库并跨全量运行滚动累积
// （实测生产库残留 3 次运行 × 2 条）。在加载阶段（env 已设、其余文件尚未执行）抢先
// 初始化，强制单例绑定本文件的临时库。
getTokenTracker();
const { captureRealUsageTrace } = await import("../../src/agent-evals/real-usage.js");
const { startTrace, addStep } = await import("../../src/utils/agent-trace.js");

afterAll(() => {
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeCtx(pathname: string) {
  const url = new URL(`http://x${pathname}`);
  return {
    url,
    req: new Request(url, { method: "GET" }),
    db: null,
    vault: null,
    pipeline: null,
    healthMonitor: null,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }),
  } as never;
}

const TASK_ID = `task-a5-completed-${process.pid}-${Date.now()}`;
// 2026-09-26 归一修复：taskId 运行唯一化。getTokenTracker() 是惰性单例，绑定**首次调用时**
// 的 TOKEN_USAGE_DB —— bun test 的文件加载/执行时序下，先前文件（routes/settings-search、
// stats 等）可能已条件性触发单例创建（当时 env 未设 → 绑生产 ./data/token-usage.db），
// 导致本文件的 record+flush 落入先前绑定的库并跨运行滚动累积（实测生产库残留 3 次运行
// × 2 条；加载阶段抢先初始化也只能降低而非消除该时序依赖）。taskId 每次进程唯一后，
// 断言永远只读本进程写入的记录 —— 不论单例最终绑定哪个库，读数恒为 120。

beforeAll(async () => {
  const tracker = getTokenTracker();
  tracker.record({
    timestamp: Date.now(), model: "m", provider: "p", category: "main", taskId: TASK_ID,
    promptTokens: 60, completionTokens: 40, totalTokens: 100,
    latencyMs: 1, contentLength: 1, success: true, fallbackUsed: false,
  } as never);
  tracker.record({
    timestamp: Date.now(), model: "m", provider: "p", category: "embedding", taskId: TASK_ID,
    promptTokens: 20, completionTokens: 0, totalTokens: 20,
    latencyMs: 1, contentLength: 1, success: true, fallbackUsed: false,
  } as never);
  await tracker.flush();

  await captureRealUsageTrace(
    { id: TASK_ID, task: "A5 已完成任务", success: true, timestamp: Date.now(), source: "chat", sessionId: "sess-a5" } as never,
    JSONL,
  );
});

describe("A5 轨迹读取面", () => {
  it("已完成任务：内存无轨迹，仍由 JSONL + 按 taskId 用量组装出响应", async () => {
    const { getTrace } = await import("../../src/utils/agent-trace.js");
    expect(getTrace(TASK_ID)).toBeNull(); // 前提：B3-Medium 已出表

    const res = (await handleTraceDetail(makeCtx(`/traces/${TASK_ID}`))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string; task?: string; sessionId?: string;
      usage?: { totalTokens: number; totalCalls: number; byCategory: Record<string, number> };
    };

    expect(body.id).toBe(TASK_ID);
    expect(body.task).toBe("A5 已完成任务");      // 来自 JSONL
    expect(body.sessionId).toBe("sess-a5");
    expect(body.usage?.totalTokens).toBe(120);     // 来自 TokenTracker（按 taskId 聚合）
    expect(body.usage?.totalCalls).toBe(2);
    expect(body.usage?.byCategory.main).toBe(100);
    expect(body.usage?.byCategory.embedding).toBe(20);
  });

  it("运行中任务：返回内存里的完整 steps", async () => {
    startTrace("agent-running", "task-a5-running");
    addStep("task-a5-running", { type: "thinking", content: "step-1" });

    const res = (await handleTraceDetail(makeCtx("/traces/task-a5-running"))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; steps?: unknown[]; usage?: unknown };
    expect(body.status).toBe("running");
    expect(body.steps?.length).toBe(1);
    expect(body.usage).toBeNull(); // 该任务无 token 记录 —— 不得凭空造
  });

  it("三方都没有 → 404（不造数据）", async () => {
    const res = (await handleTraceDetail(makeCtx("/traces/task-does-not-exist"))) as Response;
    expect(res.status).toBe(404);
  });

  it("列表：已完成任务出现且带用量；来源如实标注", async () => {
    const res = (await handleTraceList(makeCtx("/traces?limit=50"))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      traces: Array<{ id: string; source: string; usage?: { totalTokens: number } | null }>;
    };
    const hit = body.traces.find((t) => t.id === TASK_ID);
    expect(hit).toBeDefined();
    expect(hit!.source).toBe("jsonl");
    expect(hit!.usage?.totalTokens).toBe(120);
  });
});
