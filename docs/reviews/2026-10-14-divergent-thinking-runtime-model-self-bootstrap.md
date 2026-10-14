# 发散思考：Runtime 定位 × 模型激发 × 自持自举

> 日期：2026-10-14 | 基于 Axiom Runtime v4.0.0 源码实证

---

## 零、方法论

不验证"审计通过"——那已确认。而是拷问三个哲学问题：

1. **Runtime 定位**：架构是否真的是 Runtime，还是披着 Runtime 皮的 Agent Framework？
2. **模型激发**：当前约束是否把 LLM 锁死了？能力是否留在桌上？
3. **自持自举**：系统能否维持自身、举起自身？反馈环是否闭合？

每个问题用源码实证回答，不空谈。

---

## 一、Runtime 定位：是 Runtime 还是 Agent Framework？

### 1.1 支持 Runtime 的证据

| 特征 | 源码 | 判定 |
|------|------|------|
| Kernel + tick 循环 | `src/dre/kernel.ts` — `tick()` + `autoTick` | ✅ OS 内核模式 |
| EventBus | `src/dre/runtime/event-bus.ts` — emit/subscribe | ✅ 中断/信号机制 |
| WorldState | `src/dre/runtime/world-state.ts` — 全局状态 | ✅ 进程状态 |
| Scheduler | `src/dre/runtime/scheduler.ts` | ✅ 调度器 |
| Port/Adapter | `src/dre/port/` + `src/dre/ports/` | ✅ 六角架构 |
| Resource Budget | `src/dre/system-resource.ts` | ✅ 资源配额 |
| Actor Model | `src/dre/actor/` — 消息邮箱 | ✅ Erlang/Akka 式 |
| 单写者守护进程 | `src/daemon/dre-daemon.ts` | ✅ OS 守护进程 |

**结论**：Runtime 基座是真实的——Kernel/EventBus/Scheduler/Port 构成了确定性执行基底。

### 1.2 引发张力的证据

| 特征 | 源码 | 张力 |
|------|------|------|
| "意识流" | `src/dre/consciousness/stream.ts` | ⚠️ 认知词汇，非 Runtime 词汇 |
| "心智模型" | `src/dre/mental-model/` — `predict()` | ⚠️ 认知能力嵌入内核 |
| "突触" | `src/dre/synapse/` — Hebbian 学习 | ⚠️ 神经网络嵌入内核 |
| "人格" | `src/dre/persona/` — push/pop | ⚠️ Agent 概念 |
| "反思" | `CognitivePipeline` Step 6 | ⚠️ 元认知 |
| 189 MCP 工具 | 23 领域文件 | ⚠️ Agent Framework 规模 |

### 1.3 判定：是 Runtime，但边界模糊

**核心洞察**：类比 JVM——

```
JVM = 确定性运行时基底 (GC/JIT/ClassLoader)
     + 执行任意 Java 程序 (包括认知程序)

Axiom = 确定性运行时基底 (Kernel/EventBus/Scheduler)
     + 内置认知原语 (Reasoning/Knowledge/Consciousness)
     + LLM 作为外部加速器
```

**Axiom 的定位是正确的**——"认知运行时"不是矛盾修辞。就像 JVM 内置 GC 和 JIT 一样，Axiom 内置 Reasoning 和 Knowledge 是合理的运行时原语。

**但有一个真问题**：JVM 的认知程序是**外部的**（Java 字节码），而 Axiom 的认知原语是**编译进内核的**（`src/dre/`）。这意味着：

- 认知原语不能被替换（除非改源码重编译）
- 认知管道不能被重编排（`CognitivePipeline` 是硬编码的 6 步）
- 用户不能"写一个认知程序"在 Axiom 上跑——只能调用预定义的 189 个工具

**这使 Axiom 更像"内置认知能力的 OS 内核"而非"执行认知程序的运行时"。**

### 1.4 改进方向：从"内置认知"到"可编程认知"

```
当前:  Kernel ← 编译 ← [Reasoning, Knowledge, Consciousness, Synapse, ...]
                                    ↑ 不可替换

目标:  Kernel ← 运行时加载 ← CognitiveProgram (DSL/脚本)
                                    ↑ 可替换/可重编排
```

具体：将 `CognitivePipeline` 的 6 步从硬编码改为**可编排的管道定义**（JSON/YAML/DSL），让用户可以：
- 重排步骤
- 插入自定义步骤
- 替换步骤实现
- 定义新的认知管道

这不破坏确定性——管道定义仍然是确定性的，只是不再是编译时固定。

