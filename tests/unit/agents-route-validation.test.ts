/**
 * routes/agents.ts 输入校验（R1 整改首批）行为测试。
 *
 * 锁三件事：
 * 1. 类型/范围非法（temperature 传字符串等）→ 400 + 可读 detail，不透传 LLM 调用；
 * 2. 畸形 JSON → 400 "Invalid JSON body"；
 * 3. 合法体 → 正常走 handler 流程（opencode/open 回显命令 200）。
 *
 * 只 mock RouteContext 中被测 handler 触及的字段（url/req/jsonResponse/baseHeaders）。
 */
import { describe, it, expect } from "bun:test";
import type { RouteContext } from "../../src/routes/types.js";
import {
  handleOpenCodeOpen,
  handleKimiChat,
} from "../../src/routes/agents.js";

function makeCtx(pathname: string, method: string, rawBody?: string): RouteContext {
  const req = new Request(`http://127.0.0.1:18789${pathname}`, {
    method,
    ...(rawBody !== undefined
      ? { body: rawBody, headers: { "content-type": "application/json" } }
      : {}),
  });
  return {
    url: new URL(`http://127.0.0.1:18789${pathname}`),
    req,
    jsonResponse: (data: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers }),
    baseHeaders: {},
  } as unknown as RouteContext;
}

async function bodyOf(res: Response): Promise<{ status: number; error?: string; command?: string }> {
  return { status: res.status, ...(await res.json()) };
}

describe("agents 路由输入校验（R1 首批）", () => {
  it("kimi/chat：temperature 传字符串 ⇒ 400 + detail，不透传", async () => {
    const res = await handleKimiChat(
      makeCtx("/agents/kimi/chat", "POST", JSON.stringify({ prompt: "hi", temperature: "hot" })),
    )!;
    const out = await bodyOf(res!);
    expect(out.status).toBe(400);
    expect(out.error).toContain("temperature");
  });

  it("kimi/chat：timeout 超上限（>600000）⇒ 400", async () => {
    const res = await handleKimiChat(
      makeCtx("/agents/kimi/chat", "POST", JSON.stringify({ prompt: "hi", timeout: 99999999 })),
    )!;
    expect((await bodyOf(res!)).status).toBe(400);
  });

  it("kimi/chat：畸形 JSON ⇒ 400 Invalid JSON body", async () => {
    const res = await handleKimiChat(makeCtx("/agents/kimi/chat", "POST", "{not json"))!;
    const out = await bodyOf(res!);
    expect(out.status).toBe(400);
    expect(out.error).toBe("Invalid JSON body");
  });

  it("opencode/open：合法体 ⇒ 200 回显命令", async () => {
    const res = await handleOpenCodeOpen(
      makeCtx("/agents/opencode/open", "POST", JSON.stringify({ prompt: "fix bug", model: "m1" })),
    )!;
    const out = await bodyOf(res!);
    expect(out.status).toBe(200);
    expect(out.command).toContain("fix bug");
    expect(out.command).toContain("--model=m1");
  });

  it("opencode/open：prompt 超长（>32000）⇒ 400", async () => {
    const res = await handleOpenCodeOpen(
      makeCtx("/agents/opencode/open", "POST", JSON.stringify({ prompt: "x".repeat(32001) })),
    )!;
    expect((await bodyOf(res!)).status).toBe(400);
  });
});
