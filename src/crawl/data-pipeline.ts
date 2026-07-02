/**
 * 结构化数据采集 Pipeline
 * 核心能力：从任意网页提取精细化结构化数据
 *
 * 三层架构：
 *   1. 搜索层 → 多引擎聚合（DuckDuckGo / Bing / Yandex / Google / SearXNG）
 *   2. 爬虫层 → 结构化提取（Schema.org + 元数据 + 正文分块）
 *   3. 存储层 → 分类存储（Markdown + JSON 原始数据）
 *
 * 隐私保护：
 *   - 每次请求随机化浏览器指纹
 *   - 代理轮换（HTTP/HTTPS/SOCKS5）
 *   - 请求间隔抖动
 *   - URL 跟踪参数去除
 */
import { logger } from "../utils/logger.js";
import { proxyFetch } from "../utils/proxy-fetch.js";

import { searchAggregator, type SearchEngineResult, type SearchOptions } from "./search-engines.js";
import { Database } from "bun:sqlite";
import { VaultManager } from "../memory/vault-manager.js";
import { withRetry, withFallback, withTimeout, isRetryableError } from "../utils/resilience.js";

// ========== 类型定义 ==========

interface CrawlOptions {
  maxConcurrent?: number;
  requestDelay?: number;
  maxDepth?: number;
  retries?: number;
  userAgent?: string;
}

/** 结构化爬取结果 */
interface StructuredCrawlResult {
  url: string;
  title: string;
  description?: string;
  author?: string;
  publishDate?: string;
  siteName?: string;
  language?: string;
  markdown: string;
  structuredData: Record<string, unknown>[];
  tables: MarkdownTable[];
  codeBlocks: CodeBlock[];
  images: ImageInfo[];
  links: LinkInfo[];
  headings: HeadingInfo[];
  meta: Record<string, string>;
  chunks: ContentChunk[];
  fetchedAt: string;
}

/** Markdown 表格 */
interface MarkdownTable {
  caption?: string;
  headers: string[];
  rows: string[][];
}

/** 代码块 */
interface CodeBlock {
  language?: string;
  code: string;
}

/** 图片信息 */
interface ImageInfo {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}

/** 链接信息 */
interface LinkInfo {
  href: string;
  text: string;
  title?: string;
}

/** 标题信息 */
interface HeadingInfo {
  level: number;
  text: string;
  anchor?: string;
}

/** 内容分块 */
interface ContentChunk {
  heading: string;
  level: number;
  content: string;
  wordCount: number;
}

/** 站点提取规则 */
interface SiteExtractRule {
  domain: string;
  name: string;
  fields: Record<string, string>;
  removeSelectors?: string[];
  contentSelector?: string;
}

// ========== 预定义站点规则 ==========