---

## 二、模型激发：LLM 被锁死了吗？

### 2.1 当前 LLM 约束（源码实证）

```typescript
// src/dre/llm/*.ts
temperature: 0.0,   // 确定性输出
topK: 1,            // 贪心解码
seed: 42,           // 固定种子
// + JSON Schema 约束
// + 拒绝采样 (n 次取众数)
// + 熔断器
// + 缓存
```

**LLM 被当作确定性函数使用**：相同输入 → 相同输出。这是**故意的**——与 ADR-002 一致。

### 2.2 LLM 的调用时机

```
CognitivePipeline:
  Step 1: Observation → 零 LLM 关键词分类           ← 确定性
  Step 2: State → Knowledge (加载相关知识)           ← 确定性
  Step 3: Knowledge → Reasoning (构建推理图)         ← 确定性
          └─ detectGaps() → 如果有空洞 → fillGap()  ← LLM 在这里
  Step 4: Reasoning → Constraint (约束校验)          ← 确定性
  Step 5: Action (报告推荐动作, 不自动执行)           ← 确定性
  Step 6: Reflection (意识流反思)                    ← LLM 在这里 (但受限)
```

**LLM 只在两个点被调用**：
1. 推理图有空洞时 → 填补空洞（补全器位）
2. 反思阶段 → 生成教训（但教训是字符串，不反馈回系统）

### 2.3 能力留在桌上的地方

| 能力 | 当前状态 | 损失 |
|------|----------|------|
| **多假设生成** | LLM 填一个空洞，一个答案 | ❌ 无法生成多个假设让确定性引擎测试 |
| **多步推理** | 每个 gap 独立填充 | ❌ 无法让 LLM 推理多个 gap 的关联 |
| **探索性搜索** | temperature=0, topK=1 | ❌ 无法探索解空间 |
| **自我方向** | 管道决定何时调用 LLM | ❌ LLM 不能主动发起推理 |
| **创造性综合** | LLM 填预定义的 gap | ❌ 不能让 LLM 重新定义问题 |
| **元推理** | 反思生成字符串教训 | ❌ 教训不修改行为 |

### 2.4 但——约束是正确的

**关键悖论**：松绑 LLM → 不可预测 → 不可测试 → 不可审计 → 退化成 Agent Framework。

Axiom 的核心价值主张是**确定性**。松绑 LLM 会摧毁这个主张。

### 2.5 破局：受控创造力（Controlled Creativity）

不需要在"全锁死"和"全放开"之间二选一。可以引入**受控创造力模式**：

```
模式 1: 假设生成 (Hypothesis Mode)
  ┌─────────────────────────────────────────┐
  │ 确定性引擎: "这里有一个 gap"             │
  │ LLM (temp=0.7, n=5): 生成 5 个假设      │
  │ 确定性引擎: 用约束+知识测试每个假设      │
  │ 选择: 最高置信度且通过约束的假设         │
  └─────────────────────────────────────────┘
  → LLM 的创造力在"生成"，确定性在"选择"

模式 2: 探索-验证 (Explore-Verify Mode)
  ┌─────────────────────────────────────────┐
  │ LLM (temp=0.8): 自由探索解空间          │
  │ → 生成候选方案 (可能多个)               │
  │ 确定性引擎: 验证每个方案                │
  │ → 通过的进入推理图，不通过的丢弃        │
  └─────────────────────────────────────────┘
  → LLM 探索，确定性验证——类似 AlphaGo 的 MCTS

模式 3: 元管道 (Meta-Pipeline Mode)
  ┌─────────────────────────────────────────┐
  │ LLM: "当前管道在这些情况下表现不佳"      │
  │ → 建议管道修改 (新步骤/新规则/新约束)    │
  │ 确定性引擎: 验证修改的安全性            │
  │ → 安全则热加载，不安全则拒绝           │
  └─────────────────────────────────────────┘
  → LLM 做元推理，确定性做安全门——这就是自举的入口
```

**关键**：每种模式都保持"确定性最终裁决"——LLM 可以创造，但不能决定。这既激发能力又不破坏 Runtime 定位。

### 2.6 Synapse 的 `localModelAssist` 是已有钩子

```typescript
// src/dre/synapse/engine.ts
localModelAssist?: (
  suggestions: SynapseSuggestion[],
  scene: string,
  ...
) => SynapseSuggestion[];
```

突触引擎已经有可选 LLM 增强钩子——确定性生成建议，LLM 可重排/增补。**这是受控创造力的已有实例**，只是没有推广到其他子系统。

