# Axiom 架构权威参考

> 最后更新: 2026-07-13
> 本文件是 Axiom 项目的唯一架构权威参考。所有架构决策、分层规则、模块职责均以此为准。

---

## 1. 项目概览

Axiom 是一个确定性 AI Agent 框架，核心设计理念是**手写余弦（`src/memory/deterministic-search.ts` 关键词权重 + `src/dre/consciousness/stream.ts:cosineSimilarity` 手写余弦）+ PG vector 可选（`pgvector` 扩展，可选历史能力 H-M1-03，默认 SQLite FTS5，需 PG 时启用）**。确定性检索（关键词 3x/标签 2.5x/内容 1x + PARA + 关系推导）为默认，**知识库结构化（`src/knowledge/pipeline.ts:186`）的 LLM 调用为可选能力（`KNOWLEDGE_USE_LLM=false` 默认关闭）；关闭时走确定性 TF-IDF 回退 `fallbackTFIDF`，开启时依次尝试边缘小模型 `structureKnowledgeWithEdge` 与云端 `structureWithGLM`，再失败仍回退 TF-IDF。**

| 属性 | 值 |
|------|-----|
| 语言 | TypeScript 5.x |
| 运行时 | Bun 1.3+ |
| 总源文件 | 260+ 个 |
| 总代码行 | ~70,000 |
| 测试文件 | 80+ 个 |
| 测试总数 | ~1,170 (1042 后端 + 154 前端 + 其他) |
| PBT invariants | 46 |
| 类型安全 | `tsc --noEmit` 0 errors, `as any` ≤ 4 |

---

## 2. 目录架构与分层

```
src/
├── agents/          — AI Agent 实现 (opencode, hermes, consciousness, orchestrator)
├── cli/              — CLI 子命令 (knowledge, vault, eval, kg, db)
├── constants/       — 共享常量 (叶子层)
├── context/         — 上下文管理
├── core/            — 核心基础设施 (config-center, http-router, health-checker)
├── crawl/           — 数据采集管道 (web fetch, search, serpapi)
├── cron/            — 定时任务
├── db/              — 数据库访问层 (sqlite, codegraph-sync)
├── dre/             — 确定性推理引擎 (constraint, runtime, pipeline, persona, actor)
├── eval/            — 模型评估框架
├── kal/             — 知识访问层
├── kg/              — 知识图谱增强
├── knowledge/        — 知识库系统 (pipeline, collector, searcher, store, sources)
├── mcp/             — MCP 服务器 + 工具注册表 (15 领域文件)
├── memory/          — Vault 核心记忆引擎 (确定性搜索, archiver, distiller)
├── ocr/             — OCR 引擎
├── pi-agent/        — Pi Agent 代码工具适配器
├── plugins/         — 插件注册表
├── router/          — 模型路由 (model-router, thompson, capability-registry)
├── routes/          — HTTP API 路由 (chat, search, vault, agents, eval, stats, tools, sandbox, pipeline, traces, models)
├── sandbox/         — 沙盒执行环境 (docker-sandbox, process-sandbox)
├── services/        — 循环依赖解耦层 (见 2.1 节)
├── skills/          — Skill 加载器
├── tools/           — 通用工具抽象 (read/write/query + pipeline)
├── tui/             — 终端 UI
├── utils/           — 通用工具函数 (cache, env, logger, security, permissions, agent-trace)
├── workers/         — 远程 Worker 客户端 (pdf-worker, llm-worker)
```

**数据库:** SQLite 为唯一运行时数据库；PostgreSQL 已迁移为可选历史能力 (H-M1-03)。`src/db/pg-client.ts` 已删除，`pg-schema.sql` 仅归档保留；所有持久化通过 `sqlite-memory.ts` (FTS5)、`kg/enhanced.ts` (SQLite KG) 和 `codegraph-sync.ts` (SQLite 本地索引) 完成。

### 2.1 分层规则

```
叶子层:  constants, utils     — 不依赖任何 src 模块
领域层:  memory, router, dre, agents, crawl, db, ocr, kg, kal, skills, tools
集成层:  mcp, routes, agents  — 可引用所有领域层
解耦层:  services             — 唯一允许双向引用的模块 (循环依赖断路器)
```

**核心约束:**
- `utils/*` 不得从 `memory/`, `router/`, `agents/`, `mcp/`, `dre/`, `routes/`, `services/` 导入 (类型导入除外)
- `memory/*` 不得从 `agents/`, `mcp/`, `routes/` 导入
- 循环依赖仅允许通过 `services/` 层中转
- 已知设计允许的集成模块: `mcp`, `routes`, `agents` (可引用 8+ 目录)

