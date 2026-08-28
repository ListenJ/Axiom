/**
 * M11 审计修复：POST /chat 请求体 zod 校验（此前 body 零校验直接解构）
 *
 * Contract:
 *   - 合法体（messages 数组 + 可选字段类型正确）→ 200，行为不变；
 *   - 缺 messages / messages 非数组 / message 缺 role|content → 400 + 简明错误；
 *   - 空 messages 数组仍合法（对齐旧默认 `messages = []` 行为）。
 *
 * 测试模式与 tests/services-chat.test.ts 相同：mock 重型协作者（model-router /
 * self-evolve barrel），保持 services/chat 真实逻辑；intent=false 绕过 LLM 意图链。
 */
import { describe, it, expect, mock, beforeAll } from "bun:test";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");

// Mock 重型协作者（绝对路径，与 services-chat.test.ts 同一接缝）。
// 注意：不要 mock src/self-evolve/index.js —— Bun 的 mock.module 会沿 barrel
// re-export 链污染 src/self-evolve/engine.js 的真实导出（曾在并行 worker 中
// 导致 tests/self-evolve/apply-self-thought.test.ts 失败）。真实的 applySelfThought
// 失败兜底（catch → 原样返回）+ 已 mock 的 model-router 足以保证确定性。
mock.module(path.join(ROOT, "src", "router", "model-router.js"), () => ({
  router: {
    routeByIntent: () => ({ content: "routed", model: "m1", provider: "p1", layer: "code" }),
    chat: () => ({ content: "ok", model: "m1", provider: "p1", layer: "general", usage: { total_tokens: 1 } }),
    // handleChat 始终携带 tools + role → runToolLoop 走 executeWithRole；
    // self-evolve engine.think 亦经此返回非 JSON 文本 → 走 fallback thought
    executeWithRole: () => ({ content: "ok", model: "m1", provider: "p1", layer: "general", usage: { total_tokens: 1 } }),
  },
}));

let handleChat!: typeof import("../src/routes/chat.js")["handleChat"];
let chatRequestSchema!: import("zod").ZodTypeAny;

beforeAll(async () => {
  const mod = await import("../src/routes/chat.js");
  handleChat = mod.handleChat;
  chatRequestSchema = mod.chatRequestSchema;
});

function makeCtx(urlStr: string, body: unknown) {
  const req = new Request(urlStr, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // 轻量 fake db：persistChatMessage/refreshSessionLineage 只做 run/query；
  // COUNT(*)（stats）返回对象，其余 SELECT get 返回 undefined（可选链安全）
  const fakeDb = {
    run: () => {},
    query: (sql: string) => ({
      get: () => (sql.includes("COUNT(*)") ? { count: 0, tokens: 0 } : undefined),
      all: () => [],
    }),
    prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
  };
  return {
    url: new URL(urlStr),
    req,
    vault: null,
    db: fakeDb,
    pipeline: null,
    healthMonitor: null,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }),
  } as any;
}

describe("M11: POST /chat 请求体校验", () => {
  it("合法体 → 200 且 sessionId 透传（行为不变）", async () => {
    const res = (await handleChat(makeCtx("http://x/chat", {
      messages: [{ role: "user", content: "hello" }],
      taskType: "general-chat",
      intent: false,
      sessionId: "sess-m11",
    }))) as Response;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessionId).toBe("sess-m11");
    expect(data.content).toBe("ok");
  });

  it("空 messages 数组仍合法（对齐旧默认行为）", async () => {
    const res = (await handleChat(makeCtx("http://x/chat", { messages: [], intent: false }))) as Response;
    expect(res.status).toBe(200);
  });

  it("缺 messages → 400", async () => {
    const res = (await handleChat(makeCtx("http://x/chat", { taskType: "general-chat" }))) as Response;
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.error).toBe("string");
  });

  it("messages 非数组 → 400", async () => {
    const res = (await handleChat(makeCtx("http://x/chat", { messages: "hi" }))) as Response;
    expect(res.status).toBe(400);
  });

  it("message 缺 content → 400（与 /chat/stream 校验对齐）", async () => {
    const res = (await handleChat(makeCtx("http://x/chat", { messages: [{ role: "user" }] }))) as Response;
    expect(res.status).toBe(400);
  });

  it("chatRequestSchema：intent 可选、budget 接受 number 或对象、未知字段剥离", () => {
    const parsed = chatRequestSchema.parse({
      messages: [{ role: "user", content: "x", name: "extra" }],
      budget: 1024,
      taskType: "coding",
    }) as any;
    expect(parsed.messages[0].name).toBe("extra");
    expect(parsed.budget).toBe(1024);
    expect(parsed.intent).toBeUndefined();
    expect((parsed as Record<string, unknown>).evil).toBeUndefined();
  });
});