---

## 三、自持自举：反馈环闭合了吗？

### 3.1 自持（Self-Sustaining）

**已有的自持能力：**

| 能力 | 源码 | 状态 |
|------|------|------|
| 自动 tick 循环 | `Kernel.autoTick` | ✅ |
| LLM 熔断器 | `src/dre/llm/` CircuitBreaker | ✅ |
| 资源预算管理 | `system-resource.ts` | ✅ |
| 插件热重载 | ADR-014 | ✅ |
| 规则运行时添加 | `ruleEngine.addRule()` | ✅ |
| 突触 Hebbian 学习 | `SynapseEngine` | ✅ |
| 反思生成教训 | `ConsciousnessStream` | ✅ |
| 心智模型预测 | `MentalModelPool.predict()` | ✅ |

**缺失的自持能力：**

| 能力 | 现状 | 影响 |
|------|------|------|
| 自愈循环 | daemon 崩溃靠 pm2/systemd 外部重启 | ⚠️ 非自持 |
| 自优化 | 运行时不调优自身参数 | ⚠️ 静态配置 |
| 自诊断 | 不分析自身性能瓶颈 | ⚠️ 被动监控 |
| 自适应资源 | 资源预算静态 | ⚠️ 不随负载调整 |

### 3.2 自举（Self-Bootstrapping）

**已有的自举能力：**

| 能力 | 源码 | 状态 |
|------|------|------|
| 运行时加载插件 | ADR-014 热装配 | ✅ |
| 运行时添加规则 | `ruleEngine.addRule()` | ✅ |
| 运行时创建突触 | `SynapseEngine.createSynapse()` | ✅ |
| 运行时切换人格 | `PersonaLoader.push/pop()` | ✅ |
| 运行时更新心智模型 | `MentalModelPool` | ✅ |

**缺失的自举能力：**

| 能力 | 现状 | 影响 |
|------|------|------|
| 修改自身管道 | `CognitivePipeline` 硬编码 | ❌ 不能自举新管道 |
| 生成新工具 | 工具启动时注册 | ❌ 不能运行时生成 |
| 从最小核心启动 | 需预建 daemon + config + SQLite | ❌ 非最小自举 |
| 自修改代码 | 无元编程 | ❌ 不能自举新能力 |
| 经验→行为 | 教训是字符串，不修改行为 | ❌ 学习不闭环 |

### 3.3 核心发现：反馈环是开的

**这是最重要的发现。** 逐条追踪反馈路径：

```
路径 A: 意识流 → 规则引擎
  ConsciousnessStream.reflection.lessons → string[]
  ↓
  ??? lessons 没有被 addRule() 消费
  ↓
  ✗ 断路：教训不变成规则

路径 B: 突触学习 → 认知管道
  SynapseEngine Hebbian 增强 → 突触权重变化
  ↓
  ??? CognitivePipeline 不查询突触建议
  ↓
  ✗ 断路：学习不引导行为

路径 C: 心智模型预测 → 行动
  MentalModelPool.predict() → predictedState
  ↓
  ??? Step 5 (Action) 不 consult 预测
  ↓
  ✗ 断路：预测不影响决策

路径 D: 反思 → 管道修改
  ReflectionResult.issues → string[]
  ↓
  ??? 管道不可修改 (无 addStep/removeStep)
  ↓
  ✗ 断路：反思不改进方法
```

**四条反馈路径全部断路。** 系统有所有的零件——意识流、突触、心智模型、规则引擎——但它们之间没有闭合的反馈环。

### 3.4 用图表达

```
当前架构（开环）:

  Observation → Knowledge → Reasoning → Constraint → Action → Reflection
       ↑                                              ↓
       └──────────────── (外部重新调用) ──────────────┘
                       
  Reflection 产生 lessons ──→ ✗ (lessons 不反馈回任何子系统)
  Synapse 学习 ──→ ✗ (不反馈回管道)
  MentalModel 预测 ──→ ✗ (不反馈回行动)
  RuleEngine 可 addRule ──→ ✗ (没有自举规则来源)


目标架构（闭环）:

  Observation → Knowledge → Reasoning → Constraint → Action → Reflection
       ↑                                                        ↓
       │                                                        │
       │  ┌─────────────────────────────────────────────────┐  │
       │  │                                                 │  │
       │  │  Reflection.lessons → RuleGenerator → addRule() │  │
       │  │                                                 │  │
       │  │  Synapse.suggest() → Pipeline.hint()            │  │
       │  │                                                 │  │
       │  │  MentalModel.predict() → Action.consult()       │  │
       │  │                                                 │  │
       │  │  Reflection.issues → PipelineAdapt() → 热加载   │  │
       │  │                                                 │  │
       │  └─────────────────────────────────────────────────┘  │
       └────────────────────────────────────────────────────────┘
```

