# 后端架构审核报告 — 2026-08-11

> 审核范围：`D:\openclaw-fusion\src`（后端）
> 审核方式：只读代码审查 + 架构护栏测试静态分析（`tests/architecture-integrity.test.ts`）
> 审核框架：architecture / code-review / nodejs-backend-patterns / performance 四个 skill
> 声明：本报告基于静态阅读与依赖图分析；未运行测试（遵守只读约束）。标注 `事实 / 推测 / 判断`。

## 一、摘要

整体评价：**架构质量在同类本地优先 AI 网关项目中属于上乘**。存在一套 22 项架构护栏测试（依赖方向、循环、文件规模、类型纪律、性能微基准），router 统一执行端口是优秀的深模块范例，错误降级文化普及，凭据安全处理到位（全仓库扫描零硬编码密钥命中）。

但存在 **3 个 P1 级真实问题**：① 模型输出磁盘无限增长（`purgeOld` 无调用方）；② skill 自动提升的幂等逻辑失效导致重复 skill 无限累积（`Date.now()` 后缀使 `has(id)` 恒 false）；③ 自定义模型配置（`POST /models`）写入的 `data/model-config.json` **从未被路由层消费**——"用户自己配置 key 和模型链接"目前只实现了一半。另有若干 P2（services 层触顶 8 目录上限导致架构变形、流式工具循环半途失败内容重复、工具循环无 token 预算、定时器未全部纳入优雅停机、模型输出写队列无界等）。

## 二、架构优点

1. **护栏测试体系强**（`tests/architecture-integrity.test.ts`，22 项）：覆盖 utils 叶子层、memory 依赖边界、8 目录导入上限（mcp/routes/agents 豁免）、循环依赖、文件行数（白名单豁免）、`as any`/`: any`/`@ts-ignore` 上限、console 直出、裸 throw、utils 导出函数返回类型、Cache/Thompson/Pipeline 微基准。架构决策通过测试固化成纪律。`事实`
2. **router 深模块**（`src/router/model-router.ts` 1043 行，豁免上限内）：统一 `execute()` 端口集中处理 fallback 链、熔断器、永久失败黑名单（5min TTL）、指数退避+抖动（≤5s）、token 追踪、输出落盘、确定性缓存（temp=0）；`chatStream` 原生流 + 缓冲回退双路径设计意图清晰，SSE 事件序列保证 `start → (token*|error) → done`。`事实`
3. **错误降级文化普及**：self-thought、自适应知识检索、skill 提升、consciousness 反射、orchestrator self-improve 全部非阻断（外层 try/catch + fallback），主链路不会因边缘能力失败而中断。`事实`
4. **凭据与配置安全**：`utils/api-key-store.ts` 支持运行时覆盖（runtime > env > 默认），持久化走加密（`api-key-persistence.ts`，未配置加密密钥时告警）；`routes/models.ts` 返回脱敏（仅末 4 位）；`core/config-center.ts` schema 驱动（Runtime > ENV > YAML > Default）；全仓库 `sk-*`/`AKIA*`/`ghp_*`/私钥模式扫描 **0 命中**。`事实`
5. **self-evolve 模块符合规则 8**：小接口（selfThink/selfImprove/selfInduce/estimateConfidence）、依赖全部注入、确定性归纳/精算可测试，与 consciousness 集成无侵入。`事实`
6. **优雅停机框架**：`registerShutdownHook` 优先级化覆盖 health-monitor / file-watcher / consciousness / vault / db / http-server / plugins / native-bridge / MCP clients / PTY。`事实`
7. **services 层作为 cycle-breaker** 的 re-export 思路（router↔agents 环被 services 打破）有效，护栏测试保证无新环。`事实`

## 三、架构风险清单

### P1（必须修复）

#### P1-1 模型输出落盘无限增长，`purgeOld` 无调用方
- 位置：`src/utils/model-output-store.ts:210`（定义 `purgeOld`），`src/router/model-router.ts:263`（每次成功调用 persist）
- 问题：每次模型调用写一个 JSON 到 `data/model-outputs/YYYY-MM-DD/`，`purgeOld(maxAgeDays)` 存在但 **全仓库无任何调用**；`src/cron/scheduler.ts` 的每日 cleanupTask 只清 search_history / crawl_results，不含 model-outputs、token-usage.db、llm-cache.db。`事实`
- 影响：长期运行磁盘持续增长直至耗尽；dev/test 环境反复调用加速放大。
- 建议：在 `cron/scheduler.ts` cleanupTask 与启动时各调一次 `getModelOutputStore().purgeOld(30)`；保留天数配置化（如 `MODEL_OUTPUT_RETENTION_DAYS`）。

