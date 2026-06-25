# OpenClaw Architecture Evolution v2.3

## Overview

OpenClaw v2.2 已完成基础设施层、AI编排层、存储引擎层的全面重构。v2.3 将聚焦三大方向：**平台适配扩展**、**生态系统开放**、**工具能力增强**。

本文档定义从 v2.2 到 v2.5 的架构演进路线。

---

## Current Architecture (v2.2)

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw v2.2 Architecture               │
├─────────────────────────────────────────────────────────────┤
│  HTTP API (18789)  │  WebSocket (/ws)  │  MCP Server (3001) │
├────────────────────┴───────────────────┴────────────────────┤
│                    Unified Router Layer                      │
│         (ModelRouter + IntentRouter + TaskOrchestrator)     │
├─────────────────────────────────────────────────────────────┤
│  AI Providers: SiliconFlow │ OfoxAI │ DeepSeek │ OpenRouter │
│  ├─ Kimi Code (IDE Agent)                                  │
│  ├─ Hermes (Research Agent)                                │
│  ├─ OpenCode (Code Agent)                                  │
│  └─ MiniMax (Tool Model - NEW)                             │
├─────────────────────────────────────────────────────────────┤
│                    MCP Tool Layer (26 tools)                 │
│  Filesystem │ Terminal │ Git │ Code Analysis │ Search      │
│  Workspace Snapshot │ Skill Loader │ MiniMax (NEW)         │
├─────────────────────────────────────────────────────────────┤
│                    Memory Engine (Obsidian Vault)            │
│  Deterministic Search │ SQLite │ CodeGraph Index            │
├─────────────────────────────────────────────────────────────┤
│  Office Adapters: COM (Win) │ AppleScript (Mac) │ WPS       │
│  IDE Adapters: VSCode │ JetBrains │ Neovim                   │
└─────────────────────────────────────────────────────────────┘
```

---

## v2.3 Roadmap (Current Focus)

### Phase 1: Platform Expansion (Q1 2026)

#### 1.1 Linux Office Adapter
**Status**: ✅ Implemented
**Priority**: P0

**动机**: OpenClaw 目前仅支持 Windows (COM) 和 macOS (AppleScript) 的 Office 自动化。Linux 桌面用户（特别是 Ubuntu/Debian 开发者）需要完整的文档处理能力。

**实现**:
- **原生层**: LibreOffice 命令行转换 (`libreoffice --headless --convert-to`)
- **工具层**: `xclip` (剪贴板), `xdotool` (窗口控制), `wmctrl` (窗口管理)
- **Python 后备**: `python-docx`, `openpyxl`, `python-pptx`
- **架构**: 与现有 `platform-adapter.ts` 集成，自动检测 Linux 环境

**文件**: `src/ide/office/linux-adapter.ts`

#### 1.2 MiniMax MCP Integration
**Status**: ✅ Implemented
**Priority**: P0

**动机**: MiniMax 提供 Token Plan（api.minimax.io），同一 API Key 可用于模型调用和工具调用。将 MiniMax 作为 MCP 工具模型集成，增强网络搜索和图像识别能力。

**实现**:
- **API 端点**: `https://api.minimax.io/v1/coding_plan/search`
- **工具**: `minimax_web_search`, `minimax_image_understand`
- **认证**: 复用 `MINIMAX_API_KEY` 环境变量
- **特点**: 不支持代码生成（MiniMax 不涉及真实任务构建场景）

**文件**: `src/mcp/tools/minimax.ts`

#### 1.3 Plugin Market (Internal)
**Status**: ✅ Implemented
**Priority**: P0

**动机**: 用户需要动态扩展 Agent 能力，但不希望依赖外部服务。内部插件市场允许用户安装、启用、禁用插件，增强 Agent 的灵活性。

