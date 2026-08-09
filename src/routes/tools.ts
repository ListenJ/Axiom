/**
 * Tool Execution API — Standardized frontend-backend tool communication
 *
 * POST /api/tools/execute — Execute a tool by name with parameters
 */
import type { RouteContext } from "./types.js";
import { logger } from "../utils/logger.js";
import { listToolInvocations, recordToolInvocation } from "../db/tool-invocations.js";

export interface ToolExecuteRequest {
  tool: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface ToolExecuteResponse {
  success: boolean;
  data: unknown;
  error?: string;
  durationMs: number;
}

export async function handleToolExecute(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/api/tools/execute" || ctx.req.method !== "POST") return null;

  let start = 0;
  try {
    const body = (await ctx.req.json()) as ToolExecuteRequest;
    start = Date.now();
    const finish = (payload: ToolExecuteResponse, status: number): Response => {
      try {
        recordToolInvocation(ctx.db, {
          sessionId: body.sessionId,
          tool: body.tool,
          args: body.params,
          result: payload,
          status: payload.success ? "success" : "error",
          latencyMs: Date.now() - start,
        });
      } catch (err) {
        logger.warn("[Tools] Failed to record tool invocation", { tool: body.tool, error: (err as Error).message });
      }
      return ctx.jsonResponse(payload, status, ctx.baseHeaders);
    };

    switch (body.tool) {
      case "query": {
        const query = String(body.params.query ?? "");
        const scope = String(body.params.scope ?? "auto");
        const maxResults = Number(body.params.maxResults ?? 10);

        const vault = ctx.vault;
        const results: Array<{ source: string; title: string; snippet: string; url?: string }> = [];

        if (vault?.search) {
          const local = vault.search(query, { limit: maxResults });
          for (const item of local) {
            results.push({
              source: "local",
              title: item.note.title ?? item.note.path ?? "",
              snippet: (item.note.content ?? item.excerpt ?? "").slice(0, 200),
              url: item.note.path,
            });
          }
        }

        const needWeb = scope === "web" || (scope === "auto" && results.length < 3);
        if (needWeb) {
          try {
            const { searchAggregator } = await import("../crawl/search-engines.js");
            const webResults = await searchAggregator.searchMulti({ query, num: maxResults });
            for (const item of webResults) {
              results.push({ source: "web", title: item.title ?? "", snippet: item.snippet ?? "", url: item.link ?? "" });
            }
          } catch (e) {
            // Web 搜索失败不应阻断整个查询；记录 warning 便于排查，
            // 用户仍可获得 local 结果（scopeUsed 会标注为 "local"）。
            logger.warn("[Tools] Web search failed, returning local results only", {
              query: query.slice(0, 80),
              error: (e as Error).message,
            });
          }
        }

        return finish({
          success: true,
          data: { results: results.slice(0, maxResults), totalFound: results.length, scopeUsed: needWeb ? "web" : "local" },
          durationMs: Date.now() - start,
        }, 200);
      }

      case "knowledge:search": {
        const query = String(body.params.query ?? "");
        const vault = ctx.vault;
        if (!vault?.search) throw new Error("Vault search unavailable");
        const local = vault.search(query, { limit: Number(body.params.limit ?? 10) });
        const results = local.map((item: { note: { title?: string; path?: string; content?: string; paraCategory?: string; tags?: string[] }; excerpt?: string }) => ({
          title: item.note.title ?? item.note.path ?? "",
          snippet: (item.note.content ?? item.excerpt ?? "").slice(0, 300),
          path: item.note.path,
          category: item.note.paraCategory ?? "",
          tags: item.note.tags ?? [],
        }));

        return finish({
          success: true,
          data: { results, totalFound: results.length },
          durationMs: Date.now() - start,
        }, 200);
      }

      case "knowledge:stats": {
        const vault = ctx.vault;
        const vStats = vault?.stats();
        return finish({
          success: true,
          data: { notes: vStats?.totalNotes ?? 0, words: vStats?.totalWords ?? 0, tags: vStats?.totalTags ?? 0 },
          durationMs: Date.now() - start,
        }, 200);
      }

      default:
        return finish({
          success: false,
          data: null,
          error: `Unknown tool: ${body.tool}`,
          durationMs: Date.now() - start,
        }, 404);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      const body = await ctx.req.json().catch(() => ({})) as ToolExecuteRequest;
      recordToolInvocation(ctx.db, {
        sessionId: body.sessionId,
        tool: body.tool ?? "unknown",
        args: body.params,
        result: { success: false, error },
        status: "error",
        latencyMs: Date.now() - start,
      });
    } catch {
      // audit failure must not mask the original error
    }
    return ctx.jsonResponse({
      success: false,
      data: null,
      error,
      durationMs: 0,
    }, 500, ctx.baseHeaders);
  }
}

export async function handleListToolInvocations(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/api/tools/invocations" || ctx.req.method !== "GET") return null;

  const sessionId = ctx.url.searchParams.get("session");
  const limit = Math.min(parseInt(ctx.url.searchParams.get("limit") || "50", 10), 200);
  const invocations = listToolInvocations(ctx.db, sessionId, limit);
  return ctx.jsonResponse({ invocations, count: invocations.length }, 200, ctx.baseHeaders);
}