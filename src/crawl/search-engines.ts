/**
 * 多搜索引擎抽象层 v2.0 (简化版)
 *
 * 支持：DuckDuckGo / Bing / SearXNG
 * 移除：反指纹、代理管理、Yandex、Google SerpAPI
 */

import { proxyFetch, type ProxyFetchResponse } from "../utils/proxy-fetch.js";
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";

export interface SearchEngineResult {
  position: number;
  title: string;
  link: string;
  displayedUrl: string;
  snippet: string;
  date?: string;
  source: string;
  engine: string;
  richSnippets?: Record<string, unknown>;
}

export interface SearchOptions {
  query: string;
  num?: number;
  lang?: string;
  site?: string;
  safe?: boolean;
  region?: string;
  timeRange?: "d" | "w" | "m" | "y";
}

/** 搜索引擎基类 */
abstract class SearchEngine {
  abstract readonly name: string;
  abstract search(opts: SearchOptions): Promise<SearchEngineResult[]>;

  protected async fetch(url: string, init: RequestInit = {}): Promise<ProxyFetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await proxyFetch(url, {
        method: init.method || "GET",
        headers: init.headers as Record<string, string>,
        body: init.body as string | null,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
}

// ========== DuckDuckGo（无需 API Key）==========

class DuckDuckGoEngine extends SearchEngine {
  readonly name = "duckduckgo";

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", opts.query);
    if (opts.site) url.searchParams.set("sites", opts.site);

    const res = await this.fetch(url.toString());
    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);

    const html = await res.text();
    return this.parseHtml(html, opts.num ?? 10);
  }

