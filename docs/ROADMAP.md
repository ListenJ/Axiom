# OpenClaw Runtime — 开发主线文档

> 从 "多个 Agent 协作完成任务" 升级为 "一个持续运行的 Runtime，维护统一的 World State，通过确定性认知流水线完成绝大部分推理，只有在算法、规则和知识都不足以解决问题时，才调用外部 LLM 作为认知增强器。"

## 核心原则

```
1. Runtime First    — 持续运行，非请求-响应
2. State First      — 整个系统维护统一的 World State
3. Algorithm First  — 优先使用确定性算法完成推理
4. LLM Last         — 仅在算法无法完成时调用外部模型
5. Projection       — Markdown/SQLite/KG 都是世界状态的投影
6. Capability       — 用能力而非 Agent 进行调度
7. Constraint       — 整个系统围绕约束推理
8. Evidence         — 每个知识都有证据链
```

---

## 一、Agent 架构重构

### 当前问题

```
Agent = LLM（什么都负责）
├─ 理解任务
├─ 思考
├─ 规划
├─ 调用工具
├─ 管理 Memory
├─ 调用 LLM
└─ 输出
```

### 目标架构

```
Agent = 确定性执行体（只做三件事）
├─ Observe（观察输入）
├─ Execute（执行任务）
└─ Report（报告结果）

其它全部拆出去：
├─ 规划 → Planner
├─ 推理 → Inference Engine
├─ Memory → Memory Engine
├─ 知识 → Knowledge Engine
├─ Context → Context Builder
└─ 决策 → Scheduler + Capability Registry
```

### Agent 生命周期

```
Spawn → Running → Waiting → Thinking → Sleeping → Resume → Complete
                ↑                              ↓
                └──────── Interrupt ────────────┘

Agent 不拥有 Memory。
Memory 属于 World。
Agent 读取、执行、结束。
Agent 死了，Memory 还在。
```

### 实施计划

- [ ] 重构 `src/agents/` 目录
- [ ] Agent 只保留 `observe(input)`, `execute(task)`, `report(result)` 三个方法
- [ ] 所有决策逻辑移到 Scheduler 和 Capability Registry
- [ ] Agent 不再直接调用 LLM，而是通过 Runtime 请求

---

## 二、知识系统升级

### 当前问题

```
Knowledge = Storage（只是存东西）
├─ Markdown
├─ SQLite
└─ KG

缺什么？
├─ Constraint（约束）
├─ Capability（能力）
├─ Evidence（证据）
└─ State（状态）
```

### 目标架构：Knowledge Network

```
Knowledge Network
├─ Entity（实体）
│   ├─ ID
│   ├─ Kind
│   └─ Content
├─ State（状态）
│   ├─ Entity → Open / Closed / Running / Sleeping
│   └─ Task → Pending / Running / Completed / Failed
├─ Constraint（约束）
│   ├─ requires（依赖）
│   ├─ prohibits（禁止）
│   ├─ enables（启用）
│   └─ conflicts（冲突）
├─ Capability（能力）
│   ├─ Planning
│   ├─ Architecture
│   ├─ Research
│   ├─ Review
│   └─ Execution
├─ Relation（关系）
│   ├─ is-a / part-of / depends-on / derives-from
│   └─ causes / contradicts / supports
├─ Evidence（证据）
│   ├─ Source（来源）
│   ├─ Confidence（置信度）
│   ├─ Timestamp（时间戳）
│   └─ Version（版本）
└─ Timeline（时间线）
    └─ 每个实体的状态变化历史
```

### 约束推理示例

```
FunctionA requires GPU
FunctionA requires CUDA 11.0
当前环境: GPU=RTX3050, CUDA=11.8
→ 约束满足，可以执行

User cannot Delete Admin
当前操作: User123 删除 Admin
→ 约束违反，拒绝执行

API needs Token
当前请求: 无 Token
→ 约束违反，返回 401
```

### 实施计划

- [ ] 升级 `src/runtime/atom-engine.ts`，增加 Constraint、Capability、Evidence、State 类型
- [ ] 创建 `src/runtime/knowledge-network.ts`
- [ ] 实现约束求解器
- [ ] 实现能力注册表

---

## 三、Memory 升级

### 当前问题

```
Memory = CRUD（只是读写）
├─ Search
├─ Read
├─ Write
└─ Browse
```

