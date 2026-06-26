# OpenClaw AI Agent — 技术架构文档

> 版本: v2.8.1 | 更新: 2026-06-26

## 1. 系统概览

OpenClaw AI Agent 是一个本地部署的 AI 工作流引擎，通过 MCP (Model Context Protocol) 暴露 111 个工具，支持多 Agent 协作、确定性推理、知识图谱管理。

### 1.1 核心定位

- **部署方式**: 本地部署 (Windows 11 + Bun)
- **硬件要求**: Intel/AMD PC + NVIDIA RTX 3050 Ti Laptop (4GB VRAM)
- **推理策略**: Qwen3-1.7B Q4_K_M 本地 + 云 API 降级
- **数据存储**: SQLite (结构化) + 文件系统 (Vault) + 图谱 (知识网络)

### 1.2 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw v2.8.1 Architecture                  │
├─────────────────────────────────────────────────────────────────┤
│  MCP Server (111 tools)  │  HTTP API (:18789)  │  CLI          │
├──────────────────────────┴────────────────────┴────────────────┤
│                    智能路由层 (Model Router)                      │
│  ┌─────────────┬──────────────┬─────────────┬───────────────┐  │
│  │ 确定性路由   │ 意图识别      │ 任务编排     │ 成本优化       │  │
│  └─────────────┴──────────────┴─────────────┴───────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                    工具层 (111 MCP Tools)                        │
│  ┌───────────────┬───────────────────┬─────────────────────┐   │
│  │ 核心 (65)      │ 配置 (34)         │ 外部服务 (12)       │   │
│  │ Vault/Git/FS   │ GitHub/Model/Mini │ PostgreSQL/llama.cpp│   │
│  │ 代码分析/快照   │                   │                     │   │
│  └───────────────┴───────────────────┴─────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                    引擎层                                       │
│  ┌─────────────┬──────────────┬─────────────┬───────────────┐  │
│  │ Vault 引擎   │ Arena 引擎    │ KG 引擎      │ DRE 引擎       │  │
│  │ (SQLite+FTS) │ (确定性评估)   │ (知识图谱)    │ (确定性推理)    │  │
│  └─────────────┴──────────────┴─────────────┴───────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                    存储层                                       │
│  ┌─────────────┬──────────────┬─────────────┬───────────────┐  │
│  │ Obsidian     │ SQLite       │ CodeGraph   │ DRE SQLite    │  │
│  │ Vault        │ (结构化数据)  │ (代码索引)   │ (知识/图谱)    │  │
│  └─────────────┴──────────────┴─────────────┴───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 技术栈

### 2.1 运行时

| 组件 | 选择 | 原因 |
|------|------|------|
| 语言 | TypeScript | 类型安全、JSON 原生支持 |
| 运行时 | Bun | 快速启动、内置 SQLite |
| 包管理 | Bun | 无需 npm |
| 数据库 | SQLite (内置) | 零配置、确定性查询 |

### 2.2 AI 模型

| 模型 | 用途 | 部署方式 |
|------|------|----------|
| Qwen3-1.7B Q4_K_M | 主推理模型 | llama.cpp (本地) |
| Qwen3-0.6B | 判别模型 (DRE) | llama.cpp (本地) |
| DeepSeek/V3 | 代码生成 | 云 API |
| MiniMax | 网络搜索/图像识别 | 云 API |

### 2.3 确定性约束

```typescript
// temperature = 0 (固定)
// top_p = 1.0
// seed = 42 (固定)
// JSON Schema 约束输出格式
// JSON Lines 记录每次推理
```

---

## 3. MCP 工具架构

### 3.1 工具注册

```typescript
// src/mcp/server.ts
const registry = new ToolRegistry();

registry.add({
  name: "tool_name",
  description: "工具描述",
  inputSchema: { /* Zod Schema */ },
  handler: async (args) => { /* 实现 */ }
});
```

### 3.2 工具分层

