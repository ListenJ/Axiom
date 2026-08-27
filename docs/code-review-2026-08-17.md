# 代码审核报告 — 2026-08-17

> 范围：本会话新增/修改的核心代码（真实场景评测 + docker 部署 + 路由修复）。
> 方法：按 code-review 技能清单（正确性/安全/性能/可维护性/测试）逐项审查。

## Review Summary

整体质量良好：/search 三层根因修复精准、OCR 预校验防崩溃、FTS reindexAll 打通 KB 检索、工具 schema 修复让模型正确传参、docker 部署链 5 个修复均验证通过。发现 2 个功能级缺陷（web_fetch 丢内容、bing-html 误报不可用）和若干健壮性/可维护性问题。

## Critical Issues (Must Fix)

- **[src/routes/chat.ts:buildWebToolSurfaces web_fetch handler]** `crawlStructured()` 返回完整 `markdown`，但 handler 只返回 `{ url, title, description, headings/tables/codeBlocks/images 计数 }` —— **模型拿不到抓取页正文**，web_fetch 对 chat Agent 近乎无效（只能看到标题/计数，无法总结内容）。建议：返回 `content: result.markdown`（或截断版 `markdown.slice(0, 8000)`）供模型阅读。
- **[src/crawl/search-engines.ts:isEngineAvailable]** 未包含 `"bing-html"` → `listEngines()` 误报 bing-html 不可用；模型的 `search_engines_list` 工具因此会告诉它 bing-html 不可用，实际它是 duckduckgo 反爬时的可靠回退。建议：`case "bing-html": return true;`。

## Warnings

- **[src/memory/vault-manager.ts:reindexAll]** 所有笔记 `createdAt/updatedAt = 重建时刻`，覆盖真实文件 mtime → 影响「最近更新」排序与时间戳保真。建议：读 `fs.statSync(fullPath).mtimeMs` 传入 updatedAt。
- **[src/ocr/engine.ts:assertLangsAvailable]** 若 `langPath` 目录本身不存在，`fs.readdirSync(this.langPath)` 抛 ENOENT 而非友好错误（缺失语言时）。建议：先 `if (!fs.existsSync(this.langPath)) throw 友好错误` 或 try/catch readdirSync。

## Info

- **[src/db/pg-client.ts:getPG]** 返回 `any`（为兼容旧调用方放弃类型化 Row）——务实取舍，建议注释注明并后续收口类型。
- **[src/crawl/search-engines.ts:curlFetch]** `exitCode===0 → status:200`，实际 HTTP 状态未透传（404/202 也报 200）；引擎靠解析体判断，功能可用但状态语义不准。
- **[src/utils/tool-surface.ts:zodToJsonSchema]** 纯对象分支：字段名恰为 `type/properties/items/enum/const` 之一会被误判为已成形 JSON Schema 原样透传（极端边界）。
- **[src/crawl/search-engines.ts:mergeAndDeduplicate]** 跨引擎结果按各自 position（都从 1 起）排序，非全局排名；仅影响展示顺序。
- **[src/routes/api-keys.ts]** `startsWith("/api-keys")` 前缀略宽（`/api-keysX` 也命中），但后续锚定 regex + 结尾 `return null` 已兜底，无实际影响。
- **[src/routes/chat.ts:buildChatToolConfig]** 每请求重建工具面——构建本身无磁盘 I/O（skill 在 handler 内惰性加载），仅小分配，可接受。

## Positive Notes

- /search 三层根因（SPA_ROUTES 劫持 + 导航回退 + handleApiKeys 无条件 401）定位精准，修复后三路径全部正确。
- OCR 语言包预校验防止 tesseract worker 未捕获异常崩进程（好防御实践）。
- VaultManager.reindexAll + listNotePaths 让外部同步的 KB 笔记可被 FTS 检索（chat 场景 2 从空到命中）。
- 工具 schema 纯对象支持修复让模型正确传参（web_search `{"query":...}`）。
- docker 部署链 5 个问题（lock 漂移/ignore-scripts/静态导入/compose user+plugins/dbPath）全部验证通过。
