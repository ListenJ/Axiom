# 内核收敛评估与实施计划（2026-10-08）

> 任务级别 **T3**（架构/运维）。本文 = 事实基线（全部实测）+ 风险分级 + 收敛方案与分期。
> §六 的关键决策需用户裁定后再开工；本文不是免检通行证，每 Step 单独立契约。
> 触发：2026-10-08 用户在"打磨 Runtime 本体"后指示「评估内核收敛，防止多套程序带来极其严重的问题」。

## 一、任务契约（路线图级）

- **任务**：查清 Axiom Runtime 里"多套内核/多套运行时状态"的成因与真实风险，给出可验证、可回滚的收敛方案与分期。
- **验收标准**：
  1. 事实基线的每条断言附文件/行号或实测命令，可复现；
  2. 风险按"写失败 / 状态分叉 / 数据损坏"三类**如实分级**，不夸大（WAL 下是否真会损坏须点名）；
  3. 每个收敛方案写清影响面、回滚方式、与 `AGENTS.md` 规则的一致性；
  4. 分期中的 Step 0（止血）能在不改语义的前提下独立验收。
- **改动清单（本轮）**：本文件。
- **不做项**：本轮只评估不实施；不改运行时代码；不删任何分支/文件；不引入新依赖。
- **验证命令**：`bun test tests/doc-contract.test.ts`；`bun test tests/unit/docs-consistency.test.ts`。
- **风险/回滚**：纯文档，回滚为 revert 本提交。

## 二、事实基线（2026-10-08 实测）

### 2.1 两套 DRE Kernel 的装配点与调用者

| | 宿主 Kernel | MCP Kernel |
|---|---|---|
| 单例模块 | `src/dre/host.ts`（`initDreKernel()`） | `src/mcp/server/dre-tools.ts`（`getKernelAsync()`） |
| `new Kernel(` | `host.ts:42` | `dre-tools.ts:23` |
| 调用者 | `src/main.ts:165`、`src/routes/dre.ts:15` | `src/mcp/server.ts:361`、`src/mcp/dre-backend.ts:21` |
| 配置 | `ConfigLoader().toKernelConfig()` + 组合根 `hostOverrides`（`main.ts:133` 注入 `cloudCaller`/`hallucinationGate`/`recordVerdict`） | `ConfigLoader().toKernelConfig()` + `{tickInterval:10000, autoTick:true}`，**无 overrides** |
| 启动时机 | 主服务启动即 `await` | **懒启动**（首次调 `dre_*` MCP 工具才建） |

历史成因：`dre-tools.ts` 由 `dced8b23`（2026-07-10，拆分巨型 `mcp/server.ts`）带出；`host.ts` 由 `8c0053fc`（2026-08-14，"make DRE out-of-the-box"）新建，晚 5 周。两次各写一遍装配，**没有共享的内核工厂**。

### 2.2 进程模型：两者是不同进程

- `src/main.ts` 不 import `mcp/server.ts`，也不引用任何 `mcp/server/*` 工具模块；
- `src/mcp/server.ts` 不 import `dre/host.ts`；
- `src/launcher.ts` 以子进程分别 `spawn` `main.ts`（http）与 `mcp/server.ts`（mcp）：`serve`/`full` 模式下**两个都起**（`launcher.ts:281-282`）。

结论：不是"同进程双实例"，而是**两个进程各起一套**。

### 2.3 共享持久化：两进程写同一个 `agent.db`

- `.env`：`DATABASE_PATH=./data/agent.db`，无 `DRE_DB_PATH` 覆盖；
- `ConfigLoader` 默认 `dbPath = DATABASE_PATH`（`src/dre/config.ts:55`）；
- `src/main.ts:190` 与 `src/mcp/server.ts:71` 各自 `new Database(dbPath)`；
- 两进程的 DRE Kernel 又各自经 `SqliteBackend` + `KnowledgeStore` + `SQLiteMemory` 再开多条到同一库的连接（`sqlite-memory.ts:34` 解析到 `SQLITE_MEMORY_DB || DATABASE_PATH`）。

### 2.4 进程级单例：整个"运行时大脑"被复制一份

`src/dre/runtime/*` 是**模块级单例**，每个进程一份：