### 2.2 已知循环依赖 (通过 services/ 解耦)

```
agents → services ← router        (agents 使用 router 服务)
memory → services ← agents        (consciousness 访问 memory)
core   → routes   ← agents        (路由注册)
```

这些循环依赖通过 `src/services/` 中的薄桥接模块 (`router.ts`, `consciousness.ts`, `execution.ts`) 显式断环。

---

## 3. 核心模块职责

### 3.1 `memory/` — Vault 确定性记忆引擎

| 组件 | 行数 | 职责 |
|------|------|------|
| `vault-manager.ts` | 640 | 核心记忆管理 (read/write/search/browse) |
| `deterministic-search.ts` | 603 | 手写余弦全文搜索（关键词 + PARA + 标签 + 关系推导；PG vector 可选，默认 FTS5） |
| `sqlite-memory.ts` | 492 | SQLite FTS5 索引持久化 |
| `archiver.ts` | 265 | 记忆归档 (frontmatter 处理) |
| `distiller.ts` | 168 | 记忆蒸馏 (Web/对话→结构化笔记) |
| `codegraph-index.ts` | 509 | 代码符号索引 |
| `bootstrap.ts` | 262 | Agent 记忆引导初始化 |

**单例模式:** `getGlobalVault()` 是唯一获取 VaultManager 实例的方式。禁止 `new VaultManager()`。

### 3.2 `router/` — 模型路由

| 组件 | 行数 | 职责 |
|------|------|------|
| `model-router.ts` | 728 | 多平台模型路由 (fallback, retry, streaming) |
| `models/registry.ts` | 933 | 模型注册表 (UnifiedModel 数据) |
| `model-capability-registry.ts` | 162 | 能力注册表 (推荐式, 支持 opts+EXTENSIONS) |
| `tool-pool.ts` | 240 | 工具执行池 (并发/限流) |
| `thompson-router.ts` | 283 | Thompson Sampling 多臂赌博机路由 |

**查询入口统一:** `model-capability-registry.ts:findModelsForRole()` 是唯一推荐查询入口。旧版 `registry.ts:findModelsForRole()` 已标记 `@deprecated`。

### 3.3 `mcp/` — MCP 服务器

| 组件 | 行数 | 职责 |
|------|------|------|
| `server.ts` | 407 | 服务器入口 + 工具注册编排 |
| `server/vault-tools.ts` | 148 | Vault 核心工具 |
| `server/kg-tools.ts` | 524 | 知识图谱工具 |
| `server/dre-tools.ts` | 719 | DRE 推理工具 |
| `server/github-tools.ts` | 617 | GitHub 工具 |
| `server/code-agent-tools.ts` | 93 | 编码 Agent 工具 |
| `server/arena-tools.ts` | 96 | 竞技场榜单工具 |
| `server/orchestrator-tools.ts` | 118 | 多 Agent 编排工具 |
| `total 16 域文件` | — | 遵循 `registerXxxTools(registry, deps?)` 模式 |

### 3.4 `dre/` — 确定性推理引擎

| 组件 | 行数 | 职责 |
|------|------|------|
| `engine.ts` | 732 | DRE 引擎主控 (14+ 子系统编排) |
| `constraint/solver.ts` | 583 | 约束求解器 (resource, policy, temporal) |
| `runtime/knowledge-network.ts` | 577 | 知识网络 (实体+关系+预测) |
| `runtime/rule-engine.ts` | 745 | 规则引擎 (if-then + 学习) |
| `runtime/event-bus.ts` | 145 | 事件总线 (O(1) 环形缓冲区) |
| `pipeline/cognitive-pipeline.ts` | 555 | 认知管道 (感知→推理→行动) |

---

## 4. 测试架构

```
test:core         136 tests  — 核心模块单元测试 (566ms)
test:arch          22 tests  — 架构完整性约束 (497ms)
test:perf          32 tests  — 性能基准 (含 200% 超标基线)
test:integration   11 tests  — 集成/并发测试
test:e2e           31 tests  — E2E 端到端测试 (真实文件 I/O, HTTP 路由, MCP 工具, 弹性, 配置)
test:full         232 tests  — 以上全部 (~13s)
frontend          154 tests  — React 组件测试 (vitest + jsdom)
```

### 4.1 架构完整性测试 (22 项)

