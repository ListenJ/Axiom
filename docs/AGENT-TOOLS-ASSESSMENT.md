# Agent 工具系统评估报告

> 评估对象：Axiom Runtime v4.0 的 Agent 工具系统
> 评估范围：`src/tools/`、`src/mcp/tool-registry.ts`、`src/router/thompson-router.ts`、`src/agents/`、`src/dre/runtime/scheduler.ts`、`src/dre/runtime/capability-registry.ts`
> 基准数据：`tests/perf-benchmark.test.ts`、`tests/stress/perf-gate.test.ts`、`tests/stress/multi-agent-stress.test.ts`
> 评估日期：2026-07-23

---

## 一、评估维度总览

| 维度 | 评级 | 评分 | 关键结论 |
|------|------|------|----------|
| 1. 工具集完整性 | B | 7/10 | 核心三件套（read/write/query）齐全，MCP 注册统一；缺失 execute/transform/compute 类工具，工具池仅 3 个实体 |
| 2. 功能性 | B+ | 8/10 | 管道编排完善（缓存优先/循环检测/超时/深度/重试），模型 token 与 compute 解耦清晰；缓存键仅对 query 工具生效是硬编码 |
| 3. 易用性 | A− | 8.5/10 | Tool 接口简洁（validate/execute/dispose），ToolContext 工厂完备；模块级单例统计非请求隔离，跨请求污染风险 |
| 4. 性能 | A | 9/10 | 关键内存操作均 < 10ms（实测提交 0.018ms/op、能力选择 0.0015ms/op），门禁全部通过；scheduler.submit 全量排序是潜在瓶颈 |
| 5. 可扩展性 | B+ | 8/10 | CapabilityRegistry 契约抽象 + 反向索引 O(k) 查找，添加 Provider 一行注册；ToolRegistry 双传输自动注册；添加新工具需手写 Tool 接口实现，无声明式注册 |

> 评级标准：A（9-10）优秀 / B+（8-8.5）良好 / B（7-7.5）合格 / C（6 以下）待改进。

---

## 二、模块清单与职责

| 模块 | 文件 | 核心职责 | 关键 API |
|------|------|----------|----------|
| 工具类型 | `src/tools/types.ts` | Tool 接口、ToolContext、循环检测、缓存统计、模型 token 追踪 | `Tool`、`createToolContext`、`detectLoop`、`normalizeQuery` |
| 工具管道 | `src/tools/pipeline.ts` | 缓存优先 + model token vs compute 区分的编排器 | `runPipeline` |
| Read 工具 | `src/tools/read-tool.ts` | 文件/网络/记忆库读取 | `readTool` |
| Write 工具 | `src/tools/write-tool.ts` | 文件/记忆库写入（自动建目录、追加/覆盖） | `writeTool` |
| Query 工具 | `src/tools/query-tool.ts` | 本地+KG+网络自适应搜索 | `queryTool` |
| MCP 注册器 | `src/mcp/tool-registry.ts` | stdio+HTTP 双传输统一注册、标签过滤 | `ToolRegistry`、`createRegistry` |
| 路由器 | `src/router/thompson-router.ts` | 上下文 Thompson Sampling 模型路由 | `ThompsonRouter`、`route`、`reportFeedback` |
| 调度器 | `src/dre/runtime/scheduler.ts` | 优先级队列 + 资源预算 + 抢占 + 退避 + 截止 | `scheduler`、`submit`、`getNext`、`complete`、`fail` |
| 能力注册表 | `src/dre/runtime/capability-registry.ts` | 契约抽象 + Provider 解耦 + 评分选择 | `capabilityRegistry`、`select`、`recordResult` |
| 编排器 | `src/agents/orchestrator.ts` | 多 Agent 注册/路由/分解/并行·串行·DAG | `AgentOrchestrator`、`executePlan` |

---

## 三、维度 1：工具集完整性

### 已覆盖能力