#### P1-2 skill 自动提升幂等失效 → 重复 skill 无限累积
- 位置：`src/self-evolve/skill-promotion.ts:70-73`
- 问题：`const id = \`${base}-${Date.now().toString(36).slice(-4)}\`; if (deps.has(id)) continue;` —— id 每次带新时间后缀，`has(id)` 对同一模式的重复提升**恒为 false**，幂等检查形同虚设。每个反射周期若归纳出相同模式，都会生成一个全新 skill 并持久化一个 JSON 文件到 `axiom-memory/03-Resources/skills/`。`事实`
- 影响：SkillRegistry 与磁盘文件无限累积重复 skill；`skill_list` 被污染；与"简约"主基调相悖。
- 建议：id 用 `stableHash(pattern)` 或固定 `auto-induce-<slug>`，查重用 `has(base)`（存在则覆盖更新而非跳过）；补一个幂等测试（同模式两次 promote 只产生一个 id）。

#### P1-3 自定义模型配置写死且不生效（与用户需求#3 直接冲突）
- 位置：`src/routes/models.ts:8`（CONFIG_PATH）、`src/router/models/registry.ts`（UNIFIED_REGISTRY 硬编码）、`src/router/models/providers.ts`
- 问题：`POST /models` 把用户自定义模型（含 baseURL/apiKey）写入 `./data/model-config.json`，但**路由层从不读取该文件**（grep 确认唯一引用在 routes/models.ts 自身）。路由只认硬编码 `UNIFIED_REGISTRY` + 内存 `EXTENSIONS`（仅 dynamic-model-assigner 用 eval 结果注册）。`事实`
- 影响：用户在 UI 添加的模型/链接不会参与路由——功能是"假完成"；用户需求"模板用户自己配置 key 和模型的链接"只实现了一半（key 通过 env / api-key-store 可配，模型与链接不可配）。
- 建议（二选一）：(a) 启动/运行时加载 `model-config.json` → `registerModel()` 接入 `EXTENSIONS`（推荐，闭环用户需求）；(b) 若暂不做，删除该端点或明确标注"仅展示"。同时给 `providers.ts` 提供通用 `${PROVIDER}_BASE_URL` 环境变量覆盖（目前仅 minimax 支持 `MINIMAX_BASE_URL`，不一致）。

#### P1-4 `executeWithRole` 失败模式不一致 + endpoint 与执行模型可能错位
- 位置：`src/router/model-router.ts:940-975`（executeWithRole）
- 问题：先 `await this.execute(...)`（全部失败时**返回** degraded，不抛错），随后 `const assignment = this.assign(role, ...)`——`assign()` 在无模型时**throw**（model-router.ts:930 `if (!result) throw`）。即角色无可用模型时 executeWithRole 反而抛异常，调用方（tool-loop、skill-registry.execute、reflection-loop）若未捕获则整条链路失败，与 execute() 的降级语义矛盾。另外 `endpoint` 取自 `assignment.model`（按原配置分配），而 `model/provider` 取自 `out`（fallback 后的实际模型），**fallback 后 endpoint 可能报告错误的 provider**。`事实`
- 影响：edge case 下聊天/技能执行崩溃而非优雅降级；观测/成本统计错位。
- 建议：`assign` 失败时用 `out` 的 model/provider 反查 PROVIDER_CONFIG 计算 endpoint（或直接 `PROVIDER_CONFIG[out.provider]?.baseURL`），并让无模型场景返回 degraded 结果而不是 throw。

### P2（应尽快修复）

#### P2-1 services 层触顶 8 目录上限，新增能力被迫绕道 routes
- 位置：`src/services/*`（依赖 components/agents/utils/crawl/memory/router/knowledge/tools 恰好 8 个）、`src/routes/chat.ts`、`src/routes/openai-compat.ts`
- 问题：本次 self-evolve/skill 接线为不破坏上限，把跨切面注入放在 routes 层（routes 已 19 目录且被豁免），routes/chat.ts 同时 import services、router、self-evolve、mcp、utils——**routes 正在成为"杂物间"**；且 `NATIVE_SKILL_TOOLS` 在 routes/chat.ts 与 openai-compat.ts **重复定义**。`事实`
- 影响：约束本意是防膨胀，实际诱导绕路，可维护性下降；未来任何新跨切面依赖都会继续堆进 routes。
- 建议：把 services 正式定位为"业务编排层"并提高其上限（如 12），将 self-evolve/skills 收编进 services；或至少抽出 `NATIVE_SKILL_TOOLS` 共享模块消除重复。

