# DRE 架构（Deterministic Reasoning Engine）

> 摘要：DRE 是 Axiom 的确定性推理引擎，位于 `src/dre/`（约 14 个子模块）。核心原则：**确定性、可追溯、可回放、可审计、防幻觉**。本文梳理其分层架构、关键模块职责、数据流，以及 DSH 插件（`axiom-dre-dsh`）与 DRE 的映射关系。依据：`src/dre/index.ts` 导出面与各模块头部文档（事实）。

---

## 一、设计原则（事实）

- **确定性**：LLM 调用温度=0 + 固定种子；约束生成走 JSON Schema + 拒绝采样取众数；纯算法路径零 LLM。
- **可追溯**：认知闭环每步产生类型化 trace；突触写操作全链 verify hash；意识流 trace hash。
- **可回放**：固定种子 + 事件日志（EventBus 保留最近 1000 条）。
- **防幻觉**：三段甄别（预筛 → 网络校验 → LLM 自推理）；反思教训写入长期记忆；Vault 原件双写校验。
- **硬件无关**：SystemResource 只问"有多少资源预算"，不问底层硬件。

## 二、分层架构（判断，依据模块职责）

```
┌─────────────────────────────────────────────────────────┐
│ 编排/执行层  CognitivePipeline · TaskGraph · ActorSystem │
├─────────────────────────────────────────────────────────┤
│ 认知/记忆层  ConsciousnessStream · SynapseEngine ·      │
│              MentalModelPool · KnowledgeNetwork         │
├─────────────────────────────────────────────────────────┤
│ 推理/验证层  Pipeline(三段甄别) · ReasoningGraph ·       │
│              LLMClient · ConstraintSolver · 约束注入     │
├─────────────────────────────────────────────────────────┤
│ 存储层       KnowledgeStore · KnowledgeGraph · VFS      │
├─────────────────────────────────────────────────────────┤
│ 运行时基础   EventBus · WorldState · AtomEngine ·        │
│              DataUnifier · ContextEngine · RuleEngine    │
├─────────────────────────────────────────────────────────┤
│ 内核层       Kernel · DREngine · ConfigLoader ·          │
│              SystemResource · PersonaLoader             │
└─────────────────────────────────────────────────────────┘
```

## 三、关键模块职责

### 内核层
| 模块 | 职责 |
| --- | --- |
| `Kernel` (kernel.ts) | 极薄启动器：`init()` 启动所有模块、`tick` 驱动循环、生命周期状态机 |
| `DREngine` (engine.ts) | 主入口：整合全部模块，暴露 `writeKnowledge`/`consciousnessStep`/`constraints`/`actors` 等 |
| `ConfigLoader` (config.ts) | 配置加载：explicit > env（`DRE_*`）> defaults |
| `SystemResource` | 资源预算（内存/算力），不依赖具体硬件检测 |
| `PersonaLoader` | 动态角色加载（约束 + 心智模型 + 能力，替代 AgentHarness） |

### 存储层
| 模块 | 职责 |
| --- | --- |
| `VFS` + `SqliteBackend` | 虚拟文件系统（统一挂载知识库/项目/缓存） |
| `KnowledgeStore` | 知识 CRUD + 版本快照 + 三段甄别集成；范式：fact/rule/procedure/concept/behavior/prediction/hypothesis |
| `KnowledgeGraph` | 实体/关系、BFS 子图、最短证据路径、Louvain 社区检测 |

### 推理/验证层（信息确定性的核心）
| 模块 | 职责 |
| --- | --- |
| `Pipeline`（三段甄别） | **阶段1 预筛**（规则引擎 + 向量召回 + 冲突检测）→ **阶段2 网络校验**（多源搜索证据）→ **阶段3 LLM 自推理**（强约束 + 拒绝采样）。风险评分路由：`<0.3` 直接入库；`[0.3,0.7]` 走阶段2；`>0.7` 走阶段3 + 告警 |
| `ReasoningGraph` | 推理图（前提/推理/结论/证据/空洞）；Gap Detection 只对空洞做精细 LLM 填补，打破 LLM 黑盒 |
| `LLMClient` | 强约束生成（JSON Schema + 拒绝采样 n 次取众数）、温度=0、固定种子、重试 + 熔断器 |
| `ConstraintSolver` | 5 维约束：logical/physical/field_match/policy/temporal |
| `constraint-injection` | 实践手册错误记录 → 可注入 LLM 输入的约束词（可追溯来源 id） |

### 认知/记忆层
| 模块 | 职责 |
| --- | --- |
| `ConsciousnessStream` | 三层记忆：工作（FIFO 容量16）/短期（向量 TTL 1h）/长期（知识库+KG）；反思队列（连续失败/不一致/置信度方差 → 教训写长期记忆） |
| `SynapseEngine` | 神经突触：Hebbian 增强、扩散激活（BFS + 每跳衰减）、下一步建议（确定性排序）、写操作全链 verify |
| `MentalModelPool` | 心智模型：概念图 + 状态转换 + 规则（condition→action）+ 场景模拟 + 预测；预注册 Git 冲突/代码重构/Auth/数据库 4 模型 |
| `KnowledgeNetwork` | 实体 + 状态 + 约束 + 能力 + 证据 + 时间线 + 行为 + 预测 |

