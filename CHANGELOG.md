# Changelog

## v4.0.0 — The Axiom Release (2026-06-30)

### 🔄 Breaking: 品牌重塑 — Axiom Runtime

- **从 OpenClaw 更名为 Axiom**
  - 项目定位从 "AI Agent Framework" 进化为 "Deterministic Cognitive Runtime"
  - 名称含义: "公理" — 推理基于公理 (Constraint + Rule)，而非概率猜测
  - 口号: *Reasoning from Axioms, not Probabilities.*
- **全局重命名** (88 文件):
  - `OpenClaw` → `Axiom`, `openclaw` → `axiom`
  - 环境变量: `OPENCLAW_*` → `AXIOM_*`
  - 错误类: `OpenClawError` → `AxiomError`, `toOpenClawError` → `toAxiomError`
  - 配置文件: `config/openclaw.yaml` → `config/axiom.yaml`
  - 域名: `openclaw.ai` → `axiom-runtime.ai`
  - 包名: `openclaw-agent` → `axiom-agent`
- **新增**: [`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md) — 项目设计哲学最高指导原则

### 🧠 CognitivePipeline — 最小认知闭环

- 首个连接现有模块的信息流水线 (classify → knowledge → reasoning → constraint → action → reflection)
- 零 LLM 确定性管道, 每步可追踪
- 新增 MCP 工具 `cognitive_loop` + 场景号 22
- 17 个集成测试

### 🏗️ 架构对齐

- ARCHITECTURE.md 核心定位重写为 "Cognitive Runtime"
- 引擎层标注 LLM 降级为 Cognitive Accelerator
- Minimum Cognitive Loop 作为架构中枢

---

## v2.9.2 (2026-06-30)

### 🧠 认知运行时增强 (v3.2.0 全部缺陷修复)

- **认知闭环 (CognitivePipeline)** (`src/dre/pipeline/cognitive-pipeline.ts`)
  - 最小认知闭环: classify → knowledge → reasoning → constraint → action → reflection
  - 零 LLM 确定性管道, 每步可追踪 (CognitiveStep)
  - 连接现有模块 (KnowledgeStore/ReasoningGraph/ConstraintSolver/ConsciousnessStream)
  - 新增 MCP 工具: `cognitive_loop` + 22 号场景
  - 17 个集成测试覆盖正常流程/边界/鲁棒性
- **多维约束求解器** (`src/dre/constraint/solver.ts`)
  - 5 维约束: logical / physical / semantic / policy / temporal
  - 预定义约束: GPU VRAM 最低要求、生产环境保护、工作时间限制
  - 新增 MCP 工具: `constraint_check`, `constraint_select_best`, `constraint_list`, `constraint_stats`
- **轻量级 Actor 系统** (`src/dre/actor/system.ts`)
  - 4 个 Actor: Knowledge / Constraint / MentalModel / Reasoning
  - 消息邮箱 + 异步处理 + 代理模式
  - 新增 MCP 工具: `actor_list`, `actor_send`
- **反思循环集成 MentalState/Belief**
  - 从 LLM 输出中提取 intent/goals/beliefs
  - 观察中包含心智状态
  - `close()` 改为 async，正确关闭 ActorSystem

### 🐛 Bug 修复

- **KnowledgeStore.write() 返回 revision 始终为 1** — 修复为返回实际版本号
- **MentalModelPool.matchPattern() 概念匹配过于简单** — 增加概念关系扩展 (may-cause/requires)
- **MentalModelPool.register() 多池共享可变状态** — 深拷贝模型对象，避免常量被修改
- **ReasoningGraph.fillGap() 每次重算 gaps** — 新增 `fillGapFromObject()` 直接接受 gap 对象
- **ProcedureKnowledge.evaluateCondition 不支持 AND/OR** — 增加 `||` 和 `&&` 递归求值
- **ActorSystem.queryState 竞态条件** — 增加 resolved 标志防止重复 resolve
- **3 处缺失 logger 导入** — `kg/graph.ts`, `llm/client.ts`, `storage/sqlite-backend.ts` 添加 logger 导入 (修复运行时 ReferenceError)
- **9 处静默 catch 块** — 添加 `logger.debug` 日志记录

### 📦 文档 & 工具链

- **场景路由扩展**: 新增 5 个认知场景 (constraint/mental-model/reasoning/actor/procedure)，总计 21 场景
- **工具计数统一**: README/ARCHITECTURE/MCP_TOOLS_GUIDE 三文件工具计数统一为 88/33/12
- **MCP_TOOLS_GUIDE 更新**: 代码分析 5→8 工具，依赖图重构，FAQ 更新
- **ARCHITECTURE 更新**: 测试文件列表新增 scene-router/cognitive-modules 测试
- **版本号统一**: package.json 和 server.ts McpServer 统一为 2.9.2
- **类型安全**: 修复 7 处 `as any` 类型转换 (KGNodeType/KGEdgeType/ConstraintDimension)

## v2.9.1 (2026-06-30)

### 🧠 认知增强第一阶段

- **知识层扩展** (`src/dre/storage/knowledge-store.ts`)
  - 新增范式: behavior (行为) / prediction (预测) / hypothesis (假设)
  - `BehaviorKnowledge` 类: 从规则提取行为模式，预测条件下的结果
  - `HypothesisManager` 类: 假设生命周期管理 (untested→testing→confirmed/refuted)
  - `ProcedureKnowledge` 类: 过程性知识解析 (步骤序列、条件分支、循环)
  - SQLite schema 迁移: knowledge_node 表新增 behavior/prediction/hypothesis 列
- **心智模型层** (`src/dre/mental-model/pool.ts`)
  - 桥接 Pattern→Skill 认知断层
  - 预注册模型: Git 冲突模型、代码重构模型
  - 新增 MCP 工具: `mental_model_list`, `mental_model_match`, `mental_model_predict`
- **推理图** (`src/dre/reasoning/graph.ts`)
  - 打破 LLM 黑盒: 先构建推理图，再精确填补空洞
  - 4 种空洞类型: missing_premise / missing_inference / missing_evidence / weak_link
  - 新增 MCP 工具: `reasoning_build`, `reasoning_detect_gaps`, `reasoning_fill_gap`, `reasoning_result`
- **世界状态心智维度** (`src/agents/consciousness/types.ts`)
  - 新增 `Belief` 接口: 置信度加权命题 + 支持/反对证据
  - 新增 `MentalState` 接口: currentIntent + goals + beliefs + activeHypotheses
  - `SelfState` 增加 `mental` 字段

## v2.9.0 (2026-06-29)

### 🏗️ 架构缺陷修复

- **统一知识访问层 KAL** (`src/kal/`)
  - 全局 node_id 体系: `{store}:{type}:{identifier}`
  - 跨 Vault/KG/DRE fan-out 查询 + 结果合并
  - 新增 MCP 工具: `kal_query`, `kal_references`
- **文档处理管道 DIP** (`src/crawl/processor/`)
  - Markdown AST 解析器 (零 LLM)
  - AST→KG 写入器
  - 新增 MCP 工具: `dip_ingest_document`, `dip_query_ast`
- **DRE 三级降级链** (`src/dre/engine.ts`)
  - L1: 本地 Qwen3-1.7B → L2: 云 API (DeepSeek) → L3: 规则推理
  - `dre_consciousness_step` 不再硬故障
- **双 KG 系统合并** (`src/mcp/server.ts`)
  - PostgreSQL KG 工具自动 fallback 到 SQLite 执行
  - 统一降级: try PG → catch → SQLite
- **VRAM 预算管理** (`src/dre/vram-budget.ts`)
  - nvidia-smi 检测 GPU 可用性
  - 推荐最大上下文长度
  - 新增 MCP 工具: `vram_status`
- **场景路由** (`src/mcp/scene-router.ts`)
  - 16 个预定义场景覆盖全部工具组
  - 意图→工具子集匹配 (降低 context token)
  - 新增 MCP 工具: `scene_suggest_tools`, `scene_list`
- **工具分类全覆盖** (`src/agents/execution-mode.ts`)
  - TOOL_CLASSIFICATIONS: 36 → 150
  - 移除 3 个幻影工具 (fs_exists/git_show/terminal_kill)
  - MODE_CONFIGS 新增分类: mental-model / reasoning / procedure / constraint / actor

### 📊 统计

- 工具总数: 111 → 150 (+39)
- 新增文件: 9 个
- 修改文件: 10 个
- 修复缺陷: 10/10 (v3.2.0 全部缺陷)

## v2.8.2 (2026-06-26)

### 📁 文件结构整理

- **归档历史文件**: 将过时的文档和报告移到 `archive/`
  - `archive/docs/` — 历史文档
  - `archive/reports/` — 研究报告
  - `archive/tests/` — 测试文件
- **清理根目录**: 移除散落的 `.md` 文件和 `.bundle` 备份
- **更新 .gitignore**: 标记不上传 GitHub 的文件

### 📚 文档整理

- **新增 `docs/ARCHITECTURE.md`**: 完整技术架构文档
  - 系统概览与架构图
  - 技术栈详解
  - MCP 工具架构 (111 个工具)
  - 引擎层详解 (Vault/Arena/KG/DRE)
  - 开发路径与版本历史
  - 工具降级策略
  - 部署指南
- **更新 README.md**: 添加工具可用性说明和降级方案

### 🔧 工具降级改进

- **PostgreSQL 工具**: 添加降级提示，建议使用 SQLite 替代方案
  - `kg_stats` → `kg_enhanced_stats`
  - `kg_entities` → `kg_search_nodes`
  - `kg_entity_detail` → `kg_subgraph`
  - `kg_traverse` → `kg_subgraph`
  - `kg_graph` → `kg_echarts_data` / `kg_d3_data`
- **DRE 工具**: 添加降级提示，建议使用 `memory_write`
  - `dre_write_knowledge` → `memory_write`
  - `dre_consciousness_step` → 无降级方案

## v2.8.1 (2026-06-26)

### 🔧 代码质量改进

- **移除 5 个编译失败的幽灵工具**
  - `tavily_search` — 源文件不存在
  - `brave_search` — 源文件不存在
  - `jina_read` — 源文件不存在
  - `jina_search` — 源文件不存在
  - `search_providers_health` — 源文件不存在
- **整理文档**
  - 新增 `docs/MCP_TOOLS_GUIDE.md` — MCP 工具完整指南
  - 更新 README 工具表 — 按可用性分层
  - 工具总数从 141 修正为 111

### 工具可用性统计

| 分类 | 数量 | 状态 |
|------|------|------|
| 核心工具 (零配置) | 65 | ✅ 始终可用 |
| 配置工具 (需 API Key) | 34 | ⚙️ 配置后可用 |
| 外部服务工具 | 12 | 🔧 需安装服务 |

## v2.8.0 (2026-06-26)

### ✨ 新增功能

- **知识图谱增强** - 新增 `src/kg/enhanced.ts`
  - 语义层: 节点语义描述、标签系统
  - 可视化: ECharts/D3.js 数据格式生成
  - 社区检测: Louvain 算法 (简化版)
  - 自然语言查询: NL → 图查询转换
  - 多跳路径查找: BFS + DFS 混合策略
  - 10 个新 MCP 工具:
    - `kg_add_node`: 添加节点
    - `kg_add_edge`: 添加边
    - `kg_search_nodes`: 搜索节点
    - `kg_subgraph`: 子图检索
    - `kg_shortest_path`: 最短路径
    - `kg_detect_communities`: 社区检测
    - `kg_echarts_data`: ECharts 可视化数据
    - `kg_d3_data`: D3.js 可视化数据
    - `kg_nl_query`: 自然语言查询
    - `kg_enhanced_stats`: 增强统计信息
- **MCP 工具总数** - 从 130+ 扩展到 140+ 个工具

## v2.7.0 (2026-06-26)

### ✨ 新增功能

- **DRE 确定性推理引擎** - 自研文件系统 + 三段式自甄别 + 意识流 + 知识图谱
  - VFS 虚拟文件系统: 统一挂载知识库/项目/缓存，最长前缀匹配路由
  - SQLite 存储后端: WAL 模式 + 自动版本快照 + 内容哈希 (sha256)
  - 知识库存储: 3NF/4NF 范式设计 + 版本历史 + 三段甄别集成
  - 三段甄别流水线: 预筛(规则引擎) → 网络校验(Playwright) → LLM 自推理(强约束)
  - 意识流: 工作记忆(16项FIFO) + 短期记忆(TTL=1h) + 反思队列
  - 知识图谱: BFS 子图检索 + 最短路径 + 社区检测
  - Agent Harness: Planner/Coder/Retriever/Reflector 四类 Agent
  - LLM 客户端: JSON Schema 约束 + 拒绝采样(n=3取众数) + 温度=0
  - 6 个新 MCP 工具: `dre_write_knowledge`, `dre_read_knowledge`, `dre_search_knowledge`, `dre_subgraph`, `dre_consciousness_step`, `dre_status`
- **MCP 工具总数** - 从 120+ 扩展到 130+ 个工具

### 架构设计

- TypeScript 实现意识流核心 (类型安全 + JSON 处理 + 流式响应)
- 4GB 显存优化: Qwen3-1.7B Q4_K_M 主推理 + Qwen3-0.6B 甄别 + KV Cache Q8
- 确定性保证: 温度=0 + 固定种子 + 全量 trace + JSON Schema 约束

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

- **统一错误处理** - 关键模块采用 AxiomError 体系
  - `arena-collector.ts` 使用 `toAxiomError` 统一错误转换
  - `model-eval-service.ts` 使用 `toAxiomError` 统一错误转换
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