  private parseHtml(html: string, limit: number): SearchEngineResult[] {
    const results: SearchEngineResult[] = [];
    const itemRe = /<div class="result results_links[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;

    for (const m of html.matchAll(itemRe)) {
      const block = m[1];
      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const hrefMatch = block.match(/<a[^>]*class="result__a"[^>]*href=["']([^"']+)["']/i);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      const urlMatch = block.match(/<a[^>]*class="result__url"[^>]*>([\s\S]*?)<\/a>/i);

      if (!titleMatch || !hrefMatch) continue;

      let link = hrefMatch[1];
      const uMatch = link.match(/[?&]u(?:ddg)?=([^&]+)/);
      if (uMatch) {
        try { link = decodeURIComponent(uMatch[1]); } catch (e) { logger.warn(`[SearchEngines] URL decode failed: ${(e as Error).message}`); }
      }
      if (link.startsWith("//")) link = "https:" + link;

      results.push({
        position: results.length + 1,
        title: this.stripTags(titleMatch[1]).trim(),
        link,
        displayedUrl: urlMatch ? this.stripTags(urlMatch[1]).trim() : this.extractDomain(link),
        snippet: snippetMatch ? this.stripTags(snippetMatch[1]).trim() : "",
        source: this.extractDomain(link),
        engine: this.name,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }
}

// ========== Bing（Web Search API）==========

class BingEngine extends SearchEngine {
  readonly name = "bing";

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const apiKey = readString("BING_API_KEY");
    if (!apiKey) {
      logger.warn("[SearchEngine] BING_API_KEY not set");
      return [];
    }

    const url = new URL("https://api.bing.microsoft.com/v7.0/search");
    url.searchParams.set("q", opts.query);
    url.searchParams.set("count", String(Math.min(opts.num ?? 10, 50)));
    url.searchParams.set("offset", "0");
    url.searchParams.set("mkt", opts.lang ? this.mapLocale(opts.lang) : "zh-CN");
    url.searchParams.set("safeSearch", opts.safe ? "Strict" : "Off");
    if (opts.site) url.searchParams.set("site:", opts.site);

    const res = await this.fetch(url.toString(), {
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
    });

    if (!res.ok) throw new Error(`Bing API error: ${res.status}`);

    const data = await res.json();
    const raw = data.webPages?.value || [];

    return raw.map((r: { name?: string; url?: string; displayUrl?: string; snippet?: string; dateLastCrawled?: string; deepLinks?: unknown[] }, i: number) => ({
      position: i + 1,
      title: r.name || "",
      link: r.url || "",
      displayedUrl: r.displayUrl || r.url || "",
      snippet: r.snippet || "",
      date: r.dateLastCrawled,
      source: this.extractDomain(r.url || ""),
      engine: this.name,
      richSnippets: r.deepLinks ? { deepLinks: r.deepLinks } : undefined,
    }));
  }

  private mapLocale(lang: string): string {
    const map: Record<string, string> = {
      zh: "zh-CN", "zh-cn": "zh-CN", "zh-tw": "zh-TW",
      en: "en-US", ja: "ja-JP", ko: "ko-KR", de: "de-DE",
      fr: "fr-FR", ru: "ru-RU",
    };
    return map[lang.toLowerCase()] || lang;
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }
}

// ========== SearXNG（自建/公共实例，无需 API Key）==========

class SearXngEngine extends SearchEngine {
  readonly name = "searxng";
  private instance: string;

  constructor(instance?: string) {
    super();
    this.instance = instance || readString("SEARXNG_INSTANCE", "https://search.sapti.me");
  }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const url = new URL(`${this.instance}/search`);
    url.searchParams.set("q", opts.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", opts.lang || "zh-CN");
    url.searchParams.set("safesearch", opts.safe ? "2" : "0");
    if (opts.site) url.searchParams.set("q", `${opts.query} site:${opts.site}`);

    const res = await this.fetch(url.toString());
    if (!res.ok) throw new Error(`SearXNG error: ${res.status}`);

    const data = await res.json();
    const raw = data.results || [];

    return raw.slice(0, opts.num ?? 10).map((r: { title?: string; url?: string; pretty_url?: string; content?: string; publishedDate?: string; engine?: string }, i: number) => ({
      position: i + 1,
      title: r.title || "",
      link: r.url || "",
      displayedUrl: r.pretty_url || r.url || "",
      snippet: r.content || "",
      date: r.publishedDate,
      source: r.engine || this.extractDomain(r.url || ""),
      engine: `${this.name}(${r.engine || "unknown"})`,
    }));
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }
}

// ========== 搜索聚合器 ==========

export class SearchAggregator {
  private engines = new Map<string, SearchEngine>();

  constructor() {
    this.engines.set("duckduckgo", new DuckDuckGoEngine());
    this.engines.set("bing", new BingEngine());
    this.engines.set("searxng", new SearXngEngine());
  }

  async searchMulti(
    opts: SearchOptions,
    engines: string[] = ["searxng", "duckduckgo"]
  ): Promise<SearchEngineResult[]> {
    const tasks = engines
      .map((name) => {
        const engine = this.engines.get(name);
        if (!engine) {
          logger.warn(`[SearchAggregator] Unknown engine: ${name}`);
          return null;
        }
        return engine.search(opts).catch((e) => {
          logger.warn(`[SearchAggregator] ${name} failed:`, e.message);
          return [] as SearchEngineResult[];
        });
      })
      .filter(Boolean) as Promise<SearchEngineResult[]>[];

    const results = await Promise.all(tasks);
    return this.mergeAndDeduplicate(results.flat());
  }

  async search(engine: string, opts: SearchOptions): Promise<SearchEngineResult[]> {
    const e = this.engines.get(engine);
    if (!e) throw new Error(`Unknown engine: ${engine}`);
    return e.search(opts);
  }

  listEngines(): { name: string; available: boolean }[] {
    return Array.from(this.engines.values()).map((e) => ({
      name: e.name,
      available: this.isEngineAvailable(e.name),
    }));
  }

  private isEngineAvailable(name: string): boolean {
    switch (name) {
      case "duckduckgo":
      case "searxng":
        return true;
      case "bing":
        return !!readString("BING_API_KEY");
      default:
        return false;
    }
  }

  private mergeAndDeduplicate(results: SearchEngineResult[]): SearchEngineResult[] {
    const seen = new Map<string, SearchEngineResult>();

    for (const r of results) {
      const key = this.normalizeUrl(r.link);
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, r);
      } else {
        if (r.snippet.length > existing.snippet.length) existing.snippet = r.snippet;
        if (r.date && !existing.date) existing.date = r.date;
        if (!existing.engine.includes(r.engine)) existing.engine += `+${r.engine}`;
      }
    }

    return Array.from(seen.values()).sort((a, b) => a.position - b.position);
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      u.hash = "";
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach(
        (p) => u.searchParams.delete(p)
      );
      return u.toString().toLowerCase();
    } catch (e) {
      logger.warn(`[SearchEngines] URL normalization failed: ${(e as Error).message}`);
      return url.toLowerCase();
    }
  }
}

export const searchAggregator = new SearchAggregator();
