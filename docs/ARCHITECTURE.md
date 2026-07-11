# Axiom 架构权威参考

> 最后更新: 2026-07-10
> 本文件是 Axiom 项目的唯一架构权威参考。所有架构决策、分层规则、模块职责均以此为准。

---

## 1. 项目概览

Axiom 是一个确定性 AI Agent 框架，核心设计理念是**零向量、零概率、零 embedding**。所有检索、推理、记忆操作均基于确定性算法（关键词匹配、规则引擎、确定性图遍历），不使用任何 ML 模型进行搜索或聚类。

| 属性 | 值 |
|------|-----|
| 语言 | TypeScript 5.x |
| 运行时 | Bun 1.3+ |
| 总源文件 | 221 个 |
| 总代码行 | ~64,000 |
| 测试文件 | 66 个 |
| 测试总数 | ~1,100 (136 核心 + 154 前端 + 其他) |
| PBT invariants | 46 |
| 类型安全 | `tsc --noEmit` 0 errors, `as any` ≤ 15 |

---

## 2. 目录架构与分层

```
src/
├── agents/          — AI Agent 实现 (opencode, hermes, consciousness, orchestrator)
├── constants/       — 共享常量 (叶子层)
├── context/         — 上下文管理
├── core/            — 核心基础设施 (config-center, http-router, health-checker)
├── crawl/           — 数据采集管道 (web fetch, search, serpapi)
├── cron/            — 定时任务
├── db/              — 数据库访问层 (pg, sqlite, codegraph-sync)
├── dre/             — 确定性推理引擎 (constraint, runtime, pipeline, persona, actor)
├── eval/            — 模型评估框架
├── kal/             — 知识访问层
├── kg/              — 知识图谱增强
├── mcp/             — MCP 服务器 + 工具注册表 (15 领域文件)
├── memory/          — Vault 核心记忆引擎 (确定性搜索, archiver, distiller)
├── ocr/             — OCR 引擎
├── pi-agent/        — Pi Agent 代码工具适配器
├── plugins/         — 插件注册表
├── router/          — 模型路由 (model-router, thompson, capability-registry)
├── routes/          — HTTP API 路由处理器
├── services/        — 循环依赖解耦层 (见 2.1 节)
├── skills/          — Skill 加载器
├── tools/           — 通用工具抽象 (read/write/query + pipeline)
├── tui/             — 终端 UI
└── utils/           — 通用工具函数 (叶子层)
```

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
| `deterministic-search.ts` | 603 | 零向量全文搜索 (关键词 + PARA + 标签) |
| `sqlite-memory.ts` | 492 | SQLite FTS5 索引持久化 |
| `archiver.ts` | 265 | 记忆归档 (frontmatter 处理) |
| `distiller.ts` | 168 | 记忆蒸馏 (Web/对话→结构化笔记) |
| `codegraph-index.ts` | 509 | 代码符号索引 |
| `bootstrap.ts` | 262 | Agent 记忆引导初始化 |

**单例模式:** `getGlobalVault()` 是唯一获取 VaultManager 实例的方式。禁止 `new VaultManager()`。

### 3.2 `router/` — 模型路由

| 组件 | 行数 | 职责 |
|------|------|------|
| `model-router.ts` | 963 | 多平台模型路由 (fallback, retry, streaming) |
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
| `total 15 域文件` | — | 遵循 `registerXxxTools(registry, deps?)` 模式 |

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
test:full         170 tests  — 以上全部 (6.1s)
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
- SQLite/PG 查询结果行 (pg-client.ts, codegraph-sync.ts, model-eval-service.ts)
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
| 2026-07-10 | EventBus O(n)→O(1) 环形缓冲区 | 100k publish: 77ms→29ms |
| 2026-07-10 | 架构完整性测试 22 项 | CI 自动化约束检查 |
| 2026-07-10 | 性能基准 32 项 (200% 超标) | 性能回归预防 |
| 2026-07-09 | `mcp/server.ts` 拆分为 15 域文件 | 3246→407 行 |
| 2026-07-09 | `utils/` 层级违规清零 | 3→0 |
| 2026-07-09 | VaultManager 单例化 | 8→1 实例化点 |
| 2026-07-09 | `process.env` 收口 | 100+→30 合法 |
| 2026-07-09 | DRE 工厂简化 | 3 单实现工厂 inline |
| 2026-07-09 | `as any` 修复 | 59→19 (-68%) |
