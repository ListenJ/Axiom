/**
 * 扩展搜索引擎实现
 *
 * 背景：`config/web-search.yaml` 里列了十余个引擎，而 `search-engines.ts` 原本只实现了
 * 4 个（duckduckgo / bing / bing-html / searxng）。配置里出现、代码里没有 = "有形状无行为"，
 * 因此这里把其余引擎**真正实现**，再由 `SearchAggregator` 注册。
 *
 * 分两类：
 *   - **匿名引擎**：无需任何 Key，装完即可用（wikipedia / google-news / hackernews /
 *     github / arxiv / crossref / openlibrary）
 *   - **需 Key 引擎**：注册后赠送免费额度的服务（tavily / brave / jina-reader /
 *     google-cse / serper）；没有 Key 时 `search()` 直接返回空数组并记录日志，
 *     不会抛错、不会影响其他引擎。
 *
 * 约定：所有引擎都必须遵守"**失败返回空数组**"而不是抛错 —— 单个引擎挂掉不应
 * 让整次搜索失败（聚合层已有兜底，但引擎侧先自我收敛更清晰）。
 */

import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";
import {
  SearchEngine,
  type SearchEngineResult,
  type SearchFetch,
  type SearchOptions,
} from "./search-engines.js";

// ── 公共小工具 ────────────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 解码常见 HTML 实体（RSS / 摘要里很常见） */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** 去掉标签、压缩空白、解码实体 —— 用于 RSS/Atom 的 HTML 片段 */
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function toResult(
  engine: string,
  index: number,
  r: { title?: string; link?: string; snippet?: string; date?: string },
): SearchEngineResult {
  const link = r.link ?? "";
  return {
    position: index + 1,
    title: r.title ?? "",
    link,
    displayedUrl: link,
    snippet: r.snippet ?? "",
    date: r.date,
    source: extractDomain(link),
    engine,
  };
}

/** 从 RSS/Atom XML 里抽取 <item>/<entry> 列表（够用即可，不引入 XML 依赖） */
function parseFeed(xml: string): Array<{ title: string; link: string; snippet: string; date?: string }> {
  const out: Array<{ title: string; link: string; snippet: string; date?: string }> = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const b of blocks) {
    const pick = (tag: string): string => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? m[1] : "";
    };
    let link = pick("link").trim();
    if (!link) {
      // Atom 常见形式： <link href="..."/>
      const href = b.match(/<link[^>]*href="([^"]+)"/i);
      if (href) link = href[1];
    }
    const title = stripTags(pick("title"));
    const snippet = stripTags(pick("description") || pick("summary") || pick("content"));
    const date = stripTags(pick("pubDate") || pick("updated") || pick("published")) || undefined;
    if (link) out.push({ title, link, snippet, date });
  }
  return out;
}

/** 需 Key 引擎的统一前置检查：没 Key 就安静地返回空 */
function requireKey(engine: string, envName: string): string | null {
  const key = readString(envName, "");
  if (!key) {
    logger.debug(`[SearchEngine] ${engine}: ${envName} 未配置，跳过`);
    return null;
  }
  return key;
}

// ══════════════════════════════════════════════════════════════════════════
// 匿名引擎
// ══════════════════════════════════════════════════════════════════════════

