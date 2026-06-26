# OpenClaw Fusion MCP 工具指南

> 适用于 Windows 11 + OpenCode 环境
> 最后更新: 2026-06-26

## 工具总览

| 分类 | 数量 | 状态 |
|------|------|------|
| 核心工具 (零配置) | 65 | ✅ 始终可用 |
| 配置工具 (需 API Key) | 34 | ⚙️ 配置后可用 |
| 外部服务工具 | 12 | 🔧 需安装服务 |
| **总计** | **111** | - |

---

## 第一层：核心工具 (零配置，65 个)

这些工具在 Windows 11 上安装 Bun 后即可使用，无需任何额外配置。

### Vault 记忆引擎 (8 个)

| 工具 | 功能 | 使用场景 |
|------|------|----------|
| `memory_search` | 确定性搜索 Vault 笔记 | 搜索知识库 |
| `memory_read` | 读取指定笔记 | 获取笔记内容 |
| `memory_write` | 写入笔记 | 保存知识 |
| `memory_atomic` | 创建原子笔记 | Zettelkasten 方法 |
| `memory_browse` | 按 PARA/标签浏览 | 浏览知识库 |
| `memory_network` | 获取笔记关联网络 | 发现关联知识 |
| `memory_stats` | Vault 统计信息 | 了解知识库规模 |
| `code_index` | 索引项目代码 | 代码知识化 |

### 文件系统工具 (6 个)

| 工具 | 功能 |
|------|------|
| `fs_read` | 读取文件 |
| `fs_write` | 写入文件 |
| `fs_list` | 列出目录 |
| `fs_search` | 搜索文件内容 |
| `fs_delete` | 删除文件 |
| `fs_move` | 移动/重命名文件 |

### Git 工具 (5 个)

| 工具 | 功能 |
|------|------|
| `git_status` | 查看状态 |
| `git_diff` | 查看差异 |
| `git_log` | 查看提交历史 |
| `git_branch` | 查看分支 |
| `git_blame` | 查看文件修改记录 |

### 代码分析工具 (5 个)

| 工具 | 功能 |
|------|------|
| `code_symbols` | 查找符号 |
| `code_references` | 查找引用 |
| `code_outline` | 获取代码大纲 |
| `code_analyze` | 分析代码复杂度 |
| `code_detect_language` | 检测编程语言 |

### 快照工具 (5 个)

| 工具 | 功能 |
|------|------|
| `snapshot_create` | 创建快照 |
| `snapshot_revert` | 回滚快照 |
| `snapshot_list` | 列出快照 |
| `snapshot_diff` | 对比快照 |
| `snapshot_status` | 快照状态 |

### Prompt 连接池 (6 个)

| 工具 | 功能 |
|------|------|
| `prompt_pool_acquire` | 获取缓存友好提示词 |
| `prompt_pool_metrics` | 缓存命中率指标 |
| `prompt_pool_status` | 连接池状态 |
| `prompt_pool_roles` | 列出角色配置 |
| `prompt_pool_warmup` | 预热缓存 |
| `prompt_pool_evict` | 执行淘汰策略 |

### 竞技场榜单 (7 个)

| 工具 | 功能 |
|------|------|
| `arena_search_models` | 搜索模型 (FTS5) |
| `arena_get_model_scores` | 获取模型分数 |
| `arena_benchmark_ranking` | 基准排名 |
| `arena_composite_ranking` | 综合排名 |
| `arena_role_recommendation` | 角色推荐 |
| `arena_stats` | 榜单统计 |
| `arena_sources` | 数据源列表 |

### 知识图谱增强 (10 个)

| 工具 | 功能 |
|------|------|
| `kg_add_node` | 添加节点 |
| `kg_add_edge` | 添加边 |
| `kg_search_nodes` | 搜索节点 |
| `kg_subgraph` | 子图检索 |
| `kg_shortest_path` | 最短路径 |
| `kg_detect_communities` | 社区检测 |
| `kg_echarts_data` | ECharts 可视化数据 |
| `kg_d3_data` | D3.js 可视化数据 |
| `kg_nl_query` | 自然语言查询 |
| `kg_enhanced_stats` | 图谱统计 |

### DRE 确定性推理 (4 个只读工具)

