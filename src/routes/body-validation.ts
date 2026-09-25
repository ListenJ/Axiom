/**
 * 路由 body 读取 + schema 校验的共享缝（R1 整改线统一口径）。
 *
 * 与 chat.ts（M11）/agents.ts（R1 首批）同一错误形状：
 *   畸形 JSON → 400 "Invalid JSON body"
 *   校验失败 → 400 "Invalid request body — <首条 issue 路径: 消息>"
 */
import { z } from "zod";
import type { RouteContext } from "./types.js";

export async function readValidatedJson<T>(
  ctx: RouteContext,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await ctx.req.json();
  } catch {
    return { ok: false, response: ctx.jsonResponse({ error: "Invalid JSON body" }, 400, ctx.baseHeaders) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "validation failed";
    return { ok: false, response: ctx.jsonResponse({ error: `Invalid request body — ${detail}` }, 400, ctx.baseHeaders) };
  }
  return { ok: true, data: parsed.data };
}
