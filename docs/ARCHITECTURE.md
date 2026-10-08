# Axiom 架构速览（基线统计与分层约束）

> 最后更新: 2026-09-29（Linux 迁移 + 主干归一后校准）
> **权威指针**：全系统唯一权威参考是 [AXIOM-ARCHITECTURE.md](./AXIOM-ARCHITECTURE.md)（模块详解、核心代码、数据流、工具面）。
> 本文只承载**可复现的基线统计、分层约束与演进记录**；两文冲突时以 AXIOM-ARCHITECTURE.md 为准（2026-09-29 双权威裁决）。

---

## 1. 项目概览

Axiom 是一个确定性认知运行时（Runtime）——生态位位于现有 Agent 之下的基础设施层（ADR-001「Runtime 优先于 Agent」，见 AXIOM-ARCHITECTURE §〇），为上层 Agent/宿主提供确定性认知基建（检索/记忆/KG/推理/工具面）与模型调用效率（缓存/路由/预算），而非又一个 Agent。核心设计理念是**确定性检索（`src/memory/sqlite-memory.ts` 的 SQLite FTS5 为主索引、`src/memory/deterministic-search.ts` 的关键词按匹配次数加分为补，两者均无向量计算；共享 `cosineSimilarity`（`src/utils/math.ts`）仅在有 embedding 的可选语义路径使用）+ PG vector 当前不可启用（PG 客户端已随 H-M1-03 删除，TS 运行时内无 PG 路径，默认且唯一为 SQLite FTS5；native 云端件的探针例外见 `docs/LIMITATIONS.md` §2.3）**。确定性检索（关键词按匹配次数加成，优先级 标题 > 标签 > 路径 > 内容 + PARA + 关系推导）为默认，**知识库结构化（`src/knowledge/pipeline.ts` 的 `KNOWLEDGE_USE_LLM` 开关）的 LLM 调用为可选能力（`KNOWLEDGE_USE_LLM=false` 默认关闭）；关闭时走确定性 TF-IDF 回退 `fallbackTFIDF`，开启时依次尝试边缘小模型 `structureKnowledgeWithEdge` 与云端 `structureWithGLM`，再失败仍回退 TF-IDF。**

| 属性 | 值（生成命令：`bun run scripts/count-arch-stats.mjs`；本节数字禁止手抄） |
|------|-----|
| 语言 / 运行时 | TypeScript 5.x / Bun 1.4+ |
| src/ | **38 模块 / 445 文件 / 120,177 行**（`bun run arch:stats` 生成值，2026-10-08；本地 CUDA embedding、Redis AUTH/unref、搜索兜底、DRE Kernel 生命周期收口、DRE_VERSION 单一来源、SQLite 并发 pragma 单一来源、DRE Kernel 工厂后同步；数值由 docs-consistency 断言与实测精确相等） |
| 测试 | **488 个 `*.test.ts`**；串行全套 **4,725 用例（4,658 pass / 67 skip / 0 fail / 105s）**，命令与入口见 §4（2026-10-07 实测；§4 的 09-29 数字为历史基线） |
| MCP 工具 | **189** 个去重工具（零重复）；单一事实源 `src/testing/tool-count.ts`，生成器 `scripts/count-tools.mjs` |
| 代码质量门 | `as any` ≤ 25（2026-09-29 实测 8）、每文件 ≤ 5、`: any` ≤ 90、`@ts-expect-error` ≤ 1 |
| 类型安全 | `tsc --noEmit` 0 errors |
| 非确定性登记 | 见 `docs/security/tool-capability-declarations.md`；与代码一致性由 doc-contract D5/D6 门禁保证（不在此手抄） |

---

## 2. 目录架构与分层

