/**
 * P0-B（2026-08-29）跨会话记忆闭环测试 — 会话自动归档 + chat bootstrap 召回
 *
 * 来源：docs/superpowers/specs/2026-08-29-p0-lift-design.md §B
 *
 * 覆盖行为（公共接口：POST /chat 路由 + prepareChatContext 服务）：
 *   1. 非空响应后 writeConversationLog 被调用（vault 文件落在临时目录）；
 *   2. MemoryGate 拒绝（限流）时不写；
 *   3. vault 不可用 / 写入抛错 → 响应不受影响（降级）；
 *   4. 同 sessionId 二次请求 system prompt 含 bootstrap 内容且 bootstrap 仅加载一次（缓存）；
 *   5. 无 sessionId → 跳过 bootstrap；
 *   6. bootstrap 失败 → 降级现状（不抛、无 marker）。
 *
 * 测试模式与 tests/routes-chat-validation.test.ts 相同：mock 重型协作者
 * （model-router），保持 routes/chat + services/chat 真实逻辑；vault 用真实
 * VaultManager 指向临时目录（断言落盘）；隐私模式关闭一切外发 LLM 调用。
 */
import { describe, it, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");

// ── 环境隔离（在被测调用发生前设置；readString 每次调用时读取）──
// 隐私模式（R6）：关闭 GLM 改写与联网知识检索，测试零外发请求。
// bun test 同进程跑多个文件，env 是进程级共享状态：保存原值，afterAll 恢复，
// 避免污染后续测试文件（曾致 memory-edge-assist 用例在合并运行时误判）。
const ENV_ORIGINALS: Array<[string, string | undefined]> = [];
function setEnv(key: string, value: string): void {
  ENV_ORIGINALS.push([key, process.env[key]]);
  process.env[key] = value;
}
setEnv("AXIOM_PRIVACY_MODE", "1");
setEnv("PROMPT_REWRITE", "0");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-chat-memory-"));
setEnv("SQLITE_MEMORY_DB", path.join(TMP, "memory.db"));
const VAULT_DIR = path.join(TMP, "vault");
fs.mkdirSync(VAULT_DIR, { recursive: true });
// 路由测试走默认 AgentBootstrap（无注入 deps）时，vault 也必须指向临时目录，
// 避免读写仓库内真实 ./axiom-memory（ensureDailyNote 会真实落盘）
setEnv("OBSIDIAN_VAULT_PATH", VAULT_DIR);

afterAll(() => {
  for (const [key, value] of ENV_ORIGINALS) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// mock 主模型路由（与 routes-chat-validation.test.ts 同一接缝）
// 助手响应：含代码块 + 技术术语 + >500 字符 → MemoryGate 显著性判定可确定性通过
const MOCK_ASSISTANT = [
  "问题定位：该 API 由连接池耗尽导致超时。",
  "```ts",
  "const pool = new ConnectionPool({ max: 10 });",
  "await pool.query('SELECT 1');",
  "```",
  ("修复：将最大连接数从 5 提升到 10，并在请求结束时释放连接。" +
    "补充：该 server 数据库接口函数框架在高并发场景下需要持续监控连接池水位与超时率。").repeat(5),
].join("\n");

mock.module(path.join(ROOT, "src", "router", "model-router.js"), () => ({
  router: {
    routeByIntent: () => ({ content: "routed", model: "m1", provider: "p1", layer: "code" }),
    chat: () => ({ content: "ok", model: "m1", provider: "p1", layer: "general", usage: { total_tokens: 1 } }),
    // handleChat 始终携带 tools + role → 走 executeWithRole
    executeWithRole: () => ({ content: MOCK_ASSISTANT, model: "m1", provider: "p1", layer: "general", usage: { total_tokens: 5 } }),
  },
}));

let handleChat!: typeof import("../src/routes/chat.js")["handleChat"];
let archiveExchangeToVault!: typeof import("../src/routes/chat.js")["archiveExchangeToVault"];
let prepareChatContext!: typeof import("../src/services/chat.js")["prepareChatContext"];
let resetSessionBootstrapCache!: typeof import("../src/memory/bootstrap.js")["resetSessionBootstrapCache"];
let getMemoryGate!: typeof import("../src/memory/memory-gate.js")["getMemoryGate"];

// 真实 VaultManager 指向临时 vault（断言 04-Conversations 落盘），SQLite 索引走临时 db
const { VaultManager } = await import("../src/memory/vault-manager.js");
const testVault = new VaultManager({ vaultPath: VAULT_DIR });

beforeAll(async () => {
  const routes = await import("../src/routes/chat.js");
  handleChat = routes.handleChat;
  archiveExchangeToVault = routes.archiveExchangeToVault;
  const services = await import("../src/services/chat.js");
  prepareChatContext = services.prepareChatContext;
  const bootstrap = await import("../src/memory/bootstrap.js");
  resetSessionBootstrapCache = bootstrap.resetSessionBootstrapCache;
  const gate = await import("../src/memory/memory-gate.js");
  getMemoryGate = gate.getMemoryGate;
});

const CODE_QUESTION = "帮我调试一个 api 接口的 bug，连接池耗尽导致数据库超时";

/** 轻量 fake db：捕获 conversations 插入，getSessionMessages 返回真实行 */
function makeFakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    run: (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO conversations")) {
        const p = params ?? [];
        rows.push({
          session_id: p[0], agent_id: p[1], role: p[2], content: p[3],
          tool_calls: p[4] ?? null, tool_results: p[5] ?? null,
          tokens_used: p[6] ?? 0, latency_ms: p[7] ?? 0,
          created_at: Math.floor(Date.now() / 1000),
        });
      }
    },
    query: (sql: string) => ({
      get: () => (sql.includes("COUNT(*)") ? { count: 0, tokens: 0 } : undefined),
      all: (...args: unknown[]) => {
        if (sql.includes("FROM conversations")) {
          return rows
            .filter((r) => r.session_id === args[0])
            .map((r, i) => ({ id: i + 1, ...r }));
        }
        return [];
      },
    }),
    prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
  } as any;
}