| 工具 | 功能 |
|------|------|
| `dre_read_knowledge` | 读取知识条目 |
| `dre_search_knowledge` | 搜索知识库 |
| `dre_subgraph` | 知识图谱子图 |
| `dre_status` | DRE 引擎状态 |

### 其他工具 (9 个)

| 工具 | 功能 |
|------|------|
| `db_query` | SQL 查询 |
| `list_free_models` | 列出免费模型 |
| `token_stats` | Token 使用统计 |
| `token_stats_by_model` | 按模型统计 |
| `token_stats_by_role` | 按角色统计 |
| `token_daily_stats` | 每日统计 |
| `set_mode` / `get_mode` | 执行模式切换 |
| `orchestrator_list_agents` | 列出 Agent |
| `orchestrator_status` | 编排器状态 |
| `proxy_status` | 代理状态 |

---

## 第二层：配置工具 (需 API Key，34 个)

配置对应的环境变量后即可使用。

### GitHub 工具 (22 个)

**所需环境变量**: `GITHUB_TOKEN`

获取方式: https://github.com/settings/tokens

| 工具 | 功能 |
|------|------|
| `github_list_repos` | 列出仓库 |
| `github_get_repo` | 获取仓库详情 |
| `github_create_repo` | 创建仓库 |
| `github_fork_repo` | Fork 仓库 |
| `github_list_issues` | 列出 Issues |
| `github_get_issue` | 获取 Issue 详情 |
| `github_create_issue` | 创建 Issue |
| `github_add_issue_comment` | 添加评论 |
| `github_list_prs` | 列出 PRs |
| `github_create_pr` | 创建 PR |
| `github_review_pr` | 审查 PR |
| `github_get_pr_files` | 获取 PR 文件 |
| `github_get_file_contents` | 获取文件内容 |
| `github_list_directory` | 列出目录 |
| `github_search_code` | 搜索代码 |
| `github_list_releases` | 列出 Releases |
| `github_create_release` | 创建 Release |
| `github_list_workflows` | 列出 Actions |
| `github_trigger_workflow` | 触发 Action |
| `github_list_workflow_runs` | 列出运行记录 |
| `github_get_workflow_run` | 获取运行详情 |
| `github_health` | 健康检查 |

### 模型路由工具 (5 个)

**所需环境变量**: `DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY` / `OPENROUTER_API_KEY` 等

| 工具 | 功能 |
|------|------|
| `model_chat` | 模型聊天 |
| `code_generate` | 代码生成 |
| `code_refactor` | 代码重构 |
| `code_review` | 代码审查 |
| `code_test` | 测试生成 |

### MiniMax 工具 (3 个)

**所需环境变量**: `MINIMAX_API_KEY`

| 工具 | 功能 |
|------|------|
| `minimax_web_search` | 网络搜索 |
| `minimax_image_understand` | 图像识别 |
| `minimax_health` | 健康检查 |

### 编排器工具 (2 个)

**所需环境变量**: 模型 API Key

| 工具 | 功能 |
|------|------|
| `orchestrator_execute_task` | 执行任务 |
| `orchestrator_execute_plan` | 执行计划 |

### 榜单采集 (1 个)

**所需环境变量**: 无 (需网络)

| 工具 | 功能 |
|------|------|
| `arena_collect` | 采集榜单数据 |

---

## 第三层：外部服务工具 (12 个)

需要安装额外服务才能使用。

### PostgreSQL 知识图谱 (7 个)

**所需服务**: PostgreSQL + pgvector

**Windows 11 安装**:
```bash
# 使用 Docker
docker run -d --name pgvector -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16

# 或使用 Windows 安装包
# https://www.postgresql.org/download/windows/
```

| 工具 | 功能 | 降级方案 |
|------|------|----------|
| `kg_stats` | 图谱统计 | 使用 `kg_enhanced_stats` |
| `kg_entities` | 查询实体 | 使用 `kg_search_nodes` |
| `kg_entity_detail` | 实体详情 | 使用 `kg_subgraph` |
| `kg_traverse` | 图遍历 | 使用 `kg_subgraph` |
| `kg_graph` | 可视化数据 | 使用 `kg_echarts_data` |
| `kg_build` | 构建图谱 | 手动添加节点 |
| `kg_search` | 语义搜索 | 使用 `kg_nl_query` |

### DRE 写入工具 (2 个)