const SITE_RULES: SiteExtractRule[] = [
  {
    domain: "github.com",
    name: "GitHub",
    fields: {
      title: "h1[data-testid='issue-title'], .repository-content h1, article h1",
      author: "[data-testid='issue-author'] a, .author a",
      description: "[data-testid='issue-body'], .markdown-body",
      stars: ".starring-container .Counter",
      language: ".repository-content .BorderGrid-cell:first-child .text-bold",
    },
    removeSelectors: [".header", ".footer", "aside", ".repo-sidebar"],
    contentSelector: ".markdown-body, .readme article",
  },
  {
    domain: "stackoverflow.com",
    name: "Stack Overflow",
    fields: {
      title: "#question-header h1",
      question: "#question .js-post-body",
      answers: "#answers .js-post-body",
      votes: "#question .js-vote-count",
      tags: ".post-tag",
    },
    removeSelectors: [".top-bar", "#left-sidebar", "#sidebar", ".js-consent-banner"],
    contentSelector: "#mainbar",
  },
  {
    domain: "zhihu.com",
    name: "知乎",
    fields: {
      title: "h1.QuestionHeader-title, h1.Post-Title",
      content: "[data-zop-question], .RichContent-inner",
      author: ".AuthorInfo-name",
      votes: ".VoteButton--up",
    },
    removeSelectors: [".GlobalSideBar", ".Question-sideColumn", ".KfeCollection-LoginDescription"],
    contentSelector: ".Question-mainColumn, .Post-Main",
  },
  {
    domain: "juejin.cn",
    name: "稀土掘金",
    fields: {
      title: "h1.article-title, h1.title",
      content: ".markdown-body, .article-content",
      author: ".author-name, .user-name",
      views: ".views-count",
    },
    removeSelectors: [".sidebar", ".index-nav"],
    contentSelector: ".main-area article",
  },
  {
    domain: "blog.csdn.net",
    name: "CSDN",
    fields: {
      title: "h1.title-article, h1",
      content: "#content_views",
      author: ".follow-nickName, .profile-intro-name",
    },
    removeSelectors: [".toolbar", ".aside", ".recommend-box", ".blog_container_aside"],
    contentSelector: "#content_views, article",
  },
  {
    domain: "developer.mozilla.org",
    name: "MDN",
    fields: {
      title: "h1",
      content: "article.main-page-content",
      summary: ".summary",
    },
    contentSelector: "article.main-page-content",
  },
  {
    domain: "docs.python.org",
    name: "Python Docs",
    fields: {
      title: "h1",
      content: "[role='main'] .body",
      version: ".version_switcher_placeholder",
    },
    contentSelector: "[role='main']",
  },
  {
    domain: "mp.weixin.qq.com",
    name: "微信公众号",
    fields: {
      title: "h2.rich_media_title",
      content: "#js_content",
      author: "#js_name",
      publish_time: "#publish_time",
    },
    removeSelectors: [".rich_media_tool", "#js_pc_qr_code"],
    contentSelector: "#js_content",
  },
  {
    domain: "baike.baidu.com",
    name: "百度百科",
    fields: {
      title: "h1",
      summary: ".lemma-summary",
      content: ".para",
    },
    removeSelectors: [".side-content", ".lemmaWgt-promotion-vbaike"],
    contentSelector: ".lemma-summary, .para",
  },
];

// ========== 主类 ==========

export class DataPipeline {
  private options: Required<CrawlOptions>;
  private visited = new Set<string>();

  constructor(options: CrawlOptions = {}) {
    this.options = {
      maxConcurrent: options.maxConcurrent || 3,
      requestDelay: options.requestDelay || 1000,
      maxDepth: options.maxDepth || 2,
      retries: options.retries || 3,
      userAgent: options.userAgent || "Axiom/1.0 (Research Bot; +https://axiom-runtime.ai)",
    };
  }

  // ===== 搜索层：多引擎聚合 =====

  /**
   * 多引擎并行搜索，结果去重融合
   */
  async searchMulti(
    query: string,
    opts?: { num?: number; engines?: string[]; lang?: string; site?: string; safe?: boolean; timeRange?: "d" | "w" | "m" | "y" }
  ): Promise<SearchEngineResult[]> {
    const engines = opts?.engines || ["duckduckgo"];
    const searchOpts: SearchOptions = {
      query,
      num: opts?.num ?? 10,
      lang: opts?.lang,
      site: opts?.site,
      safe: opts?.safe ?? true,
      timeRange: opts?.timeRange,
    };

    logger.info(`[Pipeline] Multi-engine search: "${query}" via [${engines.join(", ")}]`);
    return searchAggregator.searchMulti(searchOpts, engines);
  }

  /**
   * 单引擎搜索（兼容旧接口）
   */
  async searchStructured(
    query: string,
    engine: string = "duckduckgo",
    opts?: { num?: number; lang?: string; site?: string; safe?: boolean }
  ): Promise<SearchEngineResult[]> {
    logger.info(`[Pipeline] Search via ${engine}: "${query}"`);
    return searchAggregator.search(engine, {
      query,
      num: opts?.num ?? 10,
      lang: opts?.lang,
      site: opts?.site,
      safe: opts?.safe ?? true,
    });
  }

