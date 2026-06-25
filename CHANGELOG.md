# Changelog

## v2.6.0 (2026-06-26)

### ✨ 新增功能

- **多 Agent 编排统一** - 新增 `src/agents/orchestrator.ts`
  - Agent Registry — 动态注册/发现 Agent
  - Task Router — 基于任务类型自动选择 Agent
  - Task Decomposition — 复杂任务分解为子任务
  - Parallel Execution — 并行执行独立子任务
  - Result Aggregation — 合并子任务结果
  - 支持串行/并行/DAG 三种执行模式
  - 5 个新 MCP 工具: `orchestrator_execute_task`, `orchestrator_execute_plan`, `orchestrator_list_agents`, `orchestrator_health_check`, `orchestrator_status`
- **MCP 工具总数** - 从 113 扩展到 120+ 个工具

## v2.5.3 (2026-06-25)

### 🔧 代码质量改进

- **统一错误处理** - 关键模块采用 OpenClawError 体系
  - `arena-collector.ts` 使用 `toOpenClawError` 统一错误转换
  - `model-eval-service.ts` 使用 `toOpenClawError` 统一错误转换
  - 错误日志包含结构化错误码

## v2.5.2 (2026-06-25)

### 🔧 代码质量改进

- **统一 retry/backoff 逻辑** - 提取 `calculateBackoffDelay` 到 `src/utils/resilience.ts`
  - `model-router.ts` 中 3 处内联 backoff 改用共享工具函数
  - 支持自定义 baseDelay、maxDelay、backoffMultiplier 参数
- **泛型化 consciousness shim 模式** - 新增 `src/utils/lazy-singleton.ts`
  - 更新 5 个 shim 文件使用 `createLazySingleton` 泛型工具
  - 消除重复的单例延迟加载代码模式

## v2.5.1 (2026-06-25)

### 🔧 代码质量改进

- **补充缺失的 MCP 工具** - 修复 README 声称但未实现的工具
  - 新增 7 个知识图谱工具: `kg_stats`, `kg_entities`, `kg_entity_detail`, `kg_traverse`, `kg_build`, `kg_search`, `kg_graph`
  - 新增 `proxy_status` 代理状态工具
  - 新增 `github_get_issue` Issue 详情工具
  - 移除 README 中不存在的 `project_plan` 和 `project_arch_review`
- **消除重复代码** - 提取 `safeJsonParse` 到 `src/utils/json.ts`
  - 移除 `model-eval-service.ts` 中的重复实现
  - 移除 `arena-collector.ts` 中的重复实现
  - 移除 `plugin-registry.ts` 中的重复实现
- **修复文档错误**
  - 修正 `SEARXNG_URL` 为 `SEARXNG_INSTANCE`
  - 移除已废弃的 `YANDEX_API_KEY`
  - 补充缺失的环境变量: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `JINA_API_KEY`, `GITHUB_TOKEN`
  - 更新搜索引擎列表为实际实现的引擎
  - 更新工具总数从 70+ 到 100+

## v2.5.0 (2026-06-25)

### ✨ 新增功能

- **竞技场榜单数据采集器** - 基于 Chapter 3 研究文档实现确定性评估管线
  - 支持 LMSYS Arena、OpenCompass、HuggingFace、LLM Stats 四大数据源
  - JSON Schema 验证，每条数据必填 source_url，杜绝幻觉
  - SQLite FTS5 存储，BM25 确定性检索
  - 确定性角色推荐算法（矩阵乘法）
  - 8 个新 MCP 工具: `arena_collect`, `arena_search_models`, `arena_get_model_scores`, `arena_benchmark_ranking`, `arena_composite_ranking`, `arena_role_recommendation`, `arena_stats`, `arena_sources`
- **User Agent Prompt 连接池** - 基于 Chapter 5 研究文档实现缓存优化
  - System Prompt Only Caching 策略 (41-80% 成本降低)
  - 8 核心角色系统提示词预构建与池化
  - XXH3 增量哈希前缀指纹
  - 混合 LRU/LFU/TTL 淘汰策略
  - 缓存预热与监控指标
  - 6 个新 MCP 工具: `prompt_pool_acquire`, `prompt_pool_metrics`, `prompt_pool_status`, `prompt_pool_roles`, `prompt_pool_warmup`, `prompt_pool_evict`
- **MCP 工具总数** - 从 50+ 扩展到 70+ 个工具

## v2.4.0 (2026-06-25)

### ✨ 新增功能

- **GitHub MCP Server 集成** - 新增 21 个 GitHub MCP 工具，覆盖完整的开发者工作流
  - **仓库管理**: `github_list_repos`, `github_get_repo`, `github_create_repo`, `github_fork_repo`
  - **Issue 管理**: `github_list_issues`, `github_create_issue`, `github_add_issue_comment`
  - **Pull Request**: `github_list_prs`, `github_create_pr`, `github_review_pr`, `github_get_pr_files`
  - **代码浏览**: `github_get_file_contents`, `github_list_directory`, `github_search_code`
  - **发布管理**: `github_list_releases`, `github_create_release`
  - **Actions**: `github_list_workflows`, `github_trigger_workflow`, `github_list_workflow_runs`, `github_get_workflow_run`
  - **健康检查**: `github_health`
- **MCP 工具总数** - 从 31+ 扩展到 50+ 个工具

### 📄 文档

- README.md 更新 MCP 工具列表，新增 GitHub 类别
- 版本号升级至 v2.4.0

## v2.2.0 (2026-06-03)

### ✨ 新增功能

- **Scene Routes Detail Endpoint** - 新增 `GET /mcp/scenes/:id` 端点，支持查询场景详情
- **Office 适配器** - 新增 Windows COM、macOS AppleScript、WPS Office 适配器
  - `ComWordAdapter`, `ComExcelAdapter`, `ComPowerPointAdapter` (Windows)
  - `AppleScriptWordAdapter`, `AppleScriptExcelAdapter`, `AppleScriptPowerPointAdapter` (macOS)
  - `WPSWordAdapter`, `WPSExcelAdapter`, `WPSPowerPointAdapter` (WPS Office)
- **核心模块测试** - 新增测试覆盖
  - `tests/vault-manager.test.ts`
  - `tests/data-pipeline.test.ts`
  - `tests/model-router.test.ts`
  - `tests/mcp-server.test.ts`

### 🔧 代码质量改进

- **统一版本号** - 所有版本号统一为 `2.2.0`
- **集中超时配置** - 创建 `src/constants/timeouts.ts`，替换所有硬编码 `30000ms`
- **消除 `any` 类型** - 修复约 30 个文件，150+ 处 `catch (e: any)` 和 `as any`
- **修复定时器泄漏** - `cache.ts`、`tui/app.ts`、`main.ts` 添加 cleanup
- **统一错误处理** - 创建 `src/utils/errors.ts`，包含 10+ 自定义错误类
- **重构 Office 适配器** - 提取共享逻辑到 `platform-adapter.ts`
- **替换 console.log** - `cron/scheduler.ts` 使用 logger

### 🐛 Bug 修复

- **TUI 端口显示** - 修复端口显示为 `3000` 的问题，正确显示 `18789`
- **环境验证** - `env-validation.ts` 默认端口修正为 `18789`
- **构建脚本** - 修复 `--target bun` 参数
- **导入修复** - `resilience.test.ts` 和 `ast-engine.test.ts` 导入修复

### 📄 文档

- README.md 添加版本号标识
- 新增 CHANGELOG.md

### 📊 统计

- 144 个文件修改
- +24,600 行 / -8,378 行
- 62 个文件新增/修改/删除
