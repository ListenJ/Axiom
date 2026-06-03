# 🦅 OpenClaw AI Agent

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

暴露 23 个工具，兼容任何 MCP Client：

| 类别 | 工具 |
|------|------|
| 记忆 | `memory_search`, `memory_read`, `memory_write`, `memory_atomic`, `memory_browse`, `memory_network`, `memory_stats` |
| 代码 | `code_index`, `code_generate`, `code_refactor`, `code_review`, `code_test` |
| 采集 | `web_fetch`, `web_search`, `search_engines_list`, `proxy_status` |
| 图谱 | `kg_create_entity`, `kg_create_relationship`, `kg_search`, `kg_shortest_path` |
| 模型 | `model_chat`, `list_free_models` |
| 数据 | `db_query` |
| Agent | `opencode_status`, `project_plan`, `project_research`, `project_arch_review`, `hermes_status` |

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
1. **API Key** (推荐，第三方工具/自建应用):
   - 访问 [Kimi Code 控制台](https://www.kimi.com/code) 创建 API Key
   - 在 `.env` 中配置 `KIMI_CODE_API_KEY=your-key`
2. **OAuth 登录** (官方 CLI):
   - 安装 CLI: `curl -LsSf https://code.kimi.com/install.sh | bash`
   - 登录: `kimi /login`

**模型 ID**: `kimi-for-coding`（固定 ID，后端自动升级对应模型）

**协议**: OpenAI 兼容 (`https://api.kimi.com/coding/v1`)

### 🐉 MiniMax (MiniMax AI) — 国内直连长文本旗舰

MiniMax 是一家国内大模型厂商，旗舰模型 `MiniMax-Text-01` 支持 **1M context** 长文本，abab-6.5 系列覆盖对话/代码/工具场景，国内网络直连。

**配置方式**（两种任选其一）：

**方式 1：在 `.env` 中配置（推荐用于生产）**

```bash
# .env
MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_BASE_URL=https://api.minimax.chat/v1  # 可选，默认已设置
```

**方式 2：在前端 Settings 页面运行时配置（推荐用于临时测试）**

打开 `http://localhost:18789/`，进入 **Settings → Provider API Keys** 卡片，在 **MiniMax (MiniMax AI)** 那一行填入 API Key 即可。
- 运行时设置仅保存在服务器内存中，**不写入** `.env`
- 重启服务后会失效
- 优先级：运行时设置 > `.env` 中的值

**已注册的 MiniMax 模型**：

| 模型 ID | 角色 | Context | 说明 |
|---------|------|---------|------|
| `MiniMax-Text-01` | general-chat / architecture / decision / research | 1M | 旗舰长文本 |
| `abab-6.5s-chat` | general-chat / english | 8K | 通用对话 |
| `abab-6.5g-chat` | coding / code-generation / code-review | 8K | 代码/工具 |

**API 调用**：

```bash
# 走模型路由器（自动按 role 路由）
curl -X POST http://localhost:18789/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}],"taskType":"general-chat"}'

# 直接调用某个 MiniMax 模型
curl -X POST http://localhost:18789/agent-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"用 Python 写个快排","taskType":"coding"}'
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
| `MINIMAX_API_KEY` | MiniMax (MiniMax AI) API Key — 也可前端运行时配置 | 否 |
| `MINIMAX_BASE_URL` | MiniMax API 端点 | 否 (默认 https://api.minimax.chat/v1) |
| `BING_API_KEY` | Bing Search API | 否 |
| `YANDEX_API_KEY` | Yandex XML API | 否 |
| `SERPAPI_KEY` | SERPAPI Key | 否 |
| `LOG_LEVEL` | 日志级别 | 否 (默认 info) |

## 技术栈

- **运行时**: Bun 1.3+
- **语言**: TypeScript (ESM, strict)
- **数据库**: SQLite (bun:sqlite) + Drizzle ORM Schema
- **协议**: MCP (Model Context Protocol) v1.29
- **搜索**: DuckDuckGo / Bing / Yandex / Google(SERPAPI) / SearXNG
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