#### P2-2 流式工具调用半途失败 → 客户端收到重复内容
- 位置：`src/router/model-router.ts` chatStream native 路径（约 660-690）
- 问题：原生流已 yield 部分 token 后失败 → catch 静默进入 `fallbackBufferedStream()` → 整段内容再作为一个 token yield。客户端会收到"半截内容 + 完整内容"的重复文本。`事实`
- 影响：流式体验严重失真（用户需求强调"丝滑切换"）。
- 建议：原生流已产出 token 时失败 → 发 `error` 事件并终止；仅当**未产出任何 token** 时才回退缓冲。

#### P2-3 工具循环无 token 预算 + 超轮结果未标记
- 位置：`src/services/tool-loop.ts`、`src/router/model-router.ts` chatStream toolLoop
- 问题：每轮追加 assistant(tool_calls)+N 个 tool 消息，最多 4 轮但无累计 token/字节预算；大工具输出可撑爆上下文。`runToolLoop` 超轮后返回 `lastResponse`（可能仍含 tool_calls），调用方/客户端无法区分"完成"与"耗尽"。`事实`
- 影响：上下文溢出导致 provider 报错；客户端可能收到无最终答案的 tool_calls 响应。
- 建议：累计 tool 消息字节数/估算 token，超限即终止返回明确提示；超轮返回增加 `toolLoopExhausted: true` 标记。

#### P2-4 类型纪律风险点
- 位置：`src/services/tool-loop.ts:45`（`role as TaskRole`）、`src/routes/chat.ts` `VALID_TASK_TYPES`（手抄 TaskRole 列表）、`src/router/model-router.ts:397/451`（`taskType as TaskRole`）、`src/db/pg-client.ts:8`（`getPG(): any`）
- 问题：`VALID_TASK_TYPES` 是 TaskRole 的**手工镜像**，registry 新增角色后必然漂移；tool-loop 的 role 参数应直接类型化为 TaskRole；pg-client 是 stub（throw），占用了 `any` 名额。
- 建议：`VALID_TASK_TYPES` 从 `TaskRole`/registry 派生；tool-loop 签名收紧；pg-client 标记 deprecated 或移除。

#### P2-5 self-evolve 默认 store 的 lessons Map 无上限
- 位置：`src/self-evolve/index.ts` createDefaultStore（`lessons = new Map`）
- 问题：每次成功 selfImprove 写入一条教训，内存 Map 与 vault 文件均无限增长（traces 有 500 上限，lessons 没有）。`事实`
- 影响：长跑内存/磁盘缓慢增长。
- 建议：与 traces 一致设上限（如 500，LRU）；vault 侧按日期/数量保留策略。

#### P2-6 定时器/资源未全部纳入优雅停机
- 位置：`src/main.ts:751-763`（shutdown hooks）、`src/utils/cache.ts` scheduleCleanup、`src/utils/vault-stats-cache.ts`（main.ts:357 init 但未注册 stop）、`src/router/token-tracker.ts`、`src/memory/blackboard.ts`
- 问题：llmCache/searchCache/crawlCache 的 5min 清理定时器、blackboard 清扫、token-tracker 批量 flush、vaultStatsCache 刷新定时器均无 shutdown 清理注册；vaultStatsCache 的 timer 虽 unref 了，其余未 unref。`事实`
- 影响：dev/test 反复重启时定时器引用泄漏；进程退出可能被拖住（Bun 下影响小，但纪律缺失）。
- 建议：在 shutdown hooks 注册 `cache.destroy()` / `tokenTracker.close()` / `blackboard.stop()` / `vaultStatsCache.stop()`。

#### P2-7 ModelOutputStore.writeQueue 无界 promise 链
- 位置：`src/utils/model-output-store.ts:160-166`
- 问题：每次 persist 追加一个 promise，串行化写入；若磁盘慢，队列无限增长，每条闭包持有完整 messages。`事实`
- 影响：高并发下内存增长。
- 建议：有界队列（如最大 1000，超出丢弃并计数）或批量合并写入。

#### P2-8 工具循环存在两份实现
- 位置：`src/services/tool-loop.ts` vs `src/router/model-router.ts` chatStream 内联循环（`parseToolArgs` 在 model-router.ts 与 tool-loop.ts 重复定义）
- 问题：非流式与流式各一套工具循环逻辑，易漂移（已见细微差异：流式多了 tool 事件、rounds 语义不同）。`事实`
- 影响：修 bug 需改两处。
- 建议：抽公共 helper（执行工具 + 组装 tool 消息 + 预算检查）供两处复用。

