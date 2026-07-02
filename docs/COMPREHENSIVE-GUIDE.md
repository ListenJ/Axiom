# Axiom Runtime v4.0.0 — 综合报告与开发指南

> **682 pass / 706 total / 46 test files / 29 commits / 10 runtime modules / 0 regressions**
>
> 本文档为项目的 **唯一权威参考**：架构、模块、API、测试、性能基准、分支演化、提取审查。
>
> 📖 哲学指导 [PHILOSOPHY.md](PHILOSOPHY.md) | 技术细节 [ARCHITECTURE.md](ARCHITECTURE.md) | 路线图 [ROADMAP.md](ROADMAP.md)

---

## 1. 项目定义

**Axiom Runtime** 是一个确定性认知运行时 (Deterministic Cognitive Runtime)，融合世界模型与认知引擎。

```
不是 Agent Framework, 不是 MCP Framework, 不是 AI IDE。
是 Runtime + World Model + Deterministic Cognitive System。
```

**核心创新**: 将 LLM 从推理主体降级为 Runtime 中的 **Cognitive Accelerator (认知加速器)**，确定性推理为核心，LLM 仅补全。

---

## 2. 三层架构

```
Tier 1: 认知接口 (Interface)
┌──────────────────────────────────────────────────────────┐
│  MCP Server (155+ tools)  │  HTTP API (:18789)  │  CLI  │
│  Scene Router (23 scenes) │  WebSocket (/ws)             │
├──────────────────────────────────────────────────────────┤
Tier 2: 认知运行时 (Cognitive Runtime)
│  CognitivePipeline (6-step 闭环)                         │
│  TaskGraph (DAG 执行 + 回滚 + Checkpoint/Resume)          │
│  ActorSystem (轻量 Actor + 健康检查)                      │
│  Runtime Kernel v1 (10 modules):                          │
│    EventBus + WorldState + AtomEngine + KnowledgeNetwork  │
│    Scheduler + ReasoningRuntime + RuleEngine              │
│    CapabilityRegistry + ContextEngine                     │
│  ConsciousnessStream (三层记忆 + 反思)                     │
├──────────────────────────────────────────────────────────┤
Tier 3: 认知引擎 (Cognitive Modules)
│  KnowledgeStore (7 知识范式 + FTS5 全文索引)               │
│  ReasoningGraph (推理图 + 缺口检测 + LLM 精确填充)          │
│  MentalModelPool (心智模型 + 仿真 + 规则 + Skill 生成)      │
│  ConstraintSolver (5 维约束: 逻辑/物理/语义/策略/时间)      │
│  Pipeline (三段甄别: 预筛→网络校验→LLM 自推理)              │
├──────────────────────────────────────────────────────────┤
Tier 4: 存储与基础设施 (Infrastructure)
│  SQLite + FTS5  │  KAL 统一知识访问层  │  VFS 虚拟文件系统 │
│  VRAM Budget Manager  │  KnowledgeGraph (O(1) 索引)       │
└──────────────────────────────────────────────────────────┘
```

### 信息流动: 最小认知闭环

```
Observation → State → Knowledge → Reasoning → Constraint → Action → Reflection
     ↑           ↑        ↑          ↑          ↑           ↑          ↑
scene-router  classify  search   ReasoningGraph  check   TaskGraph   stream
           Conscious.   FTS5    gap detect     select   checkpoint  reflect
                                fillGap(LLM)             rollback    emit
```

---

## 3. 模块详解

### 3.1 KnowledgeStore (674 行, ✅ 测试覆盖)
**文件**: `src/dre/storage/knowledge-store.ts`

