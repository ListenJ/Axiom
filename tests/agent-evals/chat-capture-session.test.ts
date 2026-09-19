/**
 * 路由级断言（切片 A3c 收尾）：chat 路由确实把 sessionId 交给了用量采集
 *
 * 为什么需要：A3c 的改动此前**只有静态证据**（`chat.ts:178/708/755` 的源码行），
 * 没有任何运行时证据证明"路由真的带上了"。本文件在**路由层**（真实 handleChat /
 * handleAgentChat + 真实 services/chat），只 mock 两个重协作者：
 *   - `model-router`：让对话离线成功（与 tests/chat-memory-loop.test.ts 同一接缝）
 *   - `agent-evals/real-usage`：**拦截**采集 payload（不落盘，避免测试污染真实 JSONL）
 * 断言的是"采集函数收到了什么"，这是路由与其下游之间的公共边界。
 *
 * 覆盖：`/chat`（采集点 1）、`/agent-chat` 显式带 sessionId（站点 2 正例）、
 *       `/agent-chat` 不带 sessionId（站点 2 反例 —— 验证"不伪造 UUID"的刻意不对称）。
 * 未覆盖：`/chat-stream` 的两个采集点（SSE 流，需消费 ReadableStream），见 ops log 登记。
 */
import { describe, it, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "../..");

// ── 拦截采集（整模块替换：必须给全运行时导出，缺符号在同进程内会变 undefined）──
const captured: Array<Record<string, unknown>> = [];
mock.module(path.join(ROOT, "src", "agent-evals", "real-usage.js"), () => ({
  REAL_USAGE_PATH: path.join(os.tmpdir(), "axiom-unused-real-usage.jsonl"),
  captureRealUsageTrace: async (t: Record<string, unknown>) => { captured.push(t); },
  captureAgentTrace: async () => {},
  flushRealUsageTraces: async () => {},
  loadRealUsageTraces: async () => [],
  clearRealUsageTraces: async () => {},
  assessTraceHealth: async () => ({ total: 0, malformed: 0, malformedRate: 0, duplicateIds: 0 }),
  evolveFromRealUsage: async () => ({ traceCount: 0, inductionCount: 0, created: [], sampled: 0 }),
}));

// ── mock 主模型路由：离线成功（assistant 内容非空 → success=true → 进入采集块）──
const MOCK_ASSISTANT = "定位：连接池耗尽导致数据库超时。修复：把最大连接数从 5 提到 10。";
mock.module(path.join(ROOT, "src", "router", "model-router.js"), () => ({
  router: {
    routeByIntent: () => ({ content: MOCK_ASSISTANT, model: "m1", provider: "p1", layer: "code" }),
    chat: () => ({ content: MOCK_ASSISTANT, model: "m1", provider: "p1", layer: "general", usage: { total_tokens: 3 } }),
    executeWithRole: () => ({ content: MOCK_ASSISTANT, model: "m1", provider: "p1", layer: "general", usage: { total_tokens: 5 } }),
  },
}));

// ── 环境隔离（bun test 同进程跑多文件，env 是进程级共享状态）──
const ENV_ORIGINALS: Array<[string, string | undefined]> = [];
function setEnv(key: string, value: string): void {
  ENV_ORIGINALS.push([key, process.env[key]]);
  process.env[key] = value;
}
setEnv("AXIOM_PRIVACY_MODE", "1");
setEnv("PROMPT_REWRITE", "0");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-chat-capture-"));
setEnv("SQLITE_MEMORY_DB", path.join(TMP, "memory.db"));
const VAULT_DIR = path.join(TMP, "vault");
fs.mkdirSync(VAULT_DIR, { recursive: true });
setEnv("OBSIDIAN_VAULT_PATH", VAULT_DIR);

afterAll(() => {
  for (const [key, value] of ENV_ORIGINALS) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

let handleChat!: typeof import("../../src/routes/chat.js")["handleChat"];
let handleAgentChat!: typeof import("../../src/routes/chat.js")["handleAgentChat"];
const { VaultManager } = await import("../../src/memory/vault-manager.js");
const testVault = new VaultManager({ vaultPath: VAULT_DIR });

beforeAll(async () => {
  const routes = await import("../../src/routes/chat.js");
  handleChat = routes.handleChat;
  handleAgentChat = routes.handleAgentChat;
});

beforeEach(() => { captured.length = 0; });

/** 轻量 fake db（形态与 tests/chat-memory-loop.test.ts 一致） */
function makeFakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    run: (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO conversations")) {
        const p = params ?? [];
        rows.push({ session_id: p[0], agent_id: p[1], role: p[2], content: p[3], created_at: 0 });
      }
    },
    query: (sql: string) => ({
      get: () => (sql.includes("COUNT(*)") ? { count: 0, tokens: 0 } : undefined),
      all: (...args: unknown[]) =>
        sql.includes("FROM conversations")
          ? rows.filter((r) => r.session_id === args[0]).map((r, i) => ({ id: i + 1, ...r }))
          : [],
    }),
    prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
  } as never;
}

function makeCtx(pathname: string, body: Record<string, unknown>) {
  const req = new Request(`http://x${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    url: new URL(`http://x${pathname}`),
    req,
    vault: testVault,
    db: makeFakeDb(),
    pipeline: null,
    healthMonitor: null,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }),
  } as never;
}

describe("路由级：sessionId 是否真的交给了用量采集", () => {
  it("POST /chat 带 sessionId → 采集 payload 携带同一 sessionId", async () => {
    const res = (await handleChat(makeCtx("/chat", {
      messages: [{ role: "user", content: "帮我看看连接池问题" }],
      sessionId: "route-sess-aaa",
    }))) as Response;
    expect(res.status).toBe(200);

    const hit = captured.find((c) => c.source === "chat");
    expect(hit, "应有一次 source=chat 的采集").toBeDefined();
    expect(hit!.sessionId).toBe("route-sess-aaa");
  });

  it("POST /agent-chat 显式带 sessionId → 采集 payload 携带该 sessionId", async () => {
    const res = (await handleAgentChat(makeCtx("/agent-chat", {
      message: "连接池超时怎么排查",
      sessionId: "route-sess-bbb",
    }))) as Response;
    expect(res.status).toBe(200);

    const hit = captured.find((c) => c.source === "agent-chat");
    expect(hit).toBeDefined();
    expect(hit!.sessionId).toBe("route-sess-bbb");
  });

  it("POST /agent-chat 不带 sessionId → 不写入该字段（刻意不对称：不伪造 UUID）", async () => {
    const res = (await handleAgentChat(makeCtx("/agent-chat", {
      message: "连接池超时怎么排查",
    }))) as Response;
    expect(res.status).toBe(200);

    const hit = captured.find((c) => c.source === "agent-chat");
    expect(hit).toBeDefined();
    expect(hit!.sessionId).toBeUndefined();
  });
});