| 层级 | 数量 | 状态 | 依赖 |
|------|------|------|------|
| 核心工具 | 65 | ✅ 始终可用 | 零配置 |
| 配置工具 | 34 | ⚙️ 配置后可用 | API Key |
| 外部服务 | 12 | 🔧 需安装服务 | PostgreSQL/llama.cpp |

### 3.3 工具分类

#### 核心工具 (65 个)

**Vault 记忆引擎 (8)**
- `memory_search` — 确定性搜索 Vault 笔记
- `memory_read` — 读取指定笔记
- `memory_write` — 写入笔记
- `memory_atomic` — 创建原子笔记 (Zettelkasten)
- `memory_browse` — 按 PARA/标签浏览
- `memory_network` — 获取笔记关联网络
- `memory_stats` — Vault 统计信息
- `code_index` — 索引项目代码

**文件系统 (6)**
- `fs_read`, `fs_write`, `fs_list`, `fs_search`, `fs_delete`, `fs_move`

**Git (5)**
- `git_status`, `git_diff`, `git_log`, `git_branch`, `git_blame`

**代码分析 (5)**
- `code_symbols`, `code_references`, `code_outline`, `code_analyze`, `code_detect_language`

**快照 (5)**
- `snapshot_create`, `snapshot_revert`, `snapshot_list`, `snapshot_diff`, `snapshot_status`

**Prompt 连接池 (6)**
- `prompt_pool_acquire`, `prompt_pool_metrics`, `prompt_pool_status`, `prompt_pool_roles`, `prompt_pool_warmup`, `prompt_pool_evict`

**竞技场 (7)**
- `arena_search_models`, `arena_get_model_scores`, `arena_benchmark_ranking`, `arena_composite_ranking`, `arena_role_recommendation`, `arena_stats`, `arena_sources`

**知识图谱增强 (10)**
- `kg_add_node`, `kg_add_edge`, `kg_search_nodes`, `kg_subgraph`, `kg_shortest_path`, `kg_detect_communities`, `kg_echarts_data`, `kg_d3_data`, `kg_nl_query`, `kg_enhanced_stats`

**DRE 只读 (4)**
- `dre_read_knowledge`, `dre_search_knowledge`, `dre_subgraph`, `dre_status`

**其他 (9)**
- `db_query`, `list_free_models`, `token_stats`, `token_stats_by_model`, `token_stats_by_role`, `token_daily_stats`, `set_mode`, `get_mode`, `proxy_status`

#### 配置工具 (34 个)

| 类别 | 工具数 | 环境变量 |
|------|--------|----------|
| GitHub | 22 | `GITHUB_TOKEN` |
| 模型路由 | 5 | `DEEPSEEK_API_KEY` 等 |
| MiniMax | 3 | `MINIMAX_API_KEY` |
| 编排器 | 2 | 模型 API |
| 榜单采集 | 1 | 网络 |

#### 外部服务工具 (12 个)

| 类别 | 工具数 | 服务依赖 |
|------|--------|----------|
| PostgreSQL KG | 7 | PostgreSQL + pgvector |
| DRE 写入 | 2 | llama.cpp + GPU |
| CLI Agent | 3 | OpenCode/Hermes CLI |

---

## 4. 引擎层详解

### 4.1 Vault 引擎

**技术栈**: Obsidian Vault + SQLite FTS5

**核心特性**:
- 确定性搜索 (BM25 全文检索)
- Zettelkasten 原子笔记
- PARA 组织法
- 代码知识图谱 (CodeGraph)

**数据流**:
```
写入: memory_write → Vault 文件 → 索引更新
读取: memory_read → Vault 文件 → 内容返回
搜索: memory_search → FTS5 查询 → 相关笔记
```

### 4.2 Arena 引擎

**技术栈**: SQLite FTS5 + 确定性算法

**核心特性**:
- 多源数据采集 (LMSYS, OpenCompass, HuggingFace, LLM Stats)
- JSON Schema 验证 (每条数据必填 source_url)
- BM25 确定性检索
- 确定性矩阵乘法匹配