| API | 签名 | 说明 |
|-----|------|------|
| `write(node)` | `(node) → KnowledgeNode` | 事务写入 + SHA256 哈希 + 版本快照 |
| `read(nodeId)` | `(string) → KnowledgeNode | null` | 按 ID 读取 |
| `search(query, opts?)` | `(string, opts?) → KnowledgeNode[]` | FTS5 优先, LIKE 降级 |
| `getRevisions(nodeId)` | `(string) → KnowledgeRevision[]` | 版本历史 |
| `addEdge(edge)` | `(KGEdge) → void` | 添加知识图谱边 |
| `subgraph(seed, depth?, max?)` | `(...) → KnowledgeNode[]` | BFS 子图检索 |

**7 种知识范式**: `fact | rule | procedure | concept | behavior | prediction | hypothesis`

**FTS5 全文索引**: `knowledge_node_fts` 虚拟表 + 3 个自动同步触发器。搜索优先级: FTS5 MATCH → LIKE 降级。

---

### 3.2 ReasoningGraph (407 行, ✅ 14 tests)
**文件**: `src/dre/reasoning/graph.ts`

| API | 说明 |
|-----|------|
| `addPremise(content, confidence?)` | 添加前提节点 |
| `addInference(content, fromIds, confidence?)` | 添加推理步骤 + 自动建边 |
| `addConclusion(content, fromIds, confidence?)` | 添加结论 |
| `addEvidence(content, targetId, supports)` | 添加证据 |
| `detectGaps()` | 4 种检测器返回 `ReasoningGap[]` |
| `fillGapFromObject(gap, llmResponse, confidence)` | LLM 精确填充缺口 |
| `getResult()` | 返回 `{conclusion, chain, confidence, hasGaps, gaps}` |
| `getStats()` | 节点/边/缺口统计 |
| `clear()` | 清空图 |

---

### 3.3 ConstraintSolver (515 行, ✅ 11 tests)
**文件**: `src/dre/constraint/solver.ts`

**5 个维度**: `logical | physical | semantic | policy | temporal`

| API | 说明 |
|-----|------|
| `check(action, context?)` | 检查动作是否满足所有约束 |
| `selectBest(candidates, context?)` | 从候选集中选最优 |
| `register(constraint)` | 注册单个约束 |
| `list()` / `listByDimension(d)` | 列出约束 |
| `getStats()` | 按维度/类型统计 |

**预注册约束**: GPU VRAM (2), 生产环境 (2), 工作时间 (1, disabled)

---

### 3.4 MentalModelPool (469 行, ✅ 18 tests, v4.0 增强)
**文件**: `src/dre/mental-model/pool.ts`

| API | 说明 |
|-----|------|
| `register(model)` | 深拷贝注册模型 |
| `matchPattern(modelId, observations)` | 概念匹配 + 关系扩展 |
| `predict(modelId, observation)` | 基于当前状态预测下一步 |
| `advanceState(modelId, trigger)` | 推进状态转换 |
| `simulate(modelId, scenario, initialState)` 🆕 | 场景 what-if 演练 |
| `addRule(modelId, condition, action, confidence?)` 🆕 | 添加领域规则 |
| `generateSkillFromSimulation(modelId, simId)` 🆕 | 成功模拟 → Skill |
| `getStats()` 🆕 | 模型/规则/仿真统计 |

**4 个预注册模型**:

| 模型 | 概念 | 转换 | 规则 | 状态 |
|------|------|------|------|------|
| Git 冲突 | 6 | 5 | 2 | clean→merging→conflict→resolved→clean |
| 代码重构 | 4 | 6 | 0 | smelly→analyzing→testing→refactoring→clean |
| Auth 认证 🆕 | 4 | 4 | 1 | authenticated→expiring→refreshing→authenticated |
| Database 事务 🆕 | 4 | 5 | 1 | connected→querying→in-transaction→committed |

---

### 3.5 ActorSystem (441 行, ✅ 7 tests)
**文件**: `src/dre/actor/system.ts`

| API | 说明 |
|-----|------|
| `register(behavior)` | 注册 Actor |
| `unregister(actorId)` | 注销 |
| `deliver(message)` | 投递消息 |
| `send(from, to, type, topic, payload)` | 便捷发送 |
| `list()` / `size` | 列出所有 Actor |
| `shutdown(timeoutMs?)` | 关闭 (per-actor 超时) |
| `healthCheck()` 🆕 | 返回所有 Actor 状态 |