### P3（低优先级）

- P3-1 `utils/cache.ts` get() 的 L2 Redis 回填直接 `this.store.set`（不经过 evict），Redis 启用时 L1 可略超 maxSize；清理定时器仅在 persistent 时调度。`事实`
- P3-2 `llmCacheKey` 对全量 messages 做 SHA-256 序列化（temp=0 路径），大上下文时开销可观；key 不含 tool_calls 字段，工具消息场景有理论碰撞。`事实`
- P3-3 `chatStream` trackCall 使用原始 `messages` 而非 `working`，工具轮 token 统计偏低。`事实`

### 架构护栏盲区（`tests/architecture-integrity.test.ts`）
- 只统计**顶层目录** import 数；子目录级循环/耦合（如 agents/a ↔ agents/b）不检测。`判断`
- 8 目录上限只对非豁免目录生效，而豁免名单（mcp/routes/agents）恰是膨胀最快的三处——护栏保护面在收缩。`判断`
- 无"磁盘/内存无界增长"类护栏（P1-1、P1-2、P2-5 全部在护栏外）。`事实`
- 无"死配置/无效端点"检测（model-config.json 无消费者不被发现）。`事实`
- 性能测试是微基准（Cache/Thompson/Pipeline），不覆盖端到端延迟、内存峰值、SSE 正确性。`事实`
- `as unknown as X` 双转型不在 `as any` 统计内。`事实`

## 四、与工程实践 skill 基准的差距

| 基准（nodejs-backend-patterns） | 现状 | 差距 |
|---|---|---|
| 自定义错误类 | 有 toAxiomError | 基本达标 |
| 输入校验（Zod 等） | chat 消息校验有；`POST /models` 仅必填校验，baseURL 未校验 URL 格式 | 部分 |
| 环境变量管理 | env.ts + config-center 强 | 达标 |
| 结构化日志 | logger 统一 | 达标 |
| 限流 | 有 rate limiter（router） | 达标 |
| 优雅停机 | 主资源覆盖，cache/token/blackboard/vaultStatsCache 缺失 | 部分（P2-6） |
| 连接池 | SQLite 直连（bun:sqlite 单连接）；pg stub | 按设计 |
| 健康检查 | health-checker + cron | 达标 |
| 监控 | metrics 计数/直方图 + PBT 微基准 | 缺端到端/内存监控 |

| 基准（performance skill） | 现状 | 差距 |
|---|---|---|
| 先测量再优化 | 有微基准测试 | 无真实流量剖析 |
| 内存泄漏/无界增长治理 | 多处 Map 有上限（traces 500、blackboard 2000、codegraph 500、Cache LRU） | 仍有 P1-1/P1-2/P2-5/P2-7 无界点 |

| 基准（architecture skill） | 现状 | 差距 |
|---|---|---|
| SRP | routes/chat.ts 三个 handler 重复同一管线（prepare+applySelfThought+tool wiring） | DRY/SRP 弱 |
| 依赖注入 | self-evolve 好；tool-loop 直接 import router 单例（不可测） | 部分 |
| 深模块 | router/execute、circuit-breaker 是范例 | 达标 |

## 五、建议的下一步（≤5 条，按性价比排序）

1. **修 P1-2 skill 提升幂等 bug**：id 去掉时间后缀 + 按 base 查重，补幂等测试。一行级改动，立即消除无限累积。
2. **接 P1-1 磁盘清理**：`cron/scheduler.ts` cleanupTask 与启动时各调一次 `getModelOutputStore().purgeOld(30)`；保留天数配置化。
3. **闭环 P1-3 自定义模型**：启动/运行时加载 `model-config.json` → `registerModel()` 接入 EXTENSIONS；providers.ts 加通用 `${PROVIDER}_BASE_URL` 覆盖。这是用户需求#3 的核心完成项。
4. **统一工具循环 + token 预算**：抽公共 helper 供 services/tool-loop 与 chatStream 复用，加累计预算与 `toolLoopExhausted` 标记；顺带修 P2-2（native 半途失败发 error 而非重复内容）。
5. **补齐优雅停机**：cache/token-tracker/blackboard/vaultStatsCache 的 stop/destroy 注册进 shutdown hooks；`VALID_TASK_TYPES` 改为从 TaskRole 派生。

> 备注：本报告未修改任何代码、未做任何 git 操作。风险项均附 文件:行号 与 建议，可直接转为修复任务。
