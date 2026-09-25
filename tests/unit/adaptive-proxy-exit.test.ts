/**
 * AdaptiveProxy 的健康检查定时器**不得钉死短命进程**
 *
 * 症状（实测 2026-09-21）：`scripts/index-knowledge-embeddings.ts` 干完活（打印完统计）后
 * **进程不退出**，必须靠 `timeout` 杀。定位：`initAdaptiveProxy()` 里的健康检查
 * `setInterval`（adaptive-proxy.ts）未 `unref()` ⇒ 一直持有事件循环。
 * 影响面：**任何**走过 `proxyFetch` 的 CLI/脚本（评测、索引、一次性任务）。
 *
 * 断言方式：独立子进程里 `initAdaptiveProxy({autoDetect:false, probeUrls:[]})`（无候选 ⇒ 不发网络）
 * 之后**不调用** `stopAdaptiveProxy()` 直接走到结尾；若定时器未 unref，`spawnSync` 会超时被杀。
 *
 * 注：子进程里清空 `*_proxy` 环境变量，避免依赖父进程代理配置（否则会真的发探测请求）。
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dir, "../..");
const MODULE_URL = pathToFileURL(join(ROOT, "src", "utils", "adaptive-proxy.ts")).href;

describe("AdaptiveProxy 定时器 unref", () => {
  it("初始化后进程能自然退出（不靠 stopAdaptiveProxy()）", () => {
    const script = `
      import { initAdaptiveProxy } from ${JSON.stringify(MODULE_URL)};
      await initAdaptiveProxy({ autoDetect: false, probeUrls: [], healthCheckInterval: 50 });
      console.log("INIT_DONE");
      // 故意不调用 stopAdaptiveProxy()：模拟 CLI/脚本走到结尾后自然退出
    `;
    const res = spawnSync("bun", ["-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
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
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status !== 0) console.error(out.slice(0, 2000));
    expect(out).toContain("INIT_DONE");
    // status=null 代表被 timeout 杀掉（= 定时器把进程钉住了）
    expect(res.status).toBe(0);
  }, 30_000);
});
