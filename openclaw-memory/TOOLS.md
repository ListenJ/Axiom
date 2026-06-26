---
created: 2026-05-24
type: available-tools
---

# TOOLS — 可用工具/API 列表

## 核心运行时工具

| 工具 | 来源 | 说明 |
|------|------|------|
| `Read` | Pi 引擎 | 读取文件内容 |
| `Write` | Pi 引擎 | 写入文件 |
| `Edit` | Pi 引擎 | 精确编辑文件 |
| `Bash` | Pi 引擎 | 执行 shell 命令 |

## MCP 服务器工具

### 记忆管理 (`memory_*`)

| 工具 | 参数 | 说明 |
|------|------|------|
| `memory_search` | `query`, `limit` | FTS5 全文搜索记忆 |
| `memory_write` | `path`, `content`, `tags?` | 写入/更新笔记 |
| `memory_read` | `path` | 读取指定笔记 |
| `memory_list` | `tag?`, `limit?` | 列出所有笔记 |

### 结构化数据采集 (`web_*`)

| 工具 | 参数 | 说明 |
|------|------|------|
| `web_fetch` | `url` | 抓取网页，提取结构化数据（标题、正文、表格、代码块、Schema.org、图片、链接等） |
| `web_search_structured` | `query`, `num?`, `site?` | 精细化搜索，返回结构化结果（含富文本片段） |
| `web_crawl_search` | `query`, `maxResults?` | 搜索并自动爬取前 N 个结果 |

### 模型路由 (`model_chat`)

| 工具 | 参数 | 说明 |
|------|------|------|
| `model_chat` | `taskType`, `messages` | 多平台模型聊天 |

### 数据库 (`db_query`)

| 工具 | 参数 | 说明 |
|------|------|------|
| `db_query` | `sql`, `params?` | 只读 SQL 查询 |

### 免费模型 (`list_free_models`)

| 工具 | 参数 | 说明 |
|------|------|------|
| `list_free_models` | 无 | 列出可用免费模型 |

## HTTP API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/chat` | POST | 模型聊天 |
| `/search?q=` | GET | 记忆搜索 |

## 数据采集能力

### 支持的站点规则（精细化提取）

| 站点 | 特殊字段 |
|------|---------|
| GitHub | stars, language, issue 内容 |
| Stack Overflow | votes, tags, answers |
| 知乎 | 作者、赞同数 |
| 稀土掘金 | 阅读量 |
| CSDN | 作者 |
| MDN | summary |
| Python Docs | version |
| 微信公众号 | publish_time |
| 百度百科 | summary |

### 通用结构化提取

- **Schema.org / JSON-LD**: 自动提取网页中的结构化数据
- **Open Graph / Twitter Cards**: 元数据提取
- **表格**: HTML `<table>` → Markdown 表格
- **代码块**: 语言识别 + 围栏代码块
- **图片**: 含 alt 文本、尺寸信息
- **链接**: 含锚文本、title
- **标题层级**: h1-h6 提取 + 锚点
- **内容分块**: 按标题自动分块，计算词数

## 模型路由表

| 任务类型 | 优先级 | 模型 |
|---------|--------|------|
| general-chat | P0 → P1 | Qwen2-7B → qwen-3-5 |
| code-generation | P0 → P1 | deepseek-v4-flash → DeepSeek-R1-Distill |
| complex-reasoning | P0 → P1 | deepseek-v4-pro → claude-opus-4-6 |
| embedding | P0 | bge-large-zh |