```
src/
├── agent-evals/     — Agent 运行时评测 (任务集, 指标, 外部对标, 自动演化)
├── agents/          — AI Agent 实现 (opencode, hermes, consciousness, orchestrator)
├── cli/              — CLI 子命令 (knowledge, vault, eval, kg, db)
├── codeindex/       — 本地 AST→SQLite 代码索引 (TypeScript Compiler API；本地优先于外部 codegraph)
├── components/      — 组件内核 (kernel, 契约, 上下文装配/压缩)
├── computer-use/    — UI 自动化 (浏览器启动守卫, 前端审查, 元素定位)
├── constants/       — 共享常量 (叶子层)
├── context/         — 上下文管理
├── core/            — 核心基础设施 (config-center, http-router, health-checker)
├── crawl/           — 数据采集管道 (web fetch, search, serpapi)
├── cron/            — 定时任务
├── db/              — 数据库访问层 (sqlite, codegraph-sync)
├── decision/        — 决策链 (Laya 本地决策模型 TS 接入, 分诊, 审计链, 置信度标定)
├── dre/             — 确定性推理引擎 (constraint, runtime, pipeline, persona, actor)
├── eval/            — 模型评估框架
├── kal/             — 知识访问层
├── kg/              — 知识图谱增强
├── knowledge/        — 知识库系统 (pipeline, collector, searcher, store, sources)
├── local-llm/       — 本地/边缘小模型接入 (llama.cpp 客户端, 边缘嵌入, 灰区初筛)
├── mcp/             — MCP 服务器 + 工具注册表 (15 领域文件)
├── memory/          — Vault 核心记忆引擎 (确定性搜索, archiver, distiller)
├── ocr/             — OCR 引擎
├── pi-agent/        — Pi Agent 代码工具适配器
├── plugins/         — 插件注册表
├── router/          — 模型路由 (model-router, thompson, capability-registry)
├── routes/          — HTTP API 路由 (chat, search, vault, agents, eval, stats, tools, sandbox, pipeline, traces, models)
├── runtime/         — RuntimeHost (宿主生命周期与运行态类型)
├── sandbox/         — 沙盒执行环境 (docker-sandbox, process-sandbox)
├── self-evolve/     — 自演化回路 (技能晋升/质量, 心智建议)
├── semantic/        — 语义表示 schema (意义模式, 符号相似度, 校验管线)
├── services/        — 循环依赖解耦层 (见 2.1 节)
├── skills/          — Skill 加载器
├── terminal/        — PTY 终端与命令审批门
├── testing/         — 测试基础设施 (工具计数单一事实源, 场景/调度/指标)
├── tools/           — 通用工具抽象 (read/write/query + pipeline)
├── tui/             — 终端 UI
├── utils/           — 通用工具函数 (cache, env, logger, security, permissions, agent-trace)
├── workers/         — 远程 Worker 客户端 (pdf-worker, llm-worker)
```

**数据库:** SQLite 为 TS 运行时唯一有数据面的数据库；PostgreSQL 在 TS 运行时不可用（H-M1-03 移除后无 PG 数据面入口：`package.json` 依赖与 `bun.lock` 均无 PG 驱动，`src/mcp`/`src/routes`/`src/tools` 内零 `postgres`/`pgvector` 引用）。`src/db/pg-client.ts` 已删除（38966d12），`src/db/pg-schema.sql` 仍在仓库（`Dockerfile` 会 COPY 进镜像）但运行时代码无消费者 —— 唯一提到它的源码是 `src/utils/db-guard.ts` 的一条注释；所有持久化通过 `sqlite-memory.ts` (FTS5)、`kg/enhanced.ts` (SQLite KG) 和 `codegraph-sync.ts` (SQLite 本地索引) 完成；native 云端件 `axiom-cloud` 另有一条只作存活探针的 PG 池（crate 内 PG 语句执行点实测 0），例外口径见 `docs/LIMITATIONS.md` §2.3。 <!-- doc-caliber:absent: src/db/pg-client.ts -->

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

> 层归属的**执行判据**是 `tests/architecture-integrity.test.ts` 的分层约束与 `src/` 的实际导入（模块清单见 §2 目录树）；
> 上列各层举例不逐一枚举 38 个模块 —— 需要精确清单时以目录树与门禁为准（2026-09-29 校准注）。

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

