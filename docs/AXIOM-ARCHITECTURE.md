# Axiom 系统权威架构文档 v3.1

> 唯一权威参考 — 覆盖全系统所有模块的架构设计、核心代码模式、数据流、配置与测试


## 〇、设计哲学 (Philosophy)

### 核心定义

#### 架构决策记录 (ADRs)

**ADR-001: Runtime 优先于 Agent**
决定: Axiom 定位为 Runtime 而非 Agent Framework。理由: Agent Framework 赛道拥挤 (LangChain, CrewAI, AutoGen), 而确定性认知运行时没有成熟的开源实现。Runtime 是基础设施层, Agent 是应用层。基础设施层一旦建立, 任何 Agent 模式都可以在其上实现。

**ADR-002: LLM 作为加速器而非核心**
决定: LLM 仅作为确定性管道的补全器, 不作为推理主体。理由: (1) 确定性推理可测试、可审计、可回放; (2) LLM 不可靠、不可预测、不可审计; (3) 将 LLM 作为填空者可以最小化幻觉影响范围, 仅在确定性管道检测到知识缺口时调用。

**ADR-003: 统一数据入口 (DataUnifier)**
决定: 所有数据通过 DataUnifier 写入和查询, 替代 VFS + KnowledgeStore + AtomEngine 三个独立入口。理由: (1) 三个独立入口导致写操作不一致 (数据可能只写入一个存储); (2) 搜索必须分别查询三个存储再合并结果; (3) DataUnifier 确保了原子性 (Atom 始终与 KnowledgeNode 一起创建)。

**ADR-004: 状态式交互替代对话式**
决定: 系统每步发布 eventBus 事件 + 更新 worldState, 而非返回最终结果。理由: (1) 对话式是黑盒 — 用户看到的是输入→输出, 中间过程不可见; (2) 状态式使用户可以看到推理的每一步, 可以随时中断、修正或继续; (3) 状态式更适合工具调用场景 — 每个步骤都可以独立触发工具。

**ADR-005: Persona 非 Agent**
决定: Persona 是 Runtime 配置上下文 (约束+心智模型+能力), 不是独立的 Agent 实例。理由: (1) Agent 实例有独立的状态和生命周期, Persona 只改变行为配置; (2) 切换 Persona 比创建新 Agent 轻量得多 (无状态迁移开销); (3) Persona 可以堆叠和组合 (push/pop), Agent 不能。

**ADR-006: 硬件无关资源预算**
决定: ResourceBudgetManager 只做数字比较, 不调用 nvidia-smi 或任何硬件 API。理由: (1) 硬件检测应属于 Infrastructure 层插件, 不是 Runtime 核心; (2) Runtime 只关心可用预算数量, 不关心预算来源; (3) 这使 Axiom 可部署在 CPU/GPU/云端/移动端/边缘设备。

Axiom = **Runtime** + **World Model** + **Deterministic Cognitive System**

| 不是 | 是 |
|------|-----|
| Agent Framework (赛道拥挤) | Runtime — 事件驱动, Actor 调度, 生命周期管理 |
| MCP Framework (只是协议层) | World Model — 统一状态表示, 投影, 演化 |
| AI IDE (非我们领域) | Deterministic Cognitive System — 可解释, 可验证的推理管道 |

### LLM 降级为认知加速器

这是 Axiom 与所有其它项目最本质的区别。

**传统范式**: Prompt → LLM → Tool — LLM 是推理主体
**Axiom 范式**: Observation → World State → Constraint → Planning → Verification → LLM (仅补全) — LLM 从推理主体降级为 **Cognitive Accelerator**

### 四大不可替代核心

| 核心 | 说明 | 实现位置 |
|------|------|----------|
| **Runtime Kernel** | 事件, 调度, 生命周期, Actor, 状态管理 | kernel.ts + event-bus.ts + world-state.ts |
| **Knowledge Representation** | 事实/行为/过程/约束/证据/预测的统一表示 | data-unifier.ts + atom-engine.ts |
| **Deterministic Cognitive Pipeline** | Observation → State → Reasoning → Planning → Verification | cognitive-pipeline.ts + reasoning-runtime.ts |
| **LLM Adapter** | 所有模型统一抽象为认知增强器 | llm/client.ts |

### 设计原则 (排序)

1. **Runtime First** — 先有运行时, 再有其他
2. **State First** — 状态是系统的一等公民
3. **Knowledge First** — 知识表示决定系统上限
4. **LLM Last** — LLM 是加速器, 不是核心

---

## 〇一、LLM 潜力释放四维模型

> 本节阐述 Axiom Runtime 如何通过认知架构设计榨干 LLM 的每一点潜力。
> 核心论点: LLM 的最大潜力不是"它什么都知道", 而是"它能极其精准地完成一个被严格定义的微任务"。
> Axiom Runtime 是 LLM 的操作系统 — 负责调度、内存、I/O 与安全。

### 现状批判: LLM 作为"超级函数"

当前业界主流用法是把 LLM 当作一个超级函数 — 输入 Prompt, 输出文本。这种方式只发挥了 LLM 不到 30% 的潜力, 表现为:

- **Context 浪费** — 大量 Token 用于重复历史、通用知识、冗余说明
- **无状态盲区** — LLM 每次调用都是独立的, 没有系统状态的概念
- **行为不可控** — System Prompt 是软约束, LLM 随时可能跑偏
- **记忆有限** — Context Window 是唯一记忆载体, 超出即遗忘

Axiom Runtime 通过四个维度解决这些问题:

### 维度一: 精度控制 — ReasoningGraph 缺口检测

**问题:** 传统做法将整个问题丢给 LLM, 让它在宽泛的 Prompt 中自行判断哪些部分需要推理、哪些已知。

**Axiom 解法:** ReasoningGraph 进行缺口检测 (Gap Detection), 只让 LLM 解决它最擅长的部分。

```
Runtime 内部流程:
1. ReasoningGraph 分析任务
2. 检查 KnowledgeStore: 已知项目结构 ✓
3. 检查 Procedure: 已知如何获取性能指标 ✓
4. Gap Detection: 不知道"如何将性能指标映射到具体重构模式"
5. → 精准 Prompt: 仅发送性能指标 + 相关代码 + 指定的重构模式
6. → LLM 输出: 仅生成优化后的代码片段
```

**实现机制:**
```
cognitive-pipeline.ts: buildReasoning()
  → graph.detectGaps()
  → 如果 gaps.length > 0
    → consciousnessStep()  // L2: 本地 LLM
    → 注入的 Prompt 仅包含缺口所需的最小上下文
```

**潜力释放:**
- **上下文利用率 100%** — Context Window 里全是解决当下问题所必需的高价值信息
- **误差隔离** — LLM 错误仅限于"代码生成"节点, 不影响架构分析
- **Token 成本降低** — 不再为 LLM 已知的信息付费

### 维度二: 状态感知 — WorldState + DataUnifier

**问题:** LLM 无状态, 完全依赖 Chat History。对话一长就遗忘细节。

**Axiom 解法:** 通过 WorldState 和 DataUnifier 注入完整运行时上下文。

```
每次 LLM 调用前, Runtime 查询:
  → WorldState.getGoals()    — 当前目标是什么 (JWT 鉴权模块)
  → WorldState.getBeliefs()  — 当前信念是什么 (JWT 最佳方案, 置信度 0.9)
  → ConstraintSolver         — 当前约束是什么 (禁止外部库)
  → AtomEngine.search()      — 相关的实体和关系
```

**实现机制:**
```
engine.ts: getCognitiveState()
  → 聚合 Persona + 意识流 + 推理 + 约束 + 目标 + 信念 → 单一可查询结构

cognitive-pipeline.ts: run().track()
  → 每步更新 worldState.set("cognitive.pipeline.lastStep", ...)
  → eventBus.publish("cognitive.step.*")
```

**潜力释放:**
- **一致性** — 无论对话进行了多久, LLM 的决策始终基于最新的系统状态
- **连贯性** — AtomEngine 将之前生成的实体/关系直接注入 Prompt, LLM 能"记住"从未见过但在系统中存在的概念

### 维度三: 行为塑形 — ConstraintSolver + VerificationEngine

**问题:** System Prompt 是软约束, LLM 容易跑偏。不依赖 LLM 的"道德感", 而依赖 Runtime 的硬性规则。

**Axiom 解法:** LLM 输出不直接交给用户 — 先过 VerificationEngine。

```
输出管线:
1. LLM 生成结果
2. → VerificationEngine.verifyResult()
3.   → ConstraintSolver.check()
4.     → Policy Check:  是否试图删除生产环境文件?
5.     → Semantic Check: 是否违反已建立的 Belief?
6.     → Logical Check:  代码语法是否正确?
7.   → 如果验证失败:
8.     → 生成修正指令发回 LLM (Refinement Loop)
9.     → 或触发降级规则 (L4: rule-based)
```