**4 个预注册 Actor**: Knowledge / Constraint / MentalModel / Reasoning

---

### 3.6 TaskGraph (325 行, ✅ 12 tests, 执行表示层)
**文件**: `src/dre/pipeline/task-graph.ts`

| API | 说明 |
|-----|------|
| `addTask(id, desc, execute, opts?)` | 添加任务 (支持依赖) |
| `executeAll()` | 拓扑排序 + 并行执行 |
| `rollbackAll()` | 反向依赖顺序回滚 |
| `checkpoint(store)` | 序列化到 KnowledgeStore |
| `resume(store, checkpointId)` | 从 KnowledgeStore 恢复 |
| `toJSON()` / `fromJSON(snapshot)` | 序列化/反序列化 |
| `getStatus()` / `isComplete()` | 状态查询 |

---

### 3.7 CognitivePipeline (326 行, ✅ 17 tests)
**文件**: `src/dre/pipeline/cognitive-pipeline.ts`

6 步闭环: `classify → knowledge → reasoning → constraint → action → reflection`

| API | 说明 |
|-----|------|
| `run(input)` | 纯认知推理 (零 LLM) |
| `runFull(input)` | 推理 + TaskGraph 执行 |

每步产生 `CognitiveStep { stage, input, output, durationMs }` — 完整可追踪。

---

### 3.8 EventBus (102 行, ✅ 10 tests, Runtime Kernel v1)
**文件**: `src/dre/runtime/event-bus.ts`

| API | 说明 |
|-----|------|
| `publish(event)` | 发布事件 (优先级排序) |
| `subscribe(type, handler, priority?)` | 订阅 |
| `subscribeOnce(type, handler, priority?)` | 一次性订阅 |
| `unsubscribe(id)` | 取消订阅 |
| `getRecentEvents(count?)` | 最近事件 |
| `getStats()` | 发布/处理/错误统计 |

---

### 3.9 WorldState (119 行, ✅ 11 tests, Runtime Kernel v1)
**文件**: `src/dre/runtime/world-state.ts`

| API | 说明 |
|-----|------|
| `get<T>(path)` / `set<T>(path, value)` | 读写状态 |
| `update(path, updater)` | 函数式更新 |
| `watch(path, listener)` | 订阅变更 |
| `query(prefix)` | 前缀查询 |
| `snapshot()` | 序列化 |
| `setIntent/getIntent()` | 意图追踪 |
| `setGoal/getGoals()` | 目标管理 |
| `setBelief/getBeliefs()` | 信念管理 |
| `setHypothesis/getHypotheses()` | 假设追踪 |
| `getVersion()` | 版本号 |

---

### 3.10 AtomEngine (355 行, 🆕 from openclaw-clean)
**文件**: `src/dre/runtime/atom-engine.ts`

统一的 Atom 表示层 — 系统中所有数据都表示为 Atom。Markdown/SQLite/KG 均为 Atom 的投影。

| API | 说明 |
|-----|------|
| `atomStore.create(kind, content, meta?)` | 创建 Atom |
| `atomStore.get(id)` | 读取 |
| `atomStore.update(id, changes)` | 更新 (版本递增) |
| `atomStore.query(opts)` | 按 kind/source/parent 查询 |
| `atomStore.link(srcId, dstId, relType)` | 建立 Atom 关系 |
| `atomStore.getStats()` | Atom 统计 |

**29 种 AtomKind**: `function | class | interface | type | variable | entity | fact | rule | concept | procedure | document | section | paragraph | sentence | goal | plan | step | action | observation | experience | belief | insight | event | state | constraint | relation` + 3 more

### 3.11 KnowledgeNetwork (395 行, 🆕 from openclaw-clean)
**文件**: `src/dre/runtime/knowledge-network.ts`

