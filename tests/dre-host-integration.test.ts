/**
 * DRE P0/P2 验证：
 *   - ConfigLoader apiKey 接线（DRE_LLM_API_KEY / DRE_DISCRIMIN_API_KEY）
 *   - 云默认模型 deepseek-v4-flash
 *   - 主服务宿主集成：initDreKernel 就绪 + POST /dre/run 跑通 6 阶段确定性管道
 *   - 未初始化时 /dre/run 返回 503
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import { ConfigLoader } from "../src/dre/config.js";
import { initDreKernel, shutdownDreKernel } from "../src/daemon/host.js";
import { startDreDaemon, type DreDaemonHandle } from "../src/daemon/dre-daemon.js";
import { handleDreRun } from "../src/routes/dre.js";
import type { RouteContext } from "../src/routes/types.js";

const DB = ".tmp/dre-host-test.db";

function fakeCtx(input: string): RouteContext {
  const req = new Request("http://127.0.0.1/dre/run", {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  return {
    url: new URL(req.url),
    req,
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: extraHeaders }),
  } as unknown as RouteContext;
}

describe("DRE ConfigLoader apiKey 接线 (P0)", () => {
  it("llmApiKey/discriminApiKey 注入 LLM 配置", () => {
    const cfg = new ConfigLoader({
      llmApiKey: "sk-main",
      discriminUrl: "http://disc:8080",
      discriminApiKey: "sk-disc",
    }).toKernelConfig();
    expect(cfg.mainLLM.apiKey).toBe("sk-main");
    expect(cfg.discriminLLM?.apiKey).toBe("sk-disc");
  });

  it("默认无 apiKey（本地 llama.cpp 可省略）", () => {
    const cfg = new ConfigLoader().toKernelConfig();
    expect(cfg.mainLLM.apiKey).toBeUndefined();
  });

  it("云默认模型为 deepseek-v4-flash、默认端点带 /v1", () => {
    const cfg = new ConfigLoader({ cloudApiKey: "sk-test" }).toKernelConfig();
    expect(cfg.cloudFallback?.model).toBe("deepseek-v4-flash");
    expect(cfg.cloudFallback?.baseUrl).toBe("https://api.deepseek.com/v1");
  });
});

describe("DRE 主服务宿主集成 (P2) — daemon 客户端", () => {
  let handle: DreDaemonHandle;
  beforeAll(async () => {
    process.env.AXIOM_DRE_ENABLED = "1";
    process.env.DRE_DB_PATH = DB;
    process.env.DRE_LLM_URL = "http://127.0.0.1:8080";
    process.env.DRE_AUTO_TICK = "0";
    // 内核收敛：唯一 Kernel 拥有者 = DRE daemon；主服务作为客户端接入。
    handle = await startDreDaemon({ port: 0, hostname: "127.0.0.1" });
    process.env.AXIOM_DRE_DAEMON_URL = `http://127.0.0.1:${handle.port}`;
    process.env.AXIOM_DRE_DAEMON_TOKEN = "";
  });

  afterAll(async () => {
    await shutdownDreKernel();
    if (handle) await handle.stop();
    delete process.env.AXIOM_DRE_ENABLED;
    delete process.env.DRE_DB_PATH;
    delete process.env.DRE_LLM_URL;
    delete process.env.DRE_AUTO_TICK;
    delete process.env.AXIOM_DRE_DAEMON_URL;
    for (const p of [DB, `${DB}-shm`, `${DB}-wal`]) {
      try { fs.rmSync(p); } catch { /* ignore */ }
    }
  });

  it("initDreKernel 连接 daemon 并返回就绪客户端", async () => {
    const k = await initDreKernel();
    expect(k).not.toBeNull();
    const h = await k!.health();
    expect(h.ok).toBe(true);
  });

  it("POST /dre/run 返回 200 且跑完 6 阶段确定性管道", async () => {
    const k = await initDreKernel();
    expect(k).not.toBeNull();
    const res = await handleDreRun(fakeCtx("分析知识库检索模块的性能瓶颈"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean; trace?: Array<{ stage: string }> };
    expect(body.ok).toBe(true);
    expect(body.trace?.map((s) => s.stage)).toEqual([
      "classify",
      "knowledge",
      "reasoning",
      "constraint",
      "action",
      "reflection",
    ]);
  });

  it("未初始化时 /dre/run 返回 503", async () => {
    await shutdownDreKernel();
    const res = await handleDreRun(fakeCtx("x"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });
});
