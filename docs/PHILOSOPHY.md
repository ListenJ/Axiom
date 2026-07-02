# Axiom Runtime 项目哲学

> 本文档记录了 Axiom 的设计哲学与长期方向，是架构决策的最高指导原则。
> 所有技术决策应能回溯到此文档中的某条原则。

---

## 1. 项目定义：Axiom 是什么？

**Axiom 不是**：
- ❌ Agent Framework — 这个赛道已经拥挤
- ❌ MCP Framework — 这只是协议层
- ❌ AI IDE — IDE 不是我们的领域

**Axiom 是**：
- ✅ **Runtime** — 事件驱动、Actor 调度、生命周期管理
- ✅ **World Model** — 统一状态表示、投影 (Projection)、演化
- ✅ **Deterministic Cognitive System** — 可解释、可验证的推理管道

**对标对象**：

| 维度 | 代表系统 |
|------|----------|
| Runtime | Erlang/OTP, Ray, Akka, ROS2 |
| 世界模型 | SOAR, ACT-R, OpenCog |
| AI 接口 | Claude Code, Hermes, OpenCode |
| 操作系统思想 | Linux Kernel 事件与调度 |

---

## 2. 核心创新：LLM 降级为认知加速器

这是 Axiom 与所有其它项目最本质的区别。

**传统范式**：
```
Prompt → LLM → Tool
```
LLM 是推理主体，确定性逻辑是辅助。

**Axiom 范式**：
```
Observation → World State → Constraint → Planning → Verification → LLM (仅补全)
```
LLM 从推理主体降级为 **Cognitive Accelerator（认知加速器）**，只在确定性管道无法闭合时调用。

> 目前几乎没有工程系统真正实现这一点。这是 Axiom 不可替代的核心。

### 论文级表述

如果发表论文，核心论点是：

> **将 LLM 从推理主体降级为 Runtime 中的一个 Cognitive Accelerator（认知加速器），构建以确定性推理为核心、LLM 为补全组件的可解释认知运行时。**

不会写的内容：
- "支持 MCP" — 这是工程实现，非学术贡献
- "多 Agent" — 已有大量工作

---

## 3. 三大缺失层

### 3.1 Knowledge Representation（知识表示层）

当前状态：Markdown → Entity

**目标状态**：统一的原子知识表示，所有知识统一表达：

```
Atom → Entity → Behavior → Constraint → Procedure → Prediction
```

- **Atom**: 最小知识单元
- **Entity**: 实体、关系、状态
- **Behavior**: IF-THEN 模式、因果链
- **Constraint**: 逻辑/物理/策略/时间约束
- **Procedure**: 步骤序列、条件分支、回滚、检查点
- **Prediction**: 假设、证据、置信度

### 3.2 Reasoning Representation（推理表示层）

当前状态：Observation → Inference

**目标状态**：所有推理都有完整表示：

```
Reasoning Graph:
  Node: premise | inference | conclusion | evidence | gap
  Edge: supports | contradicts | implies | requires | explains
  Property: confidence, source, chain
```

方便解释、验证、追溯。（v4.0.0 的 `ReasoningGraph` 已实现此结构的雏形）

### 3.3 Execution Representation（执行表示层）

当前状态：Task

**目标状态**：

```
Task Graph → Execution Graph → Rollback → Checkpoint → Resume
```

使系统真正成为 Runtime，而非任务队列。

---

## 4. 最小认知闭环 (Minimum Cognitive Loop)

真正决定 Runtime 能力的是**信息的流动方式**，而非模块数量：

```
Observation
    ↓
Atom
    ↓
State
    ↓
Knowledge
    ↓
Reasoning
    ↓
Planning
    ↓
Execution
    ↓
Reflection
    ↓
Learning
```

如果这一条流水线统一了，整个系统就统一了。
否则再多模块，最终都会变成 `Module A → Module B → Module C` 的线性堆叠。

> **当前实现**: `CognitivePipeline` (v4.0.0) — 已实现 classify → knowledge → reasoning → constraint → action → reflection 的 6 步闭环，零 LLM 确定性管道，每步可追踪。

### 最大批判：模块设计而非信息流动

> 你现在更像是在设计"模块"，而不是设计"信息如何流动"。
> 真正决定 Runtime 能力的不是有多少模块，而是信息沿着
> `Observation → Atom → State → Knowledge → Reasoning → Planning → Execution → Reflection → Learning`
> 这一条流水线如何流动。