测试 `tests/architecture-integrity.test.ts` 在 CI 中自动运行，验证：

| 类别 | 项目 | 阈值 |
|------|------|------|
| 分层 | utils 导入约束 | 0 违规 |
| 分层 | memory 导入约束 | 0 违规 |
| 分层 | 循环依赖 | 仅 services 断路器允许 |
| 代码质量 | `as any` 总数 | ≤ 25 |
| 代码质量 | `as any` 每文件 | ≤ 5 |
| 代码质量 | `: any` 注解 | ≤ 90 |
| 代码质量 | `@ts-expect` | ≤ 1 |
| 代码质量 | `console.*` | 仅 logger.ts |
| 代码质量 | 文件大小 | 一般 ≤ 1000, 豁免 ≤ 1500 |
| 环境变量 | `process.env` 直读 | 仅白名单文件 |
| 污点代码 | `throw new Error()` | 描述 ≥ 10 字符 |
| 工具 | `mcp/server.ts` 行数 | ≤ 500 |

### 4.2 性能合约 (32 项)

| 基准 | 规格 | 极限 |
|------|------|------|
| Cache 100k set+get | < 200ms | **实测 43ms** |
| Cache 1M 内存上限 | 峰值 ≤ 10000 | **实测 10000** |
| Thompson 50k route | < 500ms | **实测 31ms** |
| ConfigCenter 50k 读 | < 100ms | **实测 0.8ms** |
| Solver 50k check | < 500ms | **实测 49ms** |
| Pipeline 10k empty | < 100ms | **实测 8.7ms** |
| EventBus 100k pub | < 50ms | **实测 29ms** (O(1) 环形缓冲区) |

### 4.3 E2E 端到端测试 (31 项)

E2E 测试覆盖真实文件系统 I/O、HTTP 路由、MCP 工具调用、系统弹性与配置加载场景,与架构完整性测试一同在 CI 中自动执行。

### 4.4 CI/CD

CI 运行 `bun run test:full` (232 项测试, ~13s),代替原先的 `bun test`。架构完整性测试 (22 项) 和 E2E 测试 (31 项) 为 CI 必过门槛。

---

## 5. 代码质量规则

### 5.1 `process.env` 使用规范

所有环境变量读取必须通过 `src/utils/env.ts` 的 `readString()`, `readInt()`, `readBool()`。例外白名单：

- `env.ts` (自身实现)
- `config-center.ts` (配置中心)
- `logger.ts` (运行时日志配置)
- `proxy-fetch.ts` (代理发现)
- `api-key-store.ts` (Key 存储)
- `vault-manager.ts` (构造函数默认值)
- `main.ts` (动态 key 读取)
- `router/models/providers.ts` (provider 配置)

### 5.2 `as any` 豁免

仅允许在以下场景使用 `as any`：
- Bun 内部 API (redis-client.ts)
- SQLite 查询结果行 (codegraph-sync.ts, model-eval-service.ts)
- 复杂 DOM/协议类型 (computer-use-agent.ts, adaptive-proxy.ts)
- 第三方库兼容 (install-wizard.ts: blessed)

总数不得 > 20, 每文件不得 > 5。

### 5.3 单例模式

| 单例 | 获取方式 | 文件 |
|------|---------|------|
| VaultManager | `getGlobalVault()` | `memory/vault-manager.ts` |
| ConfigCenter | `getConfigCenter()` | `core/config-center.ts` |
| ReadOptimizer | `getReadOptimizer()` | `utils/read-optimizer.ts` |
| Consciousness | `getConsciousness()` | `agents/consciousness/index.ts` |
| DRE Kernel | `getKernel()` | `dre/kernel.ts` |

### 5.4 安全

- **环境变量密钥轮换:** `.env` 中的 API Key 支持运行时动态轮换,通过 `api-key-store.ts` 统一管理
- **速率限制:** `http-router.ts` 内置令牌桶速率限制器,防止滥用

---

## 6. MCP 工具注册模式

所有 MCP 工具遵循统一的 `registerXxxTools(registry, deps)` 模式：

```typescript
// server/<domain>-tools.ts
import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";

export function registerVaultTools(registry: ToolRegistry, vault: VaultManager): void {
  registry.add({
    name: "memory_search",
    description: "...",
    inputSchema: { query: z.string().describe("...") },
    handler: async (args) => { ... },
  });
}
```

`server.ts` 仅做编排注册，不含任何内联工具定义（~407 行）。

---

## 7. 演进记录