| 能力域 | 工具/模块 | 覆盖程度 |
|--------|-----------|----------|
| 文件读取 | `readTool` (source=file) | ✅ 完整（含 offset/limit、Vault 回退） |
| 网络抓取 | `readTool` (source=web) | ✅ 基础（带超时，无重试/编码探测） |
| 记忆检索 | `readTool` (source=memory) + `queryTool` (scope=knowledge) | ✅ 双通道 |
| 文件写入 | `writeTool` (target=file) | ✅ 完整（自动建目录、追加/覆盖、缓存失效） |
| 记忆写入 | `writeTool` (target=memory) | ✅ 完整 |
| 混合搜索 | `queryTool` (scope=auto) | ✅ 本地→KG→网络三级回退 |
| 模型路由 | `ThompsonRouter` | ✅ 完整（Beta 采样、衰减、持久化） |
| 任务调度 | `scheduler` | ✅ 完整（5 级优先级、抢占、退避、截止、依赖） |
| 能力选择 | `capabilityRegistry` | ✅ 完整（契约→Provider→评分） |
| 多 Agent 编排 | `AgentOrchestrator` | ✅ 完整（串/并/DAG + 分解 + 人工确认） |

### 缺失能力

| 缺失能力 | 影响 | 建议 |
|----------|------|------|
| 命令执行工具 | Agent 无法直接执行 shell/git/build 命令（当前依赖 `src/mcp/tools/terminal.ts`，未纳入 Tool 接口） | 新增 `executeTool` 实现 `Tool<ExecuteInput, ExecuteOutput>`，复用 sandbox 隔离 |
| 代码转换/变换工具 | 管道仅 read→query→write，无中间变换（如 JSON→Markdown、压缩、转码） | 新增 `transformTool` 作为管道中间步骤 |
| 计算/数学工具 | 无纯计算基元（如 expr 求值、hash、统计） | 新增 `computeTool`，consumesModelToken=false |
| 流式工具 | Tool.execute 返回 `Promise<ToolOutput>`，不支持流式输出 | 扩展 `Tool.execute` 返回 `AsyncIterable<ToolOutput>` |
| 工具发现/自描述 | 无 `tools/list` 端点动态暴露能力（MCP 协议有 tools/list，但 ToolRegistry 仅 `getToolsMeta`） | 接入 MCP `tools/list` 自动生成 schema |

---

## 四、维度 2：功能性

### 4.1 管道编排（pipeline.ts）

| 功能点 | 实现状态 | 评估 |
|--------|----------|------|
| 缓存优先 | ✅ 归一化 query 缓存，命中跳过执行 | 良好；但仅对 `tool.name === "query"` 写缓存（line 99 硬编码），其他工具无缓存写入 |
| 循环检测 | ✅ 60s 窗口内 >5 次同 key 调用告警 | 良好；recentCalls 为模块级 Map，无 TTL 清理（仅 clearLoopCache 全清） |
| 超时控制 | ✅ maxCpuMs 预算校验 | 良好；按 wall-clock 计算，不含 await IO 时间 |
| 深度限制 | ✅ maxDepth=10 防递归爆炸 | 良好 |
| Model token vs compute | ✅ consumesModelToken 标志 + trackModelTokens | 优秀；解耦清晰 |
| 错误处理 | ✅ try/catch 包裹，返回 error 字段 | 良好；但单步失败直接 return，无部分结果透传 |
| 并行步骤 | ❌ 仅串行 for 循环 | 待改进；独立步骤无依赖可并行 |

### 4.2 调度器（scheduler.ts）

| 功能点 | 实现状态 | 评估 |
|--------|----------|------|
| 优先级队列 | ✅ 5 级 + PRIORITY_ORDER 排序 | 良好；但 `submit` 每次 `queue.sort` 为 O(n log n)，大批量提交有放大效应 |
| 资源预算 | ✅ maxConcurrentTasks / maxTokensPerMinute / maxMemoryMB | 良好 |
| 抢占 | ✅ critical 等待时抢占 low/background，被抢占任务重排队（非丢弃） | 优秀；避免低优先级饿死 |
| 重试退避 | ✅ 指数退避 100ms×2^attempt，封顶 5s，notBefore 控制 | 优秀；语义与 LLMClient 一致 |
| 截止管理 | ✅ expirePendingTasks 自动 fail 过期任务 | 良好 |
| 依赖管理 | ✅ dependencies 数组，isReady 校验 completed 集合 | 合格；completed 为线性数组查找 O(n)，依赖多时退化 |

### 4.3 能力注册表（capability-registry.ts）

| 功能点 | 实现状态 | 评估 |
|--------|----------|------|
| 契约抽象 | ✅ 15 种 CapabilityContract 枚举 | 优秀；能力与 Provider 解耦 |
| 反向索引 | ✅ capabilitiesByContract Map，search O(k) | 优秀；近期优化（见 operations-log P2-2） |
| 评分模型 | ✅ cost 0.3 + latency 0.3 + reliability 0.4 | 良好；权重固定，无上下文感知 |
| EMA 可靠性 | ✅ recordResult 以 0.9/0.1 滑动更新 | 良好 |
| 选择计数 | ✅ select 仅 bump lastUsed，recordResult 才计数 | 优秀；避免空选计数 |
| 并发追踪 | ❌ maxConcurrency 字段存在但 select 不校验 | 待改进；无法基于实际并发做负载均衡 |