| 组件 | 职责 |
|------|------|
| `vault-manager.ts` | 核心记忆管理 (read/write/search/browse) |
| `deterministic-search.ts` | 确定性关键词打分引擎（精确匹配 + 关键词加成 + PARA + 标签 + 关系推导；FTS5 主索引在 `src/memory/sqlite-memory.ts`，二者由 `src/memory/vault-manager.ts` 的 `search()` 串接；PG vector 当前不可启用，见 §8 现状表） |
| `sqlite-memory.ts` | SQLite FTS5 索引持久化 |
| `archiver.ts` | 记忆归档 (frontmatter 处理) |
| `distiller.ts` | 记忆蒸馏 (Web/对话→结构化笔记) |
| `codegraph-index.ts` | 代码符号索引 |
| `bootstrap.ts` | Agent 记忆引导初始化 |

**单例模式:** `getGlobalVault()` 是唯一获取 VaultManager 实例的方式。禁止 `new VaultManager()`。

### 3.2 `router/` — 模型路由

| 组件 | 职责 |
|------|------|
| `model-router.ts` | 多平台模型路由 (fallback, retry, streaming) |
| `models/registry.ts` | 模型注册表 (UnifiedModel 数据) |
| `model-capability-registry.ts` | 能力注册表 (推荐式, 支持 opts+EXTENSIONS) |
| `tool-pool.ts` | 工具执行池 (并发/限流) |
| `thompson-router.ts` | Thompson Sampling 多臂赌博机路由 |

**查询入口统一:** `model-capability-registry.ts:findModelsForRole()` 是唯一推荐查询入口。旧版 `registry.ts:findModelsForRole()` 已标记 `@deprecated`。

### 3.3 `mcp/` — MCP 服务器

| 组件 | 职责 |
|------|------|
| `server.ts` | 服务器入口 + 工具注册编排 |
| `server/vault-tools.ts` | Vault 核心工具 |
| `server/kg-tools.ts` | 知识图谱工具 |
| `server/dre-tools.ts` | DRE 推理工具 |
| `server/github-tools.ts` | GitHub 工具 |
| `server/code-agent-tools.ts` | 编码 Agent 工具 |
| `server/arena-tools.ts` | 竞技场榜单工具 |
| `server/orchestrator-tools.ts` | 多 Agent 编排工具 |
| 其余领域文件 | 同遵循 `registerXxxTools(registry, deps?)` 模式；`src/mcp/server/` 下 `*-tools.ts` 清单不手抄，以 `ls src/mcp/server/*-tools.ts` 实测为准 |

### 3.4 `dre/` — 确定性推理引擎

| 组件 | 职责 |
|------|------|
| `engine.ts` | DRE 引擎主控 (14+ 子系统编排) |
| `constraint/solver.ts` | 约束求解器 (resource, policy, temporal) |
| `runtime/knowledge-network.ts` | 知识网络 (实体+关系+预测) |
| `runtime/rule-engine.ts` | 规则引擎 (if-then + 学习) |
| `runtime/event-bus.ts` | 事件总线 (O(1) 环形缓冲区) |
| `pipeline/cognitive-pipeline.ts` | 认知管道 (感知→推理→行动) |

---

## 4. 测试架构

测试入口以 `package.json` 脚本为准；**用例数一律以实跑输出为准，不在本文手抄**（历史漂移留证：本表曾记 `test:full` 232 项/~13s，2026-09-29 实测串行全量为 4,675 用例 / 470 文件 / 约 115s）。

| 脚本 | 内容 |
|------|------|
| `test` / `test:full` | 全量（`scripts/test-full.ts`；`test` 默认 `--parallel=8`） |
| `test:core` | 核心模块单元测试（脚本内固定文件清单） |
| `test:arch` | 架构完整性约束（`tests/architecture-integrity.test.ts`） |
| `test:docs` | 文档口径契约（`tests/doc-contract.test.ts`） |
| `test:perf` / `test:stress` / `test:gate` | 性能基准 / 压力 / 性能门禁（`AXIOM_PERF_ASSERT=1`） |
| `test:integration` | 集成与并发边界（`tests/integration-edge.test.ts`） |
| `test:e2e` | E2E（`scripts/run-e2e.cjs`） |
| `test:smoke` | 冒烟（`scripts/test-smoke.ts`） |

串行全量基线（Linux 迁移后，2026-09-29 实测）：`bun test --timeout 15000 ./tests` → **470 文件 / 4,675 用例 / 4,608 pass / 67 skip / 0 fail / 约 115s**。

### 4.1 架构完整性测试

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

