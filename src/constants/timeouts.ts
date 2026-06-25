/**
 * 集中式超时配置
 * 所有超时常量统一维护在此，避免硬编码分散在各地
 */

export const TIMEOUTS = {
  // API 调用默认超时
  API_DEFAULT: 30_000,

  // 流式/推理 API 超时（较长）
  API_STREAMING: 60_000,

  // 快速 API 超时（健康检查、简单查询）
  API_FAST: 10_000,

  // 中等 API 超时（普通查询）
  API_MEDIUM: 15_000,

  // 熔断器恢复超时
  CIRCUIT_BREAKER_RESET: 30_000,

  // 断路器最大延迟
  CIRCUIT_BREAKER_MAX_DELAY: 30_000,

  // 健康检查轮询间隔
  HEALTH_CHECK_INTERVAL: 10_000,

  // 优雅关闭最大等待时间
  GRACEFUL_SHUTDOWN: 30_000,

  // Token 追踪器刷盘间隔
  TOKEN_TRACKER_FLUSH: 30_000,

  // 文件监听器防抖超时
  FILE_WATCHER_DEBOUNCE: 30_000,

  // MCP 工具调用超时
  MCP_TOOL_DEFAULT: 30_000,

  // 终端命令执行超时
  TERMINAL_COMMAND: 30_000,

  // 代码分析超时
  CODE_ANALYSIS: 30_000,

  // 重试延迟
  RETRY_DELAY: 1_000,

  // 启动等待
  LAUNCHER_READY: 1_500,

  // 爬虫搜索超时
  CRAWLER_SEARCH: 15_000,

  // SERP API 超时
  SERP_API: 20_000,

  // 心跳检测间隔
  HEARTBEAT_INTERVAL: 30_000,

  // CodeGraph 重索引最小间隔（避免频繁全量重建）
  CODEGRAPH_REINDEX_COOLDOWN: 30_000,

  // CodeGraph 查询缓存 TTL
  CODEGRAPH_CACHE_TTL: 60_000,
} as const;

// 保持向后兼容的默认导出
export default TIMEOUTS;
