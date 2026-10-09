# ADR-013：内核 / 外围分域准则（性能取向入核）

- 状态：接受（2026-10-09）
- 背景任务：在 ADR-012（内核边界与统一 API 契约）之上扩大范围——按**使用场景与调用密度**把功能拆成"性能取向入内核 / 其余用外围构建"，把握耦合与内聚。
- 关联：`docs/decisions/ADR-012-kernel-boundary-and-api-contract.md`（契约面与边界门）。

## 1. 决策（一句话）

按**三维判据**（频率 × 规模 × 延迟敏感）给每个能力定位：**在线同步路径 + 高频 + （大 N 或延迟敏感）+ 确定性/共享状态 ⇒ 内核**；**I/O 密集、可选、边缘、后台、可独立伸缩 ⇒ 外围**。依赖方向恒为 **外围 → 内核**（外围经 ADR-012 契约面访问内核；内核**不得**依赖外围）。

## 2. 判据与证据来源

- **频率**：调用密度。证据 = 运行时用量库（`data/token-usage.db`、`data/agent.db`）+ 代码扇入（被 import 的文件数）+ 在线路径追踪。
- **规模**：单次处理的数据量 N。
- **延迟**：是否在**在线同步路径**（每请求/每工具调用必经）还是后台。

## 3. 实测证据（2026-10-09）

| 维度 | 事实 |
|---|---|
| 最热在线操作 | **模型调用**：`token_usage` **12,022** 行（`gpt-5.4-pro` 6,943 / `claude-opus` 3,880 次）⇒ `router` 路由/缓存是每调用必经 |
| 最大规模数据 | **代码索引**：`code_calls` **75,479** / `code_symbols` **16,615** ⇒ codeindex 是大 N 子系统 |
| 记忆/知识面 | `memory_notes` 242、`knowledge_embeddings` 245、`knowledge_sources` 280、`search_history` 71 |
| 代码扇入（结构） | `utils` 238、`memory` 35、`router` 26、`dre` 21、`services` 20、`agents` 19、`crawl` 18 |
| 在线 chat 主路径 | `services/chat.ts` → `router/model-router`、`components/context-assembler`、`agents/*`、`memory/*`、`services/tool-loop`、`services/chat-preflight` |
| 内核→外围依赖 | 仅 **4 处**（见 §6 在册） |

## 4. 分域矩阵（按证据）

| 能力 | 使用场景 | 频率 | 规模 | 延迟 | 归属 | 依据 |
|---|---|---|---|---|---|---|
| 模型路由决策 + 响应缓存（`router/model-router` 决策/缓存段） | 每次 LLM 调用 | 极高 | O(1) | 在线敏感 | **内核** | 最热路径（12k），确定性决策 |
| 上下文装配 + Token 预算（`components/context-assembler`/`token-budget`） | 每次 chat | 高 | O(消息数) | 在线敏感 | **内核** | 每请求必经 |
| 确定性检索（`dre/retrieval`、`memory/deterministic-search`） | 每次 search | 中高 | O(语料) | 在线敏感 | **内核** | 大 N + 在线 |
| 知识写入/三段甄别（`dre/pipeline`、`knowledge`） | 每次写入 | 中 | O(1) | 在线 | **内核** | 真相存储 |
| 向量索引**写入**（`knowledge_embeddings`） | 写入/扫描 | 中 | O(N) 批 | 后台 | **内核（索引）/外围（生成）** | 索引聚内核；嵌入生成 = I/O |
| 嵌入**生成**（provider/本地服务） | 写入/扫描 | 中 | O(N) | 后台 I/O | **外围** | 网络/模型 I/O，可独立伸缩 |
| 采集/爬取（`crawl`） | 采集 | 低 | 大 | 后台 | **外围** | 可选、I/O 密集 |
| OCR / 文档摄取 | 摄取 | 低 | 大 | 后台 | **外围** | 可选、重 I/O |
| 代码索引**生成**（AST→SQLite，`codeindex`） | 索引构建 | 中 | 极大(75k) | 后台 | **外围** | 大 N 但后台、可重建 |
| 代码索引**查询**（在线检索） | 代码检索 | 中 | O(索引) | 在线 | **内核（查询 API）/外围（构建）** | 查询热路径 |
| Provider 客户端（`router/provider-caller` 网络段） | 每次 LLM | 高 | O(1) | I/O | **外围** | 纯网络 I/O |
| CLI / TUI / Plugins | 交互/扩展 | 低 | — | — | **外围** | 边缘、可插拔 |

**内聚原则**：一个能力若"一半热、一半冷"，按**运行时接缝**切开——热段（决策/索引/查询）入内核并与核心同侧内聚；冷段（网络/生成/采集/构建）留外围，经契约/端口交互。

## 5. 依赖方向

- **外围 → 内核**：仅经 ADR-012 契约面（`src/dre/port`、`src/dre/host`、daemon HTTP）。由 `tests/unit/periphery-core-boundary.test.ts` 守护（基线已清零）。
- **内核 → 外围**：**禁止**（依赖倒置）。由 `tests/unit/kernel-periphery-boundary.test.ts` 守护。

内核集（当前定义）：`dre`、`memory`、`router`、`kal`、`kg`、`components`。
外围集：`ocr`、`crawl`、`plugins`、`tui`、`cli`、`computer-use`、`pi-agent`、`self-evolve`、`codeindex`、`eval`。

## 6. 内核→外围在册（棘轮基线 4，只拦增量）

| 文件 | 依赖外围 | 处置 |
|---|---|---|
| `src/dre/pipeline/search-port.ts` | `crawl/search-engines` | 已知例外（搜索端口，L1 门已豁免）——保留登记 |
| `src/memory/codegraph-index.ts` | `codeindex/local-index` | 待收敛：索引**查询 API** 内聚入核，构建留外围 |
| `src/router/dynamic-model-assigner.ts` | `eval/model-eval-service` | 待收敛：分配算法入核，评测数据源经端口 |
| `src/router/code-retrieval-router.ts` | `pi-agent/pi-agent-adapter` | 待收敛：检索决策入核，工具执行留外围 |

## 7. 待办（后续增量）

1. ✅ **已完成（2026-10-10）**：§6 的 3 处"内核→外围"已全部按接缝切开——① `router/code-retrieval-router→pi-agent`（`CodeContextRetriever` 注入）；② `router/dynamic-model-assigner→eval`（`ModelEvalProvider` 注入 + 结构类型）；③ `memory/codegraph-index→codeindex`（`CodeIndexPort` 注入 + 组合根 `installCodeIndexPort()`）。棘轮基线 **4 → 1**（仅留 `dre/pipeline/search-port→crawl` 已知例外）。
2. 把"内核集/外围集"的**成员变更**纳入本 ADR 修订（新增模块须归类）。
3. 在 `GET /version` 的 `runtime` 块里暴露**内核就绪度**（供外围判断热路径可用性），与 ADR-012 §7-2 一致。