### 编排/执行层
| 模块 | 职责 |
| --- | --- |
| `CognitivePipeline` | 最小认知闭环：`Observation → State → Knowledge → Reasoning → Constraint → Action → Reflection`；零 LLM 确定性分类，LLM 仅补空洞 |
| `TaskGraph` | 执行表示层：任务依赖/并行/失败回滚/checkpoint/resume；不新增存储（checkpoint 写 KnowledgeStore） |
| `ActorSystem` | 轻量 Actor：Knowledge / Constraint / MentalModel / Reasoning 四类，消息邮箱 + 行为 + 状态 |
| `Scheduler` | 任务队列：优先级 / 资源感知 / 期限 / 抢占 |

### 运行时基础
| 模块 | 职责 |
| --- | --- |
| `EventBus` | 统一事件总线（模块间不直接调用），优先级排序、事件日志 |
| `WorldState` | 统一状态树（唯一真相源），watch 订阅、snapshot 序列化 |
| `AtomEngine` | 统一原子表示（一切皆 Atom；Markdown/SQLite/KG 均为 Atom 的投影） |
| `DataUnifier` | 统一数据入口（协调 AtomEngine + KnowledgeStore + VFS），对外只暴露 write/search/query |
| `ContextEngine` | 统一上下文构建（WorldState + 记忆 + KG + 历史 + 目标 + 工作区） |
| `RuleEngine` | Rule 也是 Knowledge，运行时可学习 |
| `CapabilityRegistry` | 能力与模型解耦，按延迟/成本/置信度动态选 Provider |

## 四、关键数据流（事实）

### 知识写入（三段甄别）
```
DREngine.writeKnowledge(item)
  → Pipeline.process(item)
      阶段1: 规则预筛 + 向量召回 + 冲突检测 → riskScore
        riskScore<0.3  → 直接入库
        [0.3,0.7]      → 阶段2 网络校验（SearchAggregator 多源证据）
        >0.7           → 阶段3 LLM 自推理（generateConstrained 强约束）
  → KnowledgeStore 入库（accepted/verdict/confidence/evidenceRefs）
```

### 认知闭环（CognitivePipeline.run）
```
input → classify(确定性) → knowledge(加载) → reasoning(ReasoningGraph, 有空洞才调 LLM)
      → constraint(ConstraintSolver) → action(TaskGraph/推荐) → reflection(教训)
全程 trace[] 可追踪，输出 conclusion/confidence/hasGaps/constraintPassed/lessons
```

### 意识流（ConsciousnessStream.step）
```
observe → decide(LLM 或规则降级) → 记录 trace → 反思检查
反思触发（连续失败/不一致）→ 生成教训 → 写入长期记忆（KnowledgeStore）
```

## 五、DSH 插件映射（axiom-dre-dsh → DRE）

| `dre__*` 工具 | DRE 模块 |
| --- | --- |
| `dre_write_knowledge` / `dre_search_knowledge` / `dre_read_knowledge` / `dre_subgraph` | DREngine / KnowledgeStore / Pipeline（三段甄别） |
| `dre_status` | Kernel / DREngine 状态 |
| `cognitive_loop` / `cognitive_pipeline_run` / `cognitive_state` | CognitivePipeline |
| `task_graph_execute` | TaskGraph + ActorSystem |
| `reasoning_build` / `reasoning_detect_gaps` / `reasoning_fill_gap` / `reasoning_result` | ReasoningGraph |
| `constraint_check` / `constraint_list` / `constraint_select_best` / `constraint_stats` | ConstraintSolver |
| `actor_list` / `actor_send` | ActorSystem |
| `mental_model_*` | MentalModelPool |
| `mind_synapse_*` / `mind_suggest` | SynapseEngine / SynapseStore |
| `dre_constraint_inject` | constraint-injection（实践手册 → 约束词） |
| `dre_consciousness_step` | ConsciousnessStream |

> **边界（事实，2026-08-19 自包含化后）**：插件（axiom-dre-dsh）现在**内置 DRE 引擎与后端**——
> 构建产物 `backend/server.js`（bun build 单文件，约 1.25MB）包含 src/dre/ 全部引擎代码与仅含 DRE 能力的
> MCP 后端（src/dre/backend/mcp-server.ts 入口，注册 dre-tools + mind-tools 共 42 个工具）。
> 插件经 stdio 拉起 `bun backend/server.js --stdio`（cwd=可写 data/ 目录），按白名单过滤后以 `dre__<tool>` 注册进 dsh，
> 无需外部 Axiom 仓库即可直接给 LLM 调用。
>
> **可选外部模式**：配置 `axiomHome` 指向含 `src/mcp/server.ts` 的仓库并覆盖 `mcpArgs`，可改用外部后端。
> **为什么默认内置**：DRE 引擎依赖 Bun 专属 API（如 `bun:sqlite`），DSH 插件运行于 Node —— 引擎必须跑在 Bun 进程内，
> 因此以「内置 Bun 后端进程」方式打包，而非内嵌插件进程。

## 六、来源与依据

- `src/dre/index.ts`（模块导出总览）
- `src/dre/{kernel,engine,config,system-resource}.ts`（内核层）
- `src/dre/{storage,kg,pipeline,reasoning,llm,constraint,consciousness,synapse,mental-model,actor,runtime,persona}/` 各模块头部文档
- `src/mcp/server/dre-tools.ts`（MCP 工具 → DRE 调用映射）