**实现**:
- **PluginRegistry**: SQLite 持久化，支持 install/uninstall/enable/disable/configure
- **PluginManifest**: `id`, `name`, `version`, `author`, `tools`, `patterns`, `config`
- **动态加载**: 运行时加载 TypeScript/JS 插件文件
- **安全沙箱**: 限制插件 API 访问范围
- **前端**: `public/plugins.html` 提供插件市场界面

**示例插件**:
1. `code-analysis-enhanced` - 代码复杂度分析、依赖图、漏洞检测
2. `git-workflow-enhanced` - 分支命名规范、提交消息生成、PR 模板
3. `doc-generator` - API 文档生成、README 生成、架构决策记录

**文件**: `src/plugins/plugin-registry.ts`, `src/routes/plugin-routes.ts`

---

### Phase 2: Ecosystem Integration (Q2 2026)

#### 2.1 GitHub MCP Server Integration
**Status**: ✅ Implemented (v2.4.0)
**Priority**: P0

**动机**: GitHub MCP Server (30K⭐) 是开发者工作流的核心。集成后可实现：代码仓库管理、Issue/PR 自动化、代码审查、发布管理。

**已实现功能** (22 个 MCP 工具):
- **Repository Management**: `github_list_repos`, `github_get_repo`, `github_create_repo`, `github_fork_repo`
- **Issue**: `github_list_issues`, `github_get_issue`, `github_create_issue`, `github_add_issue_comment`
- **Pull Request**: `github_list_prs`, `github_create_pr`, `github_review_pr`, `github_get_pr_files`
- **Code**: `github_get_file_contents`, `github_list_directory`, `github_search_code`
- **Release**: `github_list_releases`, `github_create_release`
- **Actions**: `github_list_workflows`, `github_trigger_workflow`, `github_list_workflow_runs`, `github_get_workflow_run`
- **Health**: `github_health`

**配置**:
- `GITHUB_TOKEN` - Personal Access Token (classic) 或 Fine-grained Token

#### 2.2 Ollama Integration (Postponed)
**Status**: ⏸️ Postponed per user request
**Priority**: P1 → Postponed

**原因**: 用户明确表示本地 AI 部分先不集成。

**未来规划**: 当用户需要本地推理时，可快速接入：
- Ollama 本地模型管理
- Llama.cpp 轻量级推理
- LocalAI 兼容 OpenAI API

#### 2.3 External Memory Engines (Postponed)
**Status**: ⏸️ Postponed per user request
**Priority**: P1 → Postponed

**原因**: 用户表示本地记忆效果不差，不需要集成外部方案。

**未来规划**: 
- Supermemory (25K⭐) - 当需要跨实例记忆同步时接入
- Mem0 - 当需要用户级记忆隔离时接入

---

### Phase 3: Advanced Capabilities (Q3-Q4 2026)

#### 3.1 Knowledge Graph Enhancement
**Status**: 🔄 CodeGraph Integrated, Enhancement Planned
**Priority**: P1

**当前状态**: CodeGraph 已集成 (`src/memory/codegraph-index.ts`)，139 文件、2178 节点、5916 边。

**增强计划**:
- **语义层**: 基于 LLM 的代码语义理解（函数意图、业务逻辑）
- **动态层**: 运行时调用链追踪（与 Hermes Agent 集成）
- **可视化**: 交互式知识图谱浏览器（前端 D3.js/ECharts）
- **查询**: 自然语言查询代码库（"查找处理用户认证的函数"）

#### 3.2 Multi-Agent Orchestration
**Status**: 🔄 Partial (Kimi Code, Hermes, OpenCode)
**Priority**: P1

**当前状态**: 已支持多个 Agent，但缺乏统一编排。

**增强计划**:
- **Agent Registry**: 动态注册/发现 Agent
- **Task Router**: 基于任务类型自动选择 Agent
- **Agent Communication**: Agent 间消息传递协议
- **Human-in-the-loop**: 关键决策点人工确认

#### 3.3 Frontend Enhancement
**Status**: ✅ PWA Supported, Enhancement Planned
**Priority**: P2

