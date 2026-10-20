/**
 * 回归测试：cron/scheduler 的模块级副作用必须收敛为显式启动（TDD RED → GREEN）
 *
 * 缺陷（来自第三方审计）：
 * `src/cron/scheduler.ts` 在**模块顶层**建库、注册 `Bun.cron`、并**立即**执行一次
 * `healthCheckTask()`。于是任何 `import` 它的代码（含测试、CLI、其他模块）都会：
 *   1. 打开/创建 SQLite 库并写 WAL（副作用落在磁盘上）
 *   2. 注册 4 个全局定时任务
 *   3. 触发一次网络健康检查
 *   4. 安装 `unhandledRejection` / `uncaughtException` 进程级监听器
 *
 * 对外可观察的正确行为：
 *   - **import 不产生任何副作用**（不建库、不注册、不发请求）
 *   - 显式调用 `startCronScheduler()` 才启动
 *   - 直接运行该文件（`bun run src/cron/scheduler.ts`）仍照旧启动（import.meta.main 守卫）
 *
 * 测试方式：用子进程隔离（模块级副作用只能这样观察），临时 DATABASE_PATH +
 * 关闭代理避免真实网络。
 */
import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";

const REPO = join(import.meta.dir, "..", "..");

/** 在子进程中运行一段脚本，返回 { stdout, stderr, exitCode } */
function runInSubprocess(script: string, dbPath: string) {
  const proc = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    cwd: REPO,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      // 关键：清空平台 API Key。healthCheckTask 会按 key 是否存在决定是否外呼；
      // 若继承真实 key，子进程会真的发起 4 次 HTTP（每次最长 5s 超时）——
      // 那正是本次要消除的"import 即外呼"副作用，也会让测试非确定性地变慢。
      SILICONFLOW_API_KEY: "",
      OFOXAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      // 避免真实外呼：清空代理变量
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      NO_PROXY: "*",
    },
    stdout: "pipe",
    stderr: "pipe",
    // 子进程超时兜底（2026-10-19）：Bun.spawnSync 默认无超时，子进程挂死会让用例永久挂起。
    // 与下方各用例的第三参数（用例预算）配合：用例预算必须 > 子进程预算。
    timeout: 60_000,
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

describe("cron/scheduler 副作用收敛", () => {
  it("import 不产生副作用：不建库、不注册 cron、不安装进程监听器", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-nosideeffect-"));
    const dbPath = join(dir, "should-not-exist.db");
    try {
      // 具名导入该模块，并断言"什么都没发生"
      const { stdout, stderr, exitCode } = runInSubprocess(
        `
        import { startCronScheduler, healthCheckTask } from "./src/cron/scheduler.ts";
        console.log("HAS_START=" + (typeof startCronScheduler));
        console.log("HAS_TASK=" + (typeof healthCheckTask));
        console.log("UNHANDLED=" + process.listeners("unhandledRejection").length);
        console.log("UNCAUGHT=" + process.listeners("uncaughtException").length);
        `,
        dbPath,
      );

      if (exitCode !== 0) {
        throw new Error(`子进程失败 exit=${exitCode}\n${stderr}`);
      }
      expect(stdout).toContain("HAS_START=function");
      expect(stdout).toContain("HAS_TASK=function");
      // 关键断言：import 不应安装进程级监听器
      expect(stdout).toContain("UNHANDLED=0");
      expect(stdout).toContain("UNCAUGHT=0");
      // 关键断言：import 不应在磁盘上建库
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("显式调用 startCronScheduler() 才启动：安装监听器并建库", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-started-"));
    const dbPath = join(dir, "started.db");
    try {
      const { stdout, stderr, exitCode } = runInSubprocess(
        `
        import { startCronScheduler } from "./src/cron/scheduler.ts";
        const before = process.listeners("unhandledRejection").length;
        startCronScheduler({ registerCron: false, runImmediately: false });
        const after = process.listeners("unhandledRejection").length;
        console.log("BEFORE=" + before + " AFTER=" + after);
        `,
        dbPath,
      );

      if (exitCode !== 0) {
        throw new Error(`子进程失败 exit=${exitCode}\n${stderr}`);
      }
      expect(stdout).toContain("BEFORE=0");
      // 启动后应安装监听器
      expect(stdout).not.toContain("AFTER=0");
      // 启动后应真的打开了库
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("runImmediately:false 时不触发健康检查（避免 import 即外呼）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-noimmediate-"));
    const dbPath = join(dir, "x.db");
    try {
      const { stdout, stderr, exitCode } = runInSubprocess(
        `
        import { startCronScheduler } from "./src/cron/scheduler.ts";
        startCronScheduler({ registerCron: false, runImmediately: false });
        console.log("DONE");
        `,
        dbPath,
      );
      if (exitCode !== 0) throw new Error(`子进程失败 exit=${exitCode}\n${stderr}`);
      // 不应出现健康检查的网络日志
      expect(stdout).toContain("DONE");
      expect(stdout).not.toContain("Health check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("任务函数仍可用且不抛（语义未因重构改变）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-tasks-"));
    const dbPath = join(dir, "t.db");
    try {
      const { stdout, stderr, exitCode } = runInSubprocess(
        `
        import { healthCheckTask, heartbeatTask, cleanupTask, discoverFreeModelsTask } from "./src/cron/scheduler.ts";
        await healthCheckTask();
        await heartbeatTask();
        await cleanupTask();
        await discoverFreeModelsTask();
        console.log("TASKS_OK");
        `,
        dbPath,
      );
      if (exitCode !== 0) throw new Error(`子进程失败 exit=${exitCode}\n${stderr}`);
      expect(stdout).toContain("TASKS_OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
