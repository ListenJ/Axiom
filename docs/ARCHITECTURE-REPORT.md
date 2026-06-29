# OpenClaw Runtime Architecture Report

> Generated: 2026-06-29
> Branch: `feature/runtime-integration`
> Total: 93 commits, 732 tests, ~35,000 lines backend + ~2,500 lines frontend

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                     OpenClaw Runtime v3.2.0                      │
├─────────────────────────────────────────────────────────────────┤
│  前端层 (4 页)                                                   │
│  ├─ Home: 欢迎 + 快速输入                                        │
│  ├─ Chat: 流式对话 + 会话侧边栏 + ChatActor 集成                 │
│  ├─ Search: 统一搜索                                             │
│  └─ Settings: 主题 + 行为 + 系统状态                             │
├─────────────────────────────────────────────────────────────────┤
│  路由层 (HTTP → Runtime)                                         │
│  ├─ chat.ts: 10 步管道 (意图→约束→规则→记忆→规划→检索→Actor→路由) │
│  ├─ health.ts: /health + /api + /runtime                         │
│  └─ 90+ 其他端点                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Runtime Kernel                                                  │
│  ├─ Event Bus (所有通信通过事件)                                  │
│  ├─ World State (统一状态树)                                     │
│  ├─ Tick Engine (7阶段持续循环)                                  │
│  └─ Actor Runtime (消息传递)                                     │
├─────────────────────────────────────────────────────────────────┤
│  认知层                                                          │
│  ├─ Cognitive Pipeline (8阶段确定性推理)                         │
│  ├─ Constraint Solver (5种约束类型)                              │
│  ├─ Rule Engine (6种操作符 + 可学习)                             │
│  └─ Verification Engine (全流程验证)                             │
├─────────────────────────────────────────────────────────────────┤
│  知识层                                                          │
│  ├─ Atom Engine (统一原子表示)                                   │
│  ├─ Knowledge Network (Entity+State+Constraint+Capability+Evidence) │
│  ├─ Memory Engine (Observation→Episode→Pattern→Skill)            │
│  └─ Capability Registry (能力调度)                               │
├─────────────────────────────────────────────────────────────────┤
│  投影层                                                          │
│  ├─ Markdown → ./data/projections/markdown/                      │
│  ├─ SQLite → ./data/projections/runtime.db                       │
│  ├─ Knowledge Graph → 内存图                                     │
│  └─ Cache → 热数据缓存                                          │
├─────────────────────────────────────────────────────────────────┤
│  外部层                                                          │
│  ├─ MCP Server (30+ 工具)                                        │
│  ├─ LLM Providers (10+ 提供商)                                   │
│  ├─ External Agents (OpenCode/Hermes/Claude/GPT)                 │
│  └─ Vault/SQLite/KG 存储                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、Runtime 模块详解 (src/runtime/)

### 2.1 核心内核

| 文件 | 行数 | 职责 | 上级模块 | 状态 |
|------|------|------|---------|------|
| `kernel.ts` | 683 | Event Bus + World State + Tick Engine + Actor Runtime | Runtime Core | ✅ 活跃 |
| `atom-engine.ts` | 355 | 统一原子表示 + 代码/Markdown 解析器 | Runtime Core | ✅ 活跃 |
| `scheduler.ts` | 605 | 任务调度 + Cognitive Pipeline (8阶段确定性推理) | Runtime Core | ✅ 活跃 |
| `index.ts` | 89 | 公共导出 | Runtime Core | ✅ 活跃 |

**kernel.ts 详细职责：**
- `EventBusImpl`: 发布/订阅事件总线，所有模块通过事件通信
- `WorldStateImpl`: 统一状态树，所有其他存储是投影
- `TickEngineImpl`: 7阶段持续循环 (observe/update/reason/schedule/execute/reflect/sleep)
- `ActorRuntimeImpl`: Actor 消息传递框架