| 单例 | 位置 |
|---|---|
| `scheduler` | `runtime/scheduler.ts:507` |
| `eventBus` | `runtime/event-bus.ts:155` |
| `worldState` | `runtime/world-state.ts:262` |
| `atomStore` | `runtime/atom-engine.ts:518` |
| `knowledgeNetwork` | `runtime/knowledge-network.ts:720` |
| `capabilityRegistry` | `runtime/capability-registry.ts:315` |
| `contextEngine` / `dataUnifier` / `ruleEngine` / `verificationEngine` | `runtime/*.ts` 同名导出 |

`Kernel` 直接绑定这些单例（`kernel.ts` 引 `scheduler`/`worldState`/`eventBus`）。因此"双 Kernel"实为**调度队列、Actor、意识流、知识网络各存在两份，且都落同一个库**。

### 2.5 busy_timeout 缺口地图（多进程写失败的直接来源）

`src/dre/practice-manual.ts:29-30` **已记录该类风险**："SQLite 多进程并发写会触发 SQLITE_BUSY。连接须设置 PRAGMA busy_timeout 并启用 WAL；写失败应重试而非立即报错。"——但下列主连接**未落地**：

| 连接 | WAL | busy_timeout |
|---|---|---|
| `src/dre/storage/sqlite-backend.ts:27-28`（DRE 引擎库） | 有 | **无** |
| `src/knowledge/store.ts:22-23` | 有 | **无** |
| `src/memory/sqlite-memory.ts:191-192` | 有 | **无** |
| `src/mcp/server.ts:71`（裸 `new Database`） | 未设 | **无** |
| `src/utils/cache.ts:70-71` | 有 | 有 |
| `src/dre/synapse/store.ts:49-50` | 有 | 有 |
| `src/db/migrate.ts:12-13` / `src/cron/scheduler.ts:26` | 有 | 有 |

即：**agent.db 的关键写连接多数没有 busy_timeout**。WAL 保证的是"不损坏"，不保证"不报错"——并发写会直接抛 SQLITE_BUSY。

### 2.6 组合根注入分叉

`src/dre` 按架构约束不得 import 上层（`architecture-integrity` L1 门禁），故 `cloudCaller`/`hallucinationGate`/`recordVerdict` 只能由组合根注入。`host.ts` 接了这条注入，`dre-tools.ts` 没接——**MCP 路径下的 DRE 缺少云降级、幻觉门与裁决落库**。

### 2.7 已备未用的解耦缝

`src/dre/port/`（`KnowledgePort`/`LocalKnowledgePort`/`RemoteKnowledgePort`/`createRemotePort`）已定义并在 `dre/index.ts` 导出，但**全仓无人使用**；`RemoteKnowledgePort` 约定服务端实现 `POST /api/port`（`knowledge-port.ts:391`），而该服务端路由**不存在**（`src/routes/` 无 port 实现）。这是收敛的天然接缝，目前只建了客户端一半。

## 三、风险分级（如实）

| 级别 | 风险 | 依据 | 后果 |
|---|---|---|---|
| **高** | 多进程写 agent.db 无 busy_timeout | §2.3 + §2.5 | 并发写抛 `SQLITE_BUSY`，写路径无重试则表现为请求 500 / 采集中断 |
| **中高** | 运行时内存态分叉 | §2.4 | 调度队列/Actor/意识流两份，互不可见；同一任务可能被两边各自处理 |
| **中** | 组合根注入缺失 | §2.6 | MCP 侧 DRE 缺云降级/幻觉门/裁决落库，行为与 host 侧不一致 |
| **潜在** | 未来同进程双 Engine | §2.2 推论 | 一旦把 MCP 嵌入主进程，同一进程两 Engine 抢一库 |
| **澄清（不夸大）** | "数据损坏" | WAL 已启用 | WAL 下多进程写**不会**静默损坏文件；真实故障是"写失败/状态不一致"，非损坏 |

## 四、收敛方案