### 目标架构：经验系统

```
Memory Pipeline（认知科学模型）
├─ Observation（观察）
│   └─ 用户修了一个 Bug
├─ Episode（情节）
│   └─ Bug 出现在 auth.ts 第 42 行，原因是 token 过期未处理
├─ Pattern（模式）
│   └─ 所有 API 调用都需要处理 token 过期
├─ Knowledge（知识）
│   └─ JWT token 有效期应小于 refresh token
├─ Skill（技能）
│   └─ 自动检测并修复 token 过期问题
└─ Policy（策略）
    └─ 所有新 API 端点必须包含 token 刷新逻辑
```

### Memory 最终应该产生 Skill

```
今天：
用户：修 Bug
Memory：记录：修了 Bug
结束

以后：
Observation → Bug → 原因 → 解决方案 → 抽象 → Skill → 以后自动复用
```

### 实施计划

- [ ] 创建 `src/runtime/memory-engine.ts`
- [ ] 实现 Observation → Episode → Pattern → Knowledge → Skill → Policy 管道
- [ ] 每个阶段都有原子表示
- [ ] Skill 可以被 Capability Registry 发现和复用

---

## 四、确定性认知流水线升级

### 当前流水线

```
Observation → Atom → State → Constraint → Rule → Graph → Planning → Verification → LLM?
```

### 升级后流水线

```
Observation
    ↓
Entity Extraction（实体提取）
    ↓
State Update（状态更新）  ← 围绕 State，不是 Prompt
    ↓
Constraint Solve（约束求解）
    ↓
Rule Engine（规则引擎）  ← Rule 也是 Knowledge
    ↓
Planning（规划）  ← Task Graph + Constraint Solver
    ↓
Verification（验证）  ← 全流程验证
    ↓
Reflection（反思）
    ↓
Need LLM?
├─ No → Execute
└─ Yes → LLM → Verify → Execute
```

### Rule 也是 Entity

```
Rule
├─ Condition（条件）
├─ Action（动作）
├─ Priority（优先级）
├─ Confidence（置信度）
├─ Source（来源）
└─ Version（版本）

Runtime 可以学习 Rule。
Rule 本身就是 Knowledge。
```

### 实施计划

- [ ] 升级 `src/runtime/scheduler.ts` 中的 Cognitive Pipeline
- [ ] 增加 Entity Extraction 阶段
- [ ] 增加 Constraint Solve 阶段
- [ ] Rule 作为 Atom 存储，可学习

---

## 五、Capability Registry

### 核心思想

```
Runtime 不再调用 Agent。
Runtime 调用 Capability。

例如：
Need: Planning
↓
Search Capability
├─ Hermes (external)
├─ Claude (external)
├─ Planner (internal)
└─ 本地算法
↓
选择最优
```

### 能力模型

```
Capability
├─ ID
├─ Name
├─ Description
├─ Input Schema
├─ Output Schema
├─ Cost（成本）
├─ Latency（延迟）
├─ Reliability（可靠性）
├─ Provider（提供者）
│   ├─ Internal（本地算法）
│   └─ External（Hermes/Claude/GPT）
└─ Constraints（约束）
    ├─ requires GPU
    ├─ requires Token
    └─ max latency 5s
```

### 能力调度

```
Task: "分析代码质量"
↓
Search Capabilities:
├─ code_analyze (internal, cost=0, latency=100ms)
├─ hermes_review (external, cost=$0.01, latency=2s)
├─ claude_review (external, cost=$0.03, latency=3s)
↓
选择: code_analyze (成本最低，延迟最小)
↓
执行
↓
结果不满意？
↓
升级: hermes_review
```

### 实施计划

- [ ] 创建 `src/runtime/capability-registry.ts`
- [ ] 注册内部能力（代码分析、搜索、规划等）
- [ ] 注册外部能力（Hermes、Claude、GPT 等）
- [ ] 实现能力调度算法

---

## 六、Projection Layer 完善

### 核心思想

```
Markdown、SQLite、KG 都不是事实本身。
它们是 World State 的投影。

World State 是唯一的 Source of Truth。
所有存储都可以从 World State 重建。
```

### 投影类型

```
World State
├─ Markdown Projection → Vault 文件
├─ SQLite Projection → 数据库表
├─ KG Projection → 知识图谱
├─ Cache Projection → 热数据缓存
├─ Index Projection → 搜索索引
└─ Log Projection → 审计日志
```