升级知识系统 — 不仅是 Graph，而是实体 + 行为 + 预测 + 假设。

| API | 说明 |
|-----|------|
| `knowledgeNetwork.create(kind, name, content, opts?)` | 创建知识实体 |
| `knowledgeNetwork.get(id)` | 读取 |
| `knowledgeNetwork.queryByKind(kind)` | 按类型查询 |
| `knowledgeNetwork.search(query)` | 搜索 |
| `knowledgeNetwork.addBehavior(entityId, behavior)` | 添加行为模式 |
| `knowledgeNetwork.addPrediction(entityId, prediction)` | 添加预测 |
| `knowledgeNetwork.addHypothesis(entityId, hypothesis)` | 添加假设 |
| `knowledgeNetwork.resolveHypothesis(entityId, hypId, status, reason)` | 假设解决 |

### 3.12 Scheduler (232 行, 🆕 from openclaw-clean)
**文件**: `src/dre/runtime/scheduler.ts`

纯任务调度器 — 只处理"何时"运行，不处理"做什么"。

| API | 说明 |
|-----|------|
| `scheduler.submit(task)` | 提交任务 |
| `scheduler.getNext()` | 获取下一个就绪任务 |
| `scheduler.complete(taskId, result)` | 标记完成 |
| `scheduler.fail(taskId, error)` | 标记失败 |
| `scheduler.cancel(taskId)` | 取消任务 |
| `scheduler.getStatus()` | 队列状态 {queued, running, completed, failed} |
| `scheduler.setBudget(budget)` | 设置资源预算 |

### 3.13 ReasoningRuntime (369 行, 🆕 from openclaw-clean)
**文件**: `src/dre/runtime/reasoner/reasoning-runtime.ts`

独立推理引擎 — 从 Scheduler 中拆分，负责任务的"逻辑推理"部分。

| API | 说明 |
|-----|------|
| `getReasoningRuntime()` | 获取推理引擎单例 |
| 订阅 `scheduler.task_*` 事件 | 接收任务通知并推理 |

### 3.14 RuleEngine (564 行, 🆕 from openclaw-clean)
**文件**: `src/dre/runtime/rule-engine.ts`

规则引擎 — 规则评估 + 自动学习 + 策略预测。依赖 eventBus + atomStore。

| API | 说明 |
|-----|------|
| `ruleEngine.addRule(rule)` | 添加规则 |
| `ruleEngine.evaluate(context)` | 评估规则 (返回匹配/不匹配) |
| `ruleEngine.learnFromMemory()` | 从记忆中自动学习规则 |
| `ruleEngine.getStats()` | 规则统计 |

### 3.15 CapabilityRegistry (274 行, 🆕 from openclaw-clean)
**文件**: `src/dre/runtime/capability-registry.ts`

能力注册表 — Agent/工具的能力描述。仅依赖 eventBus (零额外依赖)。

| API | 说明 |
|-----|------|
| `capabilityRegistry.register(cap)` | 注册能力 |
| `capabilityRegistry.get(name)` | 查询能力 |
| `capabilityRegistry.getAll()` | 所有能力 |
| `capabilityRegistry.getStats()` | 统计 |

预注册: 14 个能力 (code-generation, code-review, research, architecture 等)

### 3.16 ContextEngine (179 行, 🆕 from openclaw-clean, ✅ 16 tests pass)
**文件**: `src/dre/runtime/context-engine.ts`

上下文引擎 — 自动构建 LLM 上下文。依赖 eventBus + worldState + atomStore。

| API | 说明 |
|-----|------|
| `contextEngine.build(opts?)` | 构建上下文 (项目/目标/知识/信念) |
| `contextEngine.formatForPrompt()` | 格式化为 LLM prompt |
| `contextEngine.invalidateCache()` | 清除缓存 |
| `contextEngine.getStats()` | 缓存统计 |

---

### 3.14 DREngine (462 行)
**文件**: `src/dre/engine.ts`