---

## 五、维度 3：易用性

### 5.1 API 设计

| 接口 | 易用性 | 示例 |
|------|--------|------|
| `Tool<I, O>` | ✅ 泛型清晰，validate 可选 | 实现 3 方法即可注册工具 |
| `createToolContext` | ✅ 工厂 + 默认值 | `createToolContext(reqId)` 一行创建 |
| `scheduler.submit` | ✅ Omit 自动补 id/status/createdAt | 调用方只需提供业务字段 |
| `capabilityRegistry.select` | ✅ 单参 + 可选 opts | `select("code.reasoning", {maxCost: 0})` |
| `ToolRegistry.add` | ✅ 链式 | `registry.add(t1).add(t2)` |

### 5.2 错误处理

| 模块 | 错误处理 | 评估 |
|------|----------|------|
| pipeline | try/catch + error 字段 + ProgressEvent(error) | ✅ 双通道（返回值 + 进度回调） |
| ToolRegistry | stdio 端 isError 标志 + HTTP 端包装对象 | ✅ 双传输一致 |
| scheduler | fail() 区分重试 vs 终态，eventBus 通知 | ✅ 完整 |
| readTool | 文件不存在回退 Vault，再失败抛错 | ✅ 优雅降级 |
| queryTool | 网络/KG 失败非致命，不阻塞 | ✅ 容错 |

### 5.3 待改进点

| 问题 | 位置 | 影响 |
|------|------|------|
| 模块级单例统计 | `types.ts` _modelTokenTracker / _cacheStats / recentCalls | 跨请求污染，测试需手动 clearLoopCache；建议改为 ToolContext 内或 per-registry 实例 |
| 缓存写入硬编码 | `pipeline.ts:99` `tool.name === "query"` | 其他工具无法享受缓存；建议工具声明 `cacheable: true` 标志 |
| validate 无 schema | `Tool.validate` 返回 string|null | 无结构化错误码；建议返回 `{code, message}` 或集成 Zod |
| ToolContext 局部可变 | `depth`/`aborted`/`modelCalled` 非只读 | 并发管道下需手动同步；当前管道串行故无碍 |

---

## 六、维度 4：性能

### 6.1 基准数据（perf-benchmark.test.ts + perf-gate.test.ts 门禁）

| 热路径 | 门禁阈值 | 实测达标 | 单次耗时 |
|--------|----------|----------|----------|
| Cache set+get ×10k | < 200ms | ✅ | < 0.02ms/op |
| ThompsonRouter.route ×1k | < 100ms | ✅ | < 0.1ms/route |
| ConstraintSolver.check ×10k | < 500ms | ✅ | < 0.05ms/check |
| EventBus.publish ×10k | < 50ms | ✅ | < 0.005ms/publish |
| ConfigCenter 读 ×10k | < 100ms | ✅ | < 0.01ms/read |
| normalizeQuery ×10k | < 100ms | ✅ | < 0.01ms/call |
| Scheduler 500 任务 | < 5000ms | ✅ | ~10ms/任务（含排序） |
| AtomEngine 5000 创建 | < 2000ms | ✅ | < 0.4ms/op |
| AtomEngine 5000 检索 | < 100ms | ✅ | < 0.02ms/op |
| KnowledgeNetwork 2000 实体+5000 链接 | < 3000ms | ✅ | — |
| ReasoningGraph 5000 节点 | < 3000ms | ✅ | — |
| Pipeline 空跑 ×10k | < 100ms | ✅ | < 0.01ms/run |

### 6.2 多 Agent 压测数据（multi-agent-stress.test.ts 实测）

| 场景 | 实测耗时 | 单次耗时 | 10ms 目标 |
|------|----------|----------|-----------|
| 10 Agent × 100 任务提交 | 18.58ms | 0.0186ms/submit | ✅ 达标（500× 余量） |
| 50 Agent × 100 select | 7.34ms | 0.0015ms/select | ✅ 达标（6600× 余量） |
| 100 Agent 资源竞争 | 0.23ms | — | ✅ 无崩溃 |
| 并发 register+select | 5.27ms | — | ✅ 无竞态损坏 |
| 错误隔离 | 0.34ms | — | ✅ 故障隔离 |
| 公平性（critical+low） | 0.21ms | — | ✅ 低优先级未饿死 |

