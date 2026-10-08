/**
 * DRE Daemon 集成测试（内核收敛 Step 2）。
 *
 * 验证 daemon 作为唯一 Kernel 拥有者时，对外 HTTP 面可用：
 * /health、/dre/status、/dre/cognitive-state、/api/port（写入+读取）、/dre/run。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { startDreDaemon, type DreDaemonHandle } from "../../src/daemon/dre-daemon.js";
import { createDreDaemonClient } from "../../src/daemon/client.js";
import { DRE_DAEMON_CONTRACT_VERSION, DRE_DAEMON_CAPABILITIES } from "../../src/daemon/contract.js";

const DB = `.tmp/dre-daemon-test-${process.pid}.db`;
let handle: DreDaemonHandle;
let base = "";

describe("DRE Daemon 集成", () => {
  beforeAll(async () => {
    process.env.DRE_DB_PATH = DB;
    process.env.DATABASE_PATH = DB;
    process.env.DRE_AUTO_TICK = "0";
    try { fs.rmSync(DB, { force: true }); } catch {}
    handle = await startDreDaemon({ port: 0, hostname: "127.0.0.1" });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.stop();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(DB + suffix, { force: true }); } catch {}
    }
    delete process.env.DRE_DB_PATH;
  });

  test("GET /health 存活且 state 明确", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(typeof body.state).toBe("string");
  });

  test("GET /version 返回契约版本与能力清单（ADR-012 能力协商）", async () => {
    const res = await fetch(`${base}/version`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; contractVersion: string; capabilities: string[] };
    expect(body.ok).toBe(true);
    expect(body.contractVersion).toBe(DRE_DAEMON_CONTRACT_VERSION);
    for (const c of DRE_DAEMON_CAPABILITIES) expect(body.capabilities).toContain(c);
  });

  test("GET /dre/status 返回 KernelStatus", async () => {
    const res = await fetch(`${base}/dre/status`);
    const body = await res.json() as { ok: boolean; status: { state: string; tickCount: number } };
    expect(body.ok).toBe(true);
    expect(body.status.state).toBeDefined();
    expect(typeof body.status.tickCount).toBe("number");
  });

  test("GET /dre/cognitive-state 返回引擎认知状态", async () => {
    const res = await fetch(`${base}/dre/cognitive-state`);
    const body = await res.json() as { ok: boolean; state: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.state).toBeDefined();
  });

  test("POST /api/port 写入后可读回（端口协议端到端）", async () => {
    const w = await fetch(`${base}/api/port`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "knowledge.write",
        params: { node: { title: "daemon-probe", content: "daemon port write body", domain: "test", paradigm: "test", confidence: 0.9, sourceType: "manual" } },
      }),
    });
    expect(w.status).toBe(200);
    const wb = await w.json() as { ok: boolean; data?: { nodeId: string } };
    expect(wb.ok).toBe(true);
    expect(wb.data?.nodeId).toBeTruthy();

    const r = await fetch(`${base}/api/port`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "knowledge.read", params: { nodeId: wb.data!.nodeId } }),
    });
    const rb = await r.json() as { ok: boolean; data?: { nodeId?: string; title?: string } };
    expect(rb.ok).toBe(true);
    expect(rb.data?.nodeId).toBe(wb.data!.nodeId);
  });

  test("POST /dre/run 跑通确定性认知管道", async () => {
    const res = await fetch(`${base}/dre/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "daemon smoke: 1+1=2 是否成立" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("POST /dre/tool 在 daemon 内用唯一引擎执行 DRE 工具", async () => {
    const res = await fetch(`${base}/dre/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "persona_list", args: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; result?: unknown };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.result)).toBe(true);
    expect(body.result as string[]).toContain("general");
  });

  test("POST /dre/tool 未知工具返回 404", async () => {
    const res = await fetch(`${base}/dre/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no_such_tool", args: {} }),
    });
    expect(res.status).toBe(404);
  });

  test("POST /dre/run 缺 input 返回 400", async () => {
    const res = await fetch(`${base}/dre/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DRE Daemon 客户端", () => {
  beforeAll(async () => {
    process.env.DRE_DB_PATH = `.tmp/dre-daemon-client-${process.pid}.db`;
    process.env.DATABASE_PATH = process.env.DRE_DB_PATH;
    process.env.DRE_AUTO_TICK = "0";
    handle = await startDreDaemon({ port: 0, hostname: "127.0.0.1" });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    if (handle) await handle.stop();
    try { fs.rmSync(process.env.DRE_DB_PATH ?? "", { force: true }); } catch {}
  });

  test("client.health / status / cognitiveState / run 均可用", async () => {
    const client = createDreDaemonClient({ baseUrl: base });
    const h = await client.health();
    expect(h.ok).toBe(true);
    const st = await client.status<{ state: string }>();
    expect(st.ok).toBe(true);
    const cs = await client.cognitiveState();
    expect(cs.ok).toBe(true);
    const run = await client.run("client smoke 2+2=4");
    expect(run.ok).toBe(true);
  });

  test("client.port 写入+读取", async () => {
    const client = createDreDaemonClient({ baseUrl: base });
    const w = await client.port<{ nodeId: string }>({
      method: "knowledge.write",
      params: { node: { title: "client-probe", content: "client port body", domain: "test", paradigm: "test", confidence: 0.9, sourceType: "manual" } },
    });
    expect(w.ok).toBe(true);
    expect(w.data?.nodeId).toBeTruthy();
  });

  test("client 指向不可达地址抛 DreDaemonUnavailableError", async () => {
    const client = createDreDaemonClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 300 });
    await expect(client.health()).rejects.toThrow(/unreachable/);
  });
});