确定性推理引擎顶层编排器。初始化所有子系统。

| API | 说明 |
|-----|------|
| `constructor(config)` | 初始化 VFS/SQLite/KnowledgeStore/Pipeline/LLM/Consciousness/MentalModels/Reasoning/Constraints/Actors |
| `writeKnowledge(item)` | 写入知识 (触发三段甄别) |
| `readKnowledge(nodeId)` | 读取知识 |
| `searchKnowledge(query, opts?)` | 搜索知识 |
| `subgraph(seed, depth?, max?)` | BFS 子图检索 |
| `consciousnessStep(input)` | 意识流步骤 (三级降级: 本地LLM→云API→规则) |
| `getStatus()` | 完整引擎状态快照 |
| `waitForReady()` | 等待引擎就绪 (Actor 初始化完成) |
| `close()` | 异步关闭所有子系统 |
| `createPlannerAgent/CoderAgent/RetrieverAgent/ReflectorAgent()` | Agent 工厂方法 |

### 3.15 Pipeline (283 行)
**文件**: `src/dre/pipeline/pipeline.ts`

三段甄别管道 — 知识质量验证。

| API | 说明 |
|-----|------|
| `process(item)` | 三段甄别: 预筛→网络校验→LLM 自推理 |
| Stage 1 | 规则引擎 + 向量召回 → 风险评分 |
| Stage 2 | 网络检索校验 (Playwright) |
| Stage 3 | LLM 自推理 (强约束 + 拒绝采样) |

路由: `risk < 0.3 → accept | 0.3-0.7 → Stage 2 | > 0.7 → Stage 3`

### 3.16 LLMClient (275 行)
**文件**: `src/dre/llm/client.ts`

OpenAI-compatible HTTP 客户端 (llama.cpp 或任何兼容 API)。

| API | 说明 |
|-----|------|
| `generate(prompt, opts?)` | 标准生成 (temperature=0, 确定性) |
| `streamGenerate(prompt, opts?)` | SSE 流式生成 |
| `generateConstrained(prompt, schema, opts?)` | 强约束生成 (JSON Schema + 拒绝采样 n=3) |

### 3.17 ConsciousnessStream (395 行)
**文件**: `src/dre/consciousness/stream.ts`

三层记忆架构 + 事件驱动意识流。

| 组件 | 说明 |
|------|------|
| `WorkingMemory` | FIFO, 容量受限, 当前任务上下文 |
| `EpisodicMemory` | TTL 过期, 向量索引 |
| `ReflectionQueue` | 3 触发条件: 连续失败/输出不一致/置信度波动 |
| `step(input)` | 观察→工作记忆→决策→追踪→反思 |
| `reflect(analysis?)` | 基于 ReflectionQueue 分析生成经验教训 |
| `getState()` / `getTrace()` | 状态快照 |

### 3.18 KnowledgeGraph (253 行)
**文件**: `src/dre/kg/graph.ts`

内存知识图谱 — 邻接表 + O(1) 索引。

| API | 说明 |
|-----|------|
| `addNode(node)` / `getNode(id)` | 节点管理 |
| `addEdge(edge)` | 边管理 (去重 + 双向) |
| `subgraph(seed, depth, max?)` | BFS 子图 |
| `shortestPath(start, end)` | BFS 最短路径 |
| `detectCommunities()` | 连通分量社区检测 |
| `toJSON()` / `fromJSON(data)` | 序列化 |
| `nodesByDomain(domain)` / `nodesByEnv(hash)` | O(1) Map 索引查询 |

### 3.19 AgentHarness (228 行)
**文件**: `src/dre/harness/agent.ts`

Agent 编排 — 工具调用循环。

| 子类 | 说明 |
|------|------|
| `PlannerAgent` | 确定性规划 |
| `CoderAgent` | Codex 风格沙箱执行 |
| `RetrieverAgent` | 检索 Agent |
| `ReflectorAgent` | 反思 Agent |

