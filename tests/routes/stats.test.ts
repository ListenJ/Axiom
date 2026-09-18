/**
 * 审计 ◆K-3 / 整改 R3 Task 3.8 —— /api/stats 真实数据回归
 *
 * 修复前：activeTasks = Math.floor(Math.random()*5)+1（纯随机伪造）。
 * 修复后契约：activeTasks 必须等于 scheduler.getStatus().running。
 */
import { describe, test, expect } from "bun:test";
import { handleStats } from "../../src/routes/stats.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";

function makeCtx(urlStr: string): any {
  const req = new Request(urlStr);
  return {
    url: new URL(urlStr),
    req,
    vault: null,
    db: null,
    pipeline: null,
    healthMonitor: null,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  };
}

describe("GET /api/stats 真实 activeTasks（K-3）", () => {
  test("activeTasks 与调度器 running 计数一致（非随机数）", async () => {
    const res = (await handleStats(makeCtx("http://x/api/stats"))) as Response;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeTasks).toBe(scheduler.getStatus().running);
  });

  test("连续两次调用结果一致（无随机性）", async () => {
    const r1 = (await handleStats(makeCtx("http://x/api/stats"))) as Response;
    const r2 = (await handleStats(makeCtx("http://x/api/stats"))) as Response;
    const d1 = await r1.json();
    const d2 = await r2.json();
    expect(d1.activeTasks).toBe(d2.activeTasks);
  });
});