/** 维基百科（MediaWiki API）—— 概念性查询好，时效性差 */
export class WikipediaEngine extends SearchEngine {
  readonly name = "wikipedia";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    try {
      const lang = (opts.lang ?? "zh").slice(0, 2).toLowerCase() || "zh";
      const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
      url.searchParams.set("action", "query");
      url.searchParams.set("list", "search");
      url.searchParams.set("srsearch", opts.query);
      url.searchParams.set("srlimit", String(Math.min(opts.num ?? 5, 20)));
      url.searchParams.set("format", "json");
      url.searchParams.set("origin", "*");

      const res = await this.fetch(url.toString(), {});
      if (!res.ok) throw new Error(`wikipedia ${res.status}`);
      const data = (await res.json()) as { query?: { search?: Array<{ title?: string; snippet?: string; timestamp?: string }> } };
      return (data.query?.search ?? []).map((r, i) =>
        toResult(this.name, i, {
          title: r.title,
          link: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent((r.title ?? "").replace(/ /g, "_"))}`,
          snippet: stripTags(r.snippet ?? ""),
          date: r.timestamp,
        }),
      );
    } catch (e) {
      logger.warn(`[SearchEngine] wikipedia failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** Google News（RSS）—— 新闻时效性好，无需 Key */
export class GoogleNewsEngine extends SearchEngine {
  readonly name = "google-news";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    try {
      const lang = opts.lang ?? "zh-CN";
      const region = opts.region ?? (lang.startsWith("zh") ? "CN" : "US");
      const url = new URL("https://news.google.com/rss/search");
      url.searchParams.set("q", opts.site ? `${opts.query} site:${opts.site}` : opts.query);
      url.searchParams.set("hl", lang);
      url.searchParams.set("gl", region);
      url.searchParams.set("ceid", `${region}:${lang.split("-")[0]}`);

      const res = await this.fetch(url.toString(), {});
      if (!res.ok) throw new Error(`google-news ${res.status}`);
      const items = parseFeed(await res.text());
      return items.slice(0, opts.num ?? 5).map((r, i) => toResult(this.name, i, r));
    } catch (e) {
      logger.warn(`[SearchEngine] google-news failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** Hacker News（Algolia API）—— 技术圈讨论与热点 */
export class HackerNewsEngine extends SearchEngine {
  readonly name = "hackernews";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    try {
      const url = new URL("https://hn.algolia.com/api/v1/search");
      url.searchParams.set("query", opts.query);
      url.searchParams.set("hitsPerPage", String(Math.min(opts.num ?? 5, 20)));
      url.searchParams.set("tags", "story");

      const res = await this.fetch(url.toString(), {});
      if (!res.ok) throw new Error(`hackernews ${res.status}`);
      const data = (await res.json()) as {
        hits?: Array<{ title?: string; story_title?: string; url?: string; story_url?: string; objectID?: string; created_at?: string; story_text?: string }>;
      };
      return (data.hits ?? []).map((h, i) => {
        const link = h.url || h.story_url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : "");
        return toResult(this.name, i, {
          title: h.title || h.story_title,
          link,
          snippet: stripTags(h.story_text ?? ""),
          date: h.created_at,
        });
      }).filter((r) => r.link);
    } catch (e) {
      logger.warn(`[SearchEngine] hackernews failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** GitHub 仓库搜索 —— 匿名有速率限制，填 GITHUB_TOKEN 提高额度 */
export class GitHubSearchEngine extends SearchEngine {
  readonly name = "github";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    try {
      const url = new URL("https://api.github.com/search/repositories");
      url.searchParams.set("q", opts.query);
      url.searchParams.set("per_page", String(Math.min(opts.num ?? 5, 20)));
      const token = readString("GITHUB_TOKEN", "");
      const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await this.fetch(url.toString(), { headers });
      if (!res.ok) throw new Error(`github ${res.status}`);
      const data = (await res.json()) as {
        items?: Array<{ full_name?: string; html_url?: string; description?: string; updated_at?: string; stargazers_count?: number }>;
      };
      return (data.items ?? []).map((r, i) => {
        const base = toResult(this.name, i, {
          title: r.full_name,
          link: r.html_url,
          snippet: r.description ?? "",
          date: r.updated_at,
        });
        return { ...base, richSnippets: { stars: r.stargazers_count ?? 0 } };
      });
    } catch (e) {
      logger.warn(`[SearchEngine] github failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** arXiv（Atom API）—— 预印本论文 */
export class ArxivEngine extends SearchEngine {
  readonly name = "arxiv";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    try {
      const url = new URL("https://export.arxiv.org/api/query");
      url.searchParams.set("search_query", `all:${opts.query}`);
      url.searchParams.set("max_results", String(Math.min(opts.num ?? 5, 20)));
      url.searchParams.set("sortBy", "relevance");

      const res = await this.fetch(url.toString(), {});
      if (!res.ok) throw new Error(`arxiv ${res.status}`);
      const items = parseFeed(await res.text());
      return items.slice(0, opts.num ?? 5).map((r, i) => toResult(this.name, i, r));
    } catch (e) {
      logger.warn(`[SearchEngine] arxiv failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** Crossref —— 正式发表文献的 DOI 元数据 */
export class CrossrefEngine extends SearchEngine {
  readonly name = "crossref";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    try {
      const url = new URL("https://api.crossref.org/works");
      url.searchParams.set("query", opts.query);
      url.searchParams.set("rows", String(Math.min(opts.num ?? 5, 20)));
      // 礼貌池：带上联系方式可获得更稳定的服务
      url.searchParams.set("mailto", readString("CROSSREF_MAILTO", "axiom-agent@localhost"));

      const res = await this.fetch(url.toString(), {});
      if (!res.ok) throw new Error(`crossref ${res.status}`);
      const data = (await res.json()) as {
        message?: { items?: Array<{ title?: string[]; DOI?: string; URL?: string; abstract?: string; issued?: { "date-parts"?: number[][] } }> };
      };
      return (data.message?.items ?? []).map((it, i) => {
        const doi = it.DOI ?? "";
        const dateParts = it.issued?.["date-parts"]?.[0];
        return toResult(this.name, i, {
          title: it.title?.[0] ?? doi,
          link: it.URL || (doi ? `https://doi.org/${doi}` : ""),
          snippet: stripTags(it.abstract ?? ""),
          date: dateParts ? dateParts.join("-") : undefined,
        });
      }).filter((r) => r.link);
    } catch (e) {
      logger.warn(`[SearchEngine] crossref failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** Open Library —— 图书检索 */
export class OpenLibraryEngine extends SearchEngine {
  readonly name = "openlibrary";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    try {
      const url = new URL("https://openlibrary.org/search.json");
      url.searchParams.set("q", opts.query);
      url.searchParams.set("limit", String(Math.min(opts.num ?? 5, 20)));

      const res = await this.fetch(url.toString(), {});
      if (!res.ok) throw new Error(`openlibrary ${res.status}`);
      const data = (await res.json()) as {
        docs?: Array<{ title?: string; key?: string; author_name?: string[]; first_publish_year?: number }>;
      };
      return (data.docs ?? []).map((d, i) =>
        toResult(this.name, i, {
          title: d.title,
          link: d.key ? `https://openlibrary.org${d.key}` : "",
          snippet: [d.author_name?.slice(0, 3).join(", "), d.first_publish_year].filter(Boolean).join(" · "),
          date: d.first_publish_year ? String(d.first_publish_year) : undefined,
        }),
      ).filter((r) => r.link);
    } catch (e) {
      logger.warn(`[SearchEngine] openlibrary failed: ${(e as Error).message}`);
      return [];
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 需 Key 引擎（注册后赠送免费额度）
// ══════════════════════════════════════════════════════════════════════════

/** Tavily —— 面向 LLM/RAG 的搜索 API，返回已清洗摘要 */
export class TavilyEngine extends SearchEngine {
  readonly name = "tavily";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const key = requireKey(this.name, "TAVILY_API_KEY");
    if (!key) return [];
    try {
      const res = await this.fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          query: opts.query,
          max_results: Math.min(opts.num ?? 5, 20),
          search_depth: "basic",
        }),
      });
      if (!res.ok) throw new Error(`tavily ${res.status}`);
      const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
      return (data.results ?? []).map((r, i) =>
        toResult(this.name, i, { title: r.title, link: r.url, snippet: r.content, date: r.published_date }),
      );
    } catch (e) {
      logger.warn(`[SearchEngine] tavily failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** Brave Search API —— 独立索引 */
export class BraveSearchEngine extends SearchEngine {
  readonly name = "brave";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const key = requireKey(this.name, "BRAVE_API_KEY");
    if (!key) return [];
    try {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", opts.site ? `${opts.query} site:${opts.site}` : opts.query);
      url.searchParams.set("count", String(Math.min(opts.num ?? 5, 20)));
      if (opts.lang) url.searchParams.set("search_lang", opts.lang.slice(0, 2));

      const res = await this.fetch(url.toString(), {
        headers: { Accept: "application/json", "X-Subscription-Token": key },
      });
      if (!res.ok) throw new Error(`brave ${res.status}`);
      const data = (await res.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
      };
      return (data.web?.results ?? []).map((r, i) =>
        toResult(this.name, i, { title: r.title, link: r.url, snippet: stripTags(r.description ?? ""), date: r.age }),
      );
    } catch (e) {
      logger.warn(`[SearchEngine] brave failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** Jina Search (s.jina.ai) —— 无 Key 有匿名额度，带 Key 额度更高；主要价值在正文抽取 */
export class JinaSearchEngine extends SearchEngine {
  readonly name = "jina-reader";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const key = readString("JINA_API_KEY", ""); // 可选
    try {
      const url = `https://s.jina.ai/${encodeURIComponent(opts.query)}`;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (key) headers.Authorization = `Bearer ${key}`;

      const res = await this.fetch(url, { headers });
      if (!res.ok) throw new Error(`jina ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ title?: string; url?: string; content?: string; description?: string }> };
      return (data.data ?? []).slice(0, opts.num ?? 5).map((r, i) =>
        toResult(this.name, i, { title: r.title, link: r.url, snippet: r.description || r.content }),
      );
    } catch (e) {
      logger.warn(`[SearchEngine] jina-reader failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** Google Programmable Search (CSE) —— 需要 API Key + 搜索引擎 ID(cx) */
export class GoogleCseEngine extends SearchEngine {
  readonly name = "google-cse";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const key = requireKey(this.name, "GOOGLE_CSE_KEY");
    if (!key) return [];
    const cx = readString("GOOGLE_CSE_CX", "");
    if (!cx) {
      logger.warn("[SearchEngine] google-cse: 缺少 GOOGLE_CSE_CX（搜索引擎 ID）");
      return [];
    }
    try {
      const url = new URL("https://www.googleapis.com/customsearch/v1");
      url.searchParams.set("key", key);
      url.searchParams.set("cx", cx);
      url.searchParams.set("q", opts.site ? `${opts.query} site:${opts.site}` : opts.query);
      url.searchParams.set("num", String(Math.min(opts.num ?? 5, 10)));

      const res = await this.fetch(url.toString(), {});
      if (!res.ok) throw new Error(`google-cse ${res.status}`);
      const data = (await res.json()) as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
      return (data.items ?? []).map((r, i) =>
        toResult(this.name, i, { title: r.title, link: r.link, snippet: r.snippet }),
      );
    } catch (e) {
      logger.warn(`[SearchEngine] google-cse failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/** Serper.dev —— 返回 Google SERP 结构化结果 */
export class SerperEngine extends SearchEngine {
  readonly name = "serper";
  constructor(fetchImpl?: SearchFetch) { super(fetchImpl); }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const key = requireKey(this.name, "SERPER_API_KEY");
    if (!key) return [];
    try {
      const res = await this.fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({
          q: opts.site ? `${opts.query} site:${opts.site}` : opts.query,
          num: Math.min(opts.num ?? 5, 20),
        }),
      });
      if (!res.ok) throw new Error(`serper ${res.status}`);
      const data = (await res.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }> };
      return (data.organic ?? []).map((r, i) =>
        toResult(this.name, i, { title: r.title, link: r.link, snippet: r.snippet, date: r.date }),
      );
    } catch (e) {
      logger.warn(`[SearchEngine] serper failed: ${(e as Error).message}`);
      return [];
    }
  }
}

/**
 * 全部扩展引擎（id → 实例工厂）。
 * id 必须与 `config/web-search.yaml` 中的 `engines[].id` 一致。
 */
export const EXTRA_ENGINE_FACTORIES: Record<string, (fetchImpl?: SearchFetch) => SearchEngine> = {
  wikipedia: (f) => new WikipediaEngine(f),
  "google-news": (f) => new GoogleNewsEngine(f),
  hackernews: (f) => new HackerNewsEngine(f),
  github: (f) => new GitHubSearchEngine(f),
  arxiv: (f) => new ArxivEngine(f),
  crossref: (f) => new CrossrefEngine(f),
  openlibrary: (f) => new OpenLibraryEngine(f),
  tavily: (f) => new TavilyEngine(f),
  brave: (f) => new BraveSearchEngine(f),
  "jina-reader": (f) => new JinaSearchEngine(f),
  "google-cse": (f) => new GoogleCseEngine(f),
  serper: (f) => new SerperEngine(f),
};