**实现机制:**
```
verification-engine.ts: verifyResult()
  → 4 层评分: output / constraint / reasoning / evidence
  → 如果 overallVerdict === "fail"
    → needsLLM = true (让 LLM 自我修正)
    → 修正 Prompt 包含: "你违反了 [Constraint: No External Libs]"

reasoning-runtime.ts: Stage 8 (verification)
  → 集成 verificationEngine
  → 失败时发布 pipeline.verification 事件
```

**潜力释放:**
- **鲁棒性** — LLM 的随机性被限制在 Runtime 允许的沙箱内
- **安全性** — 依赖硬性约束而非 LLM 的"道德感"
- **自我修正闭环** — 验证失败时, LLM 收到精准修正指令, 形成 Refinement Loop

### 维度四: 记忆压缩 — ConsciousnessStream

**问题:** 把所有历史塞进 Context Window, 浪费 Token 且导致"迷失中间"现象。

**Axiom 解法:** 三层记忆架构 + 智能检索。

```
记忆层级:
  WorkingMemory (FIFO)     — 最近 N 步操作 (当前任务)
  EpisodicMemory (Vector)  — 旧对话 → Atom 存入 SQLite (长期)
  Retrieval                — 基于 Observation 检索最相关的 3-5 个片段

LLM 调用前:
  → 不是加载"历史"
  → 而是基于当前 Observation 检索最相关的历史片段
  → 注入为"经验证据"
```

**实现机制:**
```
consciousness/stream.ts:
  WorkingMemory.push()   — FIFO, 容量 16
  EpisodicMemory.search(queryEmbedding, k=5)  — 余弦相似度检索
  EpisodicMemory.archive()  — TTL 过期记忆归档
  EpisodicMemory.consolidate()  — 相似记忆合并为模式
```

**潜力释放:**
- **无限上下文** — 理论上可记住无限久远的事情 (SQLite 持久化)
- **减少幻觉** — 提供的"历史"是经过筛选、验证过的, 减少 LLM 编造
- **Token 节约** — 不必为不相关的历史付费

### 总结: Axiom Runtime = LLM 的操作系统

| 操作系统概念 | Axiom Runtime 对应 | 实现 |
|-------------|-------------------|------|
| **调度** | CognitivePipeline | 决定何时唤醒 LLM, 用哪个 level 降级 |
| **内存** | WorldState + EpisodicMemory | 构建完美的运行时上下文 |
| **I/O** | DataUnifier + TaskGraph | 将 LLM 输出转化为原子操作 |
| **安全** | ConstraintSolver | 用硬约束杀死危险进程 |
| **进程隔离** | PersonaLoader | Persona = 受限的运行时沙箱 |

这种架构使得即使是一个参数量较小的 LLM (7B 模型), 在 Axiom 的加持下, 也能表现出超越其参数规模的稳定性和可控性。**这就是 Runtime 赋予 LLM 的最大潜力。**

---

## 一、架构全景

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MCP Server (src/mcp/)                        │
│  16 个 DRE 工具 + 40+ 通用工具 (GitHub, 搜索, 爬虫, 记忆, 代码...)  │
│  Protocol: stdio / HTTP (Bun.serve) ◀─ ToolRegistry                 │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ getKernel()
┌───────────────────────────▼─────────────────────────────────────────┐
│  Kernel (src/dre/kernel.ts)  — 极薄启动器                           │
│  init() → tick() → shutdown()                                       │
│  驱动 Scheduler + 事件订阅 + WorldState 心跳                        │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────────┐
│  DREngine (src/dre/engine.ts) — 引擎主入口                          │
│                                                                     │
│  ┌─ DataUnifier ─────────────────────────────────────────────────┐  │
│  │  统一数据入口: write() → AtomEngine + KnowledgeStore         │  │
│  │               search() → AtomEngine + KnowledgeStore          │  │
│  │               persist() → SQLite atom 表                     │  │
│  ├─ AtomEngine (runtime/atom-engine.ts)                          │  │
│  │  核心抽象: 一切皆 Atom (31 种类型)                            │  │
│  │  内存: Map<id, Atom> + 3 索引 (kind/source/parent)            │  │
│  │  持久化: SQLite (initPersist → persist upsert → load)         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ CognitivePipeline (pipeline/cognitive-pipeline.ts) ──────────┐  │
│  │  run(): classify → knowledge → reasoning → constraint         │  │
│  │         → action → reflection                                 │  │
│  │  runWithLLM(): L1确定→L2本地LLM→L3云→L4规则                  │  │
│  │  runFullWithLLM(): 降级链 + TaskGraph 执行                    │  │
│  │  每步发布 eventBus 事件 + 更新 worldState (状态式交互)        │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ PersonaLoader (persona/loader.ts) ───────────────────────────┐  │
│  │  8 模式: plan/code/retrieve/reflect/audit/creative/           │  │
│  │          research/general                                     │  │
│  │  切换 = 注入 Constraints + 激活 MentalModels                  │  │
│  │         + 选择 CapabilityProvider                              │  │
│  │  PromptTemplateStore: 8 预设模板                              │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ├─ ReasoningRuntime (8阶推理 + verification-engine)                │
│  ├─ ConsciousnessStream (工作记忆/情景记忆/反思)                    │
│  ├─ ConstraintSolver (5维/12类型/4组预注册)                        │
│  ├─ MentalModelPool (4预注册状态机模型)                             │
│  ├─ ActorSystem (4行为: knowledge/constraint/mental-model/reasoning)│
│  ├─ WorldState + EventBus (状态树 + 事件总线)                      │
│  ├─ ResourceBudgetManager (硬件无关资源预算)                       │
│  └─ ConfigLoader (env → KernelConfig)                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、核心模块详解

### 2.1 Kernel — 极薄启动器

**文件:** `src/dre/kernel.ts` (174 行)

**设计理念:** Kernel 不做任何业务逻辑。它只做三件事: (1) 通过 `init()` 启动所有子系统, (2) 通过 `tick()` 驱动循环, (3) 通过 `shutdown()` 优雅关闭。

**为什么这么设计?** 原有 design 中将启动逻辑、业务逻辑、调度逻辑混在同一个模块中 (旧 kernel.ts 969 行)。拆分为 Kernel + DREngine 后, Kernel 是启动器, DREngine 是引擎, Scheduler 是调度器 — 各司其职, 单一职责。

**生命周期:**
```
new Kernel(config)
  → DREngine 同步创建
  → await kernel.init()
    → await engine.waitForReady()   // Actor 系统就绪
    → startTickLoop()               // 自动定时 tick
    → 注册 reasoning.request / task.failed 事件
  → tick loop (每 10s)
    → 更新心跳到 worldState
    → scheduler.getNext() → actors.send() → scheduler.complete()
    → eventBus.publish("kernel.tick")
  → await kernel.shutdown()
    → stopTickLoop()
    → engine.close()                 // try/catch 保护 db + sqliteBackend
```

```typescript
constructor(config: KernelConfig) {
  this.engine = new DREngine(config);
  this._startTime = Date.now();
}

async init(): Promise<void> {
  await this.engine.waitForReady();
  // 检查资源预算
  if (!getResourceBudgetManager().getStatus().canRunLocal)
    logger.warn("Local inference unavailable");
  if (config.autoTick !== false) this.startTickLoop();
  // 订阅关键事件, 更新 worldState
  eventBus.subscribe("reasoning.request", (event) => {
    worldState.set("cognitive.lastRequest", { type: event.type, timestamp: Date.now() });
  });
}

async tick(source: string = "manual"): Promise<void> {
  this._tickCount++;
  this._state = "running";
  try {
    worldState.set("system.heartbeat", { tick: this._tickCount, source, timestamp: this._lastTickTime });
    const nextTask = scheduler.getNext();
    if (nextTask) {
      try {
        // TaskGraph 任务 → Actor 系统 — 5 个位置参数
        this.engine.actors.send("kernel", nextTask.assignedTo || "knowledge", "request", "execute", nextTask);
        scheduler.complete(nextTask.id, { dispatched: true });
      } catch (err) {
        scheduler.fail(nextTask.id, (err as Error).message);
      }
    }
    eventBus.publish({ type: "kernel.tick", source: "kernel", data: { tick: this._tickCount, source } });
  } catch (err) {
    logger.error("[Kernel] Tick error", { error: (err as Error).message });
  } finally {
    this._state = prevState === "running" ? "running" : "idle";
  }
}

async shutdown(): Promise<void> {
  this._state = "stopped";
  this.stopTickLoop();
  await this.engine.close();
}
```