**数据新鲜度**:
- FRESH: 7 天内更新
- STALE: 7-30 天
- UNAVAILABLE: >30 天

### 4.3 知识图谱引擎

**技术栈**: SQLite (关系存储) + 增强层 (语义/可视化)

**核心特性**:
- 节点/边 CRUD 操作
- 子图检索 (DFS/BFS)
- 最短路径 (Dijkstra)
- 社区检测 (Louvain 算法)
- ECharts/D3.js 可视化数据
- 自然语言查询

**降级策略**:
- 无 PostgreSQL: 使用 SQLite 替代 `kg_stats`, `kg_entities` 等
- 无 GPU: 使用 `memory_write` 替代 `dre_write_knowledge`

### 4.4 DRE 引擎 (确定性推理)

**技术栈**: TypeScript + SQLite + llama.cpp

**核心特性**:
- 三段甄别 (验证/过滤/合并)
- 意识流处理 (AsyncGenerator)
- VFS 虚拟文件系统
- 知识图谱存储
- 三阶段验证管线

**架构**:
```
输入 → VFS → 知识存储 → 三阶段验证 → 输出
                    ↓
              意识流处理
              (AsyncGenerator)
```

---

## 5. 开发路径

### 5.1 版本历史

| 版本 | 日期 | 主要功能 |
|------|------|----------|
| v2.2.0 | 2026-03 | Linux 适配器, MiniMax MCP, 插件市场 |
| v2.4.0 | 2026-04 | GitHub MCP 集成 (22 tools) |
| v2.5.0 | 2026-05 | 竞技场榜单 (8) + Prompt 池 (6) |
| v2.5.1-3 | 2026-05 | 代码质量改进 |
| v2.6.0 | 2026-06 | 多 Agent 编排 (5 tools) |
| v2.7.0 | 2026-06 | DRE 确定性推理引擎 |
| v2.8.0 | 2026-06 | 知识图谱增强 (10 tools) |
| v2.8.1 | 2026-06 | 文档整理, 幽灵工具移除 |

### 5.2 文件结构

```
openclaw-fusion/
├── src/                    # 核心代码
│   ├── agents/             # Agent 系统
│   ├── cli.ts              # CLI 入口
│   ├── cli/                # CLI 命令
│   ├── constants/          # 常量定义
│   ├── context/            # 上下文管理
│   ├── core/               # 核心模块
│   ├── crawl/              # 爬虫工具
│   ├── cron/               # 定时任务
│   ├── db/                 # 数据库
│   ├── dre/                # DRE 引擎
│   ├── eval/               # 评估系统
│   ├── kg/                 # 知识图谱
│   ├── launcher.ts         # 启动器
│   ├── main.ts             # 主入口
│   ├── mcp/                # MCP 服务器
│   │   ├── server.ts       # 111 个工具注册
│   │   └── tools/          # 工具实现
│   ├── memory/             # 记忆引擎
│   ├── plugins/            # 插件系统
│   ├── router/             # 路由器
│   ├── routes/             # API 路由
│   ├── skills/             # 技能系统
│   ├── tui/                # 终端 UI
│   └── utils/              # 工具函数
├── tests/                  # 测试
├── docs/                   # 开发文档
├── config/                 # 配置文件
├── scripts/                # 脚本工具
├── deploy/                 # 部署配置
├── plugins/                # 插件目录
├── openclaw-memory/        # Vault 存储
├── package.json
├── tsconfig.json
├── README.md               # 唯一上传 GitHub 的文档
└── CHANGELOG.md            # 不上传
```

### 5.3 不上传 GitHub 的文件

以下文件不上传到 GitHub，需要时从本地下载或重新生成:

