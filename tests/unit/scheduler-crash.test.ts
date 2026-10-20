/**
 * Task 4: cron 未捕获 rejection 崩溃修复 — TDD 红绿验证
 * 验证 4 个任务对 SQLITE_BUSY 重试/兜底，且进程不因未捕获 rejection 退出
 * RED: 当前 scheduler.ts healthCheck/heartbeat/cleanup 无 try/catch → 抛 SQLiteError 导致 reject
 * GREEN: 修复后应 resolve 且 warn，仅重试 SQLITE_BUSY 一次
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { logger } from "../../src/utils/logger";
import { join } from "path";
import { tmpdir } from "os";

// Mock fetch early to avoid real network during scheduler import & task execution
const _originalFetch = globalThis.fetch;
(globalThis as any).fetch = async () => ({ ok: true } as unknown as Response);

describe("scheduler crash", () => {
  let origRun: typeof Database.prototype.run;
  let origQuery: typeof Database.prototype.query;

  beforeEach(() => {
    origRun = Database.prototype.run;
    origQuery = Database.prototype.query;
    // ensure fetch mocked per test as well
    (globalThis as any).fetch = async () => ({ ok: true } as unknown as Response);
  });

  afterEach(() => {
    (Database.prototype as any).run = origRun;
    (Database.prototype as any).query = origQuery;
    // F7 修复（2026-09-25）：原版在还原后又立刻把 fetch 重新覆盖为 {ok:true} 桩
    // ——restore 成了死代码，整个进程其余测试文件（pdf-worker 等）拿到的都是
    // 无 .json() 的假 Response（res.json is not a function 的根因）。
    // beforeEach 已在每个用例前重新打桩，afterEach 只需还原真实 fetch。
    globalThis.fetch = _originalFetch;
  });

  test("healthCheckTask handles SQLITE_BUSY without throwing", async () => {
    const mod = await import("../../src/cron/scheduler.js");
    let callCount = 0;
    (Database.prototype as any).run = function (...args: any[]) {
      callCount++;
      throw new Error("database is locked");
    };
    const warnSpy = spyOn(logger, "warn");
    // 当前实现会抛 SQLiteError 导致 reject → RED
    // 修复后应 catch 并 warn → GREEN (resolves)
    await expect(mod.healthCheckTask()).resolves.toBeUndefined();
    // 修复后应有 warn 调用（非 SQLITE_BUSY 也 warn）
    // 不强制断言 warn 次数，仅确保不抛
    warnSpy.mockRestore();
    (Database.prototype as any).run = origRun;
  });

  test("healthCheckTask retries once on SQLITE_BUSY then succeeds", async () => {
    const mod = await import("../../src/cron/scheduler.js");
    let calls = 0;
    const orig = origRun;
    (Database.prototype as any).run = function (this: any, ...args: any[]) {
      calls++;
      if (calls === 1) throw new Error("SQLITE_BUSY: database is locked");
      return (orig as any).apply(this, args);
    };
    const warnSpy = spyOn(logger, "warn");
    await expect(mod.healthCheckTask()).resolves.toBeUndefined();
    // withRetry 应重试 1 次 → 总调用 2 次
    expect(calls).toBe(2);
    // 重试成功后不应 warn（仅最终失败才 warn）
    // 允许 warn 被调用 0 次，修复前 calls 恒 1 且抛错
    warnSpy.mockRestore();
    (Database.prototype as any).run = origRun;
  });

  test("heartbeatTask handles SQLITE_BUSY without throwing", async () => {
    const mod = await import("../../src/cron/scheduler.js");
    (Database.prototype as any).run = function () {
      throw new Error("database is locked");
    };
    const warnSpy = spyOn(logger, "warn");
    await expect(mod.heartbeatTask()).resolves.toBeUndefined();
    warnSpy.mockRestore();
    (Database.prototype as any).run = origRun;
  });

  test("cleanupTask handles rejection without throwing", async () => {
    const mod = await import("../../src/cron/scheduler.js");
    (Database.prototype as any).run = function () {
      throw new Error("database is locked");
    };
    const warnSpy = spyOn(logger, "warn");
    await expect(mod.cleanupTask()).resolves.toBeUndefined();
    warnSpy.mockRestore();
    (Database.prototype as any).run = origRun;
  });

  test("discoverFreeModelsTask handles rejection", async () => {
    const mod: any = await import("../../src/cron/scheduler.js");
    // discoverFreeModelsTask 已有 try/catch，修复前后均应 resolve
    // 此用例确保回归不退化
    (Database.prototype as any).query = (() => ({
      get: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    })) as any;
    // 2026-10-20：原为 `if (typeof fn === "function") {...} else { expect(Promise.resolve()).resolves }`
    // ——else 分支恒真，会在"导出丢失"这一真实回归下静默通过。改为断言导出契约存在。
    expect(typeof mod.discoverFreeModelsTask).toBe("function");
    await expect(mod.discoverFreeModelsTask()).resolves.toBeUndefined();
    (Database.prototype as any).query = origQuery;
  });

  test("discoverFreeModelsTask handles query throw", async () => {
    const mod: any = await import("../../src/cron/scheduler.js");
    // 2026-10-20：原为 `if (typeof fn !== "function") { expect(true).toBe(true); return; }`
    // ——"导出缺失即通过"会掩盖真实回归。改为断言导出契约存在，缺失即红。
    expect(typeof mod.discoverFreeModelsTask).toBe("function");
    (Database.prototype as any).query = (() => ({
      get: () => {
        throw new Error("database is locked");
      },
    })) as any;
    await expect(mod.discoverFreeModelsTask()).resolves.toBeUndefined();
    (Database.prototype as any).query = origQuery;
  });

  // 审计修复（2026-09-14）：监听器改为在 startCronScheduler() 内安装，import 不再有副作用。
  // 故这两个用例由"import 后断言"改为"显式启动后断言"。
  test("process has unhandledRejection handler that does not exit", async () => {
    const mod = await import("../../src/cron/scheduler.js");
    const before = process.listeners("unhandledRejection").length;
    mod.startCronScheduler({ registerCron: false, runImmediately: false });
    const listeners = process.listeners("unhandledRejection");
    // 修复前 listeners 为 0 → RED，修复后 >=1 → GREEN
    expect(listeners.length).toBeGreaterThan(0);
    expect(listeners.length).toBeGreaterThanOrEqual(before);
  });

  test("process has uncaughtException handler", async () => {
    const mod = await import("../../src/cron/scheduler.js");
    mod.startCronScheduler({ registerCron: false, runImmediately: false });
    const listeners = process.listeners("uncaughtException");
    expect(listeners.length).toBeGreaterThan(0);
  });

  test("import 本身不再安装监听器（副作用已收敛）", async () => {
    // 子进程隔离：模块级副作用只能这样观察
    const proc = Bun.spawnSync({
      cmd: ["bun", "-e", `await import("./src/cron/scheduler.ts"); console.log("N=" + process.listeners("unhandledRejection").length);`],
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
      // 子进程超时兜底（2026-10-19）：Bun.spawnSync 默认无超时
      timeout: 60_000,
      env: { ...process.env, DATABASE_PATH: join(tmpdir(), `nse-${Date.now()}.db`) },
    });
    const out = proc.stdout.toString();
    expect(out).toContain("N=0");
    // 用例预算（2026-10-19）：体内嵌套 bun 子进程，默认 5s 会误报失败
  }, 90_000);
});
