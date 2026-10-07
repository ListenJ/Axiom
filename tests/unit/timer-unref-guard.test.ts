/**
 * 定时器不钉死短命进程 —— **漂移门禁**（2026-09-21）
 *
 * ## 为什么要有这条
 * 同一类缺陷在本项目被**实测抓到两次**：`TokenTracker` 自动刷盘、`AdaptiveProxy` 健康检查
 * 的 `setInterval` 未 `unref()` ⇒ 任何走过这些路径的 CLI/脚本**干完活也不退出**（挂到超时才被杀）。
 * 人工审计能抓到一次，但挡不住下次新加一个定时器再犯。故把判定固化成规则：
 *
 *   1. `src/` 下凡出现 `setInterval(` 的文件，**必须**在同一文件里出现 `unref`；
 *   2. 例外必须**显式登记**在下方 `ALLOWLIST`，并写明"为什么它就该让进程活着"；
 *   3. 白名单**双向校验**：登记了但文件已无 `setInterval`（陈旧登记）也要失败。
 *
 * ## 为什么不是所有定时器都该 unref
 * `unref()` 的语义是"别因为我在等，就不让进程退出"。对**后台维护**类定时器（清理、刷盘、健康检查）
 * 这是对的；对**本身就是进程存在理由**的循环（TUI 主循环、内核 keep-alive tick、常驻更新器、
 * 服务心跳）则应当保留 —— 这不是遗漏，而是设计，故逐条登记理由。
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dir, "../..");
const SRC = join(ROOT, "src");

/** 显式例外：文件相对路径 → 为什么它**应当**让进程活着 */
const ALLOWLIST: Record<string, string> = {
  "main.ts": "常驻服务心跳：该进程本就以常驻为设计目的（HTTP/MCP 监听等），定时器不是唯一存活理由也不需要 unref",
  "tui/app.ts": "TUI 主循环：交互界面靠它驱动刷新，unref 会让界面进程提前退出",
  "knowledge/auto-updater.ts": "知识库自动更新器：以长驻更新为设计目的（显式 start() 启用）",
  "agents/consciousness/index.ts": "意识层轮询循环：以常驻轮询为设计目的",
  "routes/chat.ts": "SSE 心跳：请求作用域内创建，流结束时 clearInterval 清理",
};

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

describe("定时器 unref 门禁（防同类缺陷第三次出现）", () => {
  const files = walkTs(SRC);
  const withInterval = files.filter((f) => readFileSync(f, "utf8").includes("setInterval("));
  const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, "/");

  it("未登记的 setInterval 文件必须 unref", () => {
    // ⚠️ 必须是**真正的调用**，不能只出现 "unref" 这个词：
    // 首版用 `text.includes("unref")`，被自己的注释（注释里写了 unref() 字样）蒙混过关——
    // 实测：把调用删掉只留注释，静态断言仍然通过，只有行为级用例才发现。故收紧为正则。
    // 两种既有写法都要覆盖：`.unref()`（直接调用）与 `.unref?.()`（可选调用）
    const UNREF_CALL = /\.unref\s*(\?\.)?\s*\(\s*\)/;
    const violations: string[] = [];
    for (const f of withInterval) {
      const r = rel(f);
      if (ALLOWLIST[r]) continue;
      const text = readFileSync(f, "utf8");
      if (!UNREF_CALL.test(text)) violations.push(r);
    }
    if (violations.length > 0) {
      console.log(
        "[timer-unref-guard] 以下文件用了 setInterval 但没有 unref（也不是登记过的例外）：\n" +
          violations.map((v) => `  - ${v}`).join("\n"),
      );
    }
    expect(violations).toEqual([]);
  });

  it("白名单无陈旧登记（登记了但文件已无 setInterval）", () => {
    const intervals = new Set(withInterval.map(rel));
    const stale = Object.keys(ALLOWLIST).filter((r) => !intervals.has(r));
    if (stale.length > 0) console.log("[timer-unref-guard] 陈旧白名单：\n" + stale.join("\n"));
    expect(stale).toEqual([]);
  });

  it("白名单每条都有非空理由（防止用空理由绕过门禁）", () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.trim().length, `${file} 的理由为空`).toBeGreaterThan(10);
    }
  });

  it("行为级：三个后台维护定时器不再把进程钉住（子进程自然退出）", () => {
    const script = `
      import { SharedBlackboard } from ${JSON.stringify(pathToFileURL(join(SRC, "memory", "blackboard.ts")).href)};
      import { HealthMonitor } from ${JSON.stringify(pathToFileURL(join(SRC, "utils", "resilience.ts")).href)};
      import { DynamicModelAssigner } from ${JSON.stringify(pathToFileURL(join(SRC, "router", "dynamic-model-assigner.ts")).href)};
      // 间隔取 1 小时：本用例只验证"定时器挂着也不阻止进程退出"，不触发 tick 副作用
      new SharedBlackboard({ cleanupIntervalMs: 3600_000, redis: false });
      const monitor = new HealthMonitor();
      monitor.register({ name: "probe", interval: 3600_000, check: async () => true });
      monitor.start();
      new DynamicModelAssigner({ refreshIntervalMs: 3600_000 } as never).startAutoRefresh();
      console.log("TIMERS_STARTED");
      // 不调用任何 stop()/close()：模拟 CLI 干完活走到结尾
    `;
    const res = spawnSync("bun", ["-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status !== 0) console.error(out.slice(0, 2000));
    expect(out).toContain("TIMERS_STARTED");
    expect(res.status).toBe(0);
  }, 30_000);
});
