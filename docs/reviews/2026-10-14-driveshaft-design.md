# 传动轴设计：闭合认知反馈环

> 日期：2026-10-14 | 基于 Axiom Runtime v4.0.0 源码实证

---

## 一、四个断点的精确接口

逐条追踪源码，确认每个断点的输入输出类型：

### 断点 A：意识流 → 规则引擎

```
产出端: ConsciousnessStream.reflection
  → ReflectionResult {
      issues: string[]           // 检测到的问题
      lessons: string[]          // 经验教训（自由文本）
      rollback: boolean          // 是否需要回滚
      correctedAction?: string   // 建议的纠正动作
    }

消费端: RuleEngine.learn(type, name, condition, action, evidence, confidence)
  → Rule { id, type, condition, action, confidence, source: "learned" }
  ✅ 已存在！source 标记为 "learned"

断点: lessons 是 string[]，learn 需要 (condition, action) 结构化参数
      → 需要 LessonParser: string → { condition, action, confidence }
```

### 断点 B：突触 → 认知管道

```
产出端: SynapseEngine.suggestNextSteps(scene, goal, { limit })
  → SynapseSuggestion[] {
      targetId: string           // 建议的知识节点 ID
      targetType: SynapseNodeType
      score: number              // 0-1 综合得分
      reason: string             // 可追溯理由
      via: string[]              // 激活路径
    }
  ✅ 已实现！含 Hebbian 学习 + 扩散激活

消费端: CognitivePipeline Step 2 (知识加载)
  → this.engine.searchData(query, { minConfidence, limit })
  → KnowledgeNode[]

断点: SynapseEngine 未挂载到 DREngine（mentalModels 已挂载，synapse 没有）
      → 需要在 engine 上暴露 synapse 字段
```

### 断点 C：心智模型 → 行动

```
产出端: MentalModelPool.predict(modelId, observation)
  → { predictedState: string, trigger: string, probability: number } | null
  ✅ 已挂载！engine.mentalModels

消费端: CognitivePipeline Step 5 (行动)
  → recommendedAction = classification.action ?? conclusionNode.content.slice(0, 80)
  → 当前完全不 consult 预测

断点: predict() 返回值未被 Step 5 消费
      → 需要在 Step 5 增加 prediction consult
```

### 断点 D：反思问题 → 管道适应

```
产出端: ReflectionResult.issues: string[]
  → 反思检测到的系统性问题

消费端: CognitivePipeline
  → 当前无 addStep/removeStep/modifyConfig 接口
  → 但 searchData 的 limit、minConfidence 等参数可调
  → ruleEngine 可 addRule（间接改变管道行为）

断点: issues 不触发任何参数调整
      → 需要 IssueAccumulator: 收集 → 模式检测 → 参数微调
```

---

## 二、传动轴架构

### 设计原则

1. **EventBus 为骨干** — 组件经事件通信，不直接耦合
2. **每条路径有安全门** — 验证后才生效
3. **置信度加权** — 低置信度只记录不生效
4. **限流** — 防反馈风暴
5. **可观测** — 每个连接 emit 事件供审计
6. **渐进启用** — 每条路径可独立开关

### 整体结构

```
                    CognitivePipeline.run()
                    ┌─────────────────────────────────────────────────┐
                    │  Step 1: Observation (确定性分类)                │
                    │  Step 2: Knowledge ←── ① 突触建议注入           │
                    │  Step 3: Reasoning (推理图 + 空洞检测)           │
                    │  Step 4: Constraint (约束校验)                   │
                    │  Step 5: Action ←── ② 预测咨询                  │
                    │  Step 6: Reflection                              │
                    └────────────────────┬────────────────────────────┘
                                         │
                    eventBus.emit("cognitive.pipeline.completed", {
                      lessons, issues, gaps, confidence, trace
                    })
                                         │
                    ┌────────────────────▼────────────────────────────┐
                    │         MetaCognitiveLoop                        │
                    │  (订阅 cognitive.pipeline.completed)             │
                    │                                                 │
                    │  ┌──────────────┐  ┌──────────────┐            │
                    │  │ Bridge A     │  │ Bridge D     │            │
                    │  │ lessons→rules│  │ issues→adapt │            │
                    │  └──────┬───────┘  └──────┬───────┘            │
                    │         │                 │                    │
                    │  ┌──────▼───────┐  ┌──────▼───────┐            │
                    │  │ SafetyGate A │  │ SafetyGate D │            │
                    │  └──────┬───────┘  └──────┬───────┘            │
                    │         │                 │                    │
                    │  ruleEngine  │    pipeline params │            │
                    │  .learn()    │    (limit, thresh) │            │
                    └─────────────┴─────────────────┴────────────────┘
```

### ① 和 ② 是管道内实时连接（同一次 run 内生效）

- ① 突触建议注入：Step 2 搜索后，合并突触建议（加法，非替换）
- ② 预测咨询：Step 5 计算行动后，对比预测（咨询，非覆盖）

### Bridge A 和 D 是跨轮次连接（下一次 run 生效）

- Bridge A：本轮 lessons → 规则 → 下一轮推理可用
- Bridge D：多轮 issues 累积 → 模式检测 → 参数微调 → 下一轮管道可用

---

## 三、安全门设计

### SafetyGate 通用结构

```typescript
interface SafetyGate {
  // 置信度阈值
  confidenceThreshold: number;     // 默认 0.7

  // 限流
  maxActionsPerWindow: number;     // 默认 10
  windowMs: number;                // 默认 3600_000 (1h)

  // 影子模式（前 N 次只记录不生效）
  shadowModeCount: number;         // 默认 50

  // 预算（总量上限）
  budget: number;                  // 默认 100 (rules/adjustments)

  // 去重
  dedupFn: (candidate, existing) => boolean;
}
```

### 各路径安全门

| 路径 | 置信度阈值 | 限流 | 影子模式 | 预算 | 去重 |
|------|-----------|------|---------|------|------|
| A: lessons→rules | 0.7 | 10/h | 50 次 | 100 规则 | 语义相似度 >0.85 |
| B: synapse→pipeline | 0.3 (score 权重) | 无限 | 0 | 无限 | 天然 (突触去重) |
| C: prediction→action | 0.7 (probability) | 无限 | 0 | 无限 | N/A (咨询不修改) |
| D: issues→adapt | 0.8 | 1/h | 100 次 | 20 调整 | 相同 issue 类型 |

---

## 四、实现计划

### 4.1 新增文件

```
src/dre/runtime/meta-cognitive-loop.ts   — 传动轴主体 + 四个 Bridge
```

### 4.2 修改文件

```
src/dre/engine.ts                        — 暴露 synapse 字段
src/dre/pipeline/cognitive-pipeline.ts   — Step 2 注入突触建议 + Step 5 咨询预测
```

### 4.3 不修改的文件

```
src/dre/runtime/rule-engine.ts           — learn() 已存在，不改
src/dre/synapse/engine.ts                — suggestNextSteps() 已存在，不改
src/dre/mental-model/pool.ts             — predict() 已存在，不改
src/dre/consciousness/stream.ts          — reflection 已存在，不改
```

**关键**：传动轴是**纯连线**——不修改任何已有接口，只连接已有产出端到已有消费端。