### 实施计划

- [ ] 完善 `src/runtime/projection-layer.ts`
- [ ] 实现从 World State 到各投影的同步
- [ ] 实现投影重建能力

---

## 七、实施优先级

| 优先级 | 模块 | 影响 | 工作量 |
|--------|------|------|--------|
| ⭐⭐⭐⭐⭐ | Capability Registry | 用能力替代 Agent 调度 | 中 |
| ⭐⭐⭐⭐⭐ | Constraint Solver | 围绕约束推理 | 大 |
| ⭐⭐⭐⭐⭐ | Knowledge Network 升级 | Entity+State+Constraint+Capability+Evidence | 大 |
| ⭐⭐⭐⭐ | Memory 升级 | Observation→Episode→Pattern→Skill | 大 |
| ⭐⭐⭐⭐ | Agent 瘦身 | 只保留 Observe→Execute→Report | 中 |
| ⭐⭐⭐⭐ | Rule Engine 独立 | Rule 作为 Knowledge | 中 |
| ⭐⭐⭐ | Projection Layer 完善 | Vault/KG/SQLite 作为投影 | 小 |
| ⭐⭐⭐ | Verification 升级 | 全流程验证 | 中 |
| ⭐⭐ | Evidence 链 | 每个知识有证据 | 小 |

---

## 八、文件结构（目标）

```
src/runtime/
├── kernel.ts              # Event Bus, World State, Tick Engine, Actor RT
├── atom-engine.ts         # 统一原子表示
├── knowledge-network.ts   # Entity+State+Constraint+Capability+Evidence
├── capability-registry.ts # 能力注册表
├── constraint-solver.ts   # 约束求解器
├── memory-engine.ts       # Observation→Episode→Pattern→Skill
├── scheduler.ts           # 任务调度 + Cognitive Pipeline
├── projection-layer.ts    # Vault/KG/SQLite 作为投影
├── context-engine.ts      # 统一上下文构建
├── rule-engine.ts         # 规则引擎（Rule 作为 Knowledge）
├── verification-engine.ts # 全流程验证
└── actors.ts              # Actor 实现

src/agents/
├── executor.ts            # 纯执行器（Observe→Execute→Report）
└── (旧模块逐步废弃)
```

---

## 九、版本路线

| 版本 | 内容 | 状态 |
|------|------|------|
| v2.8.2 | Runtime Kernel + Event Bus + Atom Engine | ✅ 完成 |
| v2.9.0 | Capability Registry + Constraint Solver | ✅ 完成 |
| v3.0.0 | Knowledge Network + Memory Engine + Agent 瘦身 | ✅ 完成 |
| v3.1.0 | Rule Engine + Verification + Evidence | ✅ 完成 |
| v3.2.0 | Projection Layer 完善 + 全面测试 | 🔄 进行中 |

### 当前进度

```
✅ Runtime Kernel (Event Bus + World State + Tick Engine + Actor RT)
✅ Atom Engine (统一原子表示)
✅ Constraint Solver (约束求解)
✅ Capability Registry (能力调度)
✅ Knowledge Network (Entity+State+Constraint+Capability+Evidence)
✅ Memory Engine (Observation→Episode→Pattern→Skill)
✅ Rule Engine (Rule 作为 Knowledge)
✅ Agent Executor (纯执行体 Observe→Execute→Report)
✅ Verification Engine (全流程验证)
✅ Scheduler (任务调度 + Cognitive Pipeline)
✅ Context Engine (统一上下文构建)
✅ Actors (Memory/Reflection/Planner/Search)
✅ Integration (main.ts 启动序列)
✅ Tests (46 个 Runtime 测试)
🔄 Projection Layer (Vault/KG/SQLite 作为投影)
```

---

## 十、测试策略

```
每个模块独立测试：
├─ Unit Tests: 模块内部逻辑
├─ Integration Tests: 模块间通过 Event Bus 交互
└─ Runtime Tests: 完整的 Tick 循环

关键测试：
├─ Constraint Solver: 约束满足/违反
├─ Capability Registry: 能力发现/调度
├─ Memory Engine: Observation→Skill 管道
├─ Knowledge Network: Entity+State+Constraint 查询
└─ Cognitive Pipeline: 确定性推理覆盖率
```
