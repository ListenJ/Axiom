# Axiom 全项目权威指南

> **最后更新:** 2026-07-10 | **版本:** 4.0.0
> **本文件是 Axiom 项目的唯一综合权威参考。** 涵盖架构、开发、测试、部署全部维度。

---

## 目录

1. [项目概述](#1-项目概述)
2. [快速开始](#2-快速开始)
3. [架构全景](#3-架构全景)
4. [模块详解](#4-模块详解)
5. [测试体系](#5-测试体系)
6. [代码质量规范](#6-代码质量规范)
7. [MCP 工具系统](#7-mcp-工具系统)
8. [配置参考](#8-配置参考)
9. [开发工作流](#9-开发工作流)
10. [性能合约](#10-性能合约)
11. [演进记录](#11-演进记录)

---

## 1. 项目概述

**Axiom** 是一个确定性 AI Agent 运行时，基于 Bun + TypeScript。核心设计理念是**零向量、零概率、零 embedding**——所有检索、推理、记忆操作均基于确定性算法。

| 属性 | 值 |
|------|-----|
| 版本 | 4.0.0 |
| 运行时 | Bun 1.3+ |
| 语言 | TypeScript 5.7 |
| 授权 | MIT |
| 源文件 | 221 个 |
| 代码行 | ~64,000 |
| 测试总数 | ~1,100 |
| 类型安全 | `tsc --noEmit` 0 errors, `as any` ≤ 15 |
| PBT invariants | 46 |
| MCP 工具 | 133+（15 个域文件） |
| 前端 | React 19 + Zustand + Tauri 2.0 |

### 核心原则

1. **记忆优先** — Obsidian Vault 是唯一真理来源，SQLite 仅作为性能索引
2. **确定性推理** — 所有 Agent 通过 Vault 文件系统共享记忆，无需 embedding
3. **LLM 降级** — LLM 从推理主体降级为 Cognitive Accelerator
4. **零向量** — 搜索使用关键词 + PARA + 标签，不依赖向量数据库

---

## 2. 快速开始

### 前置要求

```bash
# 安装 Bun
curl -fsSL https://bun.sh/install | bash

# 安装系统依赖 (Windows)
# - Git
# - Bun (上述命令)
```

### 安装

```bash
git clone <repo-url>
cd axiom
bun install

# 前端依赖 (可选)
cd frontend && npm install && cd ..
```

### 运行

```bash
bun run dev        # 开发模式 (热重载)
bun run axiom      # 生产 CLI 模式
bun run mcp        # MCP 服务器 (端口 3001)
bun run cli        # CLI 工具
```

### 测试

```bash
bun run lint          # 类型检查 (tsc --noEmit)
bun run test          # 全量测试
bun run test:core     # 核心测试 (136 tests)
bun run test:arch     # 架构完整性 (22 tests)
bun run test:perf     # 性能基准 (32 tests)
bun run test:full     # 全部后端测试 (170 tests)
cd frontend && bunx vitest run --environment jsdom  # 前端测试 (154 tests)
```

### 环境变量

最低配置:

```bash
export AXIOM_AUTH_TOKEN="your-secret-token-min-16-chars"
export SILICONFLOW_API_KEY="sk-xxx"   # 至少一个模型 API Key
export OBSIDIAN_VAULT_PATH="./axiom-memory"  # Vault 路径
# 更多配置见 src/utils/env.ts 或 core/config-center.ts
```

---

## 3. 架构全景

```
┌──────────────────────────────────────────────────────────────────┐
│                        接入层                                     │
│  HTTP API (18789)    MCP Server (3001)    WebSocket (/ws)        │
│  CLI (src/cli.ts)    TUI                   Tauri Desktop          │
├──────────────────────────────────────────────────────────────────┤
│                        路由层                                     │
│  Model Router (963行)        Scene Router (21场景)                │
│  Thompson Sampling           Capability Registry                  │
├──────────────────────────────────────────────────────────────────┤
│                     工具层 (MCP 133+)                             │
│  15 个域文件: vault / kg / dre / github / skill / arena / ...    │
│  通用工具抽象: read-tool / write-tool / query-tool / pipeline     │
├──────────────────────────────────────────────────────────────────┤
│                      引擎层                                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │ Vault    │ │ DRE      │ │ KG       │ │ Cognitive        │   │
│  │ 记忆引擎  │ │ 推理引擎  │ │ 知识图谱  │ │ Pipeline         │   │
│  ├──────────┤ ├──────────┤ ├──────────┤ ├──────────────────┤   │
│  │ SQLite   │ │ 约束求解  │ │ pgvector │ │ EventBus         │   │
│  │ FTS5     │ │ 规则引擎  │ │ SQLite   │ │ (O(1)环形缓冲区)  │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
├──────────────────────────────────────────────────────────────────┤
│                      服务/解耦层                                   │
│  services/ — 循环依赖断路器 (chat, router, consciousness)         │
├──────────────────────────────────────────────────────────────────┤
│                       基础层                                      │
│  utils/ (叶子层)   constants/ (叶子层)   config-center/           │
└──────────────────────────────────────────────────────────────────┘
```

### 分层规则

```
叶子层:  constants, utils     — 不依赖任何 src 模块
                        领域层:  memory, router, dre, agents, crawl, db, ocr, kg
集成层:  mcp, routes           — 可引用所有领域层 (13-14 导入)
解耦层:  services             — 唯一允许双向引用的模块
```

---

## 4. 模块详解

### 4.1 `memory/` — Vault 确定性记忆引擎

**核心文件:** `vault-manager.ts` (640 行)

| 组件 | 行数 | 职责 |
|------|------|------|
| `vault-manager.ts` | 640 | 核心 API (read/write/search/browse/stats) |
| `deterministic-search.ts` | 603 | 零向量全文搜索 (关键词 + PARA + 标签) |
| `sqlite-memory.ts` | 492 | SQLite FTS5 索引 |
| `archiver.ts` | 265 | 记忆归档 (frontmatter 处理) |
| `distiller.ts` | 168 | 记忆蒸馏 (Web/对话→笔记) |
| `conformal-retriever.ts` | 95 | 保形检索 (NaN 防护) |
| `codegraph-index.ts` | 509 | 代码符号索引 |
| `bootstrap.ts` | 262 | Agent 记忆引导 |

**单例规则:** `getGlobalVault()` 是唯一获取方式。禁止 `new VaultManager()`。

### 4.2 `router/` — 模型路由

**核心文件:** `model-router.ts` (963 行)

| 组件 | 行数 | 职责 |
|------|------|------|
| `model-router.ts` | 963 | 多平台路由 (fallback, retry, streaming) |
| `model-capability-registry.ts` | 162 | **统一查询入口** (支持 opts + EXTENSIONS) |
| `models/registry.ts` | 933 | 模型注册表 (UnifiedModel) |
| `thompson-router.ts` | 283 | Thompson Sampling 多臂赌博机 |
| `tool-pool.ts` | 240 | 工具执行池 |

**查询规范:** 所有 `findModelsForRole` 调用使用 `model-capability-registry.ts` 版本。

### 4.3 `mcp/` — MCP 服务器

**核心文件:** `server.ts` (407 行)

```
mcp/server/           15 个域文件
├── vault-tools.ts      Vault 核心工具
├── kg-tools.ts         知识图谱工具
├── dre-tools.ts        DRE 推理工具
├── github-tools.ts     GitHub 工具 (22 工具)
├── code-agent-tools.ts 编码 Agent
├── arena-tools.ts      竞技场榜单
├── orchestrator-tools.ts 多 Agent 编排
├── prompt-tools.ts     提示池
├── token-tools.ts      Token 统计
├── mode-tools.ts       执行模式
├── router-tools.ts     模型聊天
├── hermes-tools.ts     研究 Agent
├── db-tools.ts         数据库查询
├── lsp-tools.ts        LSP 诊断
└── skill-tools.ts      Skill 管理
```

**注册模式:** 统一 `registerXxxTools(registry, deps?)` 模式。

### 4.4 `dre/` — 确定性推理引擎

**核心文件:** `engine.ts` (732 行)

| 组件 | 行数 | 职责 |
|------|------|------|
| `constraint/solver.ts` | 583 | 约束求解 (resource/policy/temporal) |
| `runtime/knowledge-network.ts` | 577 | 知识网络 (实体+关系+预测) |
| `runtime/rule-engine.ts` | 745 | 规则引擎 (if-then + 学习) |
| `runtime/event-bus.ts` | 145 | **O(1) 环形缓冲区** 事件总线 |
| `runtime/world-state.ts` | 195 | 世界状态 (防御拷贝隔离) |
| `pipeline/cognitive-pipeline.ts` | 555 | 认知管道 (感知→推理→行动) |
| `persona/loader.ts` | 487 | Persona 加载器 |
| `actor/system.ts` | 178 | Actor 系统 |

### 4.5 `tools/` — 通用工具抽象

| 组件 | 行数 | 职责 |
|------|------|------|
| `read-tool.ts` | 92 | 读取基元 (web/local/vault) |
| `write-tool.ts` | 68 | 写入基元 (local/vault) |
| `query-tool.ts` | 135 | 搜索基元 (本地 + 网络) |
| `pipeline.ts` | 113 | 工具管道编排 (缓存优先 + 循环检测) |
| `types.ts` | 161 | Tool 接口 + normalizeQuery + detectLoop |

### 4.6 `services/` — 循环依赖解耦层

```typescript
// services/router.ts        — agents 侧引用 router 的中转
// services/consciousness.ts  — memory 侧引用 consciousness 的中转
// services/execution.ts      — 执行模式的 cycler-breaker
// services/chat.ts           — 聊天服务的统一入口
// services/index.ts          — 对外暴露的统一接口
```

### 4.7 `agents/` — AI Agent

| 组件 | 行数 | 职责 |
|------|------|------|
| `opencode-agent.ts` | 259 | OpenCode 编码 Agent (代码生成/审查/重构/测试) |
| `opencode-tool-agent.ts` | 1021 | OpenCode 工具 Agent |
| `hermes-agent.ts` | 386 | 研究 Agent (深度研究/代码审查) |
| `orchestrator.ts` | 624 | 多 Agent 编排器 |
| `consciousness/` | ~800 | 意识子系统 (反射循环/记忆策展/技能推广) |
| `project-analyzer.ts` | 995 | 项目分析器 |

---

## 5. 测试体系

### 5.1 测试命令

| 命令 | 数量 | 描述 | 运行时间 |
|------|------|------|---------|
| `bun test:core` | 136 | 核心模块测试 | ~550ms |
| `bun test:arch` | 22 | 架构完整性 (CI 约束) | ~500ms |
| `bun test:perf` | 32 | 性能基准 (200% 超标) | ~5.4s |
| `bun test:integration` | 11 | 集成/并发测试 | ~1.2s |
| `bun test:full` | 170 | 全量后端 | ~6.1s |
| `bun test` | ~960 | 含 stress 测试 | ~72s |
| `vitest run` (frontend) | 154 | React 组件测试 | ~9.8s |

### 5.2 测试类型分布

- **单元测试:** 136 (core) — 每个模块独立测试
- **架构完整性:** 22 项 — 分层/代码质量/性能/依赖约束 (CI 自动执行)
- **Property-based:** 46 invariants — Cache(11) + Thompson(6) + HttpRouter(3) + Vault(13) + ConfigCenter(6) + SOAK
- **性能基准:** 32 项 — 含极端测试 (100k ops, 1M entries, 1000 并发)
- **集成测试:** 11 项 — Pipeline/Vault/ConfigCenter/EventBus/HttpRouter 集成
- **前端测试:** 154 项 — React 组件 (vitest + jsdom)
- **Stress 测试:** 多种 — 含 500 并发、5k SOAK、内存上限

### 5.3 架构完整性测试 (22 项)

`tests/architecture-integrity.test.ts` 中定义，在 `test:arch` 和 `test:full` 中运行。

| 类别 | 项目 | 阈值 |
|------|------|------|
| 分层 | utils 导入约束 | 0 违规 |
| 分层 | memory 导入约束 | 0 违规 |
| 分层 | 循环依赖 | 仅 services断路器 |
| 质量 | `as any` 总数 | ≤ 20 |
| 质量 | `as any` 每文件 | ≤ 5 |
| 质量 | `: any` 注解 | ≤ 90 |
| 质量 | `@ts-expect` | ≤ 1 |
| 质量 | `console.*` | 仅 logger.ts |
| 质量 | 文件大小 | 一般≤1000, 豁免≤1500 |
| 质量 | throw 描述 | 至少 10 字符 |
| 质量 | utils 返回类型 | 全部必须 |
| 环境 | `process.env` | 仅白名单 |
| 工具 | mcp/server.ts | ≤ 500 行 |
| 工具 | 域文件模式 | 全部 registerXxxTools |
| 性能 | PBT Cache 50k | < 500ms |
| 性能 | PBT Thompson 50k | < 1000ms |
| 性能 | Pipeline 1k empty | < 100ms |

### 5.4 性能合约 (32 项)

| 基准 | 规格 | 实测 |
|------|------|------|
| Cache 100k set+get | < 200ms | **43ms** |
| Cache 1M 内存上限 | ≤ 10000 | **10000** |
| Thompson 50k route | < 500ms | **31ms** |
| ConfigCenter 50k 读 | < 100ms | **0.8ms** |
| Solver 50k check | < 500ms | **49ms** |
| Pipeline 10k empty | < 100ms | **8.7ms** |
| EventBus 100k pub | < 50ms | **29ms** |

---

## 6. 代码质量规范

### 6.1 `process.env` 使用

所有环境变量读取必须通过 `src/utils/env.ts` 的 `readString()`, `readInt()`, `readBool()`。

**白名单文件**（允许直接 `process.env` 读取）: `env.ts`, `config-center.ts`, `logger.ts`, `proxy-fetch.ts`, `api-key-store.ts`, `vault-manager.ts`, `main.ts`, `router/models/providers.ts`

### 6.2 `as any` 豁免

仅允许 Bun 内部 API、SQLite/PG 行类型、DOM/协议处理、第三方库兼容。总数 ≤ 20, 每文件 ≤ 5。

### 6.3 单例规范

| 单例 | 获取方式 | 文件 |
|------|---------|------|
| VaultManager | `getGlobalVault()` | `memory/vault-manager.ts` |
| ConfigCenter | `getConfigCenter()` | `core/config-center.ts` |
| ReadOptimizer | `getReadOptimizer()` | `utils/read-optimizer.ts` |
| Consciousness | `getConsciousness()` | `agents/consciousness/index.ts` |
| DRE Kernel | `getKernel()` | `dre/kernel.ts` |

### 6.4 导入规范

- `utils/` 不得从 `memory/`, `router/`, `agents/`, `mcp/`, `dre/`, `routes/`, `services/` 导入 (运行时)
- 类型导入 (`import type`) 不在此限
- `memory/` 不得从 `agents/`, `mcp/`, `routes/` 导入
- 循环依赖通过 `services/` 层解决

### 6.5 日志规范

- 必须使用 `src/utils/logger.ts` 的 `logger`
- 禁止 `console.log`, `console.error`, `console.warn`

---

## 7. MCP 工具系统

### 7.1 注册模式

所有 MCP 工具遵循统一的 `registerXxxTools(registry, deps)` 模式:

```typescript
// server/vault-tools.ts
import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";

export function registerVaultTools(registry: ToolRegistry, vault: VaultManager): void {
  registry.add({
    name: "memory_search",
    description: "确定性搜索 Vault 记忆笔记",
    inputSchema: { query: z.string() },
    handler: async (args) => vault.search(args.query as string),
  });
}
```

### 7.2 工具分类

| 域 | 工具数 | 注册函数 |
|----|--------|---------|
| Vault | 8 | `registerVaultTools` |
| Web | 3 | `registerWebTools` |
| GitHub | 22 | `registerGitHubTools` |
| DRE | ~25 | `registerDreTools` |
| KG | ~15 | `registerKgTools` |
| Skill | 3 | `registerSkillTools` |
| Code Agent | 5 | `registerCodeAgentTools` |
| Hermes | 2 | `registerHermesTools` |
| Router | 1 | `registerRouterTools` |
| DB | 2 | `registerDbTools` |
| LSP | 3 | `registerLspTools` |
| Token | 4 | `registerTokenTools` |
| Mode | 4 | `registerModeTools` |
| Arena | 8 | `registerArenaTools` |
| Prompt | 6 | `registerPromptTools` |
| Orchestrator | 5 | `registerOrchestratorTools` |
| Pipeline 通用 | 3 | `adaptTools` |

### 7.3 外部工具

`mcp/tools/` 目录包含独立工具实现:

| 文件 | 行数 | 职责 |
|------|------|------|
| `code-analysis.ts` | 661 | LSP 代码分析 |
| `filesystem.ts` | 115 | 文件系统操作 |
| `git.ts` | 82 | Git 操作 |
| `github.ts` | 564 | GitHub API |
| `minimax.ts` | 115 | MiniMax 模型 |
| `terminal.ts` | 24 | 终端命令 |
| `workspace-snapshot.ts` | 106 | 工作区快照 |

---

## 8. 配置参考

### 8.1 配置优先级

Runtime Override > 环境变量 > YAML 配置 > 默认值

### 8.2 核心配置项

| Key | 环境变量 | 类型 | 默认值 | 说明 |
|-----|---------|------|--------|------|
| gateway.port | AXIOM_GATEWAY_PORT | number | 18789 | HTTP 服务端口 |
| gateway.bind | AXIOM_BIND | string | 127.0.0.1 | 绑定地址 |
| gateway.auth_token | AXIOM_AUTH_TOKEN | string | — | API 鉴权 Token |
| memory.vault_path | OBSIDIAN_VAULT_PATH | path | ./axiom-memory | Vault 路径 |
| memory.database_path | DATABASE_PATH | path | ./data/agent.db | SQLite 路径 |
| crawler.serpapi_key | SERPAPI_KEY | string | — | SerpAPI Key |

完整配置模式见 `src/core/config-center.ts` 的 `CONFIG_SCHEMA`。

---

## 9. 开发工作流

### 9.1 提交流程

1. `bun run lint` — 类型检查通过
2. `bun run test:full` — 全部后端测试通过
3. `cd frontend && bunx vitest run --environment jsdom` — 前端测试通过
4. `git commit` — 提交

### 9.2 新增工具步骤

1. 在 `src/mcp/server/` 创建 `<name>-tools.ts`
2. 实现 `registerXxxTools(registry, deps)` 函数
3. 在 `src/mcp/server.ts` 调用注册
4. 运行 `bun run test:full` 验证

### 9.3 新增模块步骤

1. 在对应目录添加文件
2. 确保 `utils/` 或 `memory/` 不违反分层规则
3. 添加对应的测试文件 `tests/<name>.test.ts`
4. 运行 `bun run test:arch` 验证约束

---

## 10. 性能合约

| 合约 | 规格 | 实测 | 状态 |
|------|------|------|------|
| Cache 100k set+get | < 200ms | 43ms | ✅ |
| Cache 1M 内存上限 | ≤ 10000 | 10000 | ✅ |
| Cache LRU thrash 10k | < 100ms | 8ms | ✅ |
| Cache concurrent 1000 | 1 factory call | 1 | ✅ |
| Thompson 50k route | < 500ms | 31ms | ✅ |
| Thompson convergence | diff ≥ 0.2 | 0.30 | ✅ |
| Thompson NaN safety | NaN = 0 | 0 | ✅ |
| Vault 10k writes | < 200ms | 17ms | ✅ |
| Vault 10k searches | < 500ms | 416ms | ✅ |
| Vault 500 concurrent | 500 present | 500 | ✅ |
| ConfigCenter 50k reads | < 100ms | 0.8ms | ✅ |
| ConfigCenter 10k set+get | 0 mismatch | 0 | ✅ |
| Solver 50k checks | < 500ms | 49ms | ✅ |
| Solver selectBest 1k | 0 mismatch | 0 | ✅ |
| Pipeline 10k empty | < 100ms | 8.7ms | ✅ |
| EventBus 100k publish | < 50ms | **29ms** | ✅ |

---

## 11. 演进记录

| 日期 | 变更 | 影响 |
|------|------|------|
| 2026-07-10 | EventBus O(n)→O(1) 环形缓冲区 | 100k publish: 77ms→**29ms** |
| 2026-07-10 | 架构完整性测试 22 项 | CI 自动化约束检查 |
| 2026-07-10 | 性能基准 32 项 (200% 超标) | 性能回归预防 |
| 2026-07-10 | `as any` 修复 | 59→**15** (-75%) |
| 2026-07-10 | 全项目权威文档 | 本文件 |
| 2026-07-09 | `mcp/server.ts` 拆分为 15 域文件 | 3246→**407** 行 |
| 2026-07-09 | `utils/` 层级违规清零 | 3→0 |
| 2026-07-09 | VaultManager 单例化 | 8→1 实例化点 |
| 2026-07-09 | `process.env` 收口 | 100+→~30 合法 |
| 2026-07-09 | DRE 工厂简化 | 3 单实现工厂 inline |
| 2026-07-09 | 前端测试激活 | 0→**154** (vitest+jsdom) |
