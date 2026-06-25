# 🦅 OpenClaw AI Agent v2.5.3

> 基于 Bun + TypeScript 的 AI Agent，以 Obsidian Vault 为核心记忆引擎，采用确定性推理（零向量、零 embedding），所有 Agent 共享同一 Markdown 记忆库。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                      OpenClaw AI Agent                      │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│  HTTP API   │  MCP Server │  WebSocket  │     CLI Tool      │
│  (18789)    │  (3001)     │  (/ws)      │  (src/cli.ts)     │
├─────────────┴─────────────┴─────────────┴───────────────────┤
│                     Vault 核心记忆引擎                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ 确定性搜索   │  │ 文件监视器   │  │ 代码索引器   │      │
│  │ (关键词+关系)│  │ (自动刷新)   │  │ (src→Vault)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Agent Bootstrap│ │ 记忆蒸馏器   │  │ 归档自动化   │      │
│  │ (启动加载)   │  │ (提炼原子笔记)│  │ (PARA归档)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
├─────────────────────────────────────────────────────────────┤
│                   openclaw-memory/ (Obsidian Vault)         │
│  00-Meta/  01-Projects/  02-Areas/  03-Resources/           │
│  04-Conversations/  05-Archives/  memory/                   │
├─────────────────────────────────────────────────────────────┤
│  数据采集层: 多搜索引擎(DDG/Bing/Google/Yandex/SearXNG)     │
│  隐私保护: 指纹随机化 + 代理轮换 + 反追踪                    │
│  模型路由: 硅基流动 → OfoxAI → DeepSeek → OpenRouter        │
│  知识图谱: SQLite 实体关系图 (BFS/最短路径/中心性)          │
└─────────────────────────────────────────────────────────────┘
```


## 8 核心角色体系 (v2.3+)

OpenClaw 采用简化的 8 核心角色架构，消除冗余并提供清晰的 Agent 分工：

| 角色 | 说明 | 代表 Agent |
|------|------|-----------|
| main_coding | 代码生成、重构、实现 | OpenCode |
| code_review | 代码审查、质量保障、测试生成 | OpenCode + Hermes |
| esearch | 研究、分析、深度研究 | Hermes + 搜索引擎 |
| rchitecture | 系统设计、架构评审 | Hermes |
| decision | 战略决策、方案评估 | Hermes |
| general_chat | 通用对话、Q&A | 任意模型 |
| 	ool_use | 工具调用 (翻译/数学/OCR) | OpenCode (免费模型) |
| computer_use | UI 自动化、浏览器控制 | Computer Use Agent |

> **Agent 分工原则**: Hermes 用于深度项目解析和架构决策，OpenCode 利用免费模型作为子代理处理编码和搜索任务，Computer Use Agent 负责 UI 自动化。

## 搜索引擎配置

OpenClaw 支持 6 个搜索引擎，从免费到商业级全覆盖：

| 引擎 | 免费额度 | 环境变量 | 获取地址 |
|------|---------|---------|---------|
| SearXNG | 无限 (自建) | SEARXNG_INSTANCE | https://searxng.org |
| Brave Search | 2000次/月 | BRAVE_SEARCH_API_KEY | https://brave.com/search/api/ |
| Tavily | 1000次/月 | TAVILY_API_KEY | https://tavily.com |
| Jina Reader | 1M tokens/月 | JINA_API_KEY (可选) | https://jina.ai/reader/ |
| MiniMax | Token Plan | MINIMAX_API_KEY | https://minimax.chat |
| SerpAPI | 100次/月 | SERPAPI_KEY | https://serpapi.com |

`ash
# 检查搜索引擎健康状态
curl http://localhost:18789/engines

# MCP 工具检查
# 调用 search_providers_health 工具
`

## 前端路由

Dashboard 前端提供 18 个页面，核心页面默认显示在侧边栏：

- **Home** / — 系统概览 Dashboard
- **Chat** /chat — AI 对话 (自动意图路由到 8 核心角色)
- **Search** /search — 多引擎搜索
- **Code** /code — 代码任务 (OpenCode Agent)
- **Agents** /agents — 智能体管理
- **Router** /router — 模型路由状态
- **Vault** /vault — 记忆库浏览
- **KG** /kg — 知识图谱可视化
- **Sessions** /sessions — 会话历史
- **Eval** /eval — 模型评估
- **Plugins** /plugins — 插件市场
- **OCR** /ocr — 文档识别
- **Research** /research — 深度研究
- **Review** /knowledge — 知识库审核
- **Settings** /settings — 系统配置

快捷键：数字 1-9 导航前 9 个页面，Shift+T 切换主题，/ 或 Ctrl+K 搜索，? 帮助。

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 API 密钥（可选，DDG/SearXNG 无需 Key）

# 3. 初始化数据库
bun run migrate

# 4. 启动服务
bun run start

# 5. 打开 Dashboard
open http://localhost:18789/
```

