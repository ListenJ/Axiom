# Axiom Runtime v4.0.0 — 综合报告与开发指南

> **677 pass / 699 total / 45 test files / 24 commits / 0 regressions**
>
> 本文档为项目的权威参考：架构、模块、API、测试、性能基准、分支演化。
>
> 📖 哲学指导参见 [PHILOSOPHY.md](PHILOSOPHY.md) | 技术细节参见 [ARCHITECTURE.md](ARCHITECTURE.md)

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
│  EventBus + WorldState (Runtime Kernel v1)               │
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

## 4. 全链路测试结果

### 4.1 总体统计

```
文件类型           数量
──────────        ────
总测试文件         45 个
总测试用例         699 个
通过              677 (96.9%)
跳过              21  (3.0%)
失败              1   (0.1%, pre-existing tesseract.js)
expect() 调用      ~12000+
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

| 分支 | 状态 | 已合并内容 |
|------|------|-----------|
| `main` (当前) | ✅ 活跃 | Axiom Runtime v4.0.0 |
| `feature/cognitive-runtime` | 📦 | MentalModelPool 增强 + Runtime Kernel (EventBus/WorldState) |
| `feature/runtime-integration` | 📦 | 与认知运行时重叠 (不需要重复合并) |
| `feature/ide-plugin` | ✅ | IDE 插件 |
| `feat/v2.2.0-intelligent-routing` | ✅ | 智能路由 |

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

*Generated 2026-07-02 | Axiom Runtime v4.0.0 | 24 commits | 677 pass / 699 total*