**关键设计决策:**
- `init()` 不阻塞 MCP 服务器启动 (异步调用, catch 错误)
- `tick()` 的 `try/catch/finally` 确保 `_state` 始终一致
- `actors.send()` 使用 5 个位置参数而非对象 (与 ActorSystem 接口一致)
- `engine.close()` 中 `db.close()` 和 `sqliteBackend.close()` 各自包裹 try/catch, 防止一个失败阻塞另一个
```

**关键数据:** `_state: "initializing"|"running"|"idle"|"stopped"`, `_tickTimer: setInterval`

---

### 2.2 DREngine — 引擎主入口

**文件:** `src/dre/engine.ts` (700 行)

**职责:** 整合所有子系统。构造函数同步初始化 12 个模块, 对外提供统一 API。

**初始化顺序 (构造函数的 12 步):**
```
1. SQLite Database           → 持久化存储
2. VFS (4 mount points)      → 文件抽象层 (/kb, /proj, /cache, /log)
3. KnowledgeStore            → 知识 CRUD + FTS5 搜索
4. ★ DataUnifier             → 统一数据入口 (Atom + KnowledgeStore + autoPersist)
5. LLMClient × 2             → 主模型 + 甄别模型
6. Pipeline                  → 三段甄别 (prefilter → webverify → llmverify)
7. KnowledgeGraph            → 图谱关系
8. MentalModelPool           → 4 个预注册状态机模型
9. ReasoningGraph            → 推理图 + 缺口检测
10. ConstraintSolver         → 5 维约束 (含 RESOURCE + POLICY + TEMPORAL + AUDIT)
11. ★ PersonaLoader          → 8 模式角色 (替代 AgentHarness)
12. ActorSystem (async)      → 4 行为 (knowledge/constraint/mental-model/reasoning)
13. ConsciousnessStream      → 3 层记忆 + 反思
14. checkResourceBudget()    → 非阻塞资源检查
```

**关键设计决策:**
- 所有模块构造是同步的, 只有 ActorSystem 异步注册行为 — 通过 `waitForReady()` 等待
- `DREngine` 的所有子系统属性是 `readonly public` — 外部代码可以直接访问, 无需经过代理方法
- `writeKnowledge()` 同时写入 Three 个存储: AtomEngine (内存) → KnowledgeStore (SQLite FTS5) → KnowledgeGraph (图谱关系)
- `getCognitiveState()` 聚合 8 个子系统状态为单一可查询结构

```typescript
export class DREngine {
  readonly data: DataUnifier;       // ★ v3.1 — 所有读写经过这里
  readonly persona: PersonaLoader;  // ★ v3.0 — 替代 AgentHarness

  constructor(config: DREConfig) {
    this.db = new Database(config.dbPath);
    this.sqliteBackend = new SqliteBackend(config.dbPath);
    this.knowledgeStore = new KnowledgeStore(this.db);
    this.data = dataUnifier;
    this.data.init(this.db, this.knowledgeStore);
    this.data.setAutoPersist(true);   // 每次写入自动持久化 Atom
    this.mainLLM = new LLMClient(config.mainLLM);
    this.mentalModels = createDefaultMentalModelPool();
    this.reasoning = new ReasoningGraph();
    this.constraints = createDefaultConstraintSolver();
    this.persona = new PersonaLoader({ constraintSolver: this.constraints, defaultPersona: "general" });
    this.actors = new ActorSystem();
    this.initActors();
    this.consciousness = new ConsciousnessStream({ workingMemoryCapacity: 16, episodicTTL: 3600000 });
    this.checkResourceBudget();
  }

  // 写入知识 — 三步: 甄别 → 统一写入 → 图谱同步
  async writeKnowledge(item: KnowledgeItem) {
    const result = await this.pipeline.process(item);   // 三段甄别
    if (result.accepted) {
      this.data.write({ id: item.id, content, kind: "entity", domain, paradigm, sourceType });
      this.syncToKG(item);                               // 图谱关系
    }
    return result;
  }

  // ★ v3.1 — 通过 DataUnifier 统一搜索
  searchData(query: string, options?) {
    return this.data.search(query, options);  // 同时搜 Atom + KnowledgeStore
  }

  // ★ v3.1 — 统一认知状态查询
  getCognitiveState() {
    return {
      persona: { mode, name, temperature, allowWrite, canUseTools, stackDepth, switchCount },
      consciousness: { workingMemorySize, episodicMemorySize, traceLength, reflectionCount, lastReflectionAt },
      reasoning: reasoningStats,
      constraints: constraintStats,
      goals: Object.entries(worldState.getGoals()).map(([id, g]) => ({ id, description, status })),
      beliefs: Object.values(worldState.getBeliefs()).map((b) => ({ statement, confidence })),
      hypotheses: Object.values(worldState.getHypotheses()).map((h) => ({ statement, status })),
      resource: { availableMemory, canRunLocal },
    };
  }

  // 3 级 LLM 降级链
  async consciousnessStep(input) {
    try { return await this.consciousness.step(input); }           // L1: 本地 LLM
    catch { if (cloudFallback) return await cloudConsciousnessStep(input); }  // L2: 云 API
    catch { return ruleBasedConsciousnessStep(input); }            // L3: 规则推理
  }

  async close(): Promise<void> {
    await this.actors.shutdown();
    try { this.db.close(); } catch (err) { logger.warn("[DRE] DB close error", ...); }
    try { this.sqliteBackend.close(); } catch (err) { logger.warn("[DRE] SQLite close error", ...); }
  }
}

  // 搜索数据 — 通过 DataUnifier 统一搜索 (Atom + KnowledgeStore)
  searchData(query: string, options?) {
    return this.data.search(query, options);
  }

  // 统一认知状态查询 — 聚合 Persona/意识流/推理/约束/目标/资源
  getCognitiveState() {
    return {
      persona: { mode, name, temperature, allowWrite, ... },
      consciousness: { workingMemorySize, episodicMemorySize, ... },
      reasoning: { totalNodes, totalEdges, gaps },
      constraints: { total, byDimension },
      goals: Object.entries(worldState.getGoals()).map(...),
      beliefs: Object.values(worldState.getBeliefs()).map(...),
      resource: { availableMemory, canRunLocal },
    };
  }
}
```

**3 级 LLM 降级链 (consciousnessStep):**

```typescript
// L1: 本地 LLM
try { return await this.consciousness.step(input); }
// L2: 云 API
catch { if (cloudFallback) return await cloudConsciousnessStep(input); }
// L3: 规则推理 (零 LLM)
catch { return ruleBasedConsciousnessStep(input); }
```

---

### 2.3 DataUnifier — 统一数据入口 ★ v3.1

**文件:** `src/dre/runtime/data-unifier.ts` (167 行)

**设计:** 替代 VFS + KnowledgeStore + AtomEngine 三个独立入口。所有读写经过这里。

```typescript
export class DataUnifier {
  // 写入 — 三步: Atom → KnowledgeStore → autoPersist
  write(item: DataItem): { atom: Atom; knowledgeNode?: KnowledgeNode } {
    const atom = atomStore.create(item.kind, item.content, {
      metadata: { domain, paradigm, sourceType },
      confidence: item.confidence ?? "inferred",
    });
    if (this.knowledgeStore) {
      this.knowledgeStore.write({ id: atom.id, title, content, domain, paradigm, sourceType });
    }
    if (this.autoPersist && this.db) atomStore.persist(this.db);
    return { atom, knowledgeNode };
  }

