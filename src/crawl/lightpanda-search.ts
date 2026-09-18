/**
 * Lightpanda 直连搜索引擎
 *
 * 使用 Lightpanda 渲染搜索引擎结果页面，直接提取结果，
 * 无需 API Key，不消耗 API 配额。
 *
 * 支持的搜索引擎:
 *   - Google (通过渲染 google.com/search)
 *   - Bing (通过渲染 bing.com/search)
 *   - Baidu (通过渲染 baidu.com/s)
 *
 * 策略: 先用 Lightpanda 渲染搜索结果页，再用 DOM 提取结构化结果。
 *       作为 DuckDuckGo/Bing API 的补充，减少 API 调用量。
 */
import { logger } from "../utils/logger.js";
import { smartRender } from "./lightpanda-client.js";

export interface DirectSearchResult {
  position: number;
  title: string;
  link: string;
  snippet: string;
  engine: string;
}

export interface DirectSearchOptions {
  query: string;
  num?: number;        // 结果数量 (默认 10)
  engine?: "google" | "bing" | "baidu";
  timeout?: number;
  language?: string;   // 搜索语言
}

/** 使用 Lightpanda 直接搜索 (无需 API Key) */
export async function directSearch(options: DirectSearchOptions): Promise<DirectSearchResult[]> {
  const { query, num = 10, engine = "google", timeout = 20000, language = "zh-CN" } = options;

  const searchUrl = buildSearchUrl(query, num, engine, language);
  if (!searchUrl) return [];

  logger.debug(`[DirectSearch] ${engine}: "${query}" -> ${searchUrl}`);

  try {
    const result = await smartRender(searchUrl, {
      preferBrowser: true,  // 搜索引擎需要浏览器渲染
      timeout,
      jsWaitTime: 3000,    // 搜索结果页需要等待 JS 加载
    });

    if (result.statusCode !== 200 || !result.html) {
      logger.warn(`[DirectSearch] ${engine} returned status ${result.statusCode}`);
      return [];
    }

    const results = extractSearchResults(result.html, engine);
    logger.debug(`[DirectSearch] ${engine}: ${results.length} results for "${query}" (${result.loadTimeMs}ms)`);
    return results.slice(0, num);
  } catch (err) {
    logger.warn(`[DirectSearch] ${engine} failed: ${(err as Error).message}`);
    return [];
  }
}

/** 构建搜索引擎 URL */
function buildSearchUrl(query: string, num: number, engine: string, language: string): string | null {
  const encodedQuery = encodeURIComponent(query);

  switch (engine) {
    case "google":
      return `https://www.google.com/search?q=${encodedQuery}&num=${num}&hl=${language}&gl=cn`;
    case "bing":
      return `https://www.bing.com/search?q=${encodedQuery}&count=${num}&setlang=${language}`;
    case "baidu":
      return `https://www.baidu.com/s?wd=${encodedQuery}&rn=${num}`;
    default:
      return null;
  }
}

/** 从渲染后的 HTML 提取搜索结果 */
function extractSearchResults(html: string, engine: string): DirectSearchResult[] {
  switch (engine) {
    case "google":
      return extractGoogleResults(html);
    case "bing":
      return extractBingResults(html);
    case "baidu":
      return extractBaiduResults(html);
    default:
      return [];
  }
}

function extractGoogleResults(html: string): DirectSearchResult[] {
  const results: DirectSearchResult[] = [];
  // Google 搜索结果通常在 <div class="g"> 或 <div data-sokoban-container> 中
  // 使用正则提取 (Lightpanda 渲染后的 HTML)

  // Pattern 1: Standard Google result blocks
  const resultBlocks = html.matchAll(/<div[^>]*class="[^"]*g[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<span[^>]*class="[^"]*VwiV3b[^"]*"[^>]*>|<div[^>]*class="[^"]*VwiV3b[^"]*"[^>]*>)([\s\S]*?)(?:<\/span>|<\/div>)/gi);

  let position = 1;
  for (const match of resultBlocks) {
    const link = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    const snippet = match[3].replace(/<[^>]+>/g, "").trim();

    if (link && title && !link.includes("google.com") && !link.includes("accounts.google")) {
      results.push({
        position: position++,
        title,
        link,
        snippet: snippet.slice(0, 300),
        engine: "google-direct",
      });
    }
  }

  // Fallback: simpler pattern for any <a> with href that looks like a result
  if (results.length === 0) {
    const links = html.matchAll(/<a[^>]*href="(https?:\/\/(?!www\.google|accounts\.google|support\.google)[^"]+)"[^>]*>(.*?)<\/a>/gi);
    for (const match of links) {
      const link = match[1];
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      if (title.length > 10 && title.length < 200 && !link.includes(".js") && !link.includes(".css")) {
        results.push({
          position: position++,
          title,
          link,
          snippet: "",
          engine: "google-direct",
        });
        if (results.length >= 20) break;
      }
    }
  }

  return results;
}

function extractBingResults(html: string): DirectSearchResult[] {
  const results: DirectSearchResult[] = [];
  // Bing results in <li class="b_algo">
  const blocks = html.matchAll(/<li[^>]*class="b_algo"[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi);

  let position = 1;
  for (const match of blocks) {
    results.push({
      position: position++,
      title: match[2].replace(/<[^>]+>/g, "").trim(),
      link: match[1],
      snippet: match[3].replace(/<[^>]+>/g, "").trim().slice(0, 300),
      engine: "bing-direct",
    });
  }

  return results;
}

function extractBaiduResults(html: string): DirectSearchResult[] {
  const results: DirectSearchResult[] = [];
  // Baidu results in <div class="result c-container">
  const blocks = html.matchAll(/<div[^>]*class="result[^"]*c-container[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<span[^>]*class="content-right_[^"]*"[^>]*>|<div[^>]*class="c-abstract"[^>]*>)([\s\S]*?)(?:<\/span>|<\/div>)/gi);

  let position = 1;
  for (const match of blocks) {
    results.push({
      position: position++,
      title: match[2].replace(/<[^>]+>/g, "").trim(),
      link: match[1],
      snippet: match[3].replace(/<[^>]+>/g, "").trim().slice(0, 300),
      engine: "baidu-direct",
    });
  }

  return results;
}

/** 多引擎直连搜索 (聚合结果) */
export async function directMultiSearch(
  query: string,
  options: { engines?: string[]; num?: number } = {},
): Promise<DirectSearchResult[]> {
  const { engines = ["google", "bing"], num = 10 } = options;

  const promises = engines.map(engine =>
    directSearch({ query, num, engine: engine as DirectSearchOptions["engine"] }).catch(() => [] as DirectSearchResult[])
  );

  const allResults = await Promise.all(promises);

  // 去重 (按 URL)
  const seen = new Set<string>();
  const merged: DirectSearchResult[] = [];
  let position = 1;

  for (const results of allResults) {
    for (const r of results) {
      const normalizedUrl = r.link.replace(/\/$/, "").toLowerCase();
      if (!seen.has(normalizedUrl)) {
        seen.add(normalizedUrl);
        merged.push({ ...r, position: position++ });
      }
    }
  }

  return merged.slice(0, num * 2); // 返回最多 2x num 个结果
}