  /** 获取可用引擎列表 */
  listSearchEngines(): { name: string; available: boolean }[] {
    return searchAggregator.listEngines();
  }

  // ===== 爬虫层：结构化提取 =====

  /**
   * 结构化单页爬取
   */
  async crawlStructured(url: string, depth = 0): Promise<StructuredCrawlResult | null> {
    if (this.visited.has(url) || depth > this.options.maxDepth) return null;
    this.visited.add(url);

    // 请求间隔
    await this.delay(this.options.requestDelay);

    try {
      return await withRetry(
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);

          const res = await proxyFetch(url, {
            headers: {
              "User-Agent": this.options.userAgent,
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            signal: controller.signal,
          });

          clearTimeout(timer);

          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          let html = await res.text();

          // After fetching HTML, check if we need browser rendering
          // (dynamic import — Lightpanda may not be installed)
          const { needsBrowserRendering } = await import("./lightpanda-client.js");
          if (needsBrowserRendering(html)) {
            logger.info(`[Crawl] Page needs browser rendering: ${url}`);
            const { smartRender } = await import("./lightpanda-client.js");
            const rendered = await smartRender(url, { preferBrowser: true, timeout: 20000 });
            if (rendered.rendered && rendered.html.length > html.length * 1.5) {
              const ratio = Math.round(rendered.html.length / html.length * 100);
              html = rendered.html;
              logger.info(`[Crawl] Browser rendering produced ${ratio}% more content`);
            }
          }

          const result = this.parseStructured(url, html);

          // 保存原始数据
          await this.saveRaw(url, { html: html.slice(0, 50000), structured: result });

          return result;
        },
        {
          maxAttempts: 3,
          baseDelay: 1000,
          retryable: (e: Error) => isRetryableError(e) || (e instanceof Error && e.message.startsWith("HTTP")),
        }
      );
    } catch (e: unknown) {
      logger.warn(`[Pipeline] Failed to crawl ${url} after retries: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * 解析 HTML 为结构化数据
   */
  private parseStructured(url: string, html: string): StructuredCrawlResult {
    // 1. 基础元数据
    const meta = this.extractMeta(html);
    const title = meta["og:title"] || meta["twitter:title"] || this.extractTitle(html) || "Untitled";
    const description = meta["og:description"] || meta["description"] || meta["twitter:description"];
    const siteName = meta["og:site_name"] || this.extractDomain(url);
    const publishDate = meta["article:published_time"] || meta["datePublished"];
    const author = meta["author"] || meta["article:author"];
    const language = meta["language"] || this.detectLanguage(html);

    // 2. Schema.org / JSON-LD 结构化数据
    const structuredData = this.extractJsonLd(html);

    // 3. 匹配站点规则
    const domain = this.extractDomain(url);
    const siteRule = SITE_RULES.find((r) => domain.includes(r.domain));

    // 4. 正文提取（先移除噪声元素）
    let cleanHtml = this.removeNoise(html, siteRule?.removeSelectors);

    // 5. 提取各结构化元素
    const headings = this.extractHeadings(cleanHtml);
    const tables = this.extractTables(cleanHtml);
    const codeBlocks = this.extractCodeBlocks(cleanHtml);
    const images = this.extractImages(cleanHtml, url);
    const links = this.extractLinks(cleanHtml, url);

    // 6. 转为 Markdown
    const markdown = this.htmlToMarkdown(cleanHtml, { siteRule, url, headings, tables, codeBlocks, images, links });

    // 7. 内容分块
    const chunks = this.chunkByHeadings(markdown);

    return {
      url,
      title,
      description,
      author,
      publishDate,
      siteName,
      language,
      markdown,
      structuredData,
      tables,
      codeBlocks,
      images,
      links,
      headings,
      meta,
      chunks,
      fetchedAt: new Date().toISOString(),
    };
  }

  // ===== 元数据提取 =====

  private extractMeta(html: string): Record<string, string> {
    const meta: Record<string, string> = {};

    // <meta name="..." content="...">
    const nameRe = /<meta\s+[^>]*name=["']([^"']+)["']\s+[^>]*content=["']([^"']*)["']/gi;
    for (const m of html.matchAll(nameRe)) meta[m[1].toLowerCase()] = m[2];

    // <meta property="..." content="..."> (Open Graph)
    const propRe = /<meta\s+[^>]*property=["']([^"']+)["']\s+[^>]*content=["']([^"']*)["']/gi;
    for (const m of html.matchAll(propRe)) meta[m[1].toLowerCase()] = m[2];

    // <meta charset="...">
    const charsetRe = /<meta\s+charset=["']([^"']+)["']/i;
    const charset = html.match(charsetRe);
    if (charset) meta["charset"] = charset[1];

    return meta;
  }

  private extractTitle(html: string): string | undefined {
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return m?.[1]?.trim();
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  // ===== JSON-LD / Schema.org =====

  private extractJsonLd(html: string): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (const m of html.matchAll(re)) {
      try {
        const data = JSON.parse(m[1].trim());
        if (Array.isArray(data)) results.push(...data);
        else results.push(data);
      } catch {
        // 忽略无效 JSON
      }
    }
    return results;
  }

  // ===== 噪声移除 =====

  private removeNoise(html: string, extraSelectors?: string[]): string {
    const defaultNoise = [
      "<script[^>]*>[\\s\\S]*?</script>",
      "<style[^>]*>[\\s\\S]*?</style>",
      "<nav[^>]*>[\\s\\S]*?</nav>",
      "<header[^>]*>[\\s\\S]*?</header>",
      "<footer[^>]*>[\\s\\S]*?</footer>",
      "<aside[^>]*>[\\s\\S]*?</aside>",
      "<noscript[^>]*>[\\s\\S]*?</noscript>",
      '<iframe[^>]*>[\\s\\S]*?</iframe>',
      '<div[^>]*class=["\'][^"\']*(?:ad|banner|popup|cookie|consent)[^"\']*["\'][^>]*>[\\s\\S]*?</div>',
    ];

    let cleaned = html;
    for (const pattern of defaultNoise) {
      cleaned = cleaned.replace(new RegExp(pattern, "gi"), "");
    }

    // 额外选择器移除
    if (extraSelectors) {
      for (const sel of extraSelectors) {
        const tagMatch = sel.match(/^([a-z0-9]+)?([.#])([^.#]+)$/i);
        if (tagMatch) {
          const [, tag, type, val] = tagMatch;
          const attr = type === "." ? `class=["'][^"']*\\b${val}\\b[^"']*["']` : `id=["']${val}["']`;
          const tagPart = tag || "[^>]*";
          const re = new RegExp(`<${tagPart}\\s+[^>]*${attr}[^>]*>[\\s\\S]*?</${tag || "div"}>`, "gi");
          cleaned = cleaned.replace(re, "");
        }
      }
    }

    return cleaned;
  }

  // ===== 结构化元素提取 =====

  private extractHeadings(html: string): HeadingInfo[] {
    const headings: HeadingInfo[] = [];
    const re = /<h([1-6])\b[^>]*>(?:<a[^>]*id=["']([^"']*)["'][^>]*>)?([\s\S]*?)(?:<\/a>)?<\/h\1>/gi;
    for (const m of html.matchAll(re)) {
      const text = this.stripHtmlTags(m[3]).trim();
      if (text) headings.push({ level: Number(m[1]), text, anchor: m[2] });
    }
    return headings;
  }

  private extractTables(html: string): MarkdownTable[] {
    const tables: MarkdownTable[] = [];
    const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;

    for (const tableMatch of html.matchAll(tableRe)) {
      const tableHtml = tableMatch[1];
      const capMatch = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
      const caption = capMatch ? this.stripHtmlTags(capMatch[1]).trim() : undefined;

      const headers: string[] = [];
      const thRe = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
      for (const th of tableHtml.matchAll(thRe)) {
        headers.push(this.stripHtmlTags(th[1]).trim());
      }

      const rows: string[][] = [];
      const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      for (const tr of tableHtml.matchAll(trRe)) {
        const cells: string[] = [];
        const tdRe = /<t[d]\b[^>]*>([\s\S]*?)<\/t[d]>/gi;
        for (const td of tr[1].matchAll(tdRe)) {
          cells.push(this.stripHtmlTags(td[1]).trim());
        }
        if (cells.length > 0 && cells.length >= headers.length) {
          rows.push(cells);
        }
      }

      if (headers.length > 0 || rows.length > 0) {
        tables.push({ caption, headers, rows });
      }
    }

    return tables;
  }

  private extractCodeBlocks(html: string): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const preCodeRe = /<pre\b[^>]*>(?:<code\b([^>]*)>([\s\S]*?)<\/code>)<\/pre>/gi;
    for (const m of html.matchAll(preCodeRe)) {
      const langMatch = m[1].match(/class=["'][^"']*language-([^\s"']+)/);
      blocks.push({
        language: langMatch ? langMatch[1] : undefined,
        code: this.decodeHtmlEntities(m[2]).trim(),
      });
    }
    return blocks;
  }

  private extractImages(html: string, baseUrl: string): ImageInfo[] {
    const images: ImageInfo[] = [];
    const re = /<img\b([^>]*)>/gi;
    for (const m of html.matchAll(re)) {
      const attrs = m[1];
      const srcMatch = attrs.match(/src=["']([^"']+)["']/);
      if (!srcMatch) continue;
      try {
        const src = new URL(srcMatch[1], baseUrl).href;
        const altMatch = attrs.match(/alt=["']([^"]*)["']/);
        const wMatch = attrs.match(/width=["']?(\d+)/);
        const hMatch = attrs.match(/height=["']?(\d+)/);
        images.push({
          src,
          alt: altMatch ? altMatch[1] : "",
          width: wMatch ? Number(wMatch[1]) : undefined,
          height: hMatch ? Number(hMatch[1]) : undefined,
        });
      } catch {
        // 忽略无效 URL
      }
    }
    return images;
  }

  private extractLinks(html: string, baseUrl: string): LinkInfo[] {
    const links: LinkInfo[] = [];
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    const seen = new Set<string>();

    for (const m of html.matchAll(re)) {
      const hrefMatch = m[1].match(/href=["']([^"']+)["']/);
      if (!hrefMatch) continue;
      try {
        const href = new URL(hrefMatch[1], baseUrl).href;
        if (seen.has(href)) continue;
        seen.add(href);
        const titleMatch = m[1].match(/title=["']([^"]*)["']/);
        links.push({
          href,
          text: this.stripHtmlTags(m[2]).trim().slice(0, 100),
          title: titleMatch ? titleMatch[1] : undefined,
        });
      } catch {
        // 忽略无效 URL
      }
    }

    return links;
  }

  // ===== HTML → Markdown 转换（精细化） =====

  private htmlToMarkdown(
    html: string,
    ctx: {
      siteRule?: SiteExtractRule;
      url: string;
      headings: HeadingInfo[];
      tables: MarkdownTable[];
      codeBlocks: CodeBlock[];
      images: ImageInfo[];
      links: LinkInfo[];
    }
  ): string {
    let md = html;

    // 先保护代码块（替换为占位符）
    const codePlaceholders: string[] = [];
    md = md.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, () => {
      const idx = codePlaceholders.length;
      codePlaceholders.push("__CODE_BLOCK_" + idx + "__");
      return codePlaceholders[idx];
    });

    // 保护表格
    const tablePlaceholders: string[] = [];
    md = md.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, () => {
      const idx = tablePlaceholders.length;
      tablePlaceholders.push("__TABLE_" + idx + "__");
      return tablePlaceholders[idx];
    });

    // 块级元素转换
    md = md.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n");
    md = md.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n");
    md = md.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n");
    md = md.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "#### $1\n\n");
    md = md.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "##### $1\n\n");
    md = md.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "###### $1\n\n");

    md = md.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, "> $1\n\n");
    md = md.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");

    // 列表
    md = md.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => {
      return inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n") + "\n";
    });
    md = md.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
      let i = 1;
      return inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, () => `${i++}. $1\n`) + "\n";
    });

    // 行内元素
    md = md.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
    md = md.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
    md = md.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
    md = md.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
    md = md.replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"]*)["'][^>]*>/gi, "![$2]($1)");
    md = md.replace(/<img\b[^>]*alt=["']([^"]*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, "![$1]($2)");
    md = md.replace(/<br\s*\/?>/gi, "\n");
    md = md.replace(/<hr\s*\/?>/gi, "\n---\n");

    // 移除剩余标签
    md = md.replace(/<[^>]+>/g, "\n");

    // 恢复表格
    ctx.tables.forEach((t, i) => {
      const tableMd = this.tableToMarkdown(t);
      md = md.replace("__TABLE_" + i + "__", tableMd);
    });

    // 恢复代码块
    ctx.codeBlocks.forEach((c, i) => {
      const lang = c.language || "";
      const codeMd = "\n```" + lang + "\n" + c.code + "\n```\n";
      md = md.replace("__CODE_BLOCK_" + i + "__", codeMd);
    });

    // 清理空白
    md = md.replace(/\n{3,}/g, "\n\n").trim();

    // 添加 YAML frontmatter
    const frontmatter = this.buildFrontmatter(ctx);

    return frontmatter + md;
  }

  private tableToMarkdown(t: MarkdownTable): string {
    if (t.headers.length === 0 && t.rows.length === 0) return "";
    const cap = t.caption ? `**${t.caption}**\n\n` : "";
    const headers = "| " + t.headers.join(" | ") + " |";
    const sep = "| " + t.headers.map(() => "---").join(" | ") + " |";
    const rows = t.rows.map((r) => "| " + r.join(" | ") + " |").join("\n");
    return "\n" + cap + headers + "\n" + sep + "\n" + rows + "\n";
  }

  private buildFrontmatter(ctx: { url: string; headings: HeadingInfo[] }): string {
    const date = new Date().toISOString();
    const source = ctx.url;
    const sections = ctx.headings.slice(0, 10).map((h) => h.text);
    return (
      "---\n" +
      `fetched_at: ${date}\n` +
      `source: ${source}\n` +
      `sections:\n` +
      sections.map((s) => `  - "${s.replace(/"/g, '\\"')}"\n`).join("") +
      "---\n\n"
    );
  }

  // ===== 内容分块 =====

  private chunkByHeadings(markdown: string): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    const lines = markdown.split("\n");
    let currentHeading = "";
    let currentLevel = 0;
    let currentContent: string[] = [];

    const flush = () => {
      const content = currentContent.join("\n").trim();
      if (content) {
        chunks.push({
          heading: currentHeading,
          level: currentLevel,
          content,
          wordCount: content.split(/\s+/).length,
        });
      }
      currentContent = [];
    };

    for (const line of lines) {
      const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (hMatch) {
        flush();
        currentLevel = hMatch[1].length;
        currentHeading = hMatch[2].trim();
      } else {
        currentContent.push(line);
      }
    }
    flush();

    return chunks;
  }

  // ===== 持久化到数据库 =====

  /**
   * 保存爬取结果到 SQLite + Vault
   */
  async saveCrawlResult(result: StructuredCrawlResult): Promise<void> {
    // 1. 保存到 SQLite（结构化查询）
    const dbPath = process.env.DATABASE_PATH || "./data/agent.db";
    const db = new Database(dbPath);
    const wordCount = result.chunks.reduce((sum, c) => sum + c.wordCount, 0);
    const qualityScore = this.calculateQualityScore(result, wordCount);

    db.run(
      `INSERT OR REPLACE INTO crawl_results (
        url, url_hash, title, description, site_name, language,
        markdown, structured_data, headings, tables, code_blocks, images, links, chunks,
        word_count, quality_score, status, fetched_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      [
        result.url,
        String(Bun.hash(result.url)),
        result.title,
        result.description || null,
        result.siteName || null,
        result.language || null,
        result.markdown,
        JSON.stringify(result.structuredData),
        JSON.stringify(result.headings),
        JSON.stringify(result.tables),
        JSON.stringify(result.codeBlocks),
        JSON.stringify(result.images),
        JSON.stringify(result.links),
        JSON.stringify(result.chunks),
        wordCount,
        qualityScore,
        "success",
        result.fetchedAt,
      ]
    );
    db.close();

    // 2. 保存到 Vault（人类可读的记忆）
    try {
      const vault = new VaultManager();
      await vault.writeCrawlResult({
        url: result.url,
        title: result.title,
        description: result.description,
        author: result.author,
        siteName: result.siteName,
        markdown: result.markdown,
        headings: result.headings,
      });
    } catch (e: unknown) {
      // Vault 写入失败不影响主流程
      logger.warn("[Pipeline] Vault write failed:", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 计算内容质量评分 (0-100)
   */
  private calculateQualityScore(result: StructuredCrawlResult, wordCount: number): number {
    let score = 0;
    // 基础分：有标题 +10
    if (result.title && result.title !== "Untitled") score += 10;
    // 有描述 +10
    if (result.description) score += 10;
    // 有作者/日期 +10
    if (result.author || result.publishDate) score += 10;
    // 内容长度 (最多 +30)
    score += Math.min(wordCount / 100, 30);
    // 结构化元素 (最多 +30)
    score += Math.min(result.headings.length * 2, 10);
    score += Math.min(result.tables.length * 5, 10);
    score += Math.min(result.codeBlocks.length * 3, 5);
    score += Math.min(result.images.length, 5);
    // Schema.org 数据 +5
    if (result.structuredData.length > 0) score += 5;
    return Math.min(Math.round(score), 100);
  }

  // ===== 存储层 =====

  /**
   * 保存到 Vault（通过 VaultManager）
   */
  async saveToVault(result: StructuredCrawlResult, vaultPath?: string): Promise<string> {
    const vault = new VaultManager({ vaultPath });
    return vault.writeCrawlResult({
      url: result.url,
      title: result.title,
      description: result.description,
      author: result.author,
      siteName: result.siteName,
      markdown: result.markdown,
      headings: result.headings,
    });
  }

  /** 批量爬取搜索结果 */
  async crawlSearchResults(
    query: string,
    opts?: { num?: number; maxResults?: number; engines?: string[] }
  ): Promise<StructuredCrawlResult[]> {
    const results = await this.searchMulti(query, {
      num: opts?.num || 10,
      engines: opts?.engines,
    });
    const max = opts?.maxResults || 5;
    const targets = results.slice(0, max);

    const crawled: StructuredCrawlResult[] = [];
    for (const item of targets) {
      const data = await this.crawlStructured(item.link);
      if (data) crawled.push(data);
    }

    return crawled;
  }

  // ===== 工具方法 =====

  private async saveRaw(url: string, data: unknown): Promise<void> {
    const hash = Bun.hash(url).toString(16).slice(0, 16);
    await Bun.write(`./data/raw/${hash}.json`, JSON.stringify(data, null, 2));
  }

  private stripHtmlTags(html: string): string {
    return html.replace(/<[^>]+>/g, "");
  }

  private decodeHtmlEntities(text: string): string {
    const entities: Record<string, string> = {
      "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"',
      "&#39;": "'", "&nbsp;": " ", "&#x2F;": "/",
    };
    return text.replace(/&[^;]+;/g, (e) => entities[e] || e);
  }

  private detectLanguage(html: string): string {
    const m = html.match(/<html[^>]*lang=["']([^"']+)["']/i);
    return m ? m[1] : "unknown";
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default DataPipeline;
export type { StructuredCrawlResult, SearchEngineResult, SearchOptions };