**所需服务**: llama.cpp 本地 LLM

**Windows 11 安装**:
```bash
# 需要 NVIDIA GPU (RTX 3050 Ti+)
# 下载 llama.cpp: https://github.com/ggerganov/llama.cpp/releases

# 启动主推理模型
llama-server -m qwen3-1.7b-instruct-q4_k_m.gguf -ngl 99 -c 4096 --port 8080
```

| 工具 | 功能 | 降级方案 |
|------|------|----------|
| `dre_write_knowledge` | 写入知识 (三段甄别) | 使用 `memory_write` |
| `dre_consciousness_step` | 意识流处理 | 暂无降级方案 |

### CLI Agent 工具 (3 个)

**所需服务**: OpenCode CLI / Hermes CLI

| 工具 | 功能 | 降级方案 |
|------|------|----------|
| `opencode_status` | OpenCode 状态 | 忽略 |
| `project_research` | 项目研究 | 使用 `model_chat` |
| `hermes_status` | Hermes 状态 | 忽略 |

---

## 推荐配置

### 最小配置 (零成本)

只需安装 Bun，即可使用 65 个核心工具。

```bash
# 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 启动服务
bun run start
```

### 标准配置 (开发者)

添加 GitHub Token，解锁 22 个 GitHub 工具。

```bash
# .env
GITHUB_TOKEN=ghp_your_token_here
```

### 完整配置 (全功能)

```bash
# .env
GITHUB_TOKEN=ghp_your_token_here
DEEPSEEK_API_KEY=sk_your_key_here
SILICONFLOW_API_KEY=sk_your_key_here
MINIMAX_API_KEY=your_minimax_key
```

---

## 工具依赖关系图

```
┌─────────────────────────────────────────────────────────────┐
│                    Windows 11 + Bun                          │
├─────────────────────────────────────────────────────────────┤
│  核心工具 (65)                                               │
│  ├── Vault 记忆 (8) ← 文件系统                               │
│  ├── 文件系统 (6) ← node:fs                                  │
│  ├── Git (5) ← Git CLI                                      │
│  ├── 代码分析 (5) ← 文件解析                                 │
│  ├── 快照 (5) ← Git CLI                                     │
│  ├── Prompt 池 (6) ← 内存                                    │
│  ├── 竞技场 (7) ← SQLite                                     │
│  ├── 知识图谱 (10) ← SQLite                                  │
│  ├── DRE 只读 (4) ← SQLite                                   │
│  └── 其他 (9) ← SQLite/内存                                  │
├─────────────────────────────────────────────────────────────┤
│  配置工具 (34) ← API Key                                     │
│  ├── GitHub (22) ← GITHUB_TOKEN                              │
│  ├── 模型 (5) ← 各平台 API Key                               │
│  ├── MiniMax (3) ← MINIMAX_API_KEY                           │
│  └── 编排器 (2) ← 模型 API                                   │
├─────────────────────────────────────────────────────────────┤
│  外部服务 (12) ← 需额外安装                                   │
│  ├── PostgreSQL KG (7) ← Docker/本地安装                     │
│  ├── DRE 写入 (2) ← llama.cpp + GPU                          │
│  └── CLI Agent (3) ← OpenCode/Hermes CLI                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 常见问题

### Q: 我没有 GPU，能用 DRE 吗？

A: `dre_read_knowledge`、`dre_search_knowledge`、`dre_subgraph`、`dre_status` 这 4 个只读工具可以正常使用。`dre_write_knowledge` 和 `dre_consciousness_step` 需要本地 LLM 服务，无 GPU 时可使用 `memory_write` 作为替代。

### Q: 我没有安装 PostgreSQL，知识图谱能用吗？

A: 可以。`kg_*_enhanced` 系列 10 个工具使用 SQLite，无需 PostgreSQL。只有 `kg_stats`、`kg_entities` 等 7 个旧版工具需要 PostgreSQL。

### Q: GitHub 工具需要什么权限？

A: Personal Access Token 需要以下权限：
- `repo` — 完整仓库访问
- `workflow` — GitHub Actions
- `read:org` — 读取组织信息

### Q: 工具太多会不会影响性能？

A: MCP 工具注册是惰性的，只有调用时才会执行。111 个工具的注册开销可以忽略不计。
