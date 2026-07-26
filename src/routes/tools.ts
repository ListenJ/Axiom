/**
 * Tool Execution API — Standardized frontend-backend tool communication
 *
 * POST /api/tools/execute — Execute a tool by name with parameters
 */
import type { RouteContext } from "./types.js";

export interface ToolExecuteRequest {
  tool: string;
  params: Record<string, unknown>;
}

export interface ToolExecuteResponse {
  success: boolean;
  data: unknown;
  error?: string;
  durationMs: number;
}

export async function handleToolExecute(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/api/tools/execute" || ctx.req.method !== "POST") return null;

  try {
    const body = (await ctx.req.json()) as ToolExecuteRequest;
    const start = Date.now();

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
          } catch {}
        }

        return ctx.jsonResponse({
          success: true,
          data: { results: results.slice(0, maxResults), totalFound: results.length, scopeUsed: needWeb ? "web" : "local" },
          durationMs: Date.now() - start,
        } satisfies ToolExecuteResponse, 200, ctx.baseHeaders);
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

        return ctx.jsonResponse({
          success: true,
          data: { results, totalFound: results.length },
          durationMs: Date.now() - start,
        } satisfies ToolExecuteResponse, 200, ctx.baseHeaders);
      }

      case "knowledge:stats": {
        const vault = ctx.vault;
        const vStats = vault?.stats();
        return ctx.jsonResponse({
          success: true,
          data: { notes: vStats?.totalNotes ?? 0, words: vStats?.totalWords ?? 0, tags: vStats?.totalTags ?? 0 },
          durationMs: Date.now() - start,
        } satisfies ToolExecuteResponse, 200, ctx.baseHeaders);
      }

      default:
        return ctx.jsonResponse({
          success: false,
          data: null,
          error: `Unknown tool: ${body.tool}`,
          durationMs: Date.now() - start,
        } satisfies ToolExecuteResponse, 404, ctx.baseHeaders);
    }
  } catch (err) {
    return ctx.jsonResponse({
      success: false,
      data: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: 0,
    } satisfies ToolExecuteResponse, 500, ctx.baseHeaders);
  }
}