### 6.3 极限基准（perf-benchmark.test.ts [perf-extreme]）

| 热路径 | 规模 | 实测 | 单次 |
|--------|------|------|------|
| Cache set+get | 100k | < 200ms | < 0.002ms |
| Cache LRU 抖动 | 10k 驱逐 | < 100ms | < 0.01ms |
| Cache 并发 getOrSet | 1000 并发 | factory 调用 1 次 | ✅ 单次计算 |
| Thompson route | 50k | < 500ms | < 0.01ms/route |
| ConstraintSolver check | 50k | < 500ms | < 0.01ms/check |
| Pipeline 空跑 | 10k | < 100ms | < 0.01ms/run |
| EventBus publish | 100k | < 50ms | < 0.0005ms |

**结论：所有关键内存操作（提交、选择、路由、检查、发布）单次耗时均在 0.1ms 量级或更低，10ms 目标已 100×~6600× 余量达成。LLM 调用（network IO）不在 10ms 范围内，符合预期。**

---

## 七、维度 5：可扩展性

### 7.1 添加新工具

| 扩展点 | 难度 | 步骤 |
|--------|------|------|
| 新增 Tool | 🟢 低 | 实现 `Tool<I, O>` 接口（name/description/consumesModelToken/execute） → 通过 `ToolRegistry.add` 或直接用于 `runPipeline` |
| 新增 MCP 工具 | 🟢 低 | 定义 `ToolDef`（含 Zod schema） → `createRegistry([def])` → `registerWithMcp` 自动双传输 |
| 新增能力契约 | 🟢 低 | 在 `CapabilityContract` 联合类型追加 → `registerProvider` 时声明 → 反向索引自动建立 |
| 新增 Provider | 🟢 低 | `registerProvider` 一行注册 → 能力自动生成 → select 立即可选 |
| 新增 Agent | 🟡 中 | 实现 `AgentInterface`（4 字段 + execute + healthCheck） → `registry.register` → 需在 TaskRouter.roleMapping 配置意图映射 |
| 新增路由臂 | 🟢 低 | `addArm` / 构造时传入 arms → TS 自动采样探索 |

### 7.2 扩展瓶颈

| 瓶颈 | 位置 | 影响 | 改进方向 |
|------|------|------|----------|
| scheduler 全量排序 | `scheduler.ts:105` `this.queue.sort(...)` | 每次提交 O(n log n)，1000 任务提交约 18ms | 改用二叉堆（插入 O(log n)，取顶 O(log n)） |
| 依赖检查线性扫描 | `scheduler.ts:202` `this.completed.some(...)` | 依赖任务多时退化 O(n) | 改用 Set 存储 completed.id，查找 O(1) |
| TaskRouter 首匹配 | `orchestrator.ts:202` `return capableAgents[0]` | 多 Agent 同能力时无负载均衡 | 接入 CapabilityRegistry 评分或轮询 |
| select 无并发感知 | `capability-registry.ts:178` | maxConcurrency 字段闲置 | 跟踪 in-flight 计数，select 时跳过满载 Provider |
| Thompson route O(n) | `thompson-router.ts:218` `for of arms` | 臂数多时线性 | 臂数通常 <10，可接受；超 100 臂可分组缓存 |
| 缓存键工具硬编码 | `pipeline.ts:99` | 仅 query 工具缓存 | 工具声明 `cacheable` + `cacheKeyFn` |

### 7.3 插件与扩展机制

- `src/plugins/plugin-registry.ts` 提供插件化扩展点
- `src/mcp/tools/` 下 15 个细分工具模块（filesystem/git/github/terminal/code-analysis 等）已存在但**未纳入 Tool 接口**，仅作为 MCP handler 暴露 → 存在两套工具体系（Tool 接口 vs MCP ToolDef），建议统一

---

## 八、性能优化方案（关键操作压缩至 10ms）

### 8.1 现状：10ms 目标已达成

基于 `tests/stress/multi-agent-stress.test.ts` 实测，关键操作单次耗时：

| 操作 | 单次耗时 | 10ms 余量 |
|------|----------|-----------|
| scheduler.submit | 0.0186ms | 537× |
| scheduler.getNext + complete | ~0.024ms | 416× |
| capabilityRegistry.select | 0.0015ms | 6666× |
| capabilityRegistry.search | < 0.01ms | 1000× |

