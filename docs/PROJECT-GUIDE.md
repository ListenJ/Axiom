# Axiom Runtime 项目权威指南

> **本文档是 Axiom 项目的唯一权威入门与参考文档。**
> 最后更新: 2026-07-17 · 版本: v4.0.0
>
> 深层架构细节请参考 [ARCHITECTURE.md](./ARCHITECTURE.md)；历史变更见 [CHANGELOG.md](../CHANGELOG.md)。

---

## 目录

1. [项目概述](#1-项目概述)
2. [架构设计](#2-架构设计)
3. [核心功能模块](#3-核心功能模块)
4. [API 接口规范](#4-api-接口规范)
5. [数据流程](#5-数据流程)
6. [开发环境配置](#6-开发环境配置)
7. [部署指南](#7-部署指南)
8. [常见问题解决方案](#8-常见问题解决方案)

---

## 1. 项目概述

### 1.1 定位

Axiom Runtime 是一个**确定性 AI Agent 框架**，核心设计理念是 **"零向量、零概率、零 embedding"**。所有检索、推理、记忆操作均基于确定性算法（关键词匹配、规则引擎、确定性图遍历），不使用任何 ML 模型进行搜索或聚类。LLM 在此框架中从"推理主体"降级为 **Cognitive Accelerator（认知加速器）**，确定性推理才是系统核心。

### 1.2 关键指标

| 属性 | 值 |
|------|-----|
| 语言 / 运行时 | TypeScript 5.x / Bun 1.3+ |
| 源文件数 | 260+ 个 (`src/`) |
| 代码行数 | ~70,000 |
| 测试文件 | 68 个 |
| 测试总数 | ~1,170 (后端 1042 + 前端 154) |
| MCP 工具 | 133+ 个（15 个领域文件） |
| HTTP 路由 | 280+ 个端点 |
| `as any` 总数 | 6（上限 25）|
| `@ts-expect-error` | ≤ 1 |
| 前端页面 | 18 个（React + Vite）|

### 1.3 技术栈

- **后端**: Bun + TypeScript, SQLite (FTS5) 为唯一数据库
- **前端**: React 18 + Vite + Tailwind CSS + Zustand
- **桌面**: Tauri (Rust shell)
- **高性能核心**: Rust native bridge (sidecar, 端口 18790)
- **MCP**: @modelcontextprotocol/sdk 1.29+ (stdio + HTTP 双传输)
- **CLI**: blessed (TUI), 自研命令分发

### 1.4 核心能力

- **确定性记忆引擎 (Vault)**: 关键词 + PARA + 标签全文搜索，SQLite FTS5 持久化
- **确定性推理引擎 (DRE)**: 约束求解 + 规则引擎 + 知识网络 + 认知管道
- **模型路由**: Thompson Sampling 多臂赌博机 + 能力注册表 + fallback 链
- **知识图谱**: SQLite 实体关系图（BFS / 最短路径 / 中心性）
- **数据采集**: 6 搜索引擎（DDG / Bing / Google / Yandex / SearXNG / Brave）
- **沙盒执行**: Docker / 进程级沙盒
- **多 Agent 编排**: OpenCode / Hermes / Computer Use / Orchestrator

---

## 2. 架构设计

### 2.1 分层架构

```
┌──────────────────────────────────────────────────────────┐
│              接入层 (Entry Points)                        │
│  HTTP API (18789) │ MCP Server (3001) │ WebSocket │ CLI  │
├──────────────────────────────────────────────────────────┤
│              路由层 (Routing)                             │
│  场景路由 (21 场景) │ 模型路由 (Thompson + Capability)    │
├──────────────────────────────────────────────────────────┤
│              工具层 (Tools)                               │
│              133+ MCP Tools (15 领域)                     │
├──────────────────────────────────────────────────────────┤
│              引擎层 (Engines)                             │
│  Vault │ DRE │ KG │ Arena │ Cognitive Pipeline           │
├──────────────────────────────────────────────────────────┤
│              存储层 (Storage)                             │
│  Obsidian Vault │ SQLite │ CodeGraph │ DRE SQLite        │
├──────────────────────────────────────────────────────────┤
│              基础设施 (Infrastructure)                    │
│  env.ts │ logger │ cache │ security │ native bridge      │
└──────────────────────────────────────────────────────────┘
```

### 2.2 目录结构与分层规则

```
src/
├── constants/       叶子层 — 共享常量，不依赖任何 src 模块
├── utils/           叶子层 — 通用工具 (cache, env, logger, security, permissions)
├── memory/          领域层 — Vault 确定性记忆引擎
├── router/          领域层 — 模型路由 (model-router, thompson, capability-registry)
├── dre/             领域层 — 确定性推理引擎 (constraint, runtime, pipeline)
├── agents/          领域层 — Agent 实现 (opencode, hermes, consciousness, orchestrator)
├── crawl/           领域层 — 数据采集管道
├── db/              领域层 — SQLite 访问层
├── knowledge/       领域层 — 知识库系统
├── kg/              领域层 — 知识图谱增强
├── tools/           领域层 — 通用工具抽象 + pipeline
├── ocr/  skills/  kal/  sandbox/  eval/  pi-agent/  plugins/
├── mcp/             集成层 — MCP 服务器 + 工具注册表
├── routes/          集成层 — HTTP API 路由 (24 文件, 280+ 端点)
├── services/        解耦层 — 循环依赖断路器（唯一允许双向引用）
├── core/            基础设施 — config-center, http-router, health-checker
├── cli/  tui/       入口 — CLI 子命令 + 终端 UI
└── main.ts  launcher.ts  cli.ts  native-bridge.ts  — 顶层入口
```

**分层约束（由 `tests/architecture-integrity.test.ts` 强制执行）：**

| 规则 | 约束 |
|------|------|
| `utils/` 导入 | 不得引用 memory/router/agents/mcp/dre/routes/services（仅 constants/utils）|
| `memory/` 导入 | 不得引用 agents/mcp/routes |
| 循环依赖 | 仅允许通过 `services/` 中转 |
| `process.env` | 必须经 `utils/env.ts`（白名单 8 文件例外）|
| `console.*` | 仅 `utils/logger.ts` 等 7 个白名单文件 |
| `as any` | 总数 ≤ 25，每文件 ≤ 5 |
| 文件行数 | 一般 ≤ 1000，豁免 ≤ 1500 |

### 2.3 已知循环依赖（通过 services/ 解耦）

```
agents → services ← router        (agents 使用 router 服务)
memory → services ← agents        (consciousness 访问 memory)
core   → routes   ← agents        (路由注册)
db     ↔ memory                   (通过 services 断环)
```

### 2.4 单例模式

| 单例 | 获取方式 | 文件 |
|------|---------|------|
| VaultManager | `getGlobalVault()` | `memory/vault-manager.ts` |
| ConfigCenter | `getConfigCenter()` | `core/config-center.ts` |
| ReadOptimizer | `getReadOptimizer()` | `utils/read-optimizer.ts` |
| Consciousness | `getConsciousness()` | `agents/consciousness/index.ts` |
| DRE Kernel | `getKernel()` | `dre/kernel.ts` |

---

## 3. 核心功能模块

### 3.1 memory/ — Vault 确定性记忆引擎

| 组件 | 行数 | 职责 |
|------|------|------|
| `vault-manager.ts` | 761 | 核心记忆管理 (read/write/search/browse)，单例 |
| `deterministic-search.ts` | ~603 | 零向量全文搜索 (关键词 + PARA + 标签) |
| `sqlite-memory.ts` | ~492 | SQLite FTS5 索引持久化 |
| `codegraph-index.ts` | ~509 | 代码符号索引 |
| `archiver.ts` / `distiller.ts` | — | 记忆归档 / 蒸馏 |

**入口**: `getGlobalVault()` 是唯一获取实例方式，禁止 `new VaultManager()`。

### 3.2 dre/ — 确定性推理引擎

| 组件 | 行数 | 职责 |
|------|------|------|
| `engine.ts` | 777 | DRE 引擎主控（14+ 子系统编排）|
| `constraint/solver.ts` | ~583 | 约束求解器 (resource, policy, temporal) |
| `runtime/knowledge-network.ts` | ~577 | 知识网络 (实体 + 关系 + 预测) |
| `runtime/rule-engine.ts` | 745 | 规则引擎 (if-then + 学习) |
| `pipeline/cognitive-pipeline.ts` | ~555 | 认知管道 (感知 → 推理 → 行动) |
| `storage/knowledge-store.ts` | 776 | 知识持久化 |

**预设**: `PRESETS.minimal/standard/production/research`，快速接入用 `createDRE(PRESETS.standard())`。

### 3.3 router/ — 模型路由

| 组件 | 行数 | 职责 |
|------|------|------|
| `model-router.ts` | 811 | 多平台路由 (fallback, retry, streaming) |
| `models/registry.ts` | 1027 | 模型注册表 (UnifiedModel 数据) |
| `model-capability-registry.ts` | ~162 | 能力注册表（推荐式，**唯一查询入口**）|
| `thompson-router.ts` | ~283 | Thompson Sampling 多臂赌博机 |
| `tool-pool.ts` | ~240 | 工具执行池 (并发 / 限流) |

**查询入口统一**: `model-capability-registry.ts:findModelsForRole()`。旧版 `registry.ts:findModelsForRole()` 已 `@deprecated`。

### 3.4 mcp/ — MCP 服务器与工具

| 组件 | 职责 |
|------|------|
| `server.ts` (≤500 行) | 服务器入口 + 工具注册编排 |
| `tool-registry.ts` | 工具注册表 (stdio + HTTP 双传输，含 try/catch 错误包装) |
| `server/<domain>-tools.ts` | 15 个领域文件，遵循 `registerXxxTools(registry, deps?)` 模式 |

**工具注册模式**:
```typescript
export function registerVaultTools(registry: ToolRegistry, vault: VaultManager): void {
  registry.add({
    name: "memory_search",
    description: "...",
    inputSchema: { query: z.string() },
    handler: async (args) => { /* ... */ },
  });
}
```

### 3.5 routes/ — HTTP API

24 个路由文件，280+ 端点，通过 `routes/index.ts` 的 Trie 路由器按优先级分发。主要路由组见 §4。

### 3.6 agents/ — Agent 体系

8 核心角色: `main_coding` / `code_review` / `research` / `architecture` / `decision` / `general_chat` / `tool_use` / `computer_use`。

| Agent | 用途 |
|-------|------|
| OpenCode | 代码生成 / 重构（免费模型子代理）|
| Hermes | 深度项目解析 / 架构决策 |
| Computer Use | UI 自动化 / 浏览器控制 |
| Orchestrator | 多 Agent 编排 |
| Consciousness | 反思循环 / 心智模型 |

### 3.7 前端 (frontend/)

React 18 + Vite + Tailwind + Zustand。18 个页面，核心页面: Home / Chat / Search / Code / Agents / Router / Vault / KG / Sessions / Eval / Plugins / OCR / Research / Settings。

**架构约束**（`tests/e2e-layout.test.ts` 强制）:
- 页面文件 < 600 行
- 根容器含 `fade-in` 类
- 列表容器含 `stagger` 类
- 禁止 hex 颜色字面量（必须用 CSS 变量 design tokens）
- `@ts-expect-error` ≤ 1

---

## 4. API 接口规范

### 4.1 路由注册

所有路由经 `routes/index.ts` 的 `dispatch()` 按优先级匹配。默认端口 **18789**，MCP 端口 **3001**，Native bridge **18790**。

### 4.2 主要端点组

| 组 | 端点 | 方法 | 功能 |
|----|------|------|------|
| 对话 | `/api/chat` | POST | 单轮对话 |
| 对话 | `/api/chat/stream` | POST (SSE) | 流式对话 |
| 对话 | `/api/chat/history` | GET | 历史记录 |
| 搜索 | `/api/search` | POST | Vault + Web 搜索 |
| 搜索 | `/api/search/web` | POST | 多引擎 Web 搜索 |
| 记忆 | `/api/vault/search` | POST | Vault 确定性搜索 |
| 记忆 | `/api/vault/write` | POST | 写入记忆 |
| 记忆 | `/api/vault/stats` | GET | Vault 统计 |
| 知识图谱 | `/api/kg/stats` | GET | KG 统计 |
| 知识图谱 | `/api/kg/entities` | GET | 实体列表 |
| 知识图谱 | `/api/kg/traverse` | POST | 图遍历 (BFS / 最短路径) |
| 模型 | `/api/models` | GET/POST/DELETE | 模型管理 |
| 模型 | `/api/providers` | GET | 供应商列表 |
| 模型 | `/api/models/:provider/test` | POST | 连接测试 |
| Token | `/api/token-details` | GET | Token 消耗分析 |
| 工具 | `/api/tools/execute` | POST | 统一工具执行 |
| 沙盒 | `/sandbox/execute` | POST | 沙盒命令执行 |
| 权限 | `/permissions/check` | POST | 高危操作检测 |
| 权限 | `/permissions/mode` | GET/POST | 权限模式 |
| 流水线 | `/pipeline/stream` | GET (SSE) | 认知流水线 |
| 追踪 | `/traces` | GET | Agent 执行追踪 |
| 健康检查 | `/health` | GET | 系统健康 |
| 指标 | `/metrics` | GET | Prometheus 指标 |

### 4.3 认证

- **网关令牌**: `AXIOM_AUTH_TOKEN`（至少 16 位随机字符串），通过 `Authorization: Bearer <token>` 头校验
- **API Key 管理**: `utils/api-key-store.ts` 统一管理，支持运行时动态轮换
- **速率限制**: `http-router.ts` 内置令牌桶限流器

### 4.4 SSE 流式协议

对话流事件类型:
```
event: start    → { type: "start", model, provider }
event: token    → { type: "token", content }
event: done     → { type: "done", model, provider, usage }
event: error    → { type: "error", message }
```

结构化标记（嵌入 token 流）: `{"_axon":"thinking"|"file-change"|"tool-call", ...}`，由 `parseTokenContent()` 解析。

---

## 5. 数据流程

### 5.1 对话请求流

```
用户输入 → POST /api/chat/stream
  → 场景路由 (SceneRouter, 21 场景)
  → 模型路由 (Thompson + Capability → 选模型)
  → LLM 调用 (streaming)
  → token 流解析 (parseTokenContent 提取思考/文件变更/工具调用)
  → SSE 推送到前端
  → 完成后写入 Vault (记忆蒸馏)
```

### 5.2 记忆写入流

```
内容 → distiller.ts (Web/对话 → 结构化笔记)
  → vault-manager.write()
  → sqlite-memory.ts (FTS5 索引)
  → codegraph-index.ts (代码符号索引)
  → Obsidian Vault 文件 (Markdown + frontmatter)
```

### 5.3 知识采集流（三机分布式）

```
编排器 (192.168.2.121) → 提交任务
  → PDF Worker (192.168.2.11, MinerU + FastAPI)
    POST /v1/submit → { task_id, status: "queued" }
    GET  /v1/status/{task_id} → { status, progress, result }
  → LLM Worker (192.168.2.150, 推理服务)
  → 结果回写 → knowledge/pipeline.ts → KG 实体抽取 → SQLite
```

### 5.4 DRE 认知管道

```
感知 (Perception) → 推理 (Reasoning: 规则引擎 + 约束求解)
  → 行动 (Action: Actor 系统)
  → 验证 (VerificationEngine)
  → 若 verdict != "pass" → refine 循环
  → 知识网络更新 (KnowledgeNetwork)
```

---

## 6. 开发环境配置

### 6.1 前置要求

- **Bun** 1.3+ (推荐最新)
- **Node.js** 18+ (前端构建 / Playwright)
- **Rust** (可选，native bridge 编译)
- **SQLite** (Bun 内置，无需单独安装)

### 6.2 安装步骤

```bash
# 1. 克隆仓库
git clone <repo-url> axiom && cd axiom

# 2. 安装后端依赖
bun install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，至少配置一个模型 API Key 和 AXIOM_AUTH_TOKEN

# 4. 初始化数据库
bun run migrate

# 5. (可选) 前端依赖
cd frontend && bun install && cd ..

# 6. (可选) Native bridge
bun run native:build
```

### 6.3 关键环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `AXIOM_AUTH_TOKEN` | 是 | 网关认证令牌（≥16 字符）|
| `DEEPSEEK_API_KEY` | 二选一 | DeepSeek 官方 Key |
| `SILICONFLOW_API_KEY` | 二选一 | 硅基流动 Key |
| `OBSIDIAN_VAULT_PATH` | 否 | Obsidian Vault 路径（默认 `./axiom-memory`）|
| `DATABASE_PATH` | 否 | SQLite 路径（默认 `./data/agent.db`）|
| `LOG_LEVEL` | 否 | 日志级别（默认 `info`）|
| `AXIOM_NATIVE` | 否 | 是否启用 Rust 核心（默认 `true`）|

**重要**: 所有 `process.env` 读取必须通过 `utils/env.ts` 的 `readString()` / `readInt()` / `readBool()`，由架构测试强制。

### 6.4 开发命令

```bash
bun run dev          # 后端热重载开发
cd frontend && bun run dev   # 前端 Vite 开发
bun run tui          # 终端 UI
bun run cli          # CLI 入口
bun run mcp          # MCP 服务器 (stdio)
bun run lint         # tsc --noEmit 类型检查
```

### 6.5 测试命令

```bash
bun run test:arch         # 架构完整性 (22 项, CI 门槛)
bun run test:core         # 核心单元测试
bun run test:perf         # 性能基准 (32 项)
bun run test:integration  # 集成测试
bun run test:full         # 全套 (~232 项, ~13s)
bun test tests/           # 全部测试
cd frontend && bun run test   # 前端测试 (vitest)
```

---

## 7. 部署指南

### 7.1 Docker 部署（推荐）

```bash
# 构建镜像（多阶段：deps → builder → runner）
docker build -t axiom-agent .

# 通过 docker-compose 启动
docker-compose up -d
```

`Dockerfile` 要点:
- 基础镜像 `oven/bun:1.3-alpine`
- 多阶段构建，最终镜像仅含 `dist/` + 依赖
- 非 root 用户 `appuser` 运行
- 暴露 `18789` (HTTP) + `3001` (MCP)
- 健康检查 `curl -f http://localhost:18789/health`

### 7.2 PM2 部署

```bash
bun run start:daemon    # PM2 守护进程启动
bun run stop            # 停止
bun run restart         # 重启
bun run status          # 状态
bun run logs            # 日志
```

配置文件 `ecosystem.config.json`。

### 7.3 Tauri 桌面应用

```bash
bun run tauri:dev       # 开发模式
bun run tauri:build     # 构建桌面安装包
```

### 7.4 生产环境清单

- [ ] `.env` 配置完成（API Key + AUTH_TOKEN）
- [ ] `bun run migrate` 已执行
- [ ] `bun run lint` 0 错误
- [ ] `bun run test:arch` 全通过
- [ ] `AXIOM_NATIVE=true`（启用 Rust 加速）
- [ ] 反向代理配置（nginx → 18789）
- [ ] HTTPS 终止（Clipboard API 等需要 secure context）
- [ ] 数据目录 `data/` 持久化卷挂载
- [ ] Vault 目录 `axiom-memory/` 持久化卷挂载

---

## 8. 常见问题解决方案 (FAQ)

### Q1: 启动报错 "Environment validation failed"

**原因**：必填环境变量缺失（如 `AXIOM_AUTH_TOKEN`）。

**解决**：
1. 复制 `.env.example` 为 `.env`
2. 至少配置一个模型平台 API Key（`DEEPSEEK_API_KEY` 等）
3. 设置 `AXIOM_AUTH_TOKEN`（≥16 位随机字符串）
4. 重启 `bun run dev`

> 环境校验采用宽松模式（`strict: false`），缺失仅 warn，不阻断启动；缺失关键变量会在对应模块加载时报错。

### Q2: 架构测试失败 `process.env reads must go through env.ts`

**原因**：架构约束要求所有 `process.env` 读取必须经过 `src/utils/env.ts`，便于统一治理与未来加密。

**解决**：
- 在 `src/` 内禁止直接 `process.env.XXX`
- 使用 `readString("XXX")` / `readInt("XXX", default)` / `readBool("XXX", default)`
- 已知预存违规位置：`routes/models.ts`、`knowledge/pipeline.ts`、`knowledge/sources/github-trending.ts`（共 7 处，待治理）

### Q3: 前端 e2e-layout 测试失败（hex 颜色 / fade-in / stagger）

**原因**：e2e-layout 测试约束前端页面：
- 页面文件 ≤ 600 行
- 必须包含 `fade-in` class
- 列表项必须含 `stagger` 动画
- 禁止硬编码 hex 颜色（必须用 CSS 变量）

**解决**：
- 行数超标：提取辅助函数到 `@/components/xxx-utils.ts`，提取子组件到 `@/components/xxx-yyy.tsx`
- 缺动画：根容器添加 `<div className="fade-in">`，列表项添加 `style={{ animationDelay: `${i * 60}ms` }}`
- hex 颜色：替换为 `var(--primary)` / `var(--success)` 等 CSS 变量

### Q4: MCP 工具调用返回 "Tool not found"

**原因**：MCP 工具按 domain 注册，未注册或 domain 写错时找不到。

**解决**：
1. 确认工具已通过 `registerXxxTools(registry, deps)` 注册
2. 调用 `/mcp/tools/list` 查看已注册工具
3. 检查工具名前缀（如 `memory.*` / `vault.*` / `codegraph.*`）
4. 启动日志查看 `[MCP] Registered tools: ...` 行

### Q5: 流式对话无响应 / 卡住

**原因**：SSE 连接被代理/防火墙切断，或上游 API Key 失效。

**解决**：
1. 检查浏览器 DevTools → Network → `/chat` 请求是否为 `eventstream`
2. 服务端日志查看 `LLMClient` 错误（401/403 表示 Key 失效）
3. 用 `bun run health` 验证平台连通性
4. 反向代理（nginx）需配置 `proxy_buffering off;` 以支持 SSE

### Q6: SQLite "database is locked"

**原因**：Bun SQLite 默认串行写入，并发写事务会冲突。

**解决**：
- 服务层使用 `withDbLock(fn)` 串行化写入
- 长事务改用 `db.transaction(() => {...})` 包裹
- 生产环境推荐切换 PostgreSQL：设置 `DATABASE_URL=postgres://...`
- WAL 模式默认已开启（`PRAGMA journal_mode=WAL`）

### Q7: Native bridge (Rust) 启动失败

**原因**：Rust sidecar 二进制缺失或端口冲突。

**解决**：
1. 设置 `AXIOM_NATIVE=false` 临时禁用（功能降级到 TS 实现）
2. 重新构建：`bun run native:build`（需 Rust toolchain）
3. 检查端口 18790 是否被占用：`netstat -ano | findstr 18790`
4. 查看日志 `[NativeBridge]` 前缀条目

### Q8: 如何添加新的 MCP 工具

**步骤**：
1. 在 `src/mcp/tools/` 下新建 `xxx-tools.ts`
2. 导出 `registerXxxTools(registry: ToolRegistry, deps?: XxxDeps): void`
3. 在 `src/mcp/server.ts` 或对应 routes 文件中调用 `registerXxxTools(registry)`
4. 工具定义使用 `zod` schema 描述参数
5. 添加测试 `tests/mcp-xxx.test.ts`，验证 `registerWithMcp` 注册成功
6. 运行 `bun test tests/mcp-server.test.ts` 验证不破坏现有工具

### Q9: 添加新模型平台

**步骤**：
1. 在 `src/routes/llm-providers/` 新建 `xxx.ts` 导出 adapter
2. 实现 `{ baseURL, headers, modelPath, transformRequest, transformResponse }`
3. 在 `src/routes/models.ts` 注册路由
4. `.env.example` 添加 `XXX_API_KEY=`
5. 在 `src/main.ts` 的 `platformChecks` 添加健康检查
6. 前端 `Providers.tsx` 添加 UI 配置项

### Q10: 部署到 Docker 后前端 404

**原因**：Dockerfile 当前未打包前端静态资源，仅暴露后端 API。

**解决**：
- 开发：前后端分离部署，前端独立 Vercel/Netlify 部署
- 单体：在 Dockerfile runner 阶段添加 `COPY frontend/dist ./public/`，并在 `src/main.ts` 配置静态资源服务
- 推荐：使用 `docker-compose.yml` 同时启动后端 + 前端 nginx 容器

### Q11: 测试失败 "singleton state leaked between files"

**原因**：Bun worker 跨文件共享单例（如 `ruleEngine`、`scheduler`、`verificationEngine`），测试未清理。

**解决**：
- `beforeEach` 和 `afterEach` 中调用 `singleton.reset()`
- `updateConfig()` 的测试必须在 `afterEach` 恢复 `ORIGINAL_CONFIG`
- `addRule()` 的测试必须追踪 ID 并在 `afterEach` 调用 `remove()`

---

## 附录 A: 文档导航表

| 文档 | 用途 | 何时查阅 |
|------|------|---------|
| **PROJECT-GUIDE.md**（本文档） | 权威入门参考，覆盖项目全貌 | 第一次接触项目、需要快速了解架构 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构深度参考，分层与依赖关系 | 需要理解模块边界、依赖方向 |
| [AXIOM-ARCHITECTURE.md](./AXIOM-ARCHITECTURE.md) | 完整架构白皮书（69KB），含数学模型 | 需要深入理解 VIB/Conformal/Thompson 等数学突破 |
| [DEVELOPER-ONBOARDING.md](./DEVELOPER-ONBOARDING.md) | 开发者上手指南 | 第一次本地启动、配置 IDE |
| [api-audit-report.md](./api-audit-report.md) | API 审计报告 | 排查 API 一致性问题 |
| [review-core.md](./review-core.md) | 核心代码审查 | 排查核心模块问题 |
| [review-frontend.md](./review-frontend.md) | 前端代码审查 | 排查前端问题 |
| [review-security.md](./review-security.md) | 安全审查 | 安全合规检查 |
| [review-knowledge.md](./review-knowledge.md) | 知识系统审查 | 排查记忆/知识库问题 |
| [changelog.md](./changelog.md) | 版本变更日志 | 升级版本时查阅 |
| [REVIEW-2026-07-17.md](./REVIEW-2026-07-17.md) | 本次综合审查报告 | 了解当前代码质量与改进建议 |

## 附录 B: 关键脚本速查

| 命令 | 用途 |
|------|------|
| `bun run dev` | 开发模式（热重载） |
| `bun run build` | 构建生产 bundle |
| `bun run test` | 运行全部测试 |
| `bun run test:arch` | 仅架构约束测试 |
| `bun run test:core` | 核心模块测试集 |
| `bun run test:full` | 完整测试套件（含 perf/e2e） |
| `bun run lint` | TypeScript 类型检查 |
| `bun run health` | 平台连通性健康检查 |
| `bun run cli` | 进入 CLI 交互模式 |
| `bun run tui` | 启动终端 UI |
| `bun run migrate` | 数据库迁移 |
| `bun run native:build` | 构建 Rust 加速核心 |

## 附录 C: 关键路径速查

```
配置入口    : src/core/config-center.ts
主入口      : src/main.ts
路由注册    : src/routes/index.ts (registerTrieRoutes)
MCP 服务    : src/mcp/server.ts
工具注册    : src/mcp/tools/*-tools.ts (15 个领域)
记忆引擎    : src/memory/vault-manager.ts
知识网络    : src/memory/knowledge-network.ts
DRE 引擎    : src/dre/ (presets.ts, errors.ts, pipeline)
调度器      : src/scheduler/
能力注册表  : src/capability/registry.ts
前端入口    : frontend/src/main.tsx
前端路由    : frontend/src/App.tsx
API 客户端  : frontend/src/api.ts
```

---

**文档版本**: v1.0  
**最后更新**: 2026-07-17  
**维护者**: Axiom Core Team