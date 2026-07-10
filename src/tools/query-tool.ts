/**
 * QueryTool — 搜索/查询基元 (网络 + 本地知识)
 *
 * 自适应: 先查本地知识库，不满足则自动触发网络搜索
 */
import type { Tool, ToolInput, ToolOutput } from "./types.js";
import { createToolOutput } from "./types.js";

export interface QueryInput {
  query: string;
  /** 搜索范围: "auto" | "web" | "local" | "knowledge" */
  scope?: "auto" | "web" | "local" | "knowledge";
  maxResults?: number;
}

export interface QueryResult {
  source: string;
  title: string;
  snippet: string;
  url?: string;
  relevance?: number;
}

export interface QueryOutput {
  results: QueryResult[];
  totalFound: number;
  scopeUsed: string;
}

export const queryTool: Tool<QueryInput, QueryOutput> = {
  name: "query",
  description: "搜索网络或本地知识库",
  consumesModelToken: false,

  validate(input: QueryInput): string | null {
    if (!input.query || input.query.length === 0) return "query is required";
    return null;
  },

  async execute(ctx: ToolInput<QueryInput>): Promise<ToolOutput<QueryOutput>> {
    const start = Date.now();
    let { query, scope, maxResults } = ctx.payload;
    scope = scope ?? "auto";
    maxResults = maxResults ?? 10;
    const results: QueryResult[] = [];

    // 1. 本地知识库搜索（始终执行）
    const store = ctx.context.localStore;
    const vault = store.get("vaultManager") as import("../memory/vault-manager.js").VaultManager | undefined;
    const kg = store.get("knowledgeGraph") as { queryNL?(query: string): Promise<{ nodes?: Array<{ name?: string; id?: string; content?: string }> }> } | undefined;

    if (vault?.search) {
      try {
        const local = vault.search(query, { limit: maxResults });
        for (const item of local) {
          results.push({
            source: "local",
            title: item.note.title ?? item.note.path ?? "",
            snippet: (item.note.content ?? item.excerpt ?? "").slice(0, 200),
            relevance: 0.9,
          });
        }
      } catch { /* 非致命 */ }
    }

    // KG 搜索
    if (kg?.queryNL) {
      try {
        const kgResult = await kg.queryNL(query);
        if (kgResult.nodes) {
          for (const node of kgResult.nodes.slice(0, 5)) {
            results.push({
              source: "knowledge-graph",
              title: node.name ?? node.id ?? "",
              snippet: (node.content ?? "").slice(0, 200),
              relevance: 0.8,
            });
          }
        }
      } catch { /* 非致命 */ }
    }

    // 2. 本地结果不足时触发网络搜索
    const needWeb = scope === "web" || (scope === "auto" && results.length < 3);

    if (needWeb) {
      try {
        const searchEngine = store.get("searchEngine") as { search?(query: string, opts?: { limit?: number }): Promise<Array<{ title?: string; snippet?: string; content?: string; url?: string; link?: string }>> } | undefined;
        let webResults: any[] = [];

        if (searchEngine?.search) {
          webResults = await searchEngine.search(query, { limit: maxResults });
        } else {
          // 直连 DuckDuckGo (无需 API Key)
          const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
          const html = await resp.text();
          // 简易解析
          const snippetRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
          let match;
          let count = 0;
          while ((match = snippetRegex.exec(html)) !== null && count < maxResults!) {
            webResults.push({
              title: match[2].replace(/<[^>]*>/g, "").trim(),
              url: match[1],
              snippet: "",
            });
            count++;
          }
        }

        for (const item of webResults) {
          results.push({
            source: "web",
            title: item.title ?? "",
            snippet: item.snippet ?? item.content ?? "",
            url: item.url ?? item.link ?? "",
            relevance: 0.7,
          });
        }
      } catch (err) {
        // 网络搜索失败不阻塞
        ctx.context.localStore.set("lastSearchError", String(err));
      }
    }

    results.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

    return createToolOutput({
      results: results.slice(0, maxResults),
      totalFound: results.length,
      scopeUsed: needWeb ? "web-enhanced" : scope,
    }, start);
  },
};