| 日期 | 变更 | 影响 |
|------|------|------|
| 2026-07-11 | PostgreSQL 移除, SQLite 为唯一数据库 | 简化数据层 |
| 2026-07-11 | `opencode-tool-agent.ts` 按需加载重构 | 1021→64 行 (-94%) |
| 2026-07-11 | `cli.ts` 拆分为 `cli/commands/` | 1411→1207 行 |
| 2026-07-11 | `model-router.ts` 拆分 | 963→728 行 |
| 2026-07-11 | CI 优化: `bun test` → `test:full` | 232 tests in ~13s |
| 2026-07-11 | `as any` 持续削减 | 59→13 (-78%) |
| 2026-07-10 | EventBus O(n)→O(1) 环形缓冲区 | 100k publish: 77ms→29ms |
| 2026-07-10 | 架构完整性测试 22 项 | CI 自动化约束检查 |
| 2026-07-10 | 性能基准 32 项 (200% 超标) | 性能回归预防 |
| 2026-07-09 | `mcp/server.ts` 拆分为 16 域文件 | 3246→407 行 |
| 2026-07-09 | `utils/` 层级违规清零 | 3→0 |
| 2026-07-09 | VaultManager 单例化 | 8→1 实例化点 |
| 2026-07-09 | `process.env` 收口 | 100+→30 合法 |
| 2026-07-09 | DRE 工厂简化 | 3 单实现工厂 inline |
| 2026-07-09 | `as any` 修复 | 59→19 |

---

## 8. 已知限制（Limitations）

> 详见 `docs/LIMITATIONS.md`。本节为架构摘要，保持与实现一致。

| 维度 | 现状 | 说明 |
|------|------|------|
| 检索 | 手写余弦（`deterministic-search.ts` 关键词权重 + `consciousness/stream.ts:cosineSimilarity`）为默认；PG vector（`pgvector`）为可选历史能力 H-M1-03，默认关闭，需 PG 时启用 | 非历史宣称，而是“确定性为主、向量可选” |
| LLM | `src/knowledge/pipeline.ts:186` 受 `KNOWLEDGE_USE_LLM=false` 控，默认 TF-IDF 回退，仅开启时走 `structureKnowledgeWithEdge`/`structureWithGLM` | 非历史旧宣称，而是“LLM 可选” |
| 历史 PG | `src/db/pg-client.ts` 已删除，`pg-schema.sql` 仅归档保留；持久化经 `sqlite-memory.ts`/`kg/enhanced.ts`/`codegraph-sync.ts`；PG 能力为可选历史，非“已移除”即不可用 | 按需启用 |
| MCP 工具数 | 权威计数以 `src/mcp/tool-registry.ts` + `src/mcp/server/*.ts` + `register-external-tools.ts` 为准，当前 **172** 个去重工具（`bun run count-tools.mjs` 统计 181 含 client-connector 等非 MCP 面，权威去重后 172） | 文档中 133/150/173 为历史值，已统一为 172 |

*更新：2026-08-21 Task16 文档一致性校准（手写余弦+PG vector 可选、可选 LLM、PG 可选历史、工具数 172）。*

---

## 10. 分布式知识网络

系统采用三机分布式架构进行知识采集与处理：

| 节点 | IP | 角色 | 硬件 |
|------|-----|------|------|
| 编排器 | 192.168.2.121 | Bun/Node 运行时 | Windows, 无 GPU |
| PDF Worker | 192.168.2.11 | MinerU + FastAPI (CPU) | E5-2450, Intel X520 万兆 |
| LLM Worker | 192.168.2.150 | 推理服务 (预留) | RTX 3050, Python 3.14 |

### 通信协议

所有 Worker 使用统一 REST API：

```
POST /v1/submit → { task_id, status: "queued" }
GET  /v1/status/{task_id} → { status, progress, result }
```

### 后端 API 端点 (280+ 路由)

| 组 | 端点 | 功能 |
|----|------|------|
| 工具执行 | POST /api/tools/execute | 统一工具执行协议 |
| 沙盒 | POST /sandbox/execute | 沙盒命令执行 |
| 权限 | POST /permissions/check | 高危操作检测 |
| 流水线 | GET /pipeline/stream | SSE 认知流水线 |
| 追踪 | GET /traces | Agent 执行追踪 |
| Token | GET /api/token-details | Token 消耗分析 |
| 模型 | GET/POST/DELETE /models | 模型管理 |
| 供应商 | GET /providers | 供应商列表 |