/** 递归查找 vault 下文件名含片段的会话笔记 */
function findConversationNote(fragment: string): string | null {
  const base = path.join(VAULT_DIR, "04-Conversations");
  if (!fs.existsSync(base)) return null;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.includes(fragment)) return full;
    }
  }
  return null;
}

async function waitFor(fn: () => unknown, timeoutMs = 2000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

function makeCtx(overrides: { sessionId?: string; vault?: unknown } = {}) {
  const body: Record<string, unknown> = {
    messages: [{ role: "user", content: CODE_QUESTION }],
    sessionId: overrides.sessionId,
  };
  const req = new Request("http://x/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    url: new URL("http://x/chat"),
    req,
    vault: overrides.vault !== undefined ? overrides.vault : testVault,
    db: makeFakeDb(),
    pipeline: null,
    healthMonitor: null,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }),
  } as any;
}

// ═══════════════ A. 会话自动归档 ═══════════════

describe("P0-B 会话自动归档", () => {
  it("非空响应后 writeConversationLog 落盘 04-Conversations（临时 vault）", async () => {
    const res = (await handleChat(makeCtx({ sessionId: "pos1-aaaa" }))) as Response;
    expect(res.status).toBe(200);

    const notePath = (await waitFor(() => findConversationNote("pos1-aa"))) as string | null;
    expect(notePath).toBeTruthy();
    const note = fs.readFileSync(notePath!, "utf-8");
    expect(note).toContain(CODE_QUESTION);       // user 侧
    expect(note).toContain("连接池耗尽");           // assistant 侧
    expect(note).toContain("pos1-aaaa");          // sessionId 元信息
  });

  it("MemoryGate 拒绝（小时限流填满）→ 不写 vault", async () => {
    // 填满全局 gate 的每小时限流（20/h）→ shouldWrite 直接 skip
    const gate = getMemoryGate();
    for (let i = 0; i < 25; i++) gate.recordWrite(`hash-${i}`, `p-${i}`);

    const res = (await handleChat(makeCtx({ sessionId: "deny1-aaa" }))) as Response;
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe(MOCK_ASSISTANT);

    // 给归档异步路径足够的完成窗口，仍不应出现文件
    await new Promise((r) => setTimeout(r, 800));
    expect(findConversationNote("deny1-aa")).toBeNull();
  });

  it("vault 不可用（null）→ 静默跳过，响应正常", async () => {
    const res = (await handleChat(makeCtx({ sessionId: "novlt-aaa", vault: null }))) as Response;
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe(MOCK_ASSISTANT);
  });

  it("vault.writeConversationLog 抛错 → 静默 debug，响应正常", async () => {
    const throwingVault = {
      writeConversationLog: async () => { throw new Error("disk full"); },
    };
    const res = (await handleChat(makeCtx({ sessionId: "throw-aaa", vault: throwingVault }))) as Response;
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe(MOCK_ASSISTANT);
  });

  it("archiveExchangeToVault 直调：空响应不触发写、vault null 直接返回", async () => {
    const calls: string[] = [];
    const spy = {
      writeConversationLog: async (sid: string) => { calls.push(sid); return "p"; },
    };
    await archiveExchangeToVault(spy as any, makeFakeDb(), "direct-aaa", {
      userContent: "q", assistantContent: "   ", gateTaskType: "coding",
    });
    await archiveExchangeToVault(null, makeFakeDb(), "direct-aaa", {
      userContent: "q", assistantContent: "answer", gateTaskType: "coding",
    });
    expect(calls).toEqual([]);
  });
});

