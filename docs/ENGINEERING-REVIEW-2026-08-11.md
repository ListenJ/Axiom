# Engineering Review 2026-08-11

> 摘要：对 openclaw-fusion 当前源码与测试进行系统审查。规模为 347 个 src TS 文件、151 个测试文件、约 85.6k 行源码。使用 CodeGraph 验证代码索引可用；架构、安全、性能门禁测试通过。审查发现并修复了 `components <-> mcp` 的循环依赖，剩余问题主要是大型文件、少量 `any`、宽泛 catch 与 SELECT *，属于可读性与维护性优化项，不构成当前阻断。

## 1. 仓库能力地图

| 模块 | 能力 |
|---|---|
| `src/mcp` | MCP stdio/HTTP 服务器、工具注册、外部受限工具面、RecoverableToolOutput |
| `src/memory` | Vault Markdown、SQLite FTS、确定性搜索、记忆门控、蒸馏优先级、归档 |
| `src/db` | 会话持久化、工具调用台账、Session lineage、SQLite 迁移 |
| `src/components` | ContextAssembler、TokenBudget、AdaptiveCompaction、ContextCacheDiscipline |
| `src/router` | 模型路由、工具池、token 统计、fallback |
| `src/agents` | 意识反射、MemoryCurator、SkillPromoter、Orchestrator、Native Agents |
| `src/dre` | 确定性推理引擎、约束求解、知识网络、认知流水线 |
| `src/crawl` | 网页抓取、多引擎搜索、结构化抽取 |
| `src/eval` | 评估器、Arena 采集、模型评测 |
| `frontend` | React/Vite 前端、聊天画布、会话管理、工具调用展示 |

## 2. 度量结果

- 源码规模：`347` 个 `src/**/*.ts`，`151` 个测试文件，约 `85,624` 行源码。
- 大型文件 Top 5：`cli.ts` 1232、`project-analyzer.ts` 1039、`models/registry.ts` 982、`arena-collector.ts` 913、`model-router.ts` 868。
- 类型纪律：
  - `: any` 注解：4 处（低于 90 上限）
  - `as any`：3 处（低于 25 上限）
  - `@ts-ignore / @ts-expect-error`：1 处（等于上限）
- 运行纪律：
  - `src/` 内非 CLI 白名单 `console.log/error`：0
  - `process.env` 直接读取：0，均走 `src/utils/env.ts`
  - 未知 `require()`：0
- 风险扫描：
  - `catch` 块：258 处
  - `Promise.all`：46 处
  - `SELECT *` 相关：32 处
  - 未授权循环依赖：修复前 1 对，修复后 0 对
- CodeGraph：
  - `.codegraph/codegraph.db` 存在，大小约 35MB
  - `cg:search "session"` 可检索到前后端与 DB 层的 Session 相关符号

## 3. 已修复问题

### `components <-> mcp` 循环依赖
- 原状：`src/components/recoverable-output.ts` 反向导入 `src/mcp/tool-registry.ts`，同时 `src/mcp/server.ts` 导入 `recoverable-output.ts`。
- 修复：
  - 新增叶子层 `src/utils/tool-surface.ts`，定义通用 `ToolSurfaceLike`。
  - `ToolDef` 继承 `ToolSurfaceLike`。
  - `RecoverableToolOutput` 不再依赖 `mcp/tool-registry.ts`。
- 影响：组件层保持独立，MCP 层单向依赖组件层，架构完整性测试恢复通过。

## 4. 工程实践评估

### 做得好的部分
- 架构门禁完整：层依赖、循环、环境变量、console、any、超大文件均有自动检查。
- 性能门禁有效：Cache、ThompsonRouter、ConstraintSolver、EventBus、Scheduler、KnowledgeNetwork 等热路径全部低于阈值。
- 原生优先：已移除运行时 `require()`，改用 ESM 静态导入。
- 记忆与上下文体系分层清晰：Vault/SQLite、TokenBudget、AdaptiveCompaction、ContextCacheDiscipline、Session lineage 各司其职。
- 测试覆盖面较高：151 个测试文件，覆盖架构、安全、性能、压力、认知、记忆、路由、MCP。

### 需要继续优化的部分
- 大型文件：`cli.ts`、`project-analyzer.ts`、`models/registry.ts` 超过 900 行，建议拆分，但不属于当前阻断。
- 少量 `any`：`db/pg-client.ts`、`utils/proxy-fetch.ts` 建议用泛型或最小接口收窄。
- 宽泛 catch：258 处 `catch` 中部分为空捕获，建议至少记录错误或限定异常类型。
- `SELECT *`：32 处，建议按查询字段显式列出，尤其是高频路径。
- 完整测试套件未在本轮全量运行；本次采样覆盖架构、安全、性能、压力与门禁，完整 `test:full` 仍建议在 CI 中执行。

## 5. 验证结果

- `bun run lint`：通过
- 架构完整性 + 性能门禁：34/34 pass
- 架构 + RecoverableToolOutput + 外部 MCP：29/29 pass
- 安全/性能/门禁采样：110 pass，1 fail（架构循环），修复后该 fail 已消除
- CodeGraph：索引可用，符号检索正常