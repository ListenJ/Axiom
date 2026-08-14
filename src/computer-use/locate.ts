/**
 * 无头浏览器精确定位（Headless Locate）— 模块/位置定位
 *
 * 需求 3：用无头浏览器（CDP）对页面模块/位置做**精确**定位——
 * 提取可交互元素（getBoundingClientRect 实测坐标），按查询过滤，
 * 返回边界框（x/y/width/height/center），供文本引导、Agent 操控、
 * 或插入 LLM 约束词（需求 4）。
 *
 * 纯函数 filterElementsByQuery 可测试；locateOnPage 需要 CDP 端点。
 */

import type { InteractiveElement } from "../crawl/lightpanda-client.js";
import { extractInteractiveElements } from "../crawl/lightpanda-client.js";

export interface LocateQuery {
  /** 文本子串（大小写不敏感） */
  text?: string;
  /** role 精确匹配（button/link/input/...） */
  role?: string;
  /** tag 精确匹配（button/a/input/...） */
  tag?: string;
  /** 精确元素 index */
  index?: number;
}

export interface LocatedElement {
  index: number;
  tag: string;
  role: string;
  text: string;
  bbox: { x: number; y: number; width: number; height: number; centerX: number; centerY: number };
  attrs: Record<string, string>;
}

/** 过滤可交互元素（纯函数、可测试） */
export function filterElementsByQuery(elements: InteractiveElement[], query: LocateQuery): LocatedElement[] {
  return elements
    .filter((el) => {
      if (query.index !== undefined && el.index !== query.index) return false;
      if (query.role && el.role !== query.role) return false;
      if (query.tag && el.tag !== query.tag) return false;
      if (query.text) {
        const hay = `${el.text} ${Object.values(el.attrs).join(" ")}`.toLowerCase();
        if (!hay.includes(query.text.toLowerCase())) return false;
      }
      return true;
    })
    .map((el) => ({
      index: el.index,
      tag: el.tag,
      role: el.role,
      text: el.text,
      bbox: { x: el.x, y: el.y, width: el.width, height: el.height, centerX: el.centerX, centerY: el.centerY },
      attrs: el.attrs,
    }));
}

export interface LocateOptions {
  cdpUrl: string;
  query: LocateQuery;
  limit?: number;
  timeoutMs?: number;
}

export interface LocateResult {
  found: number;
  matches: LocatedElement[];
  /** 无 CDP 时的引导提示 */
  hint?: string;
}

/** 无头浏览器定位：CDP 提取 → 查询过滤 → 返回边界框 */
export async function locateOnPage(opts: LocateOptions): Promise<LocateResult> {
  const elements = await extractInteractiveElements(opts.cdpUrl, opts.timeoutMs ?? 10000);
  const matches = filterElementsByQuery(elements, opts.query);
  const limited = matches.slice(0, opts.limit ?? 20);
  return {
    found: matches.length,
    matches: limited,
    hint:
      matches.length > 0
        ? `定位到 ${matches.length} 个元素；如需真实浏览器核对可调用 browser_launch。`
        : `未匹配到元素；可先 browser_launch 打开页面再核对。`,
  };
}