这是目前最需要警惕的倾向。v4.0.0 新增了 5 个认知模块，但如果没有统一的信息流水线将它们连接，新增模块只会增加维护负担而非系统能力。

---

## 5. 四大不可替代核心

研发资源应集中于此：

| 核心 | 说明 |
|------|------|
| **Runtime Kernel** | 事件、调度、生命周期、Actor、状态管理 |
| **Knowledge Representation** | 事实/行为/过程/约束/证据/预测的统一表示 |
| **Deterministic Cognitive Pipeline** | Observation → State → Reasoning → Planning → Verification |
| **LLM Adapter** | 所有模型统一抽象为"认知增强器"，而非系统中心 |

---

## 6. 三大风险与应对

### 风险一：想解决的问题过大

**症状**：Memory + KG + Runtime + Agent + Scheduler + Context + Workspace + MCP + GUI + Plugin → 每个模块完成 70%，没有一个达到 95%。

**应对**：先确定不可替代的部分 — 即第 5 节的四大核心。其它全部借助现有生态。

### 风险二：确定性推理的边界

**症状**：Rule 越来越多 → 越来越复杂 → 没人维护（1980 年代 Expert System 的 Rule Explosion）。

**应对**：推理建立在 Constraint + Graph + Search + Planner + Verification 上，Rule 只是组件之一，不是核心。

### 风险三：知识表示的形式化

**症状**：世界不是 Graph。程序执行、Git Merge、Debug 都不是 Graph，而是 Procedure。

**应对**：Knowledge 必须支持 Fact / Behavior / Procedure / Constraint / Prediction。纯 Entity-Relation 图永远不够。

---

## 7. 建议砍掉或延后的部分

> 不是"不能做"，而是"现在不该做"。

| 应砍掉/延后 | 原因 | 替代方案 |
|------------|------|----------|
| **复杂多 Agent 编排** | Agent 应作为执行器，而非系统主体 | 单 Runtime + 多 Capability |
| **重复的 Memory/KG 存储层** | 应建立唯一 World State | Markdown / SQLite / Graph 都作为投影 (Projection) |
| **大量手工 Prompt Engineering** | Prompt 应由 Runtime 自动生成 | 结构化模板 + 自动注入上下文 |

### 保留的四大核心（研发资源集中于此）

| 核心 | 说明 |
|------|------|
| **Runtime Kernel** | 事件、调度、生命周期、Actor、状态管理 |
| **Knowledge Representation** | 事实/行为/过程/约束/证据/预测的统一表示 |
| **Deterministic Cognitive Pipeline** | Observation → State → Reasoning → Planning → Verification |
| **LLM Adapter** | 所有模型统一抽象为"认知增强器"，而非系统中心 |

---

## 8. 技术可行性评估

| 模块 | 可行性 | 理由 |
|------|--------|------|
| Runtime | ★★★★★ | Actor/Scheduler/Event 有成熟理论 |
| World State | ★★★★★ | Entity/Projection/Event Sourcing/CRDT 经验丰富 |
| Knowledge Engine | ★★★★☆ | 知识更新/冲突/演化有挑战但可逐步实现 |
| Deterministic Reasoning | ★★★★☆ | SAT/SMT/Graph Search/Constraint Solver 有大量研究，难点在组合 |
| Mental Model | ★★★☆☆ | 无成熟工程范式，需要自定义 |
| Autonomous Learning | ★★☆☆☆ | 风险最大，建议最后推进 |

---

## 9. 评价体系（五年视角）

| 维度 | 评分 | 说明 |
|------|------|------|
| 创新性 | 9.5/10 | Runtime + 确定性推理 + 世界模型的结合方向差异化明显 |
| 工程可行性 | 7.5/10 | 基础设施成熟，真正挑战在知识表示和认知流水线 |
| 研究价值 | 9/10 | 可形成可解释、可验证的 AI Runtime 方法论 |
| 落地风险 | 8.5/10 | 风险不是技术不可行，而是容易同时推进太多方向 |

---

## 10. 设计原则（排序）

1. **Runtime First** — 先有运行时，再有其他
2. **State First** — 状态是系统的一等公民
3. **Knowledge First** — 知识表示决定系统上限
4. **LLM Last** — LLM 是加速器，不是核心

---

*本文档作为项目哲学的最高指导原则。所有架构决策应能回溯至此。*
