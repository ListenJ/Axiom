/**
 * 搜索结果过滤器 (Task 2.1)
 *
 * 三层过滤：
 *   1. 黑名单：垃圾站点（赌博/色情/恶意软件）、低质 SEO 内容农场
 *   2. 启发式：标题过短（<10 字符）、纯广告 snippet、snippet 过短（<20 字符）
 *   3. 去重：按 link 归一化后去重，保留 position 最小者
 *
 * API: filterResults(results: SearchEngineResult[]): SearchEngineResult[]
 */
import type { SearchEngineResult } from "./search-engines.js";

/** 黑名单域名片段（匹配 link hostname） */
const BLACKLIST_DOMAIN_PATTERNS: readonly RegExp[] = [
  /casino|gambl|poker|slot/i,
  /porn|xxx|adult|nude/i,
  /malware|phish|spyware|trojan/i,
  /content-?farm|article-?spinner|auto-?blog/i,
  /buy-?cheap|free-?download-?now|click-?here-?now/i,
];

/** 广告 snippet 特征词 */
const AD_SNIPPET_PATTERNS: readonly RegExp[] = [
  /^(buy|shop|order|deals?|discount|coupon|sale)\b/i,
  /\b(free shipping|100% guaranteed|act now|limited time offer)\b/i,
  /\b(click here|visit our|check out our|learn more today)\b/i,
];

/** 归一化 link：去除 query/hash，小写 */
function normalizeLink(link: string): string {
  try {
    const u = new URL(link);
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return link.toLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

/** 判断是否命中黑名单 */
function isBlacklisted(link: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(link).hostname.toLowerCase();
  } catch {
    hostname = link.toLowerCase();
  }
  return BLACKLIST_DOMAIN_PATTERNS.some((re) => re.test(hostname));
}

/** 判断 snippet 是否为纯广告 */
function isAdSnippet(snippet: string): boolean {
  const trimmed = snippet.trim();
  if (trimmed.length === 0) return false;
  return AD_SNIPPET_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * 过滤搜索结果。
 * 顺序：黑名单 → 启发式 → 去重，保留 position 最小者。
 */
export function filterResults(results: SearchEngineResult[]): SearchEngineResult[] {
  // 1. 黑名单过滤
  const passedBlacklist = results.filter((r) => {
    if (isBlacklisted(r.link)) return false;
    if (isBlacklisted(r.displayedUrl)) return false;
    return true;
  });

  // 2. 启发式过滤
  const passedHeuristic = passedBlacklist.filter((r) => {
    if (!r.title || r.title.trim().length < 10) return false;
    if (!r.snippet || r.snippet.trim().length < 20) return false;
    if (isAdSnippet(r.snippet)) return false;
    return true;
  });

  // 3. 去重（按归一化 link，保留 position 最小者）
  const seen = new Map<string, SearchEngineResult>();
  for (const r of passedHeuristic) {
    const key = normalizeLink(r.link);
    const existing = seen.get(key);
    if (!existing || r.position < existing.position) {
      seen.set(key, r);
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.position - b.position);
}