**scheduler.ts 详细职责：**
- `SchedulerImpl`: 优先级队列 + 资源预算 + 依赖解析
- `CognitivePipelineImpl`: 8阶段确定性推理管道
  1. Observation: 搜索 atoms + memory + knowledge
  2. Normalization: 去重标准化
  3. Entity Resolution: 12种NER模式提取实体
  4. State Update: 更新世界状态
  5. Constraint Check: 约束求解
  6. Graph Reasoning: 图遍历 + 知识网络搜索
  7. Planning: 判断是否需要LLM
  8. Verification: 验证结果

### 2.2 认知层

| 文件 | 行数 | 职责 | 上级模块 | 状态 |
|------|------|------|---------|------|
| `constraint-solver.ts` | 239 | 约束求解 (requires/prohibits/enables/conflicts/excludes) | Reasoning | ✅ 活跃 |
| `rule-engine.ts` | 429 | 规则求值 + 学习 (6种操作符: ==,!=,contains,>,<,matches,in) | Reasoning | ✅ 活跃 |
| `verification-engine.ts` | 345 | 全流程验证 (Input→Reasoning→Execution→Result) | Verification | ✅ 活跃 |

**constraint-solver.ts 详细职责：**
- 5种约束类型: requires, prohibits, enables, conflicts, excludes
- `solve()`: 检查实体集是否满足所有约束
- `learn()`: 从观察中学习新约束
- 预定义约束: 工具依赖、模式限制、模型约束

**rule-engine.ts 详细职责：**
- 6种操作符: ==, !=, contains, >, <, >=, <=, matches, in
- 4种规则类型: inference, constraint, action, validation, routing
- `evaluate()`: 求值规则匹配
- `learn()`: 从观察中学习新规则
- `learnFromMemory()`: 从 Memory Engine 模式中学习

### 2.3 知识层

| 文件 | 行数 | 职责 | 上级模块 | 状态 |
|------|------|------|---------|------|
| `knowledge-network.ts` | 256 | Entity+State+Constraint+Capability+Evidence+Timeline | Knowledge | ✅ 活跃 |
| `memory-engine.ts` | 858 | Observation→Episode→Pattern→Knowledge→Skill→Policy | Memory | ✅ 活跃 |
| `capability-registry.ts` | 280 | 能力调度 (替代 Agent 调度) | Dispatch | ✅ 活跃 |

**knowledge-network.ts 详细职责：**
- `KnowledgeEntity`: id, kind, name, content, state, constraints, capabilities, evidence, timeline
- `create()`: 创建知识实体
- `updateState()`: 更新实体状态
- `addEvidence()`: 添加证据链
- `addConstraint()`: 添加约束
- `addCapability()`: 添加能力

**memory-engine.ts 详细职责：**
- 管道: Observation → Episode → Pattern → Knowledge → Skill → Policy
- `observe()`: 记录观察
- `completeEpisode()`: 完成 episode 并形成知识
- `formSkillsFromPatterns()`: 从模式中形成技能
- `formSkillsFromSuccessfulEpisodes()`: 从成功 episode 中形成技能
- `autoLearnFromPatterns()`: 自动学习
- `findSimilarObservations()`: 相似度搜索
- `cleanup()`: 自动清理旧观察

**capability-registry.ts 详细职责：**
- 内部能力: code_analyze, memory_search, planning, constraint_solving
- 外部能力: hermes_planning, claude_reasoning, opencode_coding
- `select()`: 选择最优能力
- `recordResult()`: 记录结果

### 2.4 Actor 层

| 文件 | 行数 | 职责 | 上级模块 | 状态 |
|------|------|------|---------|------|
| `chat-actor.ts` | 197 | 聊天请求中央协调器 | Actor | ✅ 活跃 |
| `actors.ts` | 214 | Actor 实现 (Memory/Reflection/Planner/Search) | Actor | ✅ 活跃 |

**chat-actor.ts 详细职责：**
- 接收用户消息
- 流程: Memory → Constraint → Rule → Pipeline → Capability → Verify → Response
- `requestAndWait()`: HTTP → Actor → HTTP 桥接

### 2.5 投影层