// ═══════════════ B. bootstrap 召回注入 ═══════════════

const BOOTSTRAP_MARKER = "BOOTSTRAP-MARKER-XYZ";

function makeFakeBootstrap() {
  const runCalls: string[] = [];
  return {
    runCalls,
    bootstrap: {
      run: async (opts?: { topic?: string }) => {
        runCalls.push(opts?.topic ?? "");
        return {
          personality: "P", identity: "I", userPreferences: "U",
          dailyLog: "", relevantMemories: [],
          systemStatus: { version: "t", vaultNotes: 0, availableModels: [], lastBoot: "t" },
          bootTime: "t",
        };
      },
      toSystemPrompt: () => BOOTSTRAP_MARKER,
    } as any,
  };
}

describe("P0-B bootstrap 召回注入", () => {
  beforeEach(() => {
    resetSessionBootstrapCache();
  });

  it("同 sessionId 二次请求：system prompt 含 bootstrap 内容且仅加载一次", async () => {
    const { bootstrap, runCalls } = makeFakeBootstrap();
    const messages = [{ role: "user", content: CODE_QUESTION }];

    const first = await prepareChatContext(messages, true, null, { sessionId: "boot-sess-1", bootstrap });
    const second = await prepareChatContext(messages, true, null, { sessionId: "boot-sess-1", bootstrap });

    expect(runCalls.length).toBe(1);
    expect(first.chatMessages[0].role).toBe("system");
    expect(first.chatMessages[0].content).toContain(BOOTSTRAP_MARKER);
    expect(second.chatMessages[0].content).toContain(BOOTSTRAP_MARKER);
    // 与宪法并存
    expect(first.chatMessages[0].content).toContain("宪法版本");
    expect(first.chatMessages[0].content).toContain("You are Axiom");
  });

  it("无 sessionId → 跳过 bootstrap", async () => {
    const { bootstrap, runCalls } = makeFakeBootstrap();
    await prepareChatContext([{ role: "user", content: CODE_QUESTION }], true, null, { bootstrap });
    expect(runCalls.length).toBe(0);
  });

  it("bootstrap 失败 → 降级现状（不抛、无 marker、保留人格/宪法）", async () => {
    const failing = {
      run: async () => { throw new Error("vault down"); },
      toSystemPrompt: () => BOOTSTRAP_MARKER,
    } as any;
    const result = await prepareChatContext(
      [{ role: "user", content: CODE_QUESTION }], true, null, { sessionId: "boot-fail-1", bootstrap: failing },
    );
    expect(result.chatMessages[0].role).toBe("system");
    expect(result.chatMessages[0].content).not.toContain(BOOTSTRAP_MARKER);
    expect(result.chatMessages[0].content).toContain("You are Axiom");
  });
});
