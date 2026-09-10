/**
 * openai-compat 单元测试 — POST /v1/chat/completions
 *
 * 测试策略（不真实调用 LLM，只测适配层边界）：
 *   - 通过 createOpenAICompatHandler 的依赖接缝注入 fake 管线
 *     （prepareChatContext / executeChat / chatStream），不用 mock.module，
 *     避免同进程全量跑时污染其他测试文件；适配层以外的内部管线不在本测试范围内。
 *   - 最小化 mock RouteContext（仅 url / req / jsonResponse / baseHeaders）。
 *
 * 覆盖：
 *   1. 非流式响应结构（id / object / choices[0].message / usage）
 *   2. 流式 SSE 帧格式（chat.completion.chunk delta + finish_reason:stop + [DONE] 终止）
 *   3. 非法请求体 → 400（非 JSON、缺 messages、空数组、消息结构非法）
 *   4. 路径/方法不匹配 → 返回 null（交由后续 handler / 404）
 */
import { describe, it, expect } from "bun:test";
import type { RouteContext } from "../src/routes/types.js";
import { createOpenAICompatHandler, type OpenAICompatDeps } from "../src/routes/openai-compat.js";

// ── fake 内部 chat 管线（不真实调 LLM，只测适配层边界）──
// 通过 createOpenAICompatHandler 的依赖接缝注入 fake，不用 mock.module——
// 避免 bun 同进程全量跑时原地改写模块污染 services-chat.test.ts 等文件。
const fakeDeps = {
  prepareChatContext: async (messages: Array<{ role: string; content: string }>) => ({
    chatMessages: messages,
    intentInfo: null,
    codegraphContext: "",
  }),
  executeChat: async () => ({
    content: "Hello from fake LLM",
    model: "fake-model",
    provider: "fake",
    layer: "general",
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  }),
  chatStream: async function* () {
    yield { type: "start", model: "fake-model", provider: "fake", role: "general-chat" };
    yield { type: "token", content: "Hello" };
    yield { type: "token", content: " world" };
    yield {
      type: "done",
      content: "Hello world",
      model: "fake-model",
      provider: "fake",
      fallbackUsed: false,
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    };
  },
} as unknown as OpenAICompatDeps;

/** 构造最小化 mock RouteContext */
function makeCtx(body: string | null, pathname = "/v1/chat/completions", method = "POST"): RouteContext {
  const req = new Request("https://example.com" + pathname, {
    method,
    ...(body !== null
      ? { headers: { "Content-Type": "application/json" }, body }
      : {}),
  });
  return {
    url: new URL(req.url),
    req,
    vault: null,
    db: {} as never,
    pipeline: {} as never,
    healthMonitor: {} as never,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200, extra?: Record<string, string>) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...(extra ?? {}) },
      }),
  };
}

const VALID_BODY = JSON.stringify({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
});

function getHandler() {
  return createOpenAICompatHandler(fakeDeps);
}

describe("handleOpenAIChatCompletions — 非流式", () => {
  it("返回 OpenAI chat.completion 结构", async () => {
    const handler = await getHandler();
    const res = await handler(makeCtx(VALID_BODY));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      id: string;
      object: string;
      created: number;
      model: string;
      choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.id).toStartWith("chatcmpl-");
    expect(body.object).toBe("chat.completion");
    expect(typeof body.created).toBe("number");
    expect(body.model).toBe("gpt-4o-mini"); // model 字段透传回显
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].index).toBe(0);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello from fake LLM");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });
});

describe("handleOpenAIChatCompletions — 流式 SSE", () => {
  it("返回 chat.completion.chunk 帧并以 [DONE] 终止", async () => {
    const handler = await getHandler();
    const streamBody = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const res = await handler(makeCtx(streamBody));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/event-stream");

    const text = await res!.text();
    // 首帧：role delta
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"delta":{"role":"assistant"}');
    // token 增量帧
    expect(text).toContain('"delta":{"content":"Hello"}');
    expect(text).toContain('"delta":{"content":" world"}');
    // 结束帧：finish_reason + usage
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"total_tokens":8');
    // [DONE] 终止标记（最后一帧）
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // 每条 SSE 消息以 \n\n 分隔
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: {"));
    expect(frames.length).toBeGreaterThanOrEqual(4); // role + 2 token + done
    for (const frame of frames) {
      expect(() => JSON.parse(frame.slice("data: ".length))).not.toThrow();
    }
  });
});

describe("handleOpenAIChatCompletions — 非法请求体 400", () => {
  it("非 JSON body → 400", async () => {
    const handler = await getHandler();
    const res = await handler(makeCtx("this is not json"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("缺少 messages → 400", async () => {
    const handler = await getHandler();
    const res = await handler(makeCtx(JSON.stringify({ model: "m" })));
    expect(res!.status).toBe(400);
  });

  it("messages 为空数组 → 400", async () => {
    const handler = await getHandler();
    const res = await handler(makeCtx(JSON.stringify({ messages: [] })));
    expect(res!.status).toBe(400);
  });

  it("消息缺少 content 字段 → 400", async () => {
    const handler = await getHandler();
    const res = await handler(makeCtx(JSON.stringify({ messages: [{ role: "user" }] })));
    expect(res!.status).toBe(400);
  });
});

describe("handleOpenAIChatCompletions — 路由匹配", () => {
  it("其他路径返回 null（不拦截）", async () => {
    const handler = await getHandler();
    const res = await handler(makeCtx(VALID_BODY, "/chat"));
    expect(res).toBeNull();
  });

  it("GET 方法返回 null（不拦截）", async () => {
    const handler = await getHandler();
    const res = await handler(makeCtx(null, "/v1/chat/completions", "GET"));
    expect(res).toBeNull();
  });
});
