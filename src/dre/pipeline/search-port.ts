/**
 * dre 搜索端口（W8，落地形态审核 §3）。
 *
 * dre 只依赖本端口，不再直接静态 import crawl 路径（pipeline.ts 去 crawl 依赖，
 * 闭合 M13 反向依赖 + architecture-integrity L1 盲区）。本文件是 L1 唯一豁免
 * 允许静态 import crawl 的 dre 文件（端口/适配器角色）。
 *
 * SearchAggregator 结构类型满足 SearchPort（searchMulti 签名一致），零改动即可
 * 作为实现；默认值返回 crawl 模块单例，注入优先——构造签名保持同步。
 */
import {
  SearchAggregator,
  searchAggregator,
  type SearchOptions,
  type SearchEngineResult,
  type SearchFetch,
} from "../../crawl/search-engines.js";

/** dre 对外搜索能力端口：调用方只依赖此接口，不接触 crawl 具体实现。 */
export interface SearchPort {
  searchMulti(opts: SearchOptions, engines?: string[]): Promise<SearchEngineResult[]>;
}

export type { SearchOptions, SearchEngineResult, SearchFetch };

/** 默认端口实现：返回 crawl 模块单例 searchAggregator（同步，构造期可用）。 */
export function defaultSearchPort(): SearchPort {
  return searchAggregator;
}

/** 由 fetch 构造端口（测试/注入用）：内部构造 SearchAggregator，结构兼容 SearchPort。 */
export function searchAggregatorFromFetch(fetch: SearchFetch): SearchPort {
  return new SearchAggregator(fetch);
}
