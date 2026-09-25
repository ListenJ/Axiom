/**
 * AdaptiveProxy 的健康检查定时器**不得钉死短命进程**
 *
 * 症状（实测 2026-09-21）：`scripts/index-knowledge-embeddings.ts` 干完活（打印完统计）后
 * **进程不退出**，必须靠 `timeout` 杀。定位：`initAdaptiveProxy()` 里的健康检查
 * `setInterval`（adaptive-proxy.ts）未 `unref()` ⇒ 一直持有事件循环。
 * 影响面：**任何**走过 `proxyFetch` 的 CLI/脚本（评测、索引、一次性任务）。
 *
 * 断言方式：独立子进程里 `initAdaptiveProxy({autoDetect:false, probeUrls:[]})`（无候选 ⇒ 不发网络）
 * 之后**不调用** `stopAdaptiveProxy()` 直接走到结尾；若定时器未 unref，子进程 10s 内无法自然退出。
 *
 * 注 1：子进程里清空 `*_proxy` 环境变量，避免依赖父进程代理配置（否则会真的发探测请求）。
 * 注 2（2026-09-26 归一）：改用**异步 spawn**（替代 spawnSync）—— bun 1.3.14 / Windows
 * 全量套件下 spawnSync 嵌套实测会挂死（timeout 参数不生效，测试级 30s 被杀）。异步版
 * 由本进程事件循环自行计时 kill，不再依赖 spawnSync 的内置超时。
 */
import { describe, it, expect } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dir, "../..");
const MODULE_URL = pathToFileURL(join(ROOT, "src", "utils", "adaptive-proxy.ts")).href;

interface RunResult {
  out: string;
  code: number | null;
  timedOut: boolean;
  spawnError: boolean;
}

/** 异步跑一次子进程，硬超时 10s 后 SIGKILL（不依赖 spawnSync 的内置 timeout）。 */
function runOnce(script: string, timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(process.execPath, ["-e", script], {
      cwd: ROOT,
      env: {
        ...process.env,
        http_proxy: "",
        https_proxy: "",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        all_proxy: "",
        ALL_PROXY: "",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ out, code: null, timedOut: true, spawnError: false });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => finish({ out, code, timedOut: false, spawnError: false }));
    child.on("error", () => finish({ out, code: null, timedOut: false, spawnError: true }));
  });
}

describe("AdaptiveProxy 定时器 unref", () => {
  it("初始化后进程能自然退出（不靠 stopAdaptiveProxy()）", async (t) => {
    const script = `
      import { initAdaptiveProxy } from ${JSON.stringify(MODULE_URL)};
      await initAdaptiveProxy({ autoDetect: false, probeUrls: [], healthCheckInterval: 50 });
      console.log("INIT_DONE");
      // 故意不调用 stopAdaptiveProxy()：模拟 CLI/脚本走到结尾后自然退出
    `;
    let res = await runOnce(script);
    // 2026-09-26 归一：Windows 全量套件后期实测出现 spawn 层失败（瞬时进程创建错误，
    // 与被测的定时器 unref 行为无关）—— 重试一次；仍失败则跳过（测试意图无法执行）。
    if (res.spawnError && !res.out.includes("INIT_DONE")) {
      res = await runOnce(script);
      if (res.spawnError && !res.out.includes("INIT_DONE")) {
        t.skip("spawn 基础设施失败（进程创建错误），与定时器 unref 行为无关");
        return;
      }
    }
    if (res.code !== 0) console.error(res.out.slice(0, 2000));
    expect(res.out).toContain("INIT_DONE");
    // timedOut=true 代表子进程 10s 内无法自然退出（= 定时器把进程钉住了）
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(0);
  }, 30_000);
});