  // 搜索 — 双源: Atom 内存搜索 + KnowledgeStore FTS5
  search(query: string, options?: SearchOptions): SearchResult {
    const atoms = atomStore.search(query, options.limit ?? 20);
    const knowledgeNodes = this.knowledgeStore?.search(query, options) ?? [];
    return { atoms, knowledgeNodes };
  }
}
```

**AtomEngine 同步持久化:**

```typescript
// atom-engine.ts
initPersist(db) {
  db.run(`CREATE TABLE IF NOT EXISTS atom (...) `);
}
persist(db) {
  const stmt = db.prepare(`INSERT INTO atom VALUES (...) ON CONFLICT(id) DO UPDATE SET ...`);
  db.transaction(() => { for (const atom of atoms.values()) stmt.run(atom); })();
}
load(db): number {
  const rows = db.query(`SELECT * FROM atom`).all();
  for (const row of rows) { /* rebuild Atom + indexes */ }
}
```

---

### 2.4 CognitivePipeline — 认知管道

**文件:** `src/dre/pipeline/cognitive-pipeline.ts` (564 行)

**6 步确定性闭环 + 4 级 LLM 降级 + TaskGraph 执行:**

#### run() — 纯确定性 (6 步)
```typescript
async run(input: string): Promise<CognitiveLoopResult> {
  // 1. classify — 零 LLM 关键词分类 (intent, domain, entities)
  const classification = this.classify(input);
  // 2. knowledge — 搜索相关知识 (通过 DataUnifier)
  const knowledge = this.engine.searchData(query, { limit: 8 });
  // 3. reasoning — 构建推理图, 检测 Gap
  const { conclusionNode, gaps } = this.buildReasoning(knowledge, input);
  // 4. constraint — 约束校验
  const constraintPassed = constraints.check(conclusionNode.content).satisfied;
  // 5. action — 推荐动作
  const recommendedAction = classification.action ?? conclusionNode.content;
  // 6. reflection — 反思
  const cs = await this.engine.consciousnessStep({ observation, metadata });
}
```

#### runWithLLM() — 4 级降级链
```typescript
async runWithLLM(input) {
  // L1: 确定性
  const deterministic = await this.run(input);
  if (deterministic.conclusion && !deterministic.hasGaps) return { ...deterministic, fallbackLevel: "deterministic" };

  // L2-L4: 通过 consciousnessStep 的 3 级降级
  const llmResult = await this.engine.consciousnessStep({ observation: input });
  return { ...deterministic, conclusion: llmResult.decision, fallbackLevel: llmResult.fallbackLevel };
}
```

#### runFullWithLLM() — 降级链 + TaskGraph ★ v3.1
```typescript
async runFullWithLLM(input) {
  const base = await this.runWithLLM(input);
  if (!base.recommendedAction || !base.constraintPassed) return base;
  const graph = new TaskGraph();
  graph.addTask("exec-action", base.recommendedAction, async () => {
    await this.engine.actors.send("pipeline", "knowledge", "request", "execute", {
      action: base.recommendedAction, llmAssisted: base.fallbackLevel !== "deterministic",
    });
  }, { rollback: async () => { /* undo */ } });
  await graph.executeAll();
  return { ...base, executionGraph: graph.getStatus() };
}
```

#### 状态式交互 — 每步发布状态
```typescript
// 每步结束后自动发布:
eventBus.publish({ type: `cognitive.step.${stage}`, source: "cognitive-pipeline", data: { step, stage, output } });
worldState.set(`cognitive.pipeline.step.${stepIndex}`, { stage, output, durationMs });
worldState.setGoal(`goal_${Date.now()}`, input, "active");
```

#### classify() — 零 LLM 关键词分类
```typescript
private classify(input: string) {
  const lower = input.toLowerCase();
  const intents: Record<string, string> = {
    troubleshoot: ["error", "fix", "bug", "crash", "fail", "不工作", "崩溃", "错误", "修复"],
    refactor: ["refactor", "optimize", "clean", "重构", "优化", "清理"],
    create: ["create", "new", "add", "implement", "创建", "新建", "添加", "实现"],
    // ... 9 种意图
  };
  for (const [intent, keywords] of Object.entries(intents)) {
    if (keywords.some((k) => lower.includes(k))) { result.intent = intent; break; }
  }
  return result;
}
```

---

### 2.5 PersonaLoader — 角色加载器 ★ v3.0

**文件:** `src/dre/persona/loader.ts` (431 行)

**设计:** Persona ≠ Agent。Persona = Constraints + MentalModels + Capabilities + PromptTemplate。

```typescript
export class PersonaLoader {
  private context: PersonaContext;  // { current, stack[], history[] }
  private promptStore: PromptTemplateStore;

  // 切换 Persona — 压栈 + 卸载旧 + 应用新
  switchTo(mode: PersonaMode, reason = "manual"): LoadedPersona {
    this.context.stack.push(this.context.current);       // 保存旧
    this.unapplyPersona(this.context.current);            // 卸载约束/模型/能力
    const loaded = this.resolveAndApply(mode);            // 加载新
    this.context.current = loaded;
    return loaded;
  }

  // 弹栈 — 返回上一个 Persona
  popToPrevious(): LoadedPersona | null {
    const prev = this.context.stack.pop();
    if (!prev) return null;
    this.unapplyPersona(this.context.current);
    this.applyPersona(prev);
    this.context.current = prev;
    return prev;
  }

  // 应用 Persona — 3 步: 约束 + 心智模型 + 能力供应商
  private applyPersona(persona: LoadedPersona): void {
    // 1. 注入约束 (如 audit → 禁止写/删除/执行)
    this.constraintSolver?.registerAll(persona.config.constraints);
    // 2. 激活心智模型
    this.mentalModelPool?.activate(modelId);
    // 3. 自动选择 Capability Provider
    for (const contract of persona.config.requiredCapabilities) {
      capabilityRegistry.select(contract, {
        maxCost: persona.config.mode === "audit" ? 0 : undefined,
        maxLatency: persona.config.mode === "plan" ? 1000 : undefined,
      });
    }
  }
}
```

#### 8 种内置 Persona 配置

```typescript
const BUILTIN_PERSONA_BASE: Record<PersonaMode, PersonaConfigBase> = {
  plan:     { temperature: 0,   allowWrite: false, promptTemplateId: "prompt-plan" },
  code:     { temperature: 0,   allowWrite: true,  promptTemplateId: "prompt-code" },
  retrieve: { temperature: 0,   allowWrite: false, promptTemplateId: "prompt-retrieve" },
  reflect:  { temperature: 0,   allowWrite: true,  promptTemplateId: "prompt-reflect" },
  audit:    { temperature: 0,   allowWrite: false, promptTemplateId: "prompt-audit" },
  creative: { temperature: 0.7, allowWrite: true,  promptTemplateId: "prompt-creative" },
  research: { temperature: 0.1, allowWrite: true,  promptTemplateId: "prompt-research" },
  general:  { temperature: 0.3, allowWrite: true,  promptTemplateId: "prompt-general" },
};

// 各模式的能力契约映射
private builtinCapabilities(mode: PersonaMode): CapabilityContract[] {
  switch (mode) {
    case "audit":    return ["code.review", "verification.factual"];
    case "code":     return ["code.reasoning", "code.generation", "code.review"];
    case "research": return ["research.synthesis", "reasoning.analogical", "architecture.analysis"];
    case "creative": return ["generation.creative"];
    default:         return [];
  }
}
```

#### PromptTemplateStore — 8 个预设模板

```typescript
const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  { id: "prompt-plan", mode: "plan",
    systemPrompt: `你是一个确定性规划器。\n【硬性约束】\n- 必须输出 JSON 格式的执行计划...`,
    variables: ["tools"], temperature: 0, maxTokens: 4096 },
  { id: "prompt-audit", mode: "audit",
    systemPrompt: `你是一个安全审计专家。\n【硬性约束】\n- 只读模式，严禁执行写操作...`,
    variables: ["tools"], temperature: 0, maxTokens: 4096 },
  { id: "prompt-creative", mode: "creative",
    systemPrompt: `你是一个创意协作伙伴。\n- 鼓励发散思维...`,
    variables: [], temperature: 0.7, maxTokens: 8192 },
  // ... 共 8 个模板
];

render(id: string, variables: TemplateVariables = {}): string {
  const template = this.templates.get(id);
  let rendered = template.systemPrompt;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return rendered;
}
```

---

### 2.6 ConsciousnessStream — 意识流

**文件:** `src/dre/consciousness/stream.ts` (557 行)

**3 层记忆 + 反思 + 记忆整合:**

```typescript
// ── 工作记忆 (WorkingMemory) — FIFO 有限缓冲 ──
class WorkingMemory {
  push(item: MemoryItem): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift(); // 淘汰最老
  }
}