### 一键启动（推荐）

```bash
# 全自动：安装 + 复制示例配置 + 启动
bun install && \
  [ -f .env ] || cp .env.example .env && \
  bun run start
```

如果未填 API Key，OpenClaw 仍可启动（仅使用 DDG/SearXNG 等免 Key 引擎 + 已配置的本地模型）。可通过 `bun run cli setup` 交互式补充 Key。

## 运行模式与人工审批

OpenClaw 三种执行模式（[CodeWhale 启发](https://codewhale.dev)）：

- **Plan** 🔍 — 只读调查，破坏性操作全部拦截
- **Agent** 🤖 — 默认模式，破坏性操作需用户在 Dashboard/WebSocket 弹窗中确认
- **YOLO** ⚡ — 自动批准（仅在受信任工作区使用）

切模式：`bun run cli mode <plan|agent|yolo>`

审批通过 WebSocket 推送 `approval.requested` 事件给所有连接的客户端；任一客户端发送 `{ "action": "approval.resolve", "id": "<uuid>", "approved": true }` 即完成。默认 60 秒超时自动拒绝，详见 `src/utils/approval-bridge.ts`。

## 核心特性

### 🔍 确定性记忆引擎（无向量）

四阶段漏斗检索，每个结果都有明确的得分来源：

| 阶段 | 机制 | 权重 |
|------|------|------|
| 精确匹配 | 文件名/标题/alias/ID | 85-100 |
| 关键词 | 标题(3x) > 标签(2.5x) > 内容(1x) > 路径(0.5x) | - |
| 关系推导 | wiki-link 出链(+10) / 入链(+8) / 2跳(+4) | - |
| PARA 语义 | 同分类笔记提升(+5) | - |

```bash
# 搜索记忆
bun run src/cli.ts vault:search "OpenClaw" --limit=5

# HTTP API
curl "http://localhost:18789/search?q=OpenClaw&limit=5"
```

### 🧠 Vault 共享记忆库

所有 Agent 读写同一 Obsidian Vault：

```
openclaw-memory/
├── 00-Meta/              # 元数据（SOUL.md, AGENTS.md, IDENTITY.md...）
├── 01-Projects/          # 项目（有明确截止日期）
├── 02-Areas/             # 领域（长期责任）
├── 03-Resources/         # 资源（参考材料、代码索引、原子笔记）
│   ├── code-index/       # 项目代码自动索引
│   ├── web-clips/        # 爬取结果
│   ├── search-results/   # 搜索结果
│   └── atomic-notes/     # Zettelkasten 原子笔记
├── 04-Conversations/     # 会话日志
├── 05-Archives/          # 归档
└── memory/               # 每日日志
```

### 🤖 Agent Bootstrap

会话启动时自动加载记忆上下文：

```bash
curl "http://localhost:18789/bootstrap?topic=memory&depth=5&format=prompt"
# 返回可直接注入 LLM system prompt 的文本
```

### 📝 记忆蒸馏

从会话/爬取/搜索内容自动提炼原子笔记：

```bash
# 手动蒸馏
curl -X POST http://localhost:18789/vault/distill \
  -H "Content-Type: application/json" \
  -d '{"title":"核心发现","content":"...","tags":["research"]}'
```

### 🕸️ 知识图谱

基于 SQLite 的轻量级图数据库：

```bash
# 创建实体
curl -X POST http://localhost:18789/kg/entities \
  -d '{"name":"OpenClaw","type":"project"}'

# 创建关系
curl -X POST http://localhost:18789/kg/relationships \
  -d '{"sourceId":1,"targetId":2,"type":"uses"}'

# 最短路径
curl "http://localhost:18789/kg/path?from=1&to=2"
```

### 🔌 MCP 协议支持

暴露 100+ 个工具，兼容任何 MCP Client：

| 类别 | 工具 |
|------|------|
| 记忆 | `memory_search`, `memory_read`, `memory_write`, `memory_atomic`, `memory_browse`, `memory_network`, `memory_stats` |
| 代码 | `code_index`, `code_generate`, `code_refactor`, `code_review`, `code_test` |
| 采集 | `web_fetch`, `web_search`, `search_engines_list`, `proxy_status` |
| 搜索 | `minimax_web_search`, `minimax_image_understand`, `minimax_health` |
| 高级搜索 | `tavily_search`, `brave_search`, `jina_read`, `jina_search`, `search_providers_health` |
| GitHub | `github_list_repos`, `github_get_repo`, `github_create_repo`, `github_fork_repo`, `github_list_issues`, `github_get_issue`, `github_create_issue`, `github_add_issue_comment`, `github_list_prs`, `github_create_pr`, `github_review_pr`, `github_get_pr_files`, `github_get_file_contents`, `github_list_directory`, `github_search_code`, `github_list_releases`, `github_create_release`, `github_list_workflows`, `github_trigger_workflow`, `github_list_workflow_runs`, `github_get_workflow_run`, `github_health` |
| 竞技场榜单 | `arena_collect`, `arena_search_models`, `arena_get_model_scores`, `arena_benchmark_ranking`, `arena_composite_ranking`, `arena_role_recommendation`, `arena_stats`, `arena_sources` |
| Prompt 连接池 | `prompt_pool_acquire`, `prompt_pool_metrics`, `prompt_pool_status`, `prompt_pool_roles`, `prompt_pool_warmup`, `prompt_pool_evict` |
| 知识图谱 | `kg_stats`, `kg_entities`, `kg_entity_detail`, `kg_traverse`, `kg_build`, `kg_search`, `kg_graph` |
| 模型 | `model_chat`, `list_free_models` |
| 数据 | `db_query` |
| Agent | `opencode_status`, `project_research`, `hermes_status` |
| 插件 | 动态加载（取决于已启用的插件） |

### 🐧 Linux Office 适配器

支持 Linux 桌面环境（Ubuntu/Debian/Fedora/Arch）的 Office 文档自动化：

- **LibreOffice**: 文档转换（DOCX/ODT/PDF）、批量处理
- **Python 后备**: `python-docx`, `openpyxl`, `python-pptx`
- **系统工具**: `xclip`（剪贴板）、`xdotool`（窗口自动化）、`wmctrl`（窗口管理）

```bash
# 安装依赖
sudo apt-get install -y libreoffice xclip xdotool wmctrl
pip3 install python-docx openpyxl python-pptx

# 使用适配器
bun run src/cli.ts office:convert input.docx output.pdf
```

### 🔌 插件市场

内部插件系统，支持动态扩展 Agent 能力：

- **安装/卸载**: 本地插件管理，无需外部服务
- **启用/禁用**: 运行时加载/卸载，无需重启
- **配置**: 每个插件独立的配置项
- **安全沙箱**: 受限的文件/网络/系统访问权限

```bash
# 查看已安装插件
bun run src/cli.ts plugins:list

# 安装插件
bun run src/cli.ts plugins:install openclaw.plugins.code-analysis

# 启用插件
bun run src/cli.ts plugins:enable openclaw.plugins.code-analysis

# 查看插件市场界面
open http://localhost:18789/plugins.html
```

**内置示例插件**:
- `code-analysis-enhanced` - 代码复杂度分析、依赖图、漏洞检测
- `git-workflow-enhanced` - 分支命名、提交消息生成、PR 模板
- `doc-generator` - API 文档、README 生成、架构决策记录

## CLI 工具

```bash
# 系统状态
bun run src/cli.ts status

# 多引擎搜索
bun run src/cli.ts search "TypeScript" --engines=duckduckgo,searxng --num=10

# 网页抓取
bun run src/cli.ts fetch "https://example.com"

# Vault 搜索
bun run src/cli.ts vault:search "关键词" --limit=10 --para=resources

# PARA 浏览
bun run src/cli.ts vault:para projects

# 知识图谱
bun run src/cli.ts kg:entity "SQLite" "tool"
bun run src/cli.ts kg:relate "OpenClaw" "SQLite" "uses"
bun run src/cli.ts kg:stats

# Agent 启动
bun run src/cli.ts bootstrap --topic="项目主题" --depth=5

# 代码索引
bun run src/cli.ts vault:index-code

# 健康检查
bun run src/cli.ts health
```

### 🤖 编码 Agent (OpenCode) — 免费模型

```bash
# 检查 Agent 状态
bun run src/cli.ts agent:status

# 启动 OpenCode 交互式编码会话（使用免费模型 deepseek-v4-flash-free）
bun run src/cli.ts code:open "写一个 TypeScript HTTP 服务器" --model=opencode/deepseek-v4-flash-free

# 列出所有可用模型
bun run src/cli.ts code:models

# 启动 OpenCode 后台 Web 服务
bun run src/cli.ts code:serve --port=8765
```

**OpenCode 免费模型**：
- `opencode/deepseek-v4-flash-free` — 推荐，DeepSeek V4 Flash 免费版
- `opencode/big-pickle` — Big Pickle 免费版
- `opencode/nemotron-3-super-free` — NVIDIA Nemotron 3 Super 免费版

### 🦅 编码 Agent (Kimi Code) — Kimi 会员权益

Kimi Code 基于 Kimi 最新旗舰模型，为开发者提供代码阅读、文件编辑、命令执行等 AI 辅助能力。

```bash
# 检查 Kimi Code 配置状态
bun run src/cli.ts kimi:status

# API 直连编码对话（无需安装 CLI）
bun run src/cli.ts kimi:chat "写一个 TypeScript HTTP 服务器"

# 启动 Kimi Code CLI 交互式会话（需先安装 CLI）
bun run src/cli.ts kimi:open

# 查看完整安装指南
bun run src/cli.ts kimi:guide
```

**配置方式**：

💡 **推荐：使用交互式配置向导**
```bash
# 自动检测 CLI、引导安装、配置认证
bun run scripts/setup-kimi-code.ts
```

**手动配置**：
1. **API Key** (推荐，第三方工具/自建应用):
   - 访问 [Kimi Code 控制台](https://www.kimi.com/code) 创建 API Key
   - 在 `.env` 中配置 `KIMI_CODE_API_KEY=your-key`
2. **OAuth 登录** (官方 CLI):
   - 安装 CLI: `curl -LsSf https://code.kimi.com/install.sh | bash`
   - 登录: `kimi /login`

**模型 ID**: `kimi-for-coding`（固定 ID，后端自动升级对应模型）

**协议**: OpenAI 兼容 (`https://api.kimi.com/coding/v1`)

### 🐉 MiniMax — 国内直连

MiniMax 是一家国内大模型厂商，最新系列包括 **M3**（旗舰）、**M2.7**（均衡）、**M2.5**（轻量）三大语言模型，国内网络直连。

**配置方式**（两种任选其一）：

**方式 1：在 `.env` 中配置（推荐用于生产）**

```bash
# .env
MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_BASE_URL=https://api.minimax.chat/v1  # 可选，默认已设置
```

**方式 2：在前端 Settings 页面运行时配置（推荐用于临时测试）**

打开 `http://localhost:18789/`，进入 **Settings → Provider API Keys** 卡片，在 **MiniMax** 那一行填入 API Key 即可。
- 运行时设置仅保存在服务器内存中，**不写入** `.env`
- 重启服务后会失效
- 优先级：运行时设置 > `.env` 中的值

**已注册的 MiniMax 模型**：

| 模型 ID | 角色 | Context | 说明 |
|---------|------|---------|------|
| `MiniMax-M3` | general-chat / architecture / research | 256K | 旗舰模型，架构设计+研究分析 |
| `MiniMax-M2.7` | general-chat / english | 128K | 均衡模型，通用对话与内容分析 |
| `MiniMax-M2.5` | general-chat / english / general-tool | 32K | 轻量快速模型，高频对话场景 |

**MiniMax MCP 工具**（若订阅 Token Plan，同一 API Key 可同时用于模型调用和 MCP 工具）：

| 工具 | 说明 |
|------|------|
| `minimax_web_search` | 实时网络搜索，支持中文优化 |
| `minimax_image_understand` | 图像识别分析，支持 URL 或 base64 |
| `minimax_health` | 检查 MiniMax API 连接状态 |

**使用示例**：

```bash
# 通过 MCP 调用 MiniMax 网络搜索
curl -X POST http://localhost:18789/mcp/tools/minimax_web_search \
  -H "Content-Type: application/json" \
  -d '{"query":"人工智能最新进展","num":5}'

# 通过 MCP 调用图像识别
curl -X POST http://localhost:18789/mcp/tools/minimax_image_understand \
  -H "Content-Type: application/json" \
  -d '{"image":"https://example.com/image.jpg","prompt":"描述这张图片"}'
```

**Token Plan 说明**：
- 标准版 API：`https://api.minimax.chat`（按调用计费）
- Token Plan：`https://api.minimax.io`（订阅制，同一 Key 可用于模型+MCP）
- 切换方式：设置 `MINIMAX_BASE_URL=https://api.minimax.io`

**API 调用**：

```bash
# 走模型路由器（自动按 role 路由）
curl -X POST http://localhost:18789/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}],"taskType":"general-chat"}'

# 直接调用某个 MiniMax 模型
curl -X POST http://localhost:18789/agent-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"分析一下这个架构设计的优缺点","taskType":"architecture"}'
```

**管理 API（编程方式设置）**：

```bash
# 查看所有 provider 状态（API Key 已脱敏）
curl http://localhost:18789/api-keys

# 运行时设置 MiniMax API Key
curl -X POST http://localhost:18789/api-keys \
  -H "Content-Type: application/json" \
  -d '{"provider":"minimax","apiKey":"eyJhbGciOiJSUzI1NiIs..."}'

# 清除运行时 override（回退到 .env）
curl -X DELETE http://localhost:18789/api-keys/minimax
```

### 📋 项目管理 Agent (Hermes)

```bash
# 创建项目计划
bun run src/cli.ts project:plan "构建一个电商后台管理系统"

# 深度研究
bun run src/cli.ts project:research "Rust vs Go 在微服务中的性能对比"

# 架构审查
bun run src/cli.ts project:arch --path=.
```

**安装 Hermes Agent**（如未安装）：
```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

Hermes 安装后可通过 MCP 连接 OpenClaw 共享记忆库。

## API 端点速查

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | Dashboard |
| `/health` | GET | 健康检查 |
| `/chat` | POST | 模型聊天 |
| `/search?q=` | GET | Vault 确定性搜索 |
| `/web-search?q=` | GET | 多引擎搜索 |
| `/web-fetch?url=` | GET | 结构化抓取 |
| `/vault/stats` | GET | Vault 统计 |
| `/vault/para/:category` | GET | PARA 浏览 |
| `/vault/tags/:tag` | GET | 标签浏览 |
| `/vault/network/:path` | GET | 笔记关联网络 |
| `/vault/note?path=` | GET | 读取笔记 |
| `/vault/write` | POST | 写入笔记 |
| `/vault/atomic` | POST | 原子笔记 |
| `/vault/distill` | POST | 记忆蒸馏 |
| `/vault/code-index` | POST | 索引代码 |
| `/vault/reload` | POST | 重建索引 |
| `/vault/watch-status` | GET | 文件监视器状态 |
| `/bootstrap` | GET | Agent 启动加载 |
| `/kg/*` | - | 知识图谱 API |
| `/ws` | WS | 实时推送 |
| `/plugins` | GET | 插件列表 |
| `/plugins/available` | GET | 可用插件 |
| `/plugins/install` | POST | 安装插件 |
| `/plugins/:id/enable` | POST | 启用插件 |
| `/plugins/:id/disable` | POST | 禁用插件 |

## 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `OPENCLAW_GATEWAY_PORT` | HTTP 端口 | 否 (默认 18789) |
| `OBSIDIAN_VAULT_PATH` | Vault 路径 | 否 (默认 ./openclaw-memory) |
| `DATABASE_PATH` | SQLite 路径 | 否 (默认 ./data/agent.db) |
| `SILICONFLOW_API_KEY` | 硅基流动 API Key | 否 |
| `OFOXAI_API_KEY` | OfoxAI API Key | 否 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | 否 |
| `OPENROUTER_API_KEY` | OpenRouter API Key | 否 |
| `KIMI_CODE_API_KEY` | Kimi Code API Key | 否 |
| `MINIMAX_API_KEY` | MiniMax API Key (M3/M2.7/M2.5) — 也可前端运行时配置 | 否 |
| `MINIMAX_BASE_URL` | MiniMax API 端点 | 否 (默认 https://api.minimax.chat/v1) |
| `BING_API_KEY` | Bing Search API | 否 |
| `SERPAPI_KEY` | SERPAPI Key | 否 |
| `BRAVE_SEARCH_API_KEY` | Brave Search API (免费 2000次/月) | 否 |
| `TAVILY_API_KEY` | Tavily AI Search API (免费 1000次/月) | 否 |
| `JINA_API_KEY` | Jina Reader API (免费 1M tokens/月) | 否 |
| `GITHUB_TOKEN` | GitHub Personal Access Token | 否 |
| `LOG_LEVEL` | 日志级别 | 否 (默认 info) |

## 技术栈

- **运行时**: Bun 1.3+
- **语言**: TypeScript (ESM, strict)
- **数据库**: SQLite (bun:sqlite) + Drizzle ORM Schema
- **协议**: MCP (Model Context Protocol) v1.29
- **搜索**: DuckDuckGo / Bing / SearXNG / Tavily / Brave / Jina / MiniMax / SerpAPI
- **隐私**: 指纹随机化 + 代理轮换 + 反追踪
- **记忆**: Obsidian Vault (Markdown) + 确定性搜索引擎

## 测试

```bash
# 运行测试
bun test

# 确定性搜索引擎测试
bun test tests/deterministic-search.test.ts
```

## 许可证

MIT