### 4.2 性能合约

性能断言分两档：默认套件只做**防挂起上界**（宽阈值，防卡死与数量级爆炸）；`AXIOM_PERF_ASSERT=1`（`test:perf` / `test:stress` / `test:gate`）才启用严格基准。各基准的规格与实测值以**实跑输出**为准，不在本文手抄历史快照（2026-09-28 预算重校准留痕见 ops log）。

### 4.3 E2E 端到端测试

E2E 覆盖真实文件系统 I/O、HTTP 路由、工具调用、系统弹性与配置加载场景（入口 `scripts/run-e2e.cjs`），与架构完整性测试一同在 CI 中自动执行。

### 4.4 CI/CD

CI 运行 `bun run test:full`；架构完整性（`test:arch`）与文档口径契约（`test:docs`）为必过门槛。

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
- `decision/laya-calibrate.ts` (CLI 前置校验：缺 `LAYA_DECISION_URL` 拒跑，2026-09-28 增补)
- `main.ts` (动态 key 读取)
- `router/models/providers.ts` (provider 配置)

> 白名单的**权威来源**是 `tests/architecture-integrity.test.ts` 的 `ENV_WHITELIST` 常量；本列表如与门禁冲突，以门禁为准（2026-09-29 校准注）。

### 5.2 `as any` 豁免

仅允许在以下场景使用 `as any`（2026-09-29 实测：全 `src/` 共 **8 处**，分布如下）：

- `src/memory/vault-manager.ts`（2）— vault 行与动态字段
- `src/dre/system-resource.ts`（2）— 系统资源探针返回值
- `src/utils/redis-client.ts`（1）— Bun 内部 API
- `src/routes/knowledge-graph.ts`（1）— 请求体动态字段
- `src/mcp/tool-registry.ts`（1）— 工具参数透传
- `src/agents/computer-use-agent.ts`（1）— DOM/协议类型

门禁阈值：总数 ≤ 25、每文件 ≤ 5（权威来源 `tests/architecture-integrity.test.ts`）。

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
| 2026-09-29 | Linux 迁移后数据面校准 | agent.db VACUUM 轮换（空闲页 23.5%→0，-24.1%）；codeindex 重扫为 Linux 路径并修复查询字段映射；健康检查新增空闲页告警 |
| 2026-09-28 | 主干归一收口 + Rust 全退役 | `internal/main` 推进到归一 tip；运行时纯 TS（Go 负责 runtime-go 高并发）；Laya 决策链接入开发流程（后续提交仍在工作分支，main 未跟进） |
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
| 检索 | 确定性检索为默认：`src/memory/sqlite-memory.ts` 的 SQLite FTS5 为主索引，`src/memory/deterministic-search.ts` 的关键词按匹配次数加分为补（由 `src/memory/vault-manager.ts` 的 `search()` 串接：FTS 命中不足或质量偏低时用确定性引擎补充）；共享 `cosineSimilarity`（`src/utils/math.ts`）仅在有 embedding 的可选语义层使用；**知识库语义层（2026-09-20/21，ku 线并入）**：向量存**同库**表 `knowledge_embeddings`（`src/knowledge/{embedding-store,semantic-index,semantic-recall,semantic-layer,semantic-recall-port,incremental-index}.ts`），**向量只作候选召回**、最终排序带稳定 tie-breaker（同分按 node_id 升序），跨存储按 nodeId **物化**后并入 `KnowledgeAccessLayer.query()`；写入腿两条：**推送腿**（`VaultManager.writeNote` / `KnowledgeStore.write` / MCP `kg_write` 经 `services/knowledge-index-hook.ts`，组合根 `enableKnowledgeEmbeddingIndex(db)` 装配）+ **扫描腿**（采集管线收尾 `runIncrementalIndex()` 与全量脚本，含**删除同步** `pruneOrphans`，两道安全闸）；模型调用受 `AXIOM_EMBEDDING_CONSENT`（默认 `ask` = 零网络请求）控制，且发布面不含 SiliconFlow（`devOnly` 闸门）；PG vector 当前不可启用（H-M1-03 已删客户端，无启用路径） | 非历史宣称，而是“确定性为主、向量可选”；语义层端到端已实测跑通（真实 `bge-m3`，推送与扫描两条腿各一次） |
| 本地 Embedding 服务 | 本机 GPU 上运行 `BAAI/bge-m3` 的 OpenAI 兼容服务（实现见 `runtime-embed/`，只绑定 `127.0.0.1:9001`）；embedding 角色首选 `src/router/models/registry.ts` 的 `local-bge-m3`（provider `local-embed`，非 `devOnly`），模型标签 `local-embed/BAAI/bge-m3`，单条文本按 `src/knowledge/semantic-index.ts` 的 `MAX_EMBED_TEXT_CHARS` 截断 | 本地 CUDA 推理，不依赖外部 embedding API；ModelScope 仅作权重下载；服务不可用时回落确定性检索，边界与回滚见 `docs/LIMITATIONS.md` §6 |
| LLM | `src/knowledge/pipeline.ts` 的 `KNOWLEDGE_USE_LLM` 开关受 `KNOWLEDGE_USE_LLM=false` 控，默认 TF-IDF 回退，仅开启时走 `structureKnowledgeWithEdge`/`structureWithGLM` | 非历史旧宣称，而是“LLM 可选” |
| 历史 PG | `src/db/pg-client.ts` 已删除（38966d12），`src/db/pg-schema.sql` 仍在仓库但无运行时消费者；持久化经 `sqlite-memory.ts`/`kg/enhanced.ts`/`codegraph-sync.ts`；PG 数据面能力在 TS 运行时不可启用：`package.json` 依赖与 `bun.lock` 均无 PG 驱动，TS 运行时内无任何开关或入口 <!-- doc-caliber:absent: src/db/pg-client.ts --> | 需 PG 时先按规则 4 裁决 `src/db/pg-schema.sql` 存废，再重建客户端与索引迁移 |
| MCP 工具数 | 权威计数以 `src/testing/tool-count.ts` 为准（`bun run scripts/count-tools.mjs` 直接生成），当前 **189** 个去重工具，零重复 | 文档中 133/150/172/173/188 为历史值，已统一为 189 |