// ── 情景记忆 (EpisodicMemory) — 向量索引 + TTL + 档案 ──
class EpisodicMemory {
  search(queryEmbedding: number[], k: number = 5): MemoryItem[] {
    return this.items
      .filter((item) => item.embedding)
      .map((item) => ({ item, score: this.cosineSimilarity(queryEmbedding, item.embedding!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => s.item);
  }

  // ★ v3.1: 归档过期记忆
  archive(): MemoryItem[] {
    const expired = this.items.filter((item) => (item.ttl ?? 0) <= now);
    this.items = this.items.filter((item) => (item.ttl ?? 0) > now);
    return expired;
  }

  // ★ v3.1: 记忆整合 — 相似记忆合并为模式
  consolidate(threshold = 0.7) {
    // 余弦相似度 > threshold → 聚为一类
    // 返回 { pattern, occurrences, confidence, sourceIds }[]
  }
}

// ── 意识流 (ConsciousnessStream) — 核心循环 ──
class ConsciousnessStream extends EventEmitter {
  async step(input): Promise<{ decision; shouldReflect; reflection }> {
    // 1. 推入工作记忆
    this.workingMemory.push({ id, content: input.observation, timestamp, metadata });
    // 2. 如果有嵌入, 存入情景记忆
    if (input.embedding) this.episodicMemory.add({ ...input, ... });
    // 3. 决策 (由外部覆盖)
    const decision = await this.decide(input.observation);
    // 4. 记录追踪
    this.trace.push({ stepSeq, stepType, inputHash, outputHash, status: "success", timestamp });
    // 5. 反思检查 (3 触发器)
    const reflection = this.reflectionQueue.shouldReflect(this.trace);
    if (reflection.triggered) {
      const result = await this.reflect(reflection);
      this.emit("reflection", result);
    }
  }

  // ★ v3.1: 归档 + 整合 + 清理 (三步)
  archiveAndConsolidate() {
    const patterns = this.episodicMemory.consolidate();
    const archived = this.episodicMemory.archive();
    const removed = this.episodicMemory.cleanup();
    return { archived, patterns, removed };
  }
}

// ── 反思队列 (ReflectionQueue) — 3 个触发器 ──
class ReflectionQueue {
  shouldReflect(trace): { triggered, issues, lessons } {
    // T1: 连续失败 >= 3 次
    // T2: 输出哈希去重率 < 70% (幻觉检测)
    // T3: 置信度标准差 > 0.15
  }
}
```

---

### 2.7 VerificationEngine — 验证引擎 ★ v3.0

**文件:** `src/dre/runtime/verification-engine.ts` (247 行)

```typescript
// 4 层验证 + LLM fallback 决策
verifyResult(executionId, result, opts?): VerificationReport {
  // Layer 1: Output — 结果非空/长度足够
  if (result == null) { scores.output = 0; scores.constraint = 0; scores.reasoning = 0; scores.evidence = 0; }

  // Layer 2: Constraint — 约束求解器校验
  if (opts?.constraintSolver) {
    const check = opts.constraintSolver.check([String(result)]);
    if (!check.satisfied) scores.constraint = 0;
  }

  // Layer 3: Reasoning — 推理链路完整性
  if (opts?.reasoningGraph) {
    const stats = opts.reasoningGraph.getStats();
    if (stats.gaps > 0) scores.reasoning = Math.max(0, 1 - stats.gaps / stats.totalNodes);
  }

  // Layer 4: Evidence — 证据引用检查
  if (typeof result === "string" && !result.includes("evidence") && !result.includes("source")) {
    scores.evidence = 0.3;
  }

  const overallScore = (scores.output + scores.constraint + scores.reasoning + scores.evidence) / 4;
  const overallVerdict = overallScore >= 0.6 ? "pass" : overallScore >= 0.5 ? "uncertain" : "fail";
  const needsLLM = overallVerdict === "fail" || (overallVerdict === "uncertain" && issues.some((i) => i.severity >= 7));
  return { overallVerdict, overallConfidence: overallScore, issues, needsLLM, ... };
}
```

**集成到 ReasoningRuntime Stage 8:**
```typescript
// reasoning-runtime.ts — Stage 8
this.registerStage("verification", async (ctx) => {
  if (ctx.result && !ctx.needsLLM) {
    const report = verificationEngine.verifyResult(`pipeline_${Date.now()}`, JSON.stringify(ctx.result));
    if (!report.verified && report.overallConfidence < 0.5) ctx.needsLLM = true;
  }
});
```

---

### 2.8 ReasoningRuntime — 8 阶推理引擎

**文件:** `src/dre/runtime/reasoner/reasoning-runtime.ts` (431 行)

**事件驱动:** 订阅 `reasoning.request` → 执行 8 阶管道 → 发布 `reasoning.result`

```typescript
class ReasoningRuntime {
  private stages = new Map<string, StageHandler>();

  constructor() {
    this.registerDefaultStages();
    eventBus.subscribe("reasoning.request", (event) => this.run(event.data.input));
  }

  // 8 阶管道
  async run(input: string): Promise<PipelineContext> {
    const ctx: PipelineContext = { input, atoms: [], entities: [], needsLLM: false, ... };
    for (const [name, handler] of this.stages) {
      await handler(ctx);
      if (ctx.result && !ctx.needsLLM) break;  // 提前退出
    }
    if (ctx.needsLLM) eventBus.publish({ type: "pipeline.llm_needed", ... });
    return ctx;
  }

  // 默认 8 阶
  private registerDefaultStages() {
    this.registerStage("observation",        async (ctx) => { /* 搜 atomStore + memory + knowledgeNetwork */ });
    this.registerStage("normalization",      async (ctx) => { /* 去重 */ });
    this.registerStage("entity-resolution",  async (ctx) => { /* 识别已知实体 */ });
    this.registerStage("state-update",       async (ctx) => { /* 更新 worldState */ });
    this.registerStage("constraint-check",   async (ctx) => { /* constraintSolver.solve() */ });
    this.registerStage("graph-reasoning",    async (ctx) => { /* 遍历知识图谱 */ });
    this.registerStage("planning",           async (ctx) => { /* 确定性分解; 失败 → needsLLM=t */ });
    this.registerStage("verification",       async (ctx) => { /* verificationEngine.verifyResult() */ });
  }
}
```

---

### 2.9 ConstraintSolver — 多维约束求解器

**文件:** `src/dre/constraint/solver.ts` (656 行)

```typescript
class ConstraintSolver {
  private constraints = new Map<string, Constraint>();
  private context: Record<string, unknown> = {};

  // 注册约束
  register(c: Constraint): void { this.constraints.set(c.id, c); }

  // 检查动作 — 遍历所有启用约束, 收集违反
  check(action: string[], extraContext?: Record<string, unknown>): ConstraintCheckResult {
    const context = { ...this.context, ...extraContext };
    const violations: ConstraintViolation[] = [];
    for (const c of this.constraints.values()) {
      if (!c.enabled) continue;
      const v = this.evaluate(c, action, context);
      if (v) violations.push(v);
    }
    return { satisfied: violations.length === 0, violations, ... };
  }

  // 5 维度评估器
  private evaluate(c: Constraint, action: string[], context: Record<string, unknown>): ConstraintViolation | null {
    switch (c.dimension) {
      case "logical":  return this.evaluateLogical(c, action, context);
      case "physical": return this.evaluatePhysical(c, context);   // 数值比较 (min_value/max_value/between)
      case "semantic": return this.evaluateSemantic(c, context);   // 字符串匹配 (equals/in_set)
      case "policy":   return this.evaluatePolicy(c, context);     // 环境校验 (not_equals)
      case "temporal": return this.evaluateTemporal();             // 时间范围 (between 9-18)
    }
  }
}
```

**预注册约束组 (4 组):**
- `RESOURCE_CONSTRAINTS`: memory-min(500MB), memory-model(1100MB)
- `POLICY_CONSTRAINTS`: prod-no-delete, prod-no-experimental
- `TEMPORAL_CONSTRAINTS`: work-hours-only (9-18, 默认禁用)
- `AUDIT_CONSTRAINTS`: no-write, no-delete, no-exec (Persona 使用)

---

### 2.10 MentalModelPool — 心智模型池

**文件:** `src/dre/mental-model/pool.ts` (572 行)

**设计:** 有限状态机 + 概念图 + 规则 + 模拟 + 技能生成

```typescript
interface MentalModel {
  id: string; name: string; domain: string;        // "git-conflict", "code-refactor"
  concepts: ModelConcept[];                         // 概念节点 + 关系
  transitions: StateTransition[];                   // 状态机: fromState→toState + trigger
  initialState: string; currentState: string;       // 当前状态
  rules: ModelRule[];                               // condition→action
  simulations: Simulation[];                        // what-if 演练历史
}

class MentalModelPool {
  // 模式匹配 — 观察 → 概念链 + 状态路径
  matchPattern(modelId: string, observations: string[]): ModelPattern | null {
    // 直接匹配: 概念名匹配观察
    // 关系扩展: may-cause/requires 关系链
    // 状态路径: BFS 沿转换走
  }

  // 预测 — 当前状态 + 观察 → 下一状态
  predict(modelId: string, observation: string) {
    const candidates = model.transitions.filter((t) => t.fromState === model.currentState);
    return candidates.find((t) => observation.includes(t.trigger)) ?? candidates[0];
  }

  // 模拟 — what-if 演练
  simulate(modelId: string, scenario: string, initialState) {
    // 应用规则 → 评估条件 → 执行动作 → 产生新状态
    // 返回 Simulation { steps, outcome, confidence }
  }
}
```

**4 个预注册模型:**
| 模型 | 状态机 | 概念 | 转换 |
|------|--------|------|------|
| `git-conflict` | clean → merging → conflict → resolved → clean | 6 | 5 |
| `code-refactor` | smelly → analyzing → testing → refactoring → verifying → clean | 4 | 6 |
| `auth-flow` | anonymous → authenticating → authorized → session-expired | 4 | 4 |
| `database-tx` | idle → active → committing → committed/rolled-back | 4 | 5 |

---

### 2.11 TaskGraph — DAG 任务执行 + MCP 工具调用 ★ v3.1

**文件:** `src/dre/pipeline/task-graph.ts` (397 行)

**设计:** DAG 执行 + 回滚 + 检查点/恢复 + **MCP 工具直接调用**。

```typescript
// 工具执行器 — TaskGraph 节点可直接调用任意 MCP 工具
export type ToolExecutor = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

class TaskGraph {
  private toolExecutor: ToolExecutor | null = null;

  // 注册 MCP 工具执行器 (由 CognitivePipeline 传入)
  setToolExecutor(executor: ToolExecutor): void { this.toolExecutor = executor; }

  // Task 内部可调用任意 MCP 工具
  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {

**MCP tool calling example:**
```
graph.addTask("analyze", "Analyze code", async () => {
  const symbols = await graph.callTool("code_symbols", { path: "/src/main.ts" });
  return { symbols };
});
```

**Injection flow:**
1. MCP server creates CognitivePipeline with: `pipeline.setToolExecutor(async (name, args) => registry.buildHttpHandlers()[name](args))`
2. CognitivePipeline creates TaskGraph with: `graph.setToolExecutor(this.toolExecutor)`
3. Task calls: `graph.callTool(name, args)` -> direct MCP tool handler
    if (!this.toolExecutor) throw new Error(`ToolExecutor not set`);
    return this.toolExecutor(toolName, args);
  }

```typescript
class TaskGraph {
  private tasks = new Map<string, Task>();
  private status: TaskGraphStatus = "running";

  addTask(id: string, description: string, execute: () => Promise<unknown>, opts?: { dependsOn?: string[]; rollback?: () => Promise<void> }): void {
    this.tasks.set(id, { id, description, execute, rollback, dependsOn, status: "pending" });
  }

  async executeAll(): Promise<void> {
    this.validateNoCycles();                          // DFS 环检测
    const ready = this.getReadyTasks();               // 依赖已满足的任务
    const results = await Promise.all(ready.map((t) => t.execute()));  // 并行执行
    if (results.some((r) => r instanceof Error)) { this.rollbackAll(); return; }
    // 重复直到无可用任务
  }

  async checkpoint(store: KnowledgeStore): Promise<string> {
    const snapshot: TaskGraphSnapshot = {
      tasks: Array.from(this.tasks.values()).map((t) => ({ id, description, status, dependsOn })),
      status: this.status, timestamp: Date.now(),
    };
    return store.write({ id: `checkpoint_${Date.now()}`, title, content: JSON.stringify(snapshot), ... });
  }

  static async resume(store: KnowledgeStore, checkpointId: string): Promise<TaskGraph> {
    const node = store.read(checkpointId);
    const snapshot = JSON.parse(node.content) as TaskGraphSnapshot;
    const graph = new TaskGraph();
    for (const t of snapshot.tasks) {
      graph.addTask(t.id, t.description, async () => { throw new Error("Cannot re-execute"); }, { dependsOn: t.dependsOn });
    }
    return graph;
  }
}
```

---

### 2.12 EventBus — 发布订阅事件总线

**文件:** `src/dre/runtime/event-bus.ts` (121 行)

```typescript
class EventBusImpl extends EventEmitter {
  private log: RuntimeEvent[] = [];       // 循环日志 (max 1000)

  publish(event: RuntimeEvent): RuntimeEvent {
    event.id = `evt_${Date.now()}_${random}`;
    event.timestamp = Date.now();
    this.log.push(event);                  // 记录
    if (this.log.length > 1000) this.log.shift();

    const handlers = this.handlers.get(event.type) ?? [];
    handlers.sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);
    for (const h of handlers) {
      try { h.handler(event); } catch (err) { /* 记录错误, 不中断 */ }
    }
    return event;
  }

  subscribe(eventType: string, handler: Handler, priority: EventPriority = "normal"): string { ... }
  subscribeOnce(eventType: string, handler: Handler, priority: EventPriority = "normal"): string { ... }
  unsubscribe(id: string): void { ... }
  getRecentEvents(count = 20): RuntimeEvent[] { return this.log.slice(-count); }
}
```

**事件类型系统:**

```typescript
interface RuntimeEvent {
  id: string;
  type: string;           // "reasoning.request" | "pipeline.completed" | "cognitive.step.*" | "kernel.tick" | ...
  source: string;
  data: unknown;
  priority: EventPriority; // "critical" | "high" | "normal" | "low" | "background"
  timestamp: number;
  correlationId?: string;
  replyTo?: string;
}
```

---

### 2.13 WorldState — 全局状态树

**文件:** `src/dre/runtime/world-state.ts` (148 行)

```typescript
class WorldStateImpl {
  private state = new Map<string, unknown>();
  private version = 0;

  // 核心读写
  get<T>(path: string): T | undefined { return this.state.get(path) as T; }
  set<T>(path: string, value: T): void {
    this.state.set(path, value);
    this.version++;
    this.notifyWatchers(path, value);
    eventBus.publish({ type: "state.changed", source: "world-state", data: { path, value } });
  }

  // 认知维度
  setIntent(intent: string, confidence: number): void { this.set("mental.intent", { intent, confidence, timestamp }); }
  setGoal(goalId: string, description: string, status: "active"|"completed"|"abandoned"): void {
    this.set(`mental.goals.${goalId}`, { description, status, timestamp });
  }
  setBelief(beliefId: string, statement: string, confidence: number): void { ... }
  setHypothesis(id: string, statement: string, status: string): void { ... }

  // 观察者模式
  watch(path: string, listener: (value: unknown) => void): () => void { /* 返回取消函数 */ }

  // 快照
  snapshot(): Record<string, unknown> { return Object.fromEntries(this.state); }
}
```

---

### 2.14 ConfigLoader — 配置加载器 ★ v3.1

**文件:** `src/dre/config.ts` (142 行)

```typescript
class ConfigLoader {
  private source: ConfigSource;

  constructor(source?: ConfigSource) {
    this.source = { ...this.loadFromEnv(), ...source };  // 优先级: explicit > env > defaults
  }

  private loadFromEnv(): ConfigSource {
    const ENV_MAP: Record<string, keyof ConfigSource> = {
      DRE_DB_PATH: "dbPath", DRE_LLM_URL: "llmUrl", DRE_LLM_MODEL: "llmModel",
      DRE_TICK_INTERVAL: "tickInterval", DRE_AUTO_TICK: "autoTick",
      DEEPSEEK_API_KEY: "cloudApiKey", DEEPSEEK_MODEL: "cloudModel",
      // ... 15 个环境变量
    };
    for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
      const value = process.env[envKey];
      if (value) { /* 类型推断: number/boolean/string */ }
    }
  }

  toKernelConfig(): KernelConfig {
    return {
      dbPath: merged.dbPath,
      mainLLM: { baseUrl: merged.llmUrl, model: merged.llmModel, temperature: merged.llmTemperature },
      discriminLLM: merged.discriminUrl ? { baseUrl: merged.discriminUrl, ... } : undefined,
      cloudFallback: merged.cloudApiKey ? { baseUrl: merged.cloudBaseUrl, apiKey: merged.cloudApiKey, ... } : undefined,
      tickInterval: merged.tickInterval, autoTick: merged.autoTick,
    };
  }
}
```

---

### 2.15 ResourceBudgetManager — 资源预算 ★ v3.0

**文件:** `src/dre/system-resource.ts` (149 行)

```typescript
// 硬件无关 — 纯数字比较
class ResourceBudgetManager {
  private resource: SystemResource = { maxMemory: 4000, availableMemory: 4000, maxCompute: 100, availableCompute: 100, source: "default" };

  updateResource(resource: Partial<SystemResource>): void { /* 由外部插件注入 */ }

  canRun(): ResourceCheckResult {
    const required = this.modelMemoryMB + this.safetyMarginMB;   // 1100 + 200 = 1300MB
    if (this.resource.availableMemory < required) {
      return { canRun: false, reason: `Insufficient memory: ${available} < ${required}`, ... };
    }
    const maxTokens = Math.min(Math.floor(availableForKV * 1024 / bytesPerToken), maxTokensCap);
    return { canRun: true, recommendedMaxTokens: maxTokens, ... };
  }
}
```

---

### 2.16 LLMClient — LLM 客户端

**文件:** `src/dre/llm/client.ts` (325 行)

```typescript
class LLMClient {
  private baseUrl: string;
  private model: string;

  // 标准生成 (OpenAI-compatible /v1/chat/completions)
  async generate(prompt: string, options?: LLMGenerationOptions): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: this.model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        temperature: options?.temperature, max_tokens: options?.maxTokens, stop: options?.stop, seed: options?.seed,
      }),
    });
    const data = await response.json();
    return { content: data.choices[0].message.content, model: data.model, usage: data.usage, finishReason: data.choices[0].finish_reason };
  }

  // 流式生成 — AsyncGenerator
  async *streamGenerate(prompt: string, options?: LLMGenerationOptions): AsyncGenerator<string> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST", body: JSON.stringify({ ...options, stream: true }),
    });
    const reader = response.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = new TextDecoder().decode(value).split("\n").filter((l) => l.startsWith("data: "));
      for (const line of lines) {
        if (line.includes("[DONE]")) return;
        const parsed = JSON.parse(line.slice(6));
        yield parsed.choices[0].delta.content ?? "";
      }
    }
  }

  // 约束生成 — 拒绝采样 + 多数投票
  async generateConstrained(prompt: string, options: ConstrainedGenerationOptions): Promise<Record<string, unknown>> {
    const candidates: Record<string, unknown>[] = [];
    for (let i = 0; i < (options.n ?? 3); i++) {
      const response = await this.generate(prompt, { ...options, temperature: 0.7 });
      const parsed = safeJsonParse(response.content);
      if (parsed && this.validateSchema(parsed, options.schema)) candidates.push(parsed);
    }
    return this.selectMode(candidates);  // 多数投票
  }
}
```

---

## 三、MCP 工具完整清单

> 本系统共注册 133 个去重 MCP 工具。88 个零配置可用, 33 个需 API Key, 12 个需安装外部服务。

### 3.0 全工具总览

| 层 | 分类 | 数量 | 依赖 |
|---|------|------|------|
| 零配置 | Vault 记忆引擎 | 8 | Bun |
| 零配置 | 文件系统 | 6 | Bun |
| 零配置 | Git | 5 | Bun + Git |
| 零配置 | 代码分析 | 8 | Bun |
| 零配置 | 快照 | 5 | Bun |
| 零配置 | Prompt 池 | 6 | Bun |
| 零配置 | 竞技场 | 7 | Bun |
| 零配置 | 知识图谱增强 | 10 | Bun |
| 零配置 | DRE 引擎 | 6 | Bun |
| 零配置 | DRE Persona | 3 | Bun |
| 零配置 | DRE 认知管道 | 4 | Bun |
| 零配置 | DRE DataUnifier | 4 | Bun |
| 零配置 | KAL 知识访问 | 2 | Bun |
| 零配置 | DIP 文档处理 | 2 | Bun |
| 零配置 | 场景路由 | 2 | Bun |
| 零配置 | 心智模型 | 3 | Bun |
| 零配置 | 推理图 | 4 | Bun |
| 零配置 | 过程性知识 | 1 | Bun |
| 零配置 | 约束求解器 | 4 | Bun |
| 零配置 | Actor 系统 | 2 | Bun |
| 零配置 | TaskGraph | 1 | Bun |
| 零配置 | 其他 | 7 | Bun |
| 需配置 | GitHub | 22 | GITHUB_TOKEN |
| 需配置 | SerpAPI | 5 | SERPAPI_KEY |
| 需配置 | Web Search | 4 | SEARCH_API_KEY |
| 需配置 | Deep Research | 2 | DEEPSEEK_API_KEY |
| 需安装 | OpenCode | 5 | opencode CLI |
| 需安装 | Hermes | 4 | hermes CLI |
| 需安装 | OCR | 2 | Tesseract |
| 需安装 | Playwright | 1 | playwright |

### 3.1 DRE 领域工具 (16 个)


| 工具 | 模块 | 参数 | 返回值 | 版本 |
|------|------|------|--------|------|
| `dre_status` | Engine | — | engine 全量状态 | 2.0 |
| `dre_write_knowledge` | Pipeline | content, domain, paradigm, sourceType | accepted, verification | 2.0 |
| `dre_read_knowledge` | Knowledge | nodeId | KnowledgeNode | 2.0 |
| `dre_search_knowledge` | Knowledge | query, domain, paradigm, limit | KnowledgeNode[] | 2.0 |
| `dre_subgraph` | Knowledge | seedNodeId, depth | KnowledgeNode[] | 2.0 |
| `dre_consciousness_step` | Consciousness | observation | decision, fallbackLevel | 2.0 |
| `resource_status` | ResourceBudget | — | canRunLocal, resource | 3.0 |
| `cognitive_state` | Engine | — | persona+意识流+推理+约束+目标+资源+Atom统计 | 3.1 |
| `cognitive_pipeline_run` | Pipeline | input | CognitiveLoopResult + fallbackLevel | 3.1 |
| `cognitive_pipeline_run_full` | Pipeline | input | CognitiveLoopResult + executionGraph | 3.1 |
| `data_write` | DataUnifier | content, kind, domain | atomId, kind, content | 3.1 |
| `data_search` | DataUnifier | query, limit | atoms[], knowledgeNodes[] | 3.1 |
| `data_stats` | DataUnifier | — | total, byKind, created, updated, deleted | 3.1 |
| `data_persist` | DataUnifier | — | success, timestamp | 3.1 |
| `persona_switch` | Persona | mode, reason | mode, name, allowWrite, temperature | 3.0 |
| `persona_status` | Persona | — | currentPersona, stackDepth, temperature, canWrite | 3.0 |

### 3.2 DRE 辅助工具 (13 个)

| 工具 | 模块 |
|------|------|
| `persona_list` | Persona |
| `mental_model_list` / `mental_model_match` / `mental_model_predict` | MentalModel |
| `reasoning_build` / `reasoning_detect_gaps` / `reasoning_fill_gap` / `reasoning_result` | ReasoningGraph |
| `constraint_check` / `constraint_select_best` / `constraint_list` / `constraint_stats` | ConstraintSolver |
| `actor_list` / `actor_send` | ActorSystem |
| `task_graph_execute` | TaskGraph |

---

## 四、关键数据流

### 4.1 写入流

```
MCP tool: data_write
→ DREngine.writeKnowledge()
  → Pipeline.process(item)          // 三段甄别 (prefilter → webVerify → llmVerify)
  → DataUnifier.write(item)         // 统一数据入口
    → atomStore.create(kind, content)    // 内存 Atom (31 种类型)
    → atomStore.persist(db)              // SQLite atom 表 (autoPersist)
    → KnowledgeStore.write(id, content)  // SQLite knowledge_node 表 + FTS5
    → syncToKG()                         // KnowledgeGraph 图谱关系
  → eventBus.publish("knowledge.written")
  → worldState.set("knowledge.lastWritten", { id, title, timestamp })
```

### 4.2 推理流

```
MCP tool: cognitive_pipeline_run
→ CognitivePipeline.runWithLLM(input)
  ├─ L1: classify() → searchData() → buildReasoning() → constraintCheck()
  │      → action() → reflection()
  │      → 每步: eventBus.publish(`cognitive.step.${stage}`)
  │      → 每步: worldState.set(`cognitive.pipeline.step.N`, { ... })
  │
  ├─ L2: consciousnessStep() — 本地 LLM (Qwen3)
  ├─ L3: cloud API — DeepSeek (cloudFallback)
  └─ L4: rule-based — 关键词匹配
  │
  → worldState.setGoal(goalId, input, "completed"|"abandoned")
  → eventBus.publish("cognitive.pipeline.completed", result)
```

### 4.3 状态查询流

```
MCP tool: cognitive_state
→ DREngine.getCognitiveState()
  → PersonaLoader.getContextSummary()   // mode, name, stackDepth
  → ConsciousnessStream.getState()      // workingMemory, episodicMemory, trace
  → ReasoningGraph.getStats()           // nodes, edges, gaps
  → ConstraintSolver.getStats()         // total constraints, byDimension
  → WorldState.getGoals() + getBeliefs() + getHypotheses()
  → ResourceBudgetManager.getStatus()   // availableMemory, canRunLocal
  → DataUnifier.getAtomStats()          // total atoms by kind
```

---

## 五、配置参考

### 5.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DRE_DB_PATH` | `"./data/dre.db"` | SQLite 数据库路径 |
| `DRE_LLM_URL` | `"http://127.0.0.1:8080"` | 本地 LLM API 地址 |
| `DRE_LLM_MODEL` | `"qwen3-1.7b-instruct"` | 主推理模型（OpenAI 兼容端点可填云端模型） |
| `DRE_LLM_API_KEY` | — | 主推理模型 API Key（指向云端端点时必填；本地 llama.cpp 可省略） |
| `DRE_LLM_TEMPERATURE` | `0` | 推理温度 |
| `DRE_LLM_TOP_K` | `1` | Top-K 采样 |
| `DRE_LLM_SEED` | `42` | 随机种子 (确定性) |
| `DRE_DISCRIMIN_URL` | — | 甄别模型 API 地址 (可选) |
| `DRE_DISCRIMIN_MODEL` | `"qwen3-0.6b-instruct"` | 甄别模型 |
| `DRE_DISCRIMIN_API_KEY` | — | 甄别模型 API Key（可选） |
| `DRE_TICK_INTERVAL` | `10000` | Kernel tick 间隔 (ms) |
| `DRE_AUTO_TICK` | `true` | 是否自动启动 tick 循环 |
| `DRE_WORKING_MEMORY_CAPACITY` | `16` | 工作记忆容量 |
| `DRE_EPISODIC_TTL` | `3600000` | 情景记忆 TTL (ms) |
| `DEEPSEEK_API_KEY` | — | 云降级 API Key |
| `DEEPSEEK_MODEL` | `"deepseek-v4-flash"` | 云降级模型（cloudFallback 真实生效，非布尔开关） |
| `DEEPSEEK_BASE_URL` | `"https://api.deepseek.com/v1"` | 云降级端点 |
| `AXIOM_DRE_ENABLED` | `1` | 主服务宿主集成开关（0 关闭 /dre/run 与 /pipeline/stream 观测） |

### 5.2 启动配置

```typescript
// 通过 ConfigLoader (推荐)
const config = new ConfigLoader().toKernelConfig();

// 等价手动构造:
const kernel = new Kernel({
  dbPath: "./data/dre.db",
  mainLLM: { baseUrl: "http://127.0.0.1:8080", model: "qwen3-1.7b-instruct", temperature: 0, topK: 1, seed: 42 },
  discriminLLM: undefined,        // 可选
  cloudFallback: undefined,       // 可选
  tickInterval: 10000,            // 10s
  autoTick: true,
});
await kernel.init();
```

> **P2 主服务集成（2026-08-14）**：`src/main.ts` 启动时经 `src/dre/host.ts` 初始化 Kernel
> （`AXIOM_DRE_ENABLED=0` 关闭；失败不阻断主服务）。新增 `POST /dre/run`（纯确定性
> `CognitivePipeline.run`，零 LLM），与 `GET /pipeline/stream` SSE 同进程共享同一 eventBus
> 单例，观测链路天然打通。MCP 侧 `dre-*` 工具统一走 `getKernelAsync()`（等待 init、
> 失败返回明确错误）。

---

## 六、测试覆盖

**测试文件:** `tests/dre-*.test.ts` + `tests/dre-host-integration.test.ts` — **244 个测试, 全部通过**（其中 dre-core-modules 93 个）。

| 度量 | 值 |
|------|-----|
| 测试总数 | 244 |
| 失败 | 0 |
| 跳过 | 0 |
| describe 组 | 22 |
| 覆盖源文件 | 26 |
| 执行时间 | ~430ms |

> 完整测试矩阵详见 [§7.5 最终测试覆盖](#75-最终测试覆盖)

**版本历史:** 2.0.0 (初始) → 3.0.0 (Persona + Kernel + Verification) → 3.1.0 (DataUnifier + ConfigLoader + runFullWithLLM + 状态式交互 + TaskGraph MCP 调用)

---

## 七、代码审查与质量报告

### 7.1 审查范围

全量审查日期: 2026-07-04，覆盖 `src/dre/` 全部 26 个源文件，重点审查 10 个核心模块。

### 7.2 发现的问题与修复

| 严重度 | 数量 | 已修复 | 描述 |
|--------|------|--------|------|
| **CRITICAL** | 4 | ✅ | 运行时崩溃/数据损坏/安全风险 |
| **WARNING** | 8 | ✅ | 逻辑错误/缺失校验/维护陷阱 |
| **INFO / P-level** | 12 | ✅ | 全部处理 (P0-P5 + I9 等) |

#### Critical 修复详情

| ID | 文件 | 问题 | 修复 |
|----|------|------|------|
| C1 | `kernel.ts:108` | `ActorSystem.send()` 调用签名错误 (传入对象而非 5 个位置参数) → tick 循环静默失效 | 改为 5 参数: `send("kernel", target, "request", "execute", task)` |
| C2 | `atom-engine.ts:395,399` | SQLite 行数据 `as AtomKind` / `as AtomConfidence` 强制类型转换 — 数据库损坏时静默接受无效值 | 添加 `validKinds`/`validConfidences` Set 校验, 无效行跳过 + warn 日志 |
| C3 | `config.ts:80-83` | `Number("abc")` → `NaN` 静默注入配置 | 添加 `isNaN()` 守卫 + warn 日志, `continue` 跳过 |
| C4 | `stream.ts:137-147` | `archive()` 和 `cleanup()` 对无 TTL 条目的默认值不一致 (`0` vs `Infinity`) → 条目被无限重复归档 | 统一使用 `?? Infinity` (无 TTL 条目永不过期) |

#### Warning 修复详情

| ID | 文件 | 问题 | 修复 |
|----|------|------|------|
| W1 | `engine.ts:241` | `nextStage` 日志映射不完整 (只有 stage 0/2, 缺少 3) | 添加 `stage === 3 ? "llmverify" : "unknown"` |
| W3 | `cognitive-pipeline.ts:521-536` | 推理节点被孤立, 结论直接引用前提而非推理节点 | 捕获 `addInference()` 返回 ID, 结论引用推理节点 |
| W4 | `verification-engine.ts:114` | `String(object)` → `"[object Object]"` 传给约束求解器 | 使用 `typeof === "object" ? JSON.stringify() : String()` |
| W6 | `data-unifier.ts:94` | KnowledgeStore 写入失败仅 debug 日志 (生产环境静默丢失) | 升级为 `logger.warn()` |
| W7 | `system-resource.ts:75` | `updateResource()` 无输入校验 (可注入 NaN/负数) | 添加 `availableMemory >= 0` 和 `maxMemory > 0` 校验 |
| W8 | `cognitive-pipeline.ts:260-337` | `runFull` 和 `runFullWithLLM` 中 28 行 TaskGraph 逻辑重复 | 建议提取为 `createAndExecuteGraph()` 共享方法 |

### 7.3 修复验证

```
93 tests | 0 failures | 169+ expect() calls | ~430ms
22 describe groups covering all 26 DRE source files
→ 所有 Critical, Warning, P-level 修复均通过全量回归测试
```

### 7.4 全部已实施的改进

| 优先级 | 改进 | 文件 | 说明 |
|--------|------|------|------|
| C1 | `ActorSystem.send()` 参数修正 | `kernel.ts` | 5 参数位置调用, 修复 tick 循环静默失效 |
| C2 | AtomEngine SQLite 加载类型校验 | `atom-engine.ts` | `validKinds`/`validConfidences` 行校验 |
| C3 | ConfigLoader NaN 守卫 | `config.ts` | 环境变量数值 `isNaN()` 检测 + skip |
| C4 | TTL 默认值统一 | `stream.ts` | `archive()`/`cleanup()` 统一 `?? Infinity` |
| W1 | `nextStage` 日志映射补全 | `engine.ts` | 添加 stage 3: `"llmverify"` + `"unknown"` |
| W3 | 推理链节点正确连接 | `cognitive-pipeline.ts` | 结论引用推理节点而非前提 |
| W4 | 验证引擎 object → string 修正 | `verification-engine.ts` | `JSON.stringify()` 替代 `[object Object]` |
| W6 | DataUnifier 写入失败日志升级 | `data-unifier.ts` | `debug` → `warn`, persist try/catch |
| W7 | 资源预算输入校验 | `system-resource.ts` | `availableMemory >= 0` + `maxMemory > 0` |
| W8 | 消除 TaskGraph 重复代码 | `cognitive-pipeline.ts` | 提取 `executeTaskGraph()` 共享工厂 |
| P0 | 共享 TaskGraph 工厂 | `cognitive-pipeline.ts` | 消除 48 行全等代码 |
| P1 | `engine.reasoning` 用于推理图 | `cognitive-pipeline.ts` | trace 正确显示节点数 |
| P2 | 迁移 `searchKnowledge` → `searchData` | `cognitive-pipeline.ts` | 完成弃用路线 |
| P3 | `crypto.randomUUID()` Atom ID | `atom-engine.ts` | 消除并发碰撞 |
| P4 | WorldState key 固定 | `cognitive-pipeline.ts` | `"lastStep"`/`"current"` 而非递增 |
| P5 | TaskGraph MCP 工具调用 | `task-graph.ts` | `ToolExecutor` + `setToolExecutor()` + `callTool()` |
| I9 | `engine.close()` 防泄漏 | `engine.ts` | `db.close()` + `sqliteBackend.close()` 各自 try/catch |

### 7.5 最终测试覆盖

| 模块 | 测试数 | 覆盖内容 |
|------|--------|----------|
| WorkingMemory | 4 | push, evict, recent, clear |
| EpisodicMemory | 2 | add, cleanup |
| ReflectionQueue | 2 | short trace, consecutive failures |
| ConsciousnessStream | 5 | step, FIFO, reflection, state, trace |
| KnowledgeGraph | 7 | add, edges, path, community, serialize |
| Pipeline | 4 | create, write, FTS5 search |
| VFS | 2 | mount, longest prefix |
| **ResourceBudgetManager** | 3 | create, check, update |
| AgentHarness (deprecated) | 7 | tool call, system prompts |
| **PersonaLoader** | 5 | init, switch, pop, prompt, allowWrite |
| **PromptTemplateStore** | 3 | templates, render, listByMode |
| SqliteBackend | 6 | write, read, stat, list, delete, rollback |
| LLMClient | 5 | create, error, parse, stream, constrained |
| EventBus | 4 | publish, priority, once, stats |
| WorldState | 5 | get/set, watch, mental, query, snapshot |
| **VerificationEngine** | 5 | pass, fail, short, quickVerify, stats |
| **EpisodicMemory (archive)** | 3 | archive, consolidate, single |
| **Kernel** | 3 | init, tick, tickLoop |
| **ConfigLoader** | 5 | defaults, override, discrimin, cloud, source |
| **DataUnifier** | 5 | singleton, write, search, queryByKind, autoPersist |
| **CognitivePipeline E2E** | 3 | `run()`, `runWithLLM()`, `runFull()` |
| **DataUnifier persistence** | 2 | SQLite roundtrip, graceful degrade |
| **总计** | **93** | **0 fail, 0 skip** |

### 7.6 v3.1 新增功能速览

| 功能 | 文件 | 说明 |
|------|------|------|
| TaskGraph MCP 工具调用 | `task-graph.ts` | `setToolExecutor()` / `callTool()` — Task 节点可直接调用 MCP 工具 |
| CognitivePipeline 工具执行器 | `cognitive-pipeline.ts` | `setToolExecutor()` — 透传到 TaskGraph |
| MCP server 集成 | `server.ts` | CognitivePipeline 创建时自动注入 `registry.buildHttpHandlers()` 作为工具执行器 |
| 共享 TaskGraph 工厂 | `cognitive-pipeline.ts` | `executeTaskGraph()` — 消除 48 行全等代码 |

