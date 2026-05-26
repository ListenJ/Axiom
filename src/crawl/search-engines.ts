/**
 * 多搜索引擎抽象层
 * 支持：DuckDuckGo / Bing / Yandex / Google(via SERPAPI) / SearXNG
 *
 * 所有引擎统一输出结构化结果，底层自动应用反指纹机制
 */
import { fpGen, type Fingerprint } from "./anti-fingerprint.js";
import { proxyManager } from "./proxy-manager.js";

export interface SearchEngineResult {
  position: number;
  title: string;
  link: string;
  displayedUrl: string;
  snippet: string;
  date?: string;
  source: string;
  engine: string;
  richSnippets?: Record<string, any>;
}

export interface SearchOptions {
  query: string;
  num?: number;
  lang?: string;
  site?: string;
  safe?: boolean;
  region?: string;
  timeRange?: "d" | "w" | "m" | "y"; // day / week / month / year
}

/** 搜索引擎基类 */
abstract class SearchEngine {
  abstract readonly name: string;
  abstract search(opts: SearchOptions): Promise<SearchEngineResult[]>;

  protected async fetchWithPrivacy(
    url: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const fp = fpGen.generate();
    const headers = fpGen.buildHeaders(fp, init.headers as Record<string, string>);

    // 代理
    const proxy = proxyManager.next();
    const proxyOpt = proxy ? { proxy: proxy.url } : {};

    // 缓存破坏
    const sep = url.includes("?") ? "&" : "?";
    const cacheBust = `__cb=${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const finalUrl = fp.cacheBust ? `${url}${sep}${cacheBust}` : url;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(finalUrl, {
        ...init,
        ...proxyOpt,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (proxy) {
        if (res.ok) proxyManager.markSuccess(proxy.url, 0);
        else proxyManager.markFailed(proxy.url);
      }

      return res;
    } catch (e) {
      clearTimeout(timer);
      if (proxy) proxyManager.markFailed(proxy.url);
      throw e;
    }
  }

  protected delay(): Promise<void> {
    const ms = fpGen.randomJitter(800);
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ========== DuckDuckGo（无需 API Key）==========

class DuckDuckGoEngine extends SearchEngine {
  readonly name = "duckduckgo";

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    await this.delay();

    // DuckDuckGo HTML 端点
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", this.buildQuery(opts));
    if (opts.site) url.searchParams.set("sites", opts.site);

    const res = await this.fetchWithPrivacy(url.toString());
    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);

    const html = await res.text();
    return this.parseDuckDuckGoHtml(html, opts.num ?? 10);
  }

  private buildQuery(opts: SearchOptions): string {
    let q = opts.query;
    if (opts.timeRange) {
      const map: Record<string, string> = { d: "d", w: "w", m: "m", y: "y" };
      q += ` sort:date`;
    }
    return q;
  }

  private parseDuckDuckGoHtml(html: string, limit: number): SearchEngineResult[] {
    const results: SearchEngineResult[] = [];

    // DuckDuckGo HTML 结果项
    const itemRe = /<div class="result results_links[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    for (const m of html.matchAll(itemRe)) {
      const block = m[1];

      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const hrefMatch = block.match(/<a[^>]*class="result__a"[^>]*href=["']([^"']+)["']/i);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      const urlMatch = block.match(/<a[^>]*class="result__url"[^>]*>([\s\S]*?)<\/a>/i);

      if (!titleMatch || !hrefMatch) continue;

      const title = this.stripTags(titleMatch[1]).trim();
      let link = hrefMatch[1];
      // DuckDuckGo 的 href 通常是 /l/?kh=...&u=ENCODED_URL
      const uMatch = link.match(/[?&]u=([^&]+)/);
      if (uMatch) {
        try { link = decodeURIComponent(uMatch[1]); } catch { /* ignore */ }
      }

      const snippet = snippetMatch ? this.stripTags(snippetMatch[1]).trim() : "";
      const displayedUrl = urlMatch ? this.stripTags(urlMatch[1]).trim() : this.extractDomain(link);

      results.push({
        position: results.length + 1,
        title,
        link,
        displayedUrl,
        snippet,
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
    const apiKey = process.env.BING_API_KEY;
    if (!apiKey) {
      console.warn("[SearchEngine] BING_API_KEY not set");
      return [];
    }

    await this.delay();

    const url = new URL("https://api.bing.microsoft.com/v7.0/search");
    url.searchParams.set("q", opts.query);
    url.searchParams.set("count", String(Math.min(opts.num ?? 10, 50)));
    url.searchParams.set("offset", "0");
    url.searchParams.set("mkt", opts.lang ? this.mapBingLocale(opts.lang) : "zh-CN");
    url.searchParams.set("safeSearch", opts.safe ? "Strict" : "Off");
    if (opts.site) url.searchParams.set("site:", opts.site);

    const res = await this.fetchWithPrivacy(url.toString(), {
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
    });

    if (!res.ok) throw new Error(`Bing API error: ${res.status}`);

    const data = await res.json();
    const raw = data.webPages?.value || [];

    return raw.map((r: any, i: number) => ({
      position: i + 1,
      title: r.name || "",
      link: r.url || "",
      displayedUrl: r.displayUrl || r.url || "",
      snippet: r.snippet || "",
      date: r.dateLastCrawled,
      source: this.extractDomain(r.url),
      engine: this.name,
      richSnippets: r.deepLinks ? { deepLinks: r.deepLinks } : undefined,
    }));
  }

  private mapBingLocale(lang: string): string {
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

// ========== Yandex（XML API）==========

class YandexEngine extends SearchEngine {
  readonly name = "yandex";

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const apiKey = process.env.YANDEX_API_KEY;
    const user = process.env.YANDEX_USER;
    if (!apiKey || !user) {
      console.warn("[SearchEngine] YANDEX_API_KEY or YANDEX_USER not set");
      return [];
    }

    await this.delay();

    const url = new URL("https://yandex.com/search/xml");
    url.searchParams.set("query", opts.query);
    url.searchParams.set("user", user);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("l10n", "en");
    url.searchParams.set("filter", opts.safe ? "strict" : "none");
    url.searchParams.set("maxpassages", "3");
    url.searchParams.set("page", "0");

    const res = await this.fetchWithPrivacy(url.toString());
    if (!res.ok) throw new Error(`Yandex API error: ${res.status}`);

    const text = await res.text();
    return this.parseYandexXml(text, opts.num ?? 10);
  }

  private parseYandexXml(xml: string, limit: number): SearchEngineResult[] {
    const results: SearchEngineResult[] = [];

    // 简易 XML 解析（正则）
    const groupRe = /<group[^>]*>([\s\S]*?)<\/group>/gi;
    for (const g of xml.matchAll(groupRe)) {
      const block = g[1];

      const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
      const urlMatch = block.match(/<url>([\s\S]*?)<\/url>/);
      const passageMatch = block.match(/<passage>([\s\S]*?)<\/passage>/);
      const domainMatch = block.match(/<domain>([\s\S]*?)<\/domain>/);

      if (!titleMatch || !urlMatch) continue;

      results.push({
        position: results.length + 1,
        title: this.stripTags(titleMatch[1]).trim(),
        link: urlMatch[1].trim(),
        displayedUrl: domainMatch ? domainMatch[1].trim() : urlMatch[1].trim(),
        snippet: passageMatch ? this.stripTags(passageMatch[1]).trim() : "",
        source: domainMatch ? domainMatch[1].trim() : this.extractDomain(urlMatch[1]),
        engine: this.name,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  private stripTags(xml: string): string {
    return xml.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }
}

// ========== Google（via SERPAPI）==========

class GoogleSerpApiEngine extends SearchEngine {
  readonly name = "google";

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    const apiKey = process.env.SERPAPI_KEY;
    if (!apiKey) {
      console.warn("[SearchEngine] SERPAPI_KEY not set (required for Google)");
      return [];
    }

    await this.delay();

    const url = new URL("https://serpapi.com/search");
    url.searchParams.set("q", opts.query);
    url.searchParams.set("engine", "google");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("num", String(Math.min(opts.num ?? 10, 100)));
    if (opts.lang) url.searchParams.set("hl", opts.lang);
    if (opts.site) url.searchParams.set("as_sitesearch", opts.site);
    if (opts.safe) url.searchParams.set("safe", "active");
    if (opts.timeRange) url.searchParams.set("tbs", `qdr:${opts.timeRange}`);
    if (opts.region) url.searchParams.set("gl", opts.region);

    const res = await this.fetchWithPrivacy(url.toString());
    if (!res.ok) throw new Error(`SerpAPI error: ${res.status}`);

    const data = await res.json();
    const raw = data.organic_results || [];

    return raw.map((r: any, i: number) => ({
      position: i + 1,
      title: r.title || "",
      link: r.link || "",
      displayedUrl: r.displayed_link || r.link || "",
      snippet: r.snippet || "",
      date: r.date,
      source: this.extractDomain(r.link),
      engine: this.name,
      richSnippets: r.rich_snippet || r.sitelinks,
    }));
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
    this.instance = instance || process.env.SEARXNG_INSTANCE || "https://search.sapti.me";
  }

  async search(opts: SearchOptions): Promise<SearchEngineResult[]> {
    await this.delay();

    const url = new URL(`${this.instance}/search`);
    url.searchParams.set("q", opts.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", opts.lang || "zh-CN");
    url.searchParams.set("safesearch", opts.safe ? "2" : "0");
    if (opts.site) url.searchParams.set("q", `${opts.query} site:${opts.site}`);

    const res = await this.fetchWithPrivacy(url.toString());
    if (!res.ok) throw new Error(`SearXNG error: ${res.status}`);

    const data = await res.json();
    const raw = data.results || [];

    return raw.slice(0, opts.num ?? 10).map((r: any, i: number) => ({
      position: i + 1,
      title: r.title || "",
      link: r.url || "",
      displayedUrl: r.pretty_url || r.url || "",
      snippet: r.content || "",
      date: r.publishedDate,
      source: r.engine || this.extractDomain(r.url),
      engine: `${this.name}(${r.engine || "unknown"})`,
    }));
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }
}

// ========== 搜索聚合器 ==========

export class SearchAggregator {
  private engines: Map<string, SearchEngine> = new Map();

  constructor() {
    this.engines.set("duckduckgo", new DuckDuckGoEngine());
    this.engines.set("bing", new BingEngine());
    this.engines.set("yandex", new YandexEngine());
    this.engines.set("google", new GoogleSerpApiEngine());
    this.engines.set("searxng", new SearXngEngine());
  }

  /**
   * 多引擎并行搜索，结果去重融合
   */
  async searchMulti(
    opts: SearchOptions,
    engines: string[] = ["duckduckgo", "searxng"]
  ): Promise<SearchEngineResult[]> {
    const tasks = engines
      .map((name) => {
        const engine = this.engines.get(name);
        if (!engine) {
          console.warn(`[SearchAggregator] Unknown engine: ${name}`);
          return null;
        }
        return engine.search(opts).catch((e) => {
          console.warn(`[SearchAggregator] ${name} failed:`, e.message);
          return [] as SearchEngineResult[];
        });
      })
      .filter(Boolean) as Promise<SearchEngineResult[]>[];

    const results = await Promise.all(tasks);
    return this.mergeAndDeduplicate(results.flat());
  }

  /**
   * 单引擎搜索
   */
  async search(engine: string, opts: SearchOptions): Promise<SearchEngineResult[]> {
    const e = this.engines.get(engine);
    if (!e) throw new Error(`Unknown engine: ${engine}`);
    return e.search(opts);
  }

  /** 获取可用引擎列表 */
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
        return true; // 无需 API Key
      case "bing":
        return !!process.env.BING_API_KEY;
      case "yandex":
        return !!(process.env.YANDEX_API_KEY && process.env.YANDEX_USER);
      case "google":
        return !!process.env.SERPAPI_KEY;
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
        // 保留更完整的记录
        if (r.snippet.length > existing.snippet.length) {
          existing.snippet = r.snippet;
        }
        if (r.date && !existing.date) existing.date = r.date;
        // 合并引擎来源
        if (!existing.engine.includes(r.engine)) {
          existing.engine += `+${r.engine}`;
        }
      }
    }

    return Array.from(seen.values()).sort((a, b) => a.position - b.position);
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      u.hash = "";
      // 移除常见跟踪参数
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach(
        (p) => u.searchParams.delete(p)
      );
      return u.toString().toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }
}

/** 全局搜索聚合器 */
export const searchAggregator = new SearchAggregator();
