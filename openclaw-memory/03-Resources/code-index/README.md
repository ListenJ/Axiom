---
id: code-index-overview
type: code-index
created: 2026-05-25
tags: [code, index, overview]
---

# 代码索引总览

> 自动生成于 2026/5/25 13:11:12
> 共索引 20 个文件

## 目录结构

### 根目录

- [[cli]] — 代码文件: cli.ts；行数: 322；依赖: bun:sqlite, kg-graph.js, crawl-search-engines.js, crawl-data-pipeline.js, crawl-proxy-manager.js...
- [[main]] — 代码文件: main.ts；行数: 436；依赖: bun:sqlite, memory-vault-manager.js, crawl-data-pipeline.js, crawl-search-engines.js, crawl-proxy-manager.js...

### crawl

- [[crawl-anti-fingerprint]] — 代码文件: crawl\anti-fingerprint.ts；行数: 196；导出: Fingerprint(interface), FingerprintGenerator(class), fpGen(variable)
- [[crawl-data-pipeline]] — 代码文件: crawl\data-pipeline.ts；行数: 887；导出: DataPipeline(class)；依赖: search-engines.js, anti-fingerprint.js, proxy-manager.js, bun:sqlite, memory-vault-manager.js
- [[crawl-proxy-manager]] — 代码文件: crawl\proxy-manager.ts；行数: 167；导出: ProxyConfig(interface), ProxyManager(class), proxyManager(variable)；依赖: fs
- [[crawl-search-engines]] — 代码文件: crawl\search-engines.ts；行数: 499；导出: SearchEngineResult(interface), SearchOptions(interface), SearchAggregator(class), searchAggregator(variable)；依赖: anti-fingerprint.js, proxy-manager.js

### cron

- [[cron-scheduler]] — 代码文件: cron\scheduler.ts；行数: 111；导出: healthCheckT(named), proxyHealthT(named), heartbeatT(named), cleanupT(named)；依赖: bun:sqlite, crawl-proxy-manager.js

### db

- [[db-migrate]] — 代码文件: db\migrate.ts；行数: 221；依赖: bun:sqlite
- [[db-schema]] — 代码文件: db\schema.ts；行数: 152；导出: conversations(variable), tasks(variable), knowledge(variable), entities(variable), relationships(variable)...；依赖: drizzle-orm/sqlite-core

### kg

- [[kg-graph]] — 代码文件: kg\graph.ts；行数: 406；导出: Entity(interface), Relationship(interface), GraphPath(interface), Subgraph(interface), KnowledgeGraph(class)；依赖: bun:sqlite

### mcp

- [[mcp-server]] — 代码文件: mcp\server.ts；行数: 358；依赖: @modelcontextprotocol/sdk/server/mcp.js, @modelcontextprotocol/sdk/server/stdio.js, zod, bun:sqlite, crawl-data-pipeline.js...

### memory

- [[memory-code-indexer]] — 代码文件: memory\code-indexer.ts；行数: 386；导出: CodeIndexEntry(interface), CodeIndexer(class), Name(class), Name(interface), name(function)...；依赖: fs, path
- [[memory-deterministic-search]] — 代码文件: memory\deterministic-search.ts；行数: 608；导出: VaultNote(interface), SearchResult(interface), DeterministicSearchEngine(class)；依赖: fs, path
- [[memory-vault-manager]] — 代码文件: memory\vault-manager.ts；行数: 458；导出: VaultManager(class)；依赖: fs, path, deterministic-search.js, code-indexer.js, utils-logger.js

### router

- [[router-model-router]] — 代码文件: router\model-router.ts；行数: 175；导出: router(variable)

### utils

- [[utils-cache]] — 代码文件: utils\cache.ts；行数: 212；导出: Cache(class), searchCache(variable), crawlCache(variable), modelResponseCache(variable)；依赖: bun:sqlite
- [[utils-config]] — 代码文件: utils\config.ts；行数: 165；导出: AppConfig(interface), loadConfig(function), getModelRoutes(function), getConfig(function), reloadConfig(function)；依赖: fs, yaml
- [[utils-logger]] — 代码文件: utils\logger.ts；行数: 146；导出: logger(variable), Logger(named)；依赖: fs, path
- [[utils-rate-limiter]] — 代码文件: utils\rate-limiter.ts；行数: 112；导出: RateLimiter(class), createRateLimitMiddleware(function), apiLimiter(variable)
- [[utils-websocket]] — 代码文件: utils\websocket.ts；行数: 114；导出: WsMessage(interface), WebSocketManager(class), wsManager(variable)；依赖: bun