| | 方案 A：单写者 + 远程端口（目标态） | 方案 B：共享内核工厂 + 止血（最小） | 方案 C：同进程合并 |
|---|---|---|---|
| 做法 | 指定**唯一** DRE Kernel 拥有者（建议 `main.ts`）；其它入口不建 Kernel，经 `POST /api/port`（复用 `src/dre/port`）访问 | 抽 `createDreKernel(opts)` 共享工厂，两处都走它；补 busy_timeout + busy 重试 | MCP 不再独立进程，或并入 main |
| 内存态 | **单份** | 仍两份（未解决分叉） | 单份 |
| 多进程写库 | 消除（单写者） | 缓解（加 busy_timeout，仍双写） | 消除 |
| 装配一致性 | 一致 | 一致 | 一致 |
| 改动面 | 中（需补 `/api/port` 服务端 + MCP 侧改写者） | 小 | 大（动部署与 MCP 协议） |
| 回滚 | 恢复 MCP 侧自建 Kernel | revert 工厂与 pragma | 恢复独立进程 |
| 一致性 | 与"数据链透明高效"一致 | 止血，不达目标 | 一致但破坏 MCP 独立部署 |

## 五、推荐分期（每 Step 单独立契约）

> **执行进度（2026-10-08）**：
> - **Step 0 止血 ✅**（`48734e6f`）：新增 `src/utils/sqlite-pragmas.ts`，四个主库连接统一 WAL+busy_timeout；漂移门禁可证伪。
> - **Step 1 共享工厂 ✅**（`2e82992e`）：新增 `src/dre/factory.ts`（`createDreKernel`），host/dre-tools 统一装配。
> - **Step 2a Daemon 落地 ✅**（本次）：`src/daemon/dre-daemon.ts`（唯一 Kernel 拥有者 + HTTP 面：/health、/dre/status、/dre/cognitive-state、/api/port、/dre/run、/events）+ `src/daemon/client.ts` + `deploy/systemd/axiom-dre@.service`；集成测试 9/9。
> - **Step 2b 客户端切换（待做）**：`main.ts`、`routes/dre.ts`、`routes/pipeline.ts`、`mcp/server/dre-tools.ts` 改为经 daemon 客户端访问，并移除各自的内核构造；此步需回归 `e2e-runtime` / 冒烟，单独提交。
> - 用户裁定：①唯一拥有者 = DRE daemon；②MCP 侧 DRE 工具 = 代理到 daemon；③做 Step 0+1+2。



- **Step 0 — 止血（P0，可先行）**：给 `sqlite-backend.ts` / `knowledge/store.ts` / `sqlite-memory.ts` / `mcp/server.ts` 的库连接补 `PRAGMA busy_timeout=5000`；写路径遇 `SQLITE_BUSY` 重试。**不改语义**，只加防线。验收：定向测试 + 两进程并发写冒烟无 SQLITE_BUSY。
- **Step 1 — 消装配分叉（P1）**：抽共享 `createDreKernel(opts)`，`host.ts` 与 `dre-tools.ts` 都走它；明确 MCP 侧是否需要 `cloudCaller` 等注入（需要则补，不需要则文档点名）。
- **Step 2 — 单写者（P1/T3，目标态）**：选定唯一 Kernel 拥有者，落地 `POST /api/port` 服务端，MCP 侧 DRE 工具改为经端口访问；`src/dre/port` 从"备而未用"转正。

## 六、待用户裁定

1. **唯一拥有者选谁**：`main.ts`（http 进程）／`mcp/server.ts`／独立的 DRE daemon？
2. **MCP 侧 DRE 工具的定位**：代理到拥有者（读写皆转发）／只读降级／保留本地 Kernel 但独立 `DRE_DB_PATH`？
3. **本轮做到哪一步**：只做 Step 0 止血，还是 Step 0+1，或直接冲 Step 2？

## 七、不做项

- 不在本轮改任何运行时代码（评估性质）；
- 不删除、不改写任何已推送历史；
- 不引入新依赖（端口协议已在库内）。

## 八、验证命令

```
bun test tests/doc-contract.test.ts
bun test tests/unit/docs-consistency.test.ts
# 事实基线复现
grep -rn "new Kernel(" src/ --include=*.ts
grep -rn "PRAGMA busy_timeout" src/ --include=*.ts
grep -n "paths.mcp\|spawn(\"bun\"" src/launcher.ts
```