### 3.20 SqliteBackend (277 行)
**文件**: `src/dre/storage/sqlite-backend.ts`

VFS 的 SQLite 存储后端 — WAL 模式 + 自动建表 + 版本快照。

| API | 说明 |
|-----|------|
| `read(path)` / `write(path, data, reason)` | 读写 KV |
| `stat(path)` / `list(dir)` | 元数据 |
| `delete(path)` | 删除 |
| `getHistory(path)` | 版本历史 |
| `rollback(path, revision)` | 版本回滚 |

### 3.21 VFS (130 行)
**文件**: `src/dre/vfs.ts`

虚拟文件系统 — 统一挂载点 + 最长前缀路由。

| API | 说明 |
|-----|------|
| `mount(path, backend)` | 挂载后端 |
| `read(path)` / `write(path, data, reason)` | 读写 |
| `listMounts()` | 列出挂载点 |

### 3.22 VRAM Budget Manager (155 行)
**文件**: `src/dre/vram-budget.ts`

GPU VRAM 检测 — nvidia-smi + 预算管理。

| API | 说明 |
|-----|------|
| `detectGPU()` | 检测 GPU (30s 缓存) |
| `canRunLocal()` | 判断能否本地推理 |
| `getStatus()` | VRAM 状态快照 |

默认: modelBaseMB=1100, kvCacheMaxMB=2200, safetyMarginMB=200 (RTX 3050 Ti 4GB)

## 4. 全链路测试结果

### 4.1 总体统计

```
文件类型           数量
──────────        ────
总测试文件         46 个
总测试用例         706 个
通过              682 (96.7%)
跳过              21  (3.0%)
失败              1   (0.1%, pre-existing tesseract.js)
expect() 调用      ~13000+
```

### 4.2 按模块测试覆盖

| 模块 | 测试文件 | 测试数 | 状态 |
|------|----------|--------|------|
| KnowledgeStore | cognitive-modules.test.ts | 8 | ✅ |
| ReasoningGraph | cognitive-modules.test.ts | 14 | ✅ |
| ConstraintSolver | cognitive-modules.test.ts | 11 | ✅ |
| MentalModelPool | cognitive-modules.test.ts | 18 | ✅ |
| ActorSystem | cognitive-modules.test.ts | 7 | ✅ |
| HypothesisManager | cognitive-modules.test.ts | 1 | ✅ |
| CognitivePipeline | cognitive-pipeline.test.ts | 17 | ✅ |
| TaskGraph | task-graph.test.ts | 12 | ✅ |
| EventBus | dre-core-modules.test.ts + merge-stress.test.ts | 10 | ✅ |
| WorldState | dre-core-modules.test.ts + merge-stress.test.ts | 11 | ✅ |
| ContextEngine 🆕 | context-engine.test.ts | 16 | ✅ |
| SqliteBackend | dre-core-modules.test.ts | 6 | ✅ |
| LLMClient | dre-core-modules.test.ts | 5 | ✅ |
| KnowledgeGraph | dre-core-modules.test.ts | 8 | ✅ |
| ConsciousnessStream | dre-core-modules.test.ts | 6 | ✅ |
| VFS | dre-core-modules.test.ts | 2 | ✅ |
| VRAMBudget | dre-core-modules.test.ts | 3 | ✅ |
| AgentHarness | dre-core-modules.test.ts | 6 | ✅ |
| Pipeline | dre-core-modules.test.ts | 4 | ✅ |
| SceneRouter | scene-router.test.ts | 13 | ✅ |
| MCP Integration | mcp-cognitive-integration.test.ts | 10 | ✅ |
| Benchmark | benchmark.test.ts | 10 | ✅ |
| 压力测试 | merge-stress.test.ts | 23 | ✅ |
| 其他 (21 个文件) | various | 484 | ✅ |

### 4.3 压力基准 (merge-stress.test.ts)

