/**
 * TokenTracker 的自动刷盘定时器**不得钉死短命进程**
 *
 * 症状（实测）：`ModelRouter.embeddings()` 补上用量落库后，评测脚本
 * （`scripts/eval-lexical-vs-semantic-recall.ts`）写完报告**仍然不退出**，
 * 必须手动 kill。机理：`TokenTracker` 构造函数里的 `setInterval`（自动刷盘）
 * 未 `unref()` ⇒ 一直持有事件循环。凡是"记一次用量就结束"的 CLI/脚本都会被钉住。
 *
 * 断言方式：在**独立子进程**里记一条用量后**不调用 close()** 自然走到结尾；
 * 若定时器仍持有事件循环，`spawnSync` 会因超时被杀（`status === null`），测试失败。
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

describe("TokenTracker 定时器 unref", () => {
  it("记一条用量后进程能自然退出（不靠 close()）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracker-exit-"));
    const script = `
      import { getTokenTracker } from "${join(ROOT, "src", "router", "token-tracker.ts")}";
      getTokenTracker().record({
        timestamp: Date.now(),
        model: "probe-model",
        provider: "probe-provider",
        promptTokens: 1,
        completionTokens: 0,
        totalTokens: 1,
        latencyMs: 1,
        contentLength: 1,
        success: true,
        fallbackUsed: false,
      });
      console.log("RECORDED");
      // 故意不调用 close()：模拟 CLI/脚本走到结尾后自然退出
    `;
    const res = spawnSync("bun", ["-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, TOKEN_USAGE_DB: join(dir, "token-usage.db"), NODE_ENV: "test" },
    });
    try {
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      if (res.status !== 0) console.error(out.slice(0, 2000));
      expect(out).toContain("RECORDED");
      // status=null 代表被 timeout 杀掉（即"进程没退出"）—— 那正是本用例要拦的回归
      expect(res.status).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
