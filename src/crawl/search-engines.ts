/**
 * 多搜索引擎抽象层 v2.0 (简化版)
 *
 * 支持：DuckDuckGo / Bing / SearXNG
 * 移除：反指纹、代理管理、Yandex、Google SerpAPI
 */

import { proxyFetch, type ProxyFetchResponse } from "../utils/proxy-fetch.js";
import { spawnSync } from "bun"; // 静态导入：bun 打包器不支持动态 await import("bun")（bundle 中报 awaitPromise is not defined）
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
    // 代理 HTTPS 走 curl.exe：Bun 的 tls.connect({socket}) 隧道不稳定（CONNECT 后 TLS 升级挂起），
    // curl 原生支持 HTTP(S) 代理，实测可靠（mihomo 等 HTTP 代理）
    const proxyUrl =
      readString("SEARCH_PROXY") || readString("PROXY_URL") || readString("HTTPS_PROXY") || readString("HTTP_PROXY") || readString("ALL_PROXY");
    if (proxyUrl && url.startsWith("https://")) {
      return curlFetch(url, init, proxyUrl);
    }
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

/** curl 传输（代理 HTTPS）：用 curl.exe 避免 Bun TLS 隧道挂起，返回 ProxyFetchResponse 兼容对象。 */
async function curlFetch(url: string, init: RequestInit, proxyUrl: string): Promise<ProxyFetchResponse> {
  const headers = (init.headers ?? {}) as Record<string, string>;
  const args = ["-sS", "-L", "-m", "30", "-x", proxyUrl, "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (init.method && init.method !== "GET") args.push("-X", init.method);
  if (init.body) args.push("--data-binary", init.body as string);
  args.push(url);
  const curlBin = process.platform === "win32" ? "curl.exe" : "curl"; // Linux 容器（docker）无 curl.exe
  const proc = spawnSync([curlBin, ...args], { stdout: "pipe", stderr: "pipe", maxBuffer: 8 * 1024 * 1024 });
  const body = new TextDecoder().decode(proc.stdout);
  const ok = proc.exitCode === 0;
  return {
    ok,
    status: ok ? 200 : 502,
    statusText: ok ? "OK" : `curl exit ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr).slice(0, 120)}`,
    headers: {},
    url,
    text: async () => body,
    json: async () => JSON.parse(body),
    buffer: async () => Buffer.from(body),
    arrayBuffer: async () => Buffer.from(body).buffer,
  };
}

// ========== DuckDuckGo（无需 API Key）==========

class DuckDuckGoEngine extends SearchEngine {
  readonly name = "duckduckgo";

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", opts.query);
    if (opts.site) url.searchParams.set("sites", opts.site);

    // duckduckgo 反爬间歇性（202 挑战页）导致空结果：仅代理场景重试 2 次（无代理直连失败应快速返回，避免拖慢）
    const hasProxy = !!readString("SEARCH_PROXY");
    const attempts = hasProxy ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const res = await this.fetch(url.toString());
      if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
      const html = await res.text();
      const parsed = this.parseHtml(html, opts.num ?? 10);
      if (parsed.length > 0) return parsed;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    return [];
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

// ========== Bing HTML（无 key，网页搜索；duckduckgo 反爬挑战时的可靠回退）==========

class BingHtmlEngine extends SearchEngine {
  readonly name = "bing-html";

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", opts.query);
    if (opts.lang) url.searchParams.set("setlang", opts.lang);
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" };
    // Bing 对共享代理 IP 间歇 502/空页：仅代理场景重试 2 次
    const attempts = readString("SEARCH_PROXY") ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this.fetch(url.toString(), { headers });
        if (!res.ok) throw new Error(`Bing HTML HTTP ${res.status}`);
        const parsed = this.parseHtml(await res.text(), opts.num ?? 10);
        if (parsed.length > 0) return parsed;
      } catch (e) {
        if (attempt === 2) throw e;
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    return [];
  }

  private parseHtml(html: string, limit: number): SearchEngineResult[] {
    const results: SearchEngineResult[] = [];
    const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)(?=<li class="b_algo"|<\/ol>|$)/gi;
    for (const m of html.matchAll(blockRe)) {
      const block = m[1];
      const hrefM = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"/);
      const titleM = block.match(/<h2[^>]*><a[^>]*>([\s\S]*?)<\/a><\/h2>/);
      if (!hrefM || !titleM) continue;
      const snippetM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const citeM = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/);
      results.push({
        position: results.length + 1,
        title: this.strip(titleM[1]),
        link: hrefM[1],
        displayedUrl: citeM ? this.strip(citeM[1]) : this.extractDomain(hrefM[1]),
        snippet: snippetM ? this.strip(snippetM[1]) : "",
        source: this.extractDomain(hrefM[1]),
        engine: this.name,
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  private strip(html: string): string {
    return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
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
    this.engines.set("bing-html", new BingHtmlEngine());
    this.engines.set("searxng", new SearXngEngine());
  }

  async searchMulti(
    opts: SearchOptions,
    engines: string[] = ["duckduckgo", "bing-html", "searxng"]
  ): Promise<SearchEngineResult[]> {
    // bing-html 作为无 key 可靠回退：显式指定引擎时也追加（duckduckgo 反爬挑战/空结果场景兜底）
    if (!engines.includes("bing-html")) engines = [...engines, "bing-html"];
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
      case "bing-html":
        return true;
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