### 3.5 自举的真正含义

自举不是"系统能启动"——那只是引导（booting）。

自举是"系统能**用自身的能力构建自身的新能力**"：

```
当前:  人类写代码 → 编译 → Axiom 获得新能力
       (Axiom 不参与自身能力的构建)

目标:  Axiom 运行 → 发现缺口 → 生成规则/突触/管道步骤 → 验证 → 热加载
       (Axiom 用自身能力构建自身新能力)
```

**Axiom 已有所有原语**——addRule、createSynapse、updateMentalModel、hot-reload plugin。缺的是**连接它们的元循环**。

---

## 四、综合判定

| 问题 | 判定 | 理由 |
|------|------|------|
| **Runtime 定位** | ✅ 正确，但边界可 sharper | 基座是 Runtime，但认知原语编译进内核限制了可编程性 |
| **模型激发** | ⚠️ 能力留在桌上 | LLM 被当作确定性函数，无探索/多假设/元推理能力 |
| **自持** | ⚠️ 半自持 | 有自动 tick + 熔断 + 热重载，但无自愈/自优化/自适应 |
| **自举** | ❌ 有零件无回路 | 所有原语存在（addRule/createSynapse/hot-reload），但四条反馈路径全断路 |

---

## 五、三个可执行的改进方向

### 方向 1：闭合反馈环（最小改动，最大收益）

**改动量**：~200 行，不破坏任何现有接口。

```
1. ConsciousnessStream.lessons → RuleGenerator → ruleEngine.addRule()
   教训自动转化为规则（经约束验证后）

2. SynapseEngine.suggest() → CognitivePipeline hint
   管道在 Step 2 (知识加载) 时查询突触建议

3. MentalModel.predict() → Step 5 (Action) consult
   行动步骤参考预测结果

4. ReflectionResult.issues → PipelineAdapter
   反思检测到的系统性问题触发管道微调
```

**效果**：系统从"开环执行"变为"闭环学习"。每次执行都让系统变得更好。

### 方向 2：受控创造力模式（中等改动，激发模型能力）

**改动量**：~500 行，新增 LLM 调用模式。

```
在 ReasoningGraph.fillGap() 处增加模式选择:
  - "deterministic" (当前): temp=0, topK=1, 单答案
  - "hypothesis": temp=0.7, n=5, 生成多假设 → 约束筛选
  - "explore": temp=0.8, 自由生成 → 确定性验证
  - "meta": LLM 分析管道表现 → 建议改进 → 安全验证后热加载

模式由管道定义选择，非 LLM 自决——保持确定性裁决。
```

**效果**：LLM 的创造力被释放，但确定性仍然是最终裁判。模型能力被激发，Runtime 定位不破坏。

### 方向 3：可编程认知管道（较大改动，完成 Runtime 定位）

**改动量**：~1000 行重构，将硬编码管道改为可定义。

```
将 CognitivePipeline 的 6 步从硬编码改为:
  pipelineDefinition: PipelineStep[] (JSON/YAML/DSL)

每步:
  - name: string
  - handler: string (已注册的步骤函数名)
  - condition?: string (执行条件)
  - params?: Record<string, unknown>

支持运行时:
  - addStep() / removeStep() / reorderSteps()
  - 热加载新管道定义
  - 管道版本化 (回滚能力)
```

**效果**：Axiom 从"内置认知的 OS 内核"进化为"执行认知程序的运行时"。用户可以编写和部署自定义认知管道，就像在 JVM 上部署 Java 程序。**这是自举的完整形态**——系统能用自身能力（管道执行）构建自身新能力（新管道）。

---

## 六、终极思考

**Axiom 的架构是优秀的 Runtime 基座，但还不是完整的认知运行时。**

差距不在于缺零件——所有零件都在（意识流、突触、心智模型、规则引擎、热重载）。差距在于**零件之间没有闭合的反馈环**。

这就像造了一辆有发动机、变速箱、车轮的车，但传动轴没接上——发动机在转，车轮不转。

**接上传动轴（闭合反馈环）是最高杠杆的改进**：改动最小（~200 行），但将系统从"确定性执行引擎"进化为"确定性自学习运行时"——这才是 Runtime 定位的完整实现，也是自持自举的真正起点。