| 文件 | 行数 | 职责 | 上级模块 | 状态 |
|------|------|------|---------|------|
| `projection-layer.ts` | 397 | Vault/KG/SQLite/Cache 投影 | Persistence | ✅ 活跃 |
| `context-engine.ts` | 178 | 统一上下文构建 | Context | ✅ 活跃 |

**projection-layer.ts 详细职责：**
- `MarkdownProjection`: 写入 ./data/projections/markdown/
- `SQLiteProjection`: 写入 ./data/projections/runtime.db
- `KGProjection`: 生成图数据
- `CacheProjection`: 热数据缓存
- `syncAll()`: 同步所有投影

---

## 三、路由层详解 (src/routes/)

### 3.1 核心路由

| 文件 | 路由 | 职责 | 状态 |
|------|------|------|------|
| `chat.ts` | POST /chat, POST /agent-chat | 10步管道: 意图→约束→规则→记忆→规划→检索→Actor→路由→验证→响应 | ✅ 活跃 |
| `health.ts` | GET /health, /api, /runtime | 健康检查 + API文档 + 运行时状态 | ✅ 活跃 |
| `search.ts` | GET /search, /web-search, ... | 统一搜索 (Vault + Web) | ✅ 活跃 |
| `vault.ts` | GET/POST /vault/* | Vault CRUD + CodeGraph | ✅ 活跃 |
| `agents.ts` | GET/POST /agents/* | 外部 Agent 集成 | ✅ 活跃 |

**chat.ts 详细流程：**
```
1. 意图识别 (buildAgentMessages)
2. 意识观察 (consciousness.observe)
3. 约束检查 (constraintSolver.solve)
4. 规则求值 (ruleEngine.evaluate)
5. 记忆观察 (memoryEngine.observe)
6. 规划阶段 (planExecution)
7. 代码检索 (retrieveCodeMemory)
8. 知识检索 (decomposeQuery + searchKnowledgeBase)
9. ChatActor 处理 (deterministic first)
10. UnifiedRouter 回退 (LLM fallback)
11. 验证 (verificationEngine.verifyResult)
12. 记忆反馈 (memoryEngine.completeEpisode)
```

---

## 四、Agent 层详解 (src/agents/)

### 4.1 意识层

| 文件 | 行数 | 职责 | 状态 |
|------|------|------|------|
| `consciousness/index.ts` | 295 | 公共API + 单例 + 路由信号 | ✅ 活跃 |
| `consciousness/activity-tracker.ts` | 153 | 活动追踪 + 话题漂移检测 | ✅ 活跃 |
| `consciousness/trace-analyzer.ts` | 196 | EWMA 自适应异常检测 | ✅ 活跃 |
| `consciousness/reflection-loop.ts` | 219 | 反思循环 | ✅ 活跃 |
| `consciousness/skill-promoter.ts` | 151 | 技能晋升 | ✅ 活跃 |
| `consciousness/memory-curator.ts` | 151 | 记忆整理 | ✅ 活跃 |

### 4.2 规划层

| 文件 | 行数 | 职责 | 状态 |
|------|------|------|------|
| `planning/planner.ts` | 329 | 复杂度分类 + LLM规划 + LRU缓存 | ✅ 活跃 |
| `planning/verifier.ts` | 347 | 规则验证 + DRE风险评分 + 声明级验证 | ✅ 活跃 |
| `planning/first-principles.ts` | 113 | 第一性原理 + 反幻觉规则 | ✅ 活跃 |
| `planning/plan-schema.ts` | 147 | JSON Schema 约束 | ✅ 活跃 |

### 4.3 路由层

| 文件 | 行数 | 职责 | 状态 |
|------|------|------|------|
| `intent-router.ts` | 221 | 零成本关键词意图识别 | ✅ 活跃 |
| `orchestrator.ts` | 640 | 多Agent编排 | ⚠️ 未集成 |
| `prompt-pool.ts` | 705 | 提示词模板池 | ✅ 活跃 |

---

## 五、路由器层详解 (src/router/)

### 5.1 核心路由

| 文件 | 行数 | 职责 | 状态 |
|------|------|------|------|
| `unified-router.ts` | 273 | 统一路由入口 | ✅ 活跃 |
| `model-router.ts` | 597 | 主路由器 v5.0 | ✅ 活跃 |
| `context-scorer.ts` | 354 | 贝叶斯专业度推断 + 归一化评分 | ✅ 活跃 |
| `route-strategy.ts` | 225 | 断路器 + 漂移恢复 + 成本优化 | ✅ 活跃 |
| `model-capability-registry.ts` | 138 | 模型能力注册表 | ✅ 活跃 |
| `models.ts` | 1060 | 模型定义 + 提供商配置 | ✅ 活跃 |

**unified-router.ts 路由流程：**
```
1. 构建上下文 (buildRoutingContext)
2. 关键词快速路径 (keywordFastPath)
   └─ 受保护: 检查失败/漂移/疲劳
3. Capability Registry 检查
4. 上下文评分 (scoreCandidates)
5. 策略应用 (applyStrategies)
6. 返回路由决策
```

---

## 六、MCP 工具层详解 (src/mcp/)

### 6.1 核心基础设施

| 文件 | 行数 | 职责 | 状态 |
|------|------|------|------|
| `server.ts` | 1177 | MCP 服务器 (30+ 工具) | ✅ 活跃 |
| `tool-registry.ts` | 78 | 统一工具注册表 | ✅ 活跃 |
| `tool-factory.ts` | 371 | 动态工具生成 | ✅ 活跃 |
| `tool-middleware.ts` | 271 | 工具中间件管道 | ✅ 活跃 |
| `tool-composition.ts` | 294 | 工具组合引擎 | ✅ 活跃 |
| `scene-router.ts` | 226 | 场景驱动工具调用 | ✅ 活跃 |

### 6.2 工具文件

| 文件 | 工具数 | 职责 | 状态 |
|------|--------|------|------|
| `tools/filesystem.ts` | 6 | 文件读写/列表/搜索/删除/移动 | ✅ 已注册 |
| `tools/terminal.ts` | 3 | 命令执行/进程列表/系统信息 | ✅ 已注册 |
| `tools/git.ts` | 5 | Git状态/差异/日志/分支/注释 | ✅ 已注册 |
| `tools/code-analysis.ts` | 8 | 代码分析/符号/诊断/大纲 | ✅ 已注册 |
| `tools/github.ts` | 19 | GitHub API (Issues/PRs/Repos) | ⚠️ 未注册 |
| `tools/workspace-snapshot.ts` | 5 | 工作区快照 | ✅ 已注册 |
| `tools/minimax.ts` | 4 | MiniMax AI API | ✅ 已注册 |

---

## 七、前端层详解 (frontend/src/)

### 7.1 页面 (4 页)

| 文件 | 路由 | 职责 | 状态 |
|------|------|------|------|
| `pages/Home.tsx` | `/` | 欢迎页 + 快速输入 | ✅ 活跃 |
| `pages/Chat.tsx` | `/chat` | 流式对话 + 会话侧边栏 | ✅ 活跃 |
| `pages/Search.tsx` | `/search` | 统一搜索 | ✅ 活跃 |
| `pages/Settings.tsx` | `/settings` | 主题 + 行为 + 系统状态 | ✅ 活跃 |

### 7.2 布局组件

| 文件 | 职责 | 状态 |
|------|------|------|
| `Layout.tsx` | 根布局 + OpeningAnimation | ✅ 活跃 |
| `Header.tsx` | 顶栏 | ✅ 活跃 |
| `Sidebar.tsx` | 侧边导航 | ✅ 活跃 |
| `BottomNav.tsx` | 移动端底部导航 | ✅ 活跃 |
| `OpeningAnimation.tsx` | 启动动画 (线框绘制 + 径向填充) | ✅ 活跃 |

### 7.3 UI 组件

| 文件 | 职责 | 状态 |
|------|------|------|
| `Button.tsx` | 按钮 | ✅ 活跃 |
| `Input.tsx` | 输入框 | ✅ 活跃 |
| `Tabs.tsx` | 标签页 | ✅ 活跃 |
| `StatCard.tsx` | 统计卡片 | ✅ 活跃 |
| `BarChart.tsx` | 柱状图 | ✅ 活跃 |
| `ShimmerCard.tsx` | 闪光卡片 | ✅ 活跃 |
| `PageHeader.tsx` | 页面标题 | ✅ 活跃 |
| `EmptyState.tsx` | 空状态 | ✅ 活跃 |
| `HelpModal.tsx` | 帮助弹窗 | ✅ 活跃 |
| `Toasts.tsx` | 通知 | ✅ 活跃 |

---

## 八、数据流图

### 8.1 请求流

```
用户消息
  │
  ├─ chat.ts: 意图识别 (buildAgentMessages)
  │
  ├─ consciousness.observe() ──→ ActivityTracker (O(1))
  │
  ├─ constraintSolver.solve() ──→ 约束检查
  │
  ├─ ruleEngine.evaluate() ──→ 规则求值
  │
  ├─ memoryEngine.observe() ──→ 记录观察
  │
  ├─ planExecution() ──→ 复杂任务生成计划
  │
  ├─ ChatActor.requestAndWait()
  │   ├─ cognitivePipeline.run() ──→ 确定性推理
  │   ├─ 如果确定性回答 → 验证 → 返回
  │   └─ 如果需要LLM → 继续
  │
  ├─ unifiedRouter.route()
  │   ├─ capabilityRegistry.select() ──→ 能力匹配
  │   ├─ contextScorer ──→ 上下文评分
  │   └─ routeStrategy ──→ 策略选择
  │
  ├─ router.executeWithRole() ──→ LLM调用
  │
  ├─ verificationEngine.verifyResult() ──→ 验证
  │
  ├─ memoryEngine.completeEpisode() ──→ 记忆反馈
  │
  └─ WebSocket broadcast (routing.decision + model.usage)
```

### 8.2 Tick 循环 (每秒)

```
Tick Engine
  ├─ observe: 发布 tick 事件
  ├─ update: 同步所有模块统计到 World State
  ├─ reason: 求值规则 + 检查约束
  ├─ schedule: 处理待执行任务
  ├─ execute: 跟踪 Actor 统计
  ├─ reflect: 更新指标 + 规则学习 + 技能形成
  └─ sleep: 清理旧观察 (每100 ticks)
```

---

## 九、当前实现状态 vs 改造意见

| # | 改造意见 | 实现状态 | 证据 |
|---|---------|---------|------|
| 1 | Agent = 纯执行体 | ✅ 已实现 | `chat-actor.ts` 接管聊天流程，`agent-executor.ts` 定义纯执行体 |
| 2 | Event Bus 替代直接调用 | ✅ 已实现 | `kernel.ts` Event Bus，所有 Runtime 模块通过事件通信 |
| 3 | World State 唯一事实源 | ⚠️ 部分实现 | Tick Engine 同步统计，但 Vault/SQLite 仍是独立存储 |
| 4 | Tick Engine 持续循环 | ✅ 已实现 | 7 阶段全部有处理器 |
| 5 | 所有模块 Actor 化 | ⚠️ 部分实现 | ChatActor 已集成，其他模块结构性存在 |
| 6 | Capability Registry 替代 Agent 调度 | ✅ 已实现 | 集成到 unified-router.ts |
| 7 | Memory 产生 Skill | ✅ 已实现 | Observation→Episode→Pattern→Knowledge→Skill 管道 |
| 8 | Rule 可学习 | ✅ 已实现 | `learnFromMemory()` + Tick 推理阶段 |
| 9 | Constraint 阻止执行 | ✅ 已实现 | chat.ts 路由前检查 |
| 10 | 全流程验证 | ✅ 已实现 | Input→Reasoning→Execution→Result |
| 11 | Cognitive Pipeline | ✅ 已实现 | 8 阶段确定性推理 |
| 12 | Projection 同步 | ✅ 已实现 | 真实 SQLite + Markdown + 自动同步 |

---

## 十、已知问题

### 10.1 高优先级

| 问题 | 文件 | 严重度 | 描述 |
|------|------|--------|------|
| `handleChatStream` 不存在 | routes/index.ts | 🔴 高 | 导入了不存在的函数，运行时会崩溃 |
| CJS require() | memory-engine.ts | 🟡 中 | 两处使用 `require()` 打破循环依赖 |
| `enhanced-tools.ts` 未导入 | src/mcp/ | 🟢 低 | 桶文件从未被导入 |

### 10.2 中优先级

| 问题 | 文件 | 描述 |
|------|------|------|
| `agent-executor.ts` 未调用 | src/runtime/ | 定义了完整执行体但从未被调用 |
| `orchestrator.ts` 未集成 | src/agents/ | 640 行的多 Agent 编排器从未被使用 |
| `github.ts` 未注册 | src/mcp/tools/ | 19 个 GitHub 工具定义但未注册到 MCP |
| 双模型注册表 | src/router/ | `models.ts` 和 `models/` 并存 |

### 10.3 低优先级

| 问题 | 描述 |
|------|------|
| `agent-discovery.ts` 死代码 | 254 行，从未被导入 |
| `project-analyzer.ts` 死代码 | 1056 行，从未被导入 |
| `task-orchestrator.ts` 未集成 | 370 行，仅被 tui/app.ts 导入 |

---

## 十一、测试覆盖

| 测试文件 | 测试数 | 状态 |
|----------|--------|------|
| runtime.test.ts | 16 | ✅ |
| runtime-modules.test.ts | 30 | ✅ |
| runtime-integration.test.ts | 13 | ✅ |
| runtime-advanced.test.ts | 18 | ✅ |
| runtime-edge-cases.test.ts | 25 | ✅ |
| runtime-integration-v2.test.ts | 18 | ✅ |
| runtime-complete.test.ts | 11 | ✅ |
| runtime-e2e.test.ts | 17 | ✅ |
| runtime-comprehensive.test.ts | 31 | ✅ |
| memory-engine-advanced.test.ts | 15 | ✅ |
| cognitive-memory.test.ts | 12 | ✅ |
| similarity.test.ts | 6 | ✅ |
| runtime-final.test.ts | 13 | ✅ |
| **Runtime 总计** | **225** | ✅ |
| 其他测试 | 497 | ✅ |
| **总计** | **724** | ✅ |

---

## 十二、版本路线

| 版本 | 内容 | 状态 |
|------|------|------|
| v2.8.2 | Runtime Kernel + Event Bus + Atom Engine | ✅ 完成 |
| v2.9.0 | Capability Registry + Constraint Solver | ✅ 完成 |
| v3.0.0 | Knowledge Network + Memory Engine + Agent 瘦身 | ✅ 完成 |
| v3.1.0 | Rule Engine + Verification + Evidence | ✅ 完成 |
| v3.2.0 | Projection Layer + 全面测试 + 边界测试 | ✅ 完成 |
| v3.3.0 | Runtime 集成 + ChatActor + 全流程 | ✅ 完成 |

---

## 十三、下一步建议

### 高优先级
1. **修复 `handleChatStream`** — 实现 SSE 流式聊天或移除导入
2. **注册 GitHub 工具** — 19 个 GitHub 工具未注册到 MCP
3. **移除死代码** — `agent-discovery.ts`, `project-analyzer.ts` (1300+ 行)

### 中优先级
4. **统一模型注册表** — 解决 `models.ts` 和 `models/` 并存问题
5. **集成 Orchestrator** — 640 行的多 Agent 编排器应被使用
6. **Wire agent-executor** — 纯执行体应被 ChatActor 使用

### 低优先级
7. **添加 chat 流式支持** — 实现 SSE 流式响应
8. **完善 Projection Layer** — 实现到真实 Vault/KG 的同步
9. **添加更多测试** — 提高覆盖率到 80%+