**当前状态**: 纯 Vanilla JS SPA，PWA 已支持（manifest.json + sw.js）。

**增强计划**:
- **React/Vue Migration**: 现代化前端框架
- **Plugin Market UI**: 可视化插件管理
- **Knowledge Graph Viz**: 代码知识图谱可视化

#### 3.4 Arena Leaderboard Collector (新增)
**Status**: ✅ Implemented (v2.5.0)
**Priority**: P0

**动机**: 基于 Chapter 3 研究文档，实现确定性竞技场榜单数据采集，消除评估幻觉。

**已实现功能** (8 个 MCP 工具):
- **数据采集**: `arena_collect` — 支持 LMSYS Arena、OpenCompass、HuggingFace、LLM Stats
- **搜索**: `arena_search_models` — FTS5 BM25 确定性检索
- **查询**: `arena_get_model_scores`, `arena_benchmark_ranking`, `arena_composite_ranking`
- **推荐**: `arena_role_recommendation` — 确定性矩阵乘法匹配
- **元数据**: `arena_stats`, `arena_sources`

**核心特性**:
- JSON Schema 验证，每条数据必填 source_url
- SQLite FTS5 存储，BM25 确定性检索
- 数据新鲜度管理 (FRESH/STALE/UNAVAILABLE)

#### 3.5 User Agent Prompt Connection Pool (新增)
**Status**: ✅ Implemented (v2.5.0)
**Priority**: P0

**动机**: 基于 Chapter 5 研究文档，实现 System Prompt Only Caching，降低 41-80% 成本。

**已实现功能** (6 个 MCP 工具):
- **获取**: `prompt_pool_acquire` — 从连接池获取缓存友好提示词
- **监控**: `prompt_pool_metrics`, `prompt_pool_status`
- **管理**: `prompt_pool_roles`, `prompt_pool_warmup`, `prompt_pool_evict`

**核心特性**:
- 8 核心角色系统提示词预构建与池化
- XXH3 增量哈希前缀指纹
- 混合 LRU/LFU/TTL 淘汰策略
- 缓存预热与监控指标
- **Settings Panel**: 可视化配置管理

---