*更新：2026-08-21 Task16 文档一致性校准（可选 LLM、PG 可选历史 —— 后者为旧口径，已随 H-M1-03 废止，现状见 §8）；2026-08-25 检索口径校准（FTS5+关键词为默认、余弦仅可选语义层）；工具数经 2026-08-22 真相化与 2026-08-25 单一事实源治理，2026-08-30 S4 新增 hallucination_feedback 后为 189（以 `src/testing/tool-count.ts` 为准）；2026-09-26 归一并入 ku 线知识库语义层口径（推送腿+扫描腿+删除同步、AXIOM_EMBEDDING_CONSENT、SiliconFlow devOnly）；2026-10-07 新增本地 CUDA embedding 服务口径（`local-embed` provider、`local-bge-m3` 首选、单条截断）。*

---

## 10. 分布式知识网络

系统采用三机分布式架构进行知识采集与处理：

| 节点 | 地址（部署参数，不入库） | 角色 | 硬件 |
|------|-----|------|------|
| 编排器 | `${LAN_ORCHESTRATOR}` | Bun/TS 运行时（Rust sidecar 已退役；Go 仅 runtime-go 高并发面） | Linux（2026-09-28 迁移后） |
| PDF Worker | `${LAN_PDF_WORKER}` | MinerU + FastAPI (CPU) | E5-2450, Intel X520 万兆 |
| LLM Worker | `${LAN_LLM_WORKER}` | 推理服务 (预留) | RTX 3050, Python 3.14 |

> 三机地址与登录账号属部署拓扑，按规则 11 不入库（占位符只表达"哪个角色在哪台机"，不表达可寻址信息）。
> 编排器行已按 2026-09-28 Linux 迁移更新；**Worker 两行为迁移前登记值，本轮未复核其在线状态与硬件**，以部署时 `${LAN_*}` 实际配置为准（2026-09-29 校准注）。
> 脚本/代码侧的字面量默认值（`scripts/deploy-pdf-worker.sh`、`src/cli.ts` 的 `--pdf-worker` 示例）本轮只登记未改，
> 换环境时以参数或环境变量覆盖。

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