**目标已超额达成。以下方案为进一步优化与防御性加固，应对未来规模增长。**

### 8.2 热路径瓶颈分析与优化

#### 瓶颈 1：scheduler.submit 全量排序（O(n log n)）

**位置**：`src/dre/runtime/scheduler.ts:105`
```ts
this.queue.push(fullTask);
this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
```

**影响**：n=1000 时单次排序约 0.02ms，累计 1000 次提交 ≈ 18ms（实测）。n=10000 时预计 200ms+。

**优化方案**：改用二叉堆（BinaryHeap）
- 插入：O(log n)，1000 次提交预计 < 1ms
- 取顶：O(log n)
- 实现：5 个优先级桶 + 桶内 FIFO，或标准二叉堆按 (priority, createdAt) 排序
- 预期收益：1000 任务提交从 18ms → < 2ms

#### 瓶颈 2：依赖检查线性扫描（O(n)）

**位置**：`src/dre/runtime/scheduler.ts:202`
```ts
return task.dependencies.every((depId) =>
  this.completed.some((c) => c.id === depId && c.status === "completed"),
);
```

**影响**：completed 数组最大 100（trimCompleted），单次 every×some 最坏 100×100 = 10000 比较。

**优化方案**：completedId Set
- 维护 `private completedIds = new Set<string>()`
- complete/fail 时同步 add/delete
- isReady 查找 O(deps)，通常 deps < 5
- 预期收益：依赖检查从 O(n×deps) → O(deps)

#### 瓶颈 3：缓存键工具硬编码

**位置**：`src/tools/pipeline.ts:99`
```ts
if (context.cache && tool.name === "query" && output.data?.results?.length > 0) {
```

**影响**：read/write 工具无法享受缓存；新工具需改 pipeline 源码。

**优化方案**：工具声明式缓存
- Tool 接口新增 `cacheable?: boolean` 与 `cacheKeyFn?: (input: I) => string`
- pipeline 中 `if (tool.cacheable && context.cache)` 替代硬编码
- 预期收益：缓存命中率提升，重复 read 文件从 IO → 内存命中 < 0.01ms

#### 瓶颈 4：模块级统计单例

**位置**：`src/tools/types.ts:25,41,72`
```ts
const _modelTokenTracker = { calls: 0, totalTokens: 0 };
const _cacheStats = { hits: 0, misses: 0, rate: 0 };
const recentCalls = new Map<string, number[]>();
```

**影响**：跨请求污染，测试需 clearLoopCache；recentCalls 无 TTL，长期运行内存增长。

**优化方案**：per-ToolContext 统计 + TTL 清理
- 将统计移入 ToolContext 或独立的 MetricsRegistry 实例
- recentCalls 用 Map + 定时清理（每 60s 扫描移除过期 key）
- 预期收益：测试隔离 + 内存上限可控

#### 瓶颈 5：select 无并发感知

**位置**：`src/dre/runtime/capability-registry.ts:178`

**影响**：maxConcurrency 字段存在但 select 不校验，可能选中已满载的 Provider。

**优化方案**：in-flight 计数
- Capability 增加 `inFlight: number`
- select 前校验 `cap.inFlight < cap.provider.maxConcurrency`
- 调用方在 invoke 前后 acquire/release（需 Tool 层配合）
- 预期收益：负载均衡，避免单 Provider 过载

### 8.3 优化优先级与预期收益

| 优化项 | 难度 | 预期收益 | 优先级 |
|--------|------|----------|--------|
| 二叉堆替换全量排序 | 🟡 中 | 1000 任务提交 18ms→2ms | P1 |
| completedIds Set | 🟢 低 | 依赖检查 O(n)→O(1) | P1 |
| 工具声明式缓存 | 🟢 低 | 缓存命中率 +30% | P2 |
| 统计 per-context | 🟡 中 | 测试隔离 + 内存可控 | P2 |
| select 并发感知 | 🟡 中 | 负载均衡 | P3 |

### 8.4 10ms 目标适用范围说明