## Architecture Vision v2.5

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw v2.5 Vision                      │
├─────────────────────────────────────────────────────────────┤
│  Web UI (React)  │  Desktop (Tauri)  │  CLI  │  API        │
├──────────────────┴───────────────────┴───────┴─────────────┤
│                    Plugin Market (Internal)                  │
│  ├─ Community Plugins (User-contributed)                    │
│  ├─ Official Plugins (GitHub, GitLab, Jira, Slack)         │
│  └─ Enterprise Plugins (Custom internal tools)             │
├─────────────────────────────────────────────────────────────┤
│                    Multi-Agent Orchestrator                  │
│  ├─ Task Decomposition                                     │
│  ├─ Agent Selection (Kimi, Hermes, OpenCode, Custom)       │
│  ├─ Parallel Execution                                     │
│  └─ Result Aggregation                                     │
├─────────────────────────────────────────────────────────────┤
│                    Knowledge Graph Engine                    │
│  ├─ Code Graph (CodeGraph)                                 │
│  ├─ Semantic Graph (LLM-powered)                           │
│  ├─ Runtime Graph (Dynamic tracing)                        │
│  └─ Query Interface (Natural Language)                     │
├─────────────────────────────────────────────────────────────┤
│                    Memory Layer (Hybrid)                     │
│  ├─ Local Vault (Obsidian)                                 │
│  ├─ SQLite (Structured)                                    │
│  ├─ External Sync (Supermemory - Optional)                 │
│  └─ Session Memory (In-memory)                             │
├─────────────────────────────────────────────────────────────┤
│                    AI Model Mesh                             │
│  ├─ Cloud APIs (SiliconFlow, DeepSeek, MiniMax, etc.)     │
│  ├─ Local Models (Ollama - Optional)                       │
│  ├─ IDE Agents (Kimi Code, Hermes, OpenCode)               │
│  └─ Custom Models (Plugin-defined)                         │
├─────────────────────────────────────────────────────────────┤
│                    Platform Adapters                         │
│  ├─ Windows (COM, WPS)                                     │
│  ├─ macOS (AppleScript)                                    │
│  ├─ Linux (LibreOffice, xclip, xdotool) - NEW             │
│  └─ IDE (VSCode, JetBrains, Neovim)                        │
└─────────────────────────────────────────────────────────────┘
```

---

## Integration Priority Matrix

| Integration | Priority | Status | Effort | Impact |
|------------|----------|--------|--------|--------|
| Linux Office Adapter | P0 | ✅ Done | Medium | High |
| MiniMax MCP | P0 | ✅ Done | Low | Medium |
| Plugin Market | P0 | ✅ Done | High | High |
| GitHub MCP Server | P0 | ✅ Done (v2.4.0) | Medium | High |
| Arena Leaderboard Collector | P0 | ✅ Done (v2.5.0) | High | High |
| Prompt Connection Pool | P0 | ✅ Done (v2.5.0) | Medium | High |
| CodeGraph Enhancement | P1 | 🔄 Partial | Medium | High |
| Multi-Agent Orchestration | P1 | 🔄 Partial | High | High |
| Ollama | P1 | ⏸️ Postponed | Low | Medium |
| Supermemory | P1 | ⏸️ Postponed | Low | Medium |
| Frontend Modernization | P2 | 📋 Planned | High | Medium |
| Desktop App (Tauri) | P2 | 📋 Planned | High | Medium |

---

## Monetization Strategy

### Open Source Core
- **MIT License**: 核心框架永远开源
- **Community**: GitHub Issues, Discussions, PRs

### Enterprise Edition
- **On-premise Deployment**: 企业内部部署
- **SSO/SAML**: 企业身份认证
- **Audit Log**: 完整审计日志
- **Priority Support**: 企业级技术支持
- **Price**: $50-500/用户/月

### Plugin Market
- **Free Plugins**: 官方维护，免费使用
- **Premium Plugins**: 第三方开发，平台抽成 20-30%
- **Custom Plugins**: 企业定制开发

### Cloud Services
- **Managed Hosting**: 云端托管实例
- **API Credits**: 按量计费（模型调用、存储）
- **SLA Guarantee**: 99.9% 可用性保证

---

## Technical Standards

### Code Quality
- **TypeScript**: Strict mode, no `any` types
- **Testing**: 95%+ coverage for core modules
- **Linting**: ESLint + Prettier
- **Documentation**: JSDoc + Markdown

### API Design
- **REST**: OpenAPI 3.0 规范
- **WebSocket**: JSON-RPC 2.0
- **MCP**: Model Context Protocol 标准

### Security
- **API Keys**: 环境变量管理，绝不硬编码
- **Secrets**: `.env` 不提交到 Git
- **Sandbox**: 插件运行在受限环境中
- **Rate Limiting**: 基于 Token 的速率限制

---

## Conclusion

OpenClaw v2.5.3 已完成以下核心功能：

- ✅ Linux 适配器、MiniMax MCP、插件市场 (v2.2.0)
- ✅ GitHub MCP Server 集成 (v2.4.0) — 22 个工具
- ✅ 竞技场榜单采集器 (v2.5.0) — 8 个工具，确定性评估
- ✅ Prompt 连接池 (v2.5.0) — 6 个工具，缓存优化
- ✅ 代码质量改进 (v2.5.1-v2.5.3) — 消除重复，统一错误处理

**当前状态**: 113 个 MCP 工具，生产就绪。

**下一阶段**: 多 Agent 编排统一、知识图谱增强、前端现代化。

---

*Last Updated: 2026-06-26*
*Version: v2.5.3*
*Version: v2.3.0*
