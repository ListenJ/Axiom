/**
 * 路由级断言（切片 A3c 收尾）：chat 路由确实把 sessionId 交给了用量采集
 *
 * ⚠️ 本文件**故意不叫** `*.test.ts`，以避开 Bun 的自动发现：
 * 它在模块加载期调用 `mock.module` 整模块替换 `agent-evals/real-usage.js`，
 * 而 Bun 是「先加载全部测试文件、再执行」⇒ 该替换会**在加载期**污染同进程的其它
 * 测试文件（实测：3 个 real-usage 文件单独跑 17 pass/0 fail，一旦与本文件同批
 * 就变成 9 pass/11 fail；`afterAll` 里调 `mock.restore()` 也来不及，因为污染发生在
 * 执行之前）。故改由兄弟文件 `chat-capture-session.test.ts` 用**子进程**运行本文件，
 * 把 mock 关进独立进程。这也与仓库既有做法一致（见 tests/rigorous/determinism-repro.test.ts）。
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
// A4（2026-09-20）：记录路由收到的 options.taskId —— 用于断言"token 用量与轨迹共用同一任务 id"。
const routerCalls: Array<{ via: string; taskId?: string }> = [];
const MOCK_ASSISTANT = "定位：连接池耗尽导致数据库超时。修复：把最大连接数从 5 提到 10。";
mock.module(path.join(ROOT, "src", "router", "model-router.js"), () => ({
  router: {
    routeByIntent: (_i: string, _m: unknown, opts?: { taskId?: string }) => {
      routerCalls.push({ via: "routeByIntent", taskId: opts?.taskId });
      return { content: MOCK_ASSISTANT, model: "m1", provider: "p1", layer: "code" };
    },
    chat: (_t: unknown, _m: unknown, opts?: { taskId?: string }) => {
      routerCalls.push({ via: "chat", taskId: opts?.taskId });
      return { content: MOCK_ASSISTANT, model: "m1", provider: "p1", layer: "general", usage: { total_tokens: 3 } };
    },
    executeWithRole: (_r: unknown, _m: unknown, opts?: { taskId?: string }) => {
      routerCalls.push({ via: "executeWithRole", taskId: opts?.taskId });
      return { content: MOCK_ASSISTANT, model: "m1", provider: "p1", layer: "general", usage: { total_tokens: 5 } };
    },
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
  // ⚠️ 必须恢复模块 mock：mock.module 是**进程级**替换，会泄漏到同进程后续测试文件
  // （见 tests/proxy-fetch-hardening.test.ts:11 的既有告警）。不恢复的话，只要与本文件
  // 同批运行的 real-usage 系测试都会拿到这里的假实现 —— 实测过：同批 3 个 real-usage
  // 文件单独跑 17 pass / 0 fail，一旦加上本文件就变成 9 pass / 11 fail。
  mock.restore();
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

beforeEach(() => { captured.length = 0; routerCalls.length = 0; });

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

    // A4：路由收到的 taskId 必须与轨迹 id **同一个** —— 这是"按任务把用量与轨迹对上"的前提
    const routed = routerCalls.find((c) => c.taskId !== undefined);
    expect(routed, "路由应收到 options.taskId").toBeDefined();
    expect(routed!.taskId).toBe(hit!.id as string);
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

    const routed = routerCalls.find((c) => c.taskId !== undefined);
    expect(routed).toBeDefined();
    expect(routed!.taskId).toBe(hit!.id as string);
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
