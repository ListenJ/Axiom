/**
 * Settings routes — 设置目录与语义搜索
 *
 * GET  /settings/catalog — 返回设置目录（无敏感值）
 * POST /settings/search  — 语义搜索（本地 embedding → 路由 embedding → 关键词兜底）
 */
import type { RouteContext } from "./types.js";
import { SETTING_SECTIONS, SETTINGS_CATALOG } from "../core/settings-catalog.js";
import { searchSettings } from "../core/settings-search.js";

export async function handleSettingsCatalog(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/settings/catalog" || ctx.req.method !== "GET") return null;
  return ctx.jsonResponse(
    { sections: SETTING_SECTIONS, items: SETTINGS_CATALOG },
    200,
    ctx.baseHeaders,
  );
}

export async function handleSettingsSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/settings/search" || ctx.req.method !== "POST") return null;
  try {
    const body = (await ctx.req.json()) as { q?: string; limit?: number };
    const q = (body.q ?? "").trim();
    if (!q) {
      return ctx.jsonResponse({ error: "Missing q param" }, 400, ctx.baseHeaders);
    }
    const result = await searchSettings(q, { limit: body.limit });
    return ctx.jsonResponse(result, 200, ctx.baseHeaders);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return ctx.jsonResponse({ error: msg }, 500, ctx.baseHeaders);
  }
}