| 场景 | 规模 | 耗时 | 评级 |
|------|------|------|------|
| EventBus 吞吐 | 10,000 events | 13.86ms (714K/s) | ⭐⭐⭐⭐⭐ |
| EventBus 广播 | 1,000 subscribers | 2.49ms | ⭐⭐⭐⭐⭐ |
| EventBus 并发 | 10 coroutines × 100 | 2.05ms | ⭐⭐⭐⭐⭐ |
| WorldState 写入 | 10,000 keys | 14.91ms | ⭐⭐⭐⭐⭐ |
| WorldState 监视 | 1,000 watchers | 0.93ms | ⭐⭐⭐⭐⭐ |
| WorldState 查询 | 5,000 keys prefix | 15.45ms | ⭐⭐⭐⭐ |
| MentalModel 仿真 | 100 parallel | 1.26ms | ⭐⭐⭐⭐⭐ |
| MentalModel 模型 | 500 registrations | 4.29ms | ⭐⭐⭐⭐⭐ |

### 4.4 性能基准 (benchmark.test.ts)

| 指标 | 结果 |
|------|------|
| CognitivePipeline 6-step | avg 0.9ms |
| 并发 5x CognitivePipeline | 0.8ms/task |
| TaskGraph 100 tasks | 2.4ms |
| KG index lookup | 30µs (31x vs 线性) |
| ConstraintSolver | 0.005ms/check |
| ReasoningGraph gap (100 nodes) | 0.23ms |

---

## 5. MCP 工具索引

### 认知工具 (核心新增)

| 工具 | 说明 | 底层 |
|------|------|------|
| `cognitive_loop` | 6 步认知闭环 | CognitivePipeline.run() |
| `cognitive_loop_full` | 闭环 + TaskGraph 执行 | CognitivePipeline.runFull() |
| `task_graph_execute` | DAG 任务图 + 回滚 | TaskGraph |

### 认知模块工具

| 类别 | 工具 |
|------|------|
| DRE | `dre_write/read/search/subgraph/status/consciousness_step` |
| Mental Model | `mental_model_list/match/predict` |
| Reasoning | `reasoning_build/detect_gaps/fill_gap/result` |
| Constraint | `constraint_check/select_best/list/stats` |
| Actor | `actor_list/send` |
| Procedure | `procedure_parse` |

### 核心工具 (88) | 配置工具 (33) | 外部服务 (12)

详见 [MCP_TOOLS_GUIDE.md](MCP_TOOLS_GUIDE.md)

---

## 6. 场景路由 (23 scenes)

| 场景组 | 场景 | 优先级范围 |
|--------|------|-----------|
| 基础操作 | git_ops, file_read, file_write, code_analysis, terminal, search | 5-10 |
| 知识操作 | memory, knowledge_query, kg_ops, dre_ops | 4-9 |
| 扩展 | github_ops, code_generate, document_ingest, arena, prompt_pool, snapshot | 4-7 |
| 认知增强 | constraint_ops, mental_model_ops, reasoning_ops, actor_ops, procedure_ops | 5-6 |
| 运行时 | cognitive_loop, task_graph | 8 |

---

## 7. 三层缺失补齐状态

| 层 | 状态 | 实现 | 文件 |
|---|------|------|------|
| **Knowledge Representation** | ✅ 完成 | 7 范式 + FTS5 索引 | `knowledge-store.ts` |
| **Reasoning Representation** | ✅ 完成 | 推理图 + 缺口 + LLM 填补 | `reasoning/graph.ts` |
| **Execution Representation** | ✅ 完成 | TaskGraph + Checkpoint/Resume | `task-graph.ts` |

---

## 8. 分支与合并状态