| 文件 | 说明 |
|------|------|
| `docs/` | 除 README 外的所有文档 |
| `CHANGELOG.md` | 版本历史 |
| `docker-compose.yml` | Docker 配置 |
| `Dockerfile` | Docker 镜像 |
| `frontend/` | 前端代码 (未使用) |
| `src-tauri/` | Tauri 桌面应用 |
| `python_libs/` | Python 库 |
| `vendor/` | 第三方依赖 |
| `native/` | 原生绑定 |
| `deploy/` | 部署配置 |
| `.audits/` | 审计报告 |
| `.codegraph/` | CodeGraph 数据 |
| `.workbuddy/` | WorkBuddy 数据 |
| `archive/` | 历史归档 |

---

## 6. 工具降级策略

### 6.1 无 PostgreSQL

当 PostgreSQL 未安装时，以下工具不可用，但有替代方案:

| 原工具 | 降级方案 |
|--------|----------|
| `kg_stats` | 使用 `kg_enhanced_stats` |
| `kg_entities` | 使用 `kg_search_nodes` |
| `kg_entity_detail` | 使用 `kg_subgraph` |
| `kg_traverse` | 使用 `kg_subgraph` |
| `kg_graph` | 使用 `kg_echarts_data` |
| `kg_build` | 手动添加节点 |
| `kg_search` | 使用 `kg_nl_query` |

### 6.2 无 GPU

当 NVIDIA GPU 不可用时:

| 原工具 | 降级方案 |
|--------|----------|
| `dre_write_knowledge` | 使用 `memory_write` |
| `dre_consciousness_step` | 暂无降级方案 |

### 6.3 无 API Key

当 API Key 未配置时:

| 原工具 | 降级方案 |
|--------|----------|
| `github_*` (22个) | 无降级方案 (需配置 GITHUB_TOKEN) |
| `model_chat` | 无降级方案 (需配置模型 API Key) |
| `minimax_*` (3个) | 无降级方案 (需配置 MINIMAX_API_KEY) |

### 6.4 基本功能保证

即使没有任何外部配置，Agent 仍可完成以下基本功能:

1. **文件操作**: 读取、写入、搜索、删除文件
2. **代码分析**: 符号查找、引用查找、代码大纲
3. **知识管理**: Vault 笔记的创建、搜索、浏览
4. **Git 操作**: 查看状态、差异、历史、分支
5. **快照管理**: 创建、恢复、对比快照
6. **Prompt 缓存**: 提示词预构建与池化
7. **知识图谱**: SQLite 存储的图谱操作
8. **竞技场查询**: 本地数据库的模型查询

---

## 7. 部署指南

### 7.1 最小部署 (零成本)

```bash
# 1. 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. 安装依赖
bun install

# 3. 启动服务
bun run start
```

### 7.2 标准部署 (开发者)

```bash
# .env
GITHUB_TOKEN=ghp_your_token_here
DEEPSEEK_API_KEY=sk_your_key_here
```

### 7.3 完整部署 (全功能)

```bash
# .env
GITHUB_TOKEN=ghp_your_token_here
DEEPSEEK_API_KEY=sk_your_key_here
SILICONFLOW_API_KEY=sk_your_key_here
MINIMAX_API_KEY=your_minimax_key

# PostgreSQL (可选)
docker run -d --name pgvector -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16

# llama.cpp (可选，需要 GPU)
llama-server -m qwen3-1.7b-instruct-q4_k_m.gguf -ngl 99 -c 4096 --port 8080
```

---

## 8. 测试策略

### 8.1 测试文件

| 文件 | 覆盖范围 |
|------|----------|
| `tests/dre.test.ts` | DRE 引擎 |
| `tests/kg-enhanced.test.ts` | 知识图谱增强 |
| `tests/orchestrator.test.ts` | 多 Agent 编排 |
| `tests/mcp-server.test.ts` | MCP 服务器 |
| `tests/model-router.test.ts` | 模型路由器 |
| `tests/prompt-engineer.test.ts` | 提示词引擎 |
| `tests/vault-manager.test.ts` | Vault 管理器 |

### 8.2 运行测试

```bash
bun test
```

---

*Last Updated: 2026-06-26*
*Version: v2.8.1*