| 操作类别 | 10ms 目标 | 说明 |
|----------|-----------|------|
| scheduler.submit / getNext / complete / fail / cancel | ✅ 适用 | 纯内存操作 |
| capabilityRegistry.search / select / recordResult | ✅ 适用 | 纯内存 + 索引 |
| ThompsonRouter.route | ✅ 适用 | 内存采样（inMemory 模式） |
| runPipeline（无 IO 步骤） | ✅ 适用 | 空跑 < 0.01ms |
| normalizeQuery / detectLoop / emitProgress | ✅ 适用 | 纯计算 |
| **readTool (source=file)** | ❌ 不适用 | 磁盘 IO，受文件系统影响 |
| **readTool (source=web)** | ❌ 不适用 | 网络 IO |
| **queryTool (scope=web)** | ❌ 不适用 | 网络搜索 IO |
| **LLM 调用** | ❌ 不适用 | 网络 IO 不可避免，秒级 |
| **ThompsonRouter.route (持久化模式)** | ⚠️ 部分 | SQLite 写入，ms 级 |

---

## 九、改进建议汇总

### 9.1 短期（P0-P1）

1. **scheduler 改用二叉堆**：消除全量排序 O(n log n)，1000 任务提交从 18ms 降至 2ms 以内。
2. **completedIds Set 化**：依赖检查从 O(n) 降至 O(1)。
3. **工具缓存声明式**：Tool 接口增加 `cacheable` + `cacheKeyFn`，移除 pipeline 硬编码 `tool.name === "query"`。
4. **循环检测 TTL 清理**：recentCalls 增加定时扫描，避免长期运行内存泄漏。

### 9.2 中期（P2）

5. **统一工具体系**：将 `src/mcp/tools/` 下的 15 个工具（filesystem/git/github/terminal 等）纳入 Tool 接口适配层，消除 ToolDef 与 Tool 双轨制。
6. **统计 per-context 化**：_modelTokenTracker / _cacheStats 移入 ToolContext 或独立 MetricsRegistry，实现请求隔离。
7. **管道并行步骤**：runPipeline 支持声明无依赖步骤并行执行（Promise.all），提升多步骤管道吞吐。
8. **select 并发感知**：跟踪 in-flight 计数，跳过满载 Provider，实现真正负载均衡。

### 9.3 长期（P3）

9. **流式工具**：扩展 Tool.execute 返回 `AsyncIterable<ToolOutput>`，支持 LLM 流式输出与中间结果透传。
10. **TaskRouter 评分化**：selectAgent 接入 CapabilityRegistry 评分模型，替代首匹配。
11. **工具自描述**：接入 MCP `tools/list` 协议，动态暴露 schema，支持运行时工具发现。
12. **声明式 Agent 注册**：通过装饰器或配置文件声明 Agent 能力映射，替代硬编码 roleMapping。

---

## 十、结论

Axiom Runtime v4.0 的 Agent 工具系统在**性能维度表现优秀**（10ms 目标以 100×~6600× 余量达成），**功能性覆盖完整**（read/write/query + 调度 + 路由 + 能力选择 + 多 Agent 编排），**易用性良好**（接口简洁、错误处理完善）。

主要改进方向集中在：
1. **可扩展性的扩展瓶颈**：scheduler 全量排序、依赖线性扫描、缓存硬编码——这些在当前规模（< 1000 任务）下不构成问题，但规模增长 10× 后会显现。
2. **工具集完整性**：缺少 execute/transform/compute 类工具，且 MCP 工具与 Tool 接口存在双轨制。
3. **统计隔离**：模块级单例在测试与长期运行场景下需关注。

当前系统已能满足多 Agent 并行调度的性能与正确性要求，建议按优先级推进 P1 优化以应对未来规模增长。

---

## 附录：评估依据文件清单

| 文件 | 用途 |
|------|------|
| `src/tools/types.ts` | Tool 接口、ToolContext、循环检测、缓存统计 |
| `src/tools/pipeline.ts` | 工具管道编排器 |
| `src/tools/read-tool.ts` | Read 工具实现 |
| `src/tools/write-tool.ts` | Write 工具实现 |
| `src/tools/query-tool.ts` | Query 工具实现 |
| `src/mcp/tool-registry.ts` | MCP 双传输注册器 |
| `src/router/thompson-router.ts` | Thompson Sampling 路由 |
| `src/agents/orchestrator.ts` | 多 Agent 编排器 |
| `src/dre/runtime/scheduler.ts` | 任务调度器 |
| `src/dre/runtime/capability-registry.ts` | 能力注册表 |
| `src/dre/runtime/event-bus.ts` | 事件总线 |
| `tests/perf-benchmark.test.ts` | 性能基准数据源 |
| `tests/stress/perf-gate.test.ts` | 性能门禁阈值 |
| `tests/stress/multi-agent-stress.test.ts` | 多 Agent 压测数据源 |