| 分支 | 状态 | 未合并 commits | 已提取内容 |
|------|------|---------------|-----------|
| `main` (当前) | ✅ 活跃 | 0 | Axiom Runtime v4.0.0 |
| `feature/cognitive-runtime` | 📦 56 ahead | EventBus,WorldState,AtomEngine,KnowledgeNetwork,Scheduler,ReasoningRuntime,MentalModel 增强 | — |
| `feature/runtime-kernel` | 📦 27 ahead | 与 cognitive-runtime 重叠，无 unique 模块 | — |
| `feature/runtime-integration` | 📦 42 ahead | 与 cognitive-runtime 重叠，无 unique 模块 | — |
| `feature/ide-plugin` | ✅ 0 ahead | 已完全合并 | — |
| `feat/v2.2.0-intelligent-routing` | ✅ 0 ahead | 已完全合并 | — |

**分支关系**: `cognitive-runtime ⊃ runtime-integration ⊃ runtime-kernel` (层层包含)
所有有价值代码均来自 cognitive-runtime，其余分支无额外 unique 内容。

### cognitive-runtime 待提取清单 (11 modules remaining)

| 模块 | 行数 | 稳定性 | 原因 |
|------|------|--------|------|
| kernel.ts | 969 | ❌ 不稳定 | 依赖所有模块，循环引用 |
| memory-engine.ts | 962 | ❌ 不稳定 | 依赖 kernel |
| projection-layer.ts | 453 | ⚠️ 有副作用 | 文件系统写入操作 |
| verification-engine.ts | 345 | ❌ 不稳定 | 依赖 solver+rule，循环链 |
| agent-executor.ts | 322 | ⚠️ 依赖深 | 依赖 kernel + actors |
| chat-actor.ts | 287 | ❌ 不稳定 | 依赖 6+ 其他模块 |
| capability-registry.ts | 274 | ✅ 已提取 | — |
| constraint-solver.ts | 292 | ⚠️ 重叠 | 与 ConstraintSolver 重叠 |
| actors.ts | 214 | ⚠️ 重叠 | 与 ActorSystem 重叠 |
| reasoning-graph.ts | 214 | ⚠️ 重叠 | 与 ReasoningGraph 重叠 |
| context-engine.ts | 179 | ✅ 已提取 (16 tests pass) | — |
| specialized-actors.ts | 230 | ❌ 不稳定 | 依赖 kernel + actors |
| rule-engine.ts | 564 | ✅ 已提取 | — |
| index.ts | 81 | ⚠️ 需全部 | 依赖所有模块 |

---

## 9. 设计原则

排序来自 [PHILOSOPHY.md](PHILOSOPHY.md):

1. **Runtime First** — 先有运行时，再有其他
2. **State First** — 状态是系统的一等公民
3. **Knowledge First** — 知识表示决定系统上限
4. **LLM Last** — LLM 是加速器，不是核心

---

## 10. 快速导航

| 文档 | 用途 |
|------|------|
| [PHILOSOPHY.md](PHILOSOPHY.md) | 设计哲学与长期方向 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | v4.0.0 技术架构 |
| [ROADMAP.md](ROADMAP.md) | 发展规划与知识地图 |
| [MCP_TOOLS_GUIDE.md](MCP_TOOLS_GUIDE.md) | MCP 工具使用指南 |
| [CHANGELOG.md](../CHANGELOG.md) | 版本变更记录 |

| 关键文件 | 位置 |
|----------|------|
| CognitivePipeline | `src/dre/pipeline/cognitive-pipeline.ts` |
| TaskGraph | `src/dre/pipeline/task-graph.ts` |
| ReasoningGraph | `src/dre/reasoning/graph.ts` |
| ConstraintSolver | `src/dre/constraint/solver.ts` |
| MentalModelPool | `src/dre/mental-model/pool.ts` |
| ActorSystem | `src/dre/actor/system.ts` |
| KnowledgeStore | `src/dre/storage/knowledge-store.ts` |
| EventBus | `src/dre/runtime/event-bus.ts` |
| WorldState | `src/dre/runtime/world-state.ts` |

---

*Generated 2026-07-02 | Axiom Runtime v4.0.0 | 29 commits | 682 pass / 706 total | 10 runtime modules extracted from openclaw-clean*
