# ADR-012：内核边界、外围组件与统一 API 契约（版本化）

- 状态：接受（2026-10-08）
- 背景任务：内核收敛（唯一 Kernel 拥有者 = DRE daemon）收口后，用户要求「整体做减法：关键部分才进核心，其余都是外围组件；预留后续接口/功能的适配位；对内核与外围的耦合/内聚建立统一 API 管理，防止更新把外围打挂」。
- 关联：`docs/superpowers/plans/2026-10-08-kernel-consolidation.md`（内核收敛四步）；`src/dre/port/`（既有端口协议）；`src/runtime/`（RuntimeHost/AgentAdapter）。

## 1. 决策（一句话）

Axiom 分为**三层**：**核心（Core）**、**契约（Contract）**、**外围（Periphery）**。核心只保留不可替换的确定性推理内核；一切外部能力经**唯一版本化契约面**接入；外围只依赖契约，不依赖核心内部结构。契约面**只增不改**，破坏性变更必须走主版本号并保留兼容期。

## 2. 分层与准入

| 层 | 内容 | 准入判据（"删掉测试"） |
|---|---|---|
| **Core 核心** | DRE Kernel/Engine、各 runtime 单例（scheduler/eventBus/worldState/…）、KnowledgeStore/真相存储、约束/验证/推理引擎 | 删掉它，**确定性推理与真相存储**是否不成立？是→入核心 |
| **Contract 契约** | `src/dre/port`（KnowledgePort）、DRE daemon HTTP 面（`/api/port`、`/dre/run`、`/dre/tool`、`/dre/status`、`/events`、`/version`）、`RuntimeHost`/`AgentAdapter` | 是"核心↔外围"的**唯一**穿越面；核心内部符号不得直接暴露给外围 |
| **Periphery 外围** | MCP 工具（`src/mcp`）、数据采集（Wind/AkShare/OCR/crawl）、CLI/TUI、前端、插件（`src/plugins`、`plugins/`）、agents/self-evolve | 删掉它，核心**仍可独立运行**（有降级路径） |

**减法定则**：候选内容默认进**外围**；只有在"删掉它核心不成立"时才升入核心。升核心需本 ADR 的修订或新 ADR。

## 3. 统一 API 管理（防外围被更新打挂）

### 3.1 唯一契约面
外围**只能**通过契约层与核心交互：
- **进程内**：`src/dre/port` 的 `KnowledgePort` 接口（`LocalKnowledgePort` 进程内 / `RemoteKnowledgePort` HTTP）。
- **跨进程**：DRE daemon 的 HTTP 面。契约版本由 `GET /version` 返回（`src/daemon/contract.ts` 的 `DRE_DAEMON_CONTRACT_VERSION`）。

**禁止**：外围直接 import 核心内部模块（如 `src/dre/engine.ts` 的内部方法、`src/dre/runtime/*` 单例）。这类耦合正是历史上"多套内核 + 外围随内核改而崩"的根因。

### 3.2 版本与兼容规则（semver）
- 契约版本 `MAJOR.MINOR.PATCH`：
  - **PATCH**：修 bug，不改变入参/出参形状；
  - **MINOR**：**只增**——新增方法/字段/端点，旧客户端不受影响；
  - **MAJOR**：破坏性变更，必须**保留旧面 ≥1 个发布周期**（双写/双读），并在 `GET /version` 声明 `deprecated`。
- **响应向前兼容**：外围**必须忽略未知字段**（不得因多出字段而崩溃）；核心**不得**删除/改名既有字段（MINOR 内）。
- **能力协商**：外围启动时可选调 `GET /version` 读取 `contractVersion` 与 `capabilities`，据此决定可用功能；核心不支持某能力时返回结构化错误码（不抛未处理异常）。

### 3.3 错误与降级契约
- 契约层错误统一为结构化对象（`{ code, message, retriable }`，见 `src/dre/port/types.ts` 的 `PortError`）。
- 外围对核心不可达**必须优雅降级**（如主服务 daemon 不可达时禁用 DRE 能力而非崩溃；已有实现见 `src/dre/host.ts` + `src/daemon/host.ts`）。

## 4. 预留的扩展位（后续新接口/功能在此适配，不改核心）

| 扩展点 | 位置 | 用途 |
|---|---|---|
| 新知识/数据源 | `src/dre/port` 新方法（MINOR 增）或 daemon 新端点 | 采集接入不碰核心 |
| 新 Agent / 外部 Agent | `src/runtime/types.ts` 的 `AgentAdapter`；后续经 `RuntimeHost` 或 daemon 端点 | 第三方 Agent 走接口，不改内核 |
| 新 MCP 工具 | `src/mcp/server/*-tools.ts` | 纯外围，经契约调用核心 |
| 新插件 | `src/plugins/` + `plugins/` | 独立进程/打包，走 MCP 或 HTTP |
| 契约新增能力 | `src/daemon/contract.ts` 的 `capabilities` 名单 + `GET /version` | 机器可读的能力发现 |

**约定**：任何"新增接口/功能"的实现都落在上表位置之一；**不得**以"顺手改核心内部"的方式接入。

## 5. 强制与验证

- `tests/architecture-integrity.test.ts`：顶层目录不得互相 import（循环）；`src/dre` 不得引用上层 `router`/`crawl`。
- `tests/unit/docs-consistency.test.ts` 的 L1 依赖方向门 + 本 ADR 的分层口径。
- 契约版本一致性：`src/daemon/contract.ts` 的常量与 `GET /version` 实测一致（见 `tests/unit/dre-daemon.test.ts`）。
- **§3.1 边界门禁**：`tests/unit/periphery-core-boundary.test.ts`（棘轮）+ `config/periphery-core-boundary-baseline.json`——扫描外围目录是否 import 核心内部（仅放行契约面 `src/dre/port/**`、`src/dre/host.ts`）；存量在册、新增即红、陈旧在册项亦红（可下调）。

## 6. 后果

- **正**：核心可独立演进；外围只依赖稳定契约，更新核心不再直接打挂外围；新能力有固定适配位，边界不再漂移。
- **负**：外围访问核心需多一层（进程内 Port / 跨进程 HTTP），有少量序列化/调用开销；破坏性变更受兼容期约束、成本更高。
- **风险**：若外围绕过契约直连核心内部，本 ADR 失效——由 §5 的门禁与代码评审守住。

## 7. 待办（后续增量）

1. 把主服务/MCP 的其余核心访问逐步收敛到契约面（当前 DRE 已收敛；其余模块渐进）。
2. `GET /version` 的 `capabilities` 从"静态清单"升级为按 runtime 实况生成。
3. ✅ **已完成（2026-10-08）**：`tests/unit/periphery-core-boundary.test.ts` + `config/periphery-core-boundary-baseline.json`——扫描外围是否 import 核心内部（棘轮：存量在册 5 文件 / 9 处，只拦增量，陈旧在册项亦红）。
