# OpenClaw AI Agent v2.8.2 — 技术架构文档

> 基于 Bun + TypeScript 的 AI Agent，以 Obsidian Vault 为核心记忆引擎，采用确定性推理（零向量、零 embedding），所有 Agent 共享同一 Markdown 记忆库。

## 目录

1. [架构总览](#架构总览)
2. [规划层](#规划层)
3. [路由层](#路由层)
4. [意识层](#意识层)
5. [工具层](#工具层)
6. [前端](#前端)
7. [API 端点](#api-端点)
8. [论文引用](#论文引用)
9. [测试](#测试)
10. [部署](#部署)

---

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw AI Agent v2.8.2              │
├─────────────────────────────────────────────────────────┤
│  前端 (4 页)                                             │
│  ├─ Home: 欢迎 + 快速输入                                │
│  ├─ Chat: 流式对话 + 会话侧边栏                          │
│  ├─ Search: 统一搜索                                     │
│  └─ Settings: 主题 + 行为 + 系统状态                     │
├─────────────────────────────────────────────────────────┤
│  规划层                                                  │
│  ├─ 复杂度分类 (0 成本)                                  │
│  ├─ LLM 规划 (第一性原理约束)                            │
│  ├─ LRU 缓存 (60s TTL)                                  │
│  └─ 声明级验证 (年份/工具/前提)                          │
├─────────────────────────────────────────────────────────┤
│  路由层                                                  │
│  ├─ 统一路由器 (取代 4 套)                               │
│  ├─ 贝叶斯专业度推断                                     │
│  ├─ 受保护快速路径                                       │
│  ├─ 归一化评分                                           │
│  └─ 指数衰减断路器                                       │
├─────────────────────────────────────────────────────────┤
│  意识层                                                  │
│  ├─ EWMA 自适应异常检测                                  │
│  ├─ 话题漂移检测                                         │
│  ├─ WebSocket 事件广播                                   │
│  └─ 路由信号生成                                         │
├─────────────────────────────────────────────────────────┤
│  工具层                                                  │
│  ├─ ToolFactory: 动态生成工具                            │
│  ├─ ToolMiddleware: 验证/守卫/缓存/指标                  │
│  ├─ ToolComposition: 管道执行                            │
│  ├─ SceneRouter: 意图路由                                │
│  └─ ExecutionMode: 模式守卫                              │
├─────────────────────────────────────────────────────────┤
│  错误处理                                                │
│  ├─ 上下文感知错误消息                                   │
│  ├─ 恢复建议                                             │
│  └─ 严重性分级                                           │
├─────────────────────────────────────────────────────────┤
│  API                                                     │
│  ├─ GET /health: 模块状态                                │
│  ├─ GET /api: 端点文档                                   │
│  ├─ POST /chat: 流式对话                                 │
│  └─ 90+ 其他端点                                         │
└─────────────────────────────────────────────────────────┘
```

### 核心数据流

```
用户消息
  │
  ├─ consciousness.observe() ──→ ActivityTracker (贝叶斯专业度)
  │
  ├─ planExecution() [LRU 缓存]
  │   ├─ 简单任务 → passthrough (0ms)
  │   └─ 复杂任务 → LLM 规划 + 第一性原理约束
  │
  ├─ unifiedRouter.route()
  │   ├─ guardedFastPath (检查失败/漂移/疲劳)
  │   ├─ contextScorer (贝叶斯 + 归一化评分)
  │   └─ routeStrategy (指数衰减断路器)
  │
  ├─ router.executeWithRole()
  │
  ├─ verifyPlanExecution()
  │   ├─ 声明提取 + 年份/工具/前提验证
  │   ├─ DRE 风险评分
  │   └─ Noisy-OR 聚合
  │
  ├─ trace-analyzer (EWMA 自适应)
  │
  └─ WebSocket broadcast
       ├─ routing.decision
       ├─ model.usage
       └─ consciousness.status
```

---

## 规划层

### 文件结构

```
src/agents/planning/
├── plan-schema.ts        # JSON Schema 约束生成
├── first-principles.ts   # 第一性原理 + 反幻觉规则
├── planner.ts            # 复杂度分类 + LLM 规划 + LRU 缓存
├── verifier.ts           # 规则验证 + DRE 风险评分
└── index.ts              # 模块导出
```

### 工作流程

1. **复杂度分类** (0 成本): 关键词匹配判断任务复杂度
   - 简单: 问候、简短问题 → 跳过规划
   - 中等: 单个复杂关键词 → 生成规划
   - 复杂: 多个复杂关键词 → 生成详细规划

2. **LLM 规划**: 调用最便宜的模型 (decision role) 生成 ExecutionPlan
   - 第一性原理约束注入 prompt
   - JSON Schema 约束输出格式
   - 最大 8 步，每步有验证方法

3. **LRU 缓存**: 相同输入 60s 内直接返回缓存结果

4. **声明级验证**: 执行后验证输出
   - 年份合理性检查
   - 工具引用验证
   - 前提走私检测 (arXiv:2606.24902)
   - Noisy-OR 聚合

### ExecutionPlan 结构

```typescript
interface ExecutionPlan {
  understanding: string        // 对问题的理解
  knownFacts: string[]         // 已知事实
  unknowns: string[]           // 需要确认的未知
  steps: PlanStep[]            // 原子步骤
  verificationCriteria: string // 验证标准
  complexity: "simple" | "medium" | "complex"
  firstPrinciples: string[]    // 第一性原理分解
  clarificationsNeeded?: string[] // 需要向用户确认的问题
}
```

---

## 路由层

### 文件结构

```
src/router/
├── unified-router.ts     # 统一路由入口
├── context-scorer.ts     # 意识感知评分
├── route-strategy.ts     # 断路器 + 漂移恢复 + 成本优化
├── model-router.ts       # 底层模型路由
└── model-capability-registry.ts # 模型能力注册表
```

### 路由决策流程

1. **构建上下文**: 收集对话历史、失败记录、专业度、疲劳度
2. **快速路径**: 关键词匹配 (0 成本)
   - 受保护: 检查失败/漂移/疲劳后才使用
   - 降级: 上下文异常时跳过，进入完整评分
3. **上下文评分**: 归一化特征加权求和
4. **策略应用**: 断路器/漂移恢复/成本优化

### 贝叶斯专业度推断

```typescript
// 维护后验概率分布
posterior = { beginner: 0.33, intermediate: 0.34, expert: 0.33 }

// 每条消息更新
update(message) {
  likelihood = computeLikelihood(message)
  for (cat in [beginner, intermediate, expert]) {
    posterior[cat] = posterior[cat] * decay * likelihood[cat]
  }
  normalize(posterior)
}

// 指数衰减: 近期消息权重更高
decay = 0.85
```

### 评分归一化

```
每个特征归一化到 [0, 1]:
- basePriority: / 100
- historyBonus: (+ 10) / 20
- failurePenalty: (+ 40) / 40
- expertiseBonus: (+ 10) / 20
- complexityMatch: (+ 10) / 20
- contextFatigue: (+ 20) / 20
- timePreference: (+ 10) / 10
- driftPenalty: (+ 10) / 10

加权求和 (权重和 = 1.0):
W = { base: 0.25, history: 0.10, failure: 0.20, expertise: 0.10,
      complexity: 0.15, fatigue: 0.10, time: 0.05, drift: 0.05 }
```

---

## 意识层

### 文件结构

```
src/agents/consciousness/
├── index.ts              # 公共 API + WebSocket 广播
├── activity-tracker.ts   # 话题漂移检测 + 回合计数
├── trace-analyzer.ts     # EWMA 自适应异常检测
├── state-store.ts        # Blackboard 状态持久化
├── reflection-loop.ts    # 反思循环
├── trigger.ts            # 触发器评估
├── skill-promoter.ts     # 技能晋升
└── memory-curator.ts     # 记忆整理
```

### EWMA 自适应异常检测

替代固定阈值，使用指数加权移动平均控制图:

```typescript
class AdaptiveThreshold {
  ewma = 0
  ewmaVariance = 0
  alpha = 0.2  // 平滑因子
  k = 3        // sigma 倍数

  update(value: number): boolean {
    delta = value - ewma
    ewma += alpha * delta
    ewmaVariance = (1 - alpha) * (ewmaVariance + alpha * delta²)
    sigma = sqrt(ewmaVariance)
    return |value - ewma| > k * sigma  // 异常检测
  }
}
```

### 话题漂移检测

```typescript
// 追踪最近 10 个意图
recentIntents = ["code", "code", "code", "research", "research", "research"]

// 检测漂移: 最近 3 个与前 3 个完全不同
detectTopicShift(): boolean {
  recent = recentIntents.slice(-3)    // ["research", "research", "research"]
  previous = recentIntents.slice(-6, -3) // ["code", "code", "code"]
  return no_overlap(recent, previous)  // true → 漂移
}
```

### 路由信号

```typescript
interface RoutingSignal {
  patternDrift: boolean      // 话题漂移
  fatigueIndicator: boolean  // 上下文疲劳
  expertiseSignal: "beginner" | "intermediate" | "expert"
  urgencyLevel: "low" | "normal" | "high"
}
```

---

## 工具层

### 文件结构

```
src/mcp/
├── tool-registry.ts      # 工具注册表
├── tool-factory.ts       # 动态工具生成
├── tool-middleware.ts     # 中间件管道
├── tool-composition.ts   # 工具组合
├── enhanced-tools.ts     # 统一导出
├── scene-router.ts       # 意图路由
└── server.ts             # MCP 服务器
```

### ToolFactory — 动态工具生成

```typescript
// REST 客户端
toolFactory.generateRestClient("github-api", "https://api.github.com", "GET")

// CLI 包装器
toolFactory.generateCliWrapper("lint", "eslint {{file}}", "Run ESLint", {
  file: { type: "string", required: true, description: "File path" }
})

// 数据转换
toolFactory.generateDataTransform("json-to-csv", (input) => convert(input))

// 管道步骤
toolFactory.generatePipelineStep("analyze-and-fix", [
  { tool: "code_analyze" },
  { tool: "code_actions" },
  { tool: "fs_write" },
])
```

### ToolMiddleware — 中间件管道

```
工具调用
  ├─ 审计日志 (谁/何时/什么)
  ├─ 断路器检查 (3次失败 → 60s冷却)
  ├─ 输入验证 (类型/必填)
  ├─ 模式守卫 (plan模式阻止写操作)
  ├─ 结果缓存 (30s TTL)
  └─ 执行 → 指标记录
```

### ToolComposition — 工具组合

```typescript
// 顺序管道
compositionEngine.createSequential("fix-lint", "Fix Lint", [
  { tool: "code_diagnostics" },
  { tool: "code_actions" },
  { tool: "fs_write" },
])

// 条件管道
compositionEngine.createConditional("smart-fix", "Smart Fix",
  "code_diagnostics",  // 检查
  "code_actions",      // 有问题 → 修复
  "code_analyze",      // 没问题 → 分析
)

// 执行
const result = await compositionEngine.execute("fix-lint")
```

### 执行模式守卫

```typescript
// 三种模式
type ExecutionMode = "plan" | "agent" | "yolo"

// Plan 模式: 只读，阻止写操作
// Agent 模式: 默认，破坏性操作需审批
// YOLO 模式: 全自动，受信任工作区

// 集成到 MCP 调度
const modeCheck = executionMode.canExecute(toolName)
if (!modeCheck.allowed) {
  return { error: modeCheck.reason }
}
```

---

## 前端

### 页面结构

| 页面 | 路由 | 功能 |
|------|------|------|
| Home | `/` | 欢迎页 + 快速输入 |
| Chat | `/chat` | 流式对话 + 会话侧边栏 |
| Search | `/search` | 统一搜索 (Vault + Code) |
| Settings | `/settings` | 主题 + 行为 + 系统状态 |

### 启动动画

```
Phase 1 (0-1.2s): SVG 线框绘制
  ├─ 侧边栏框架 + 导航项
  ├─ 顶栏框架 + 搜索框 + 图标
  └─ 内容区框架 + 卡片 + 文本行

Phase 2 (1.2-2.0s): 径向填充
  └─ clip-path: circle(0% → 100%) 从中心扩展

Phase 3 (2.0-2.5s): 淡出
  └─ opacity: 1 → 0 露出真实页面
```

### Chat 侧边栏

- 会话列表 (点击加载历史)
- 新建对话按钮
- 活跃会话高亮
- 消息计数 + 时间显示

### 系统状态

Settings 页面显示:
- Planning Phase: Active
- Unified Router: Active
- Consciousness: Active

---

## API 端点

### 核心端点

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/health` | 系统健康 + 模块状态 |
| GET | `/api` | API 文档 (自动生成) |
| GET | `/metrics` | Prometheus 格式指标 |
| GET | `/stats` | 数据库和缓存统计 |
| POST | `/chat` | 流式对话 |
| POST | `/agent-chat` | Agent 对话 |
| GET | `/search?q=...` | 统一搜索 |

### 模块端点

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/vault/stats` | Vault 统计 |
| GET | `/agents/status` | Agent 状态 |
| GET | `/eval/stats` | 模型评估 |
| GET | `/kg/stats` | 知识图谱 |
| GET | `/consciousness/status` | 意识状态 |
| GET | `/plugins` | 插件列表 |
| POST | `/ocr/scan` | OCR 扫描 |
| POST | `/research/run` | 深度研究 |

### 工具端点

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/mcp/scenes` | 场景路由 |
| GET | `/mcp/scenes` | 场景列表 |
| POST | `/eval/run` | 模型评估 |
| POST | `/eval/assign` | 动态分配 |

---

## 论文引用

| 论文 | arXiv | 应用 |
|------|-------|------|
| Fine-Grained UQ | 2602.17431 | 贝叶斯专业度推断 |
| MARCH | 2603.24579 | 受保护快速路径 |
| RT4CHART | 2603.27752 | 声明级幻觉检测 |
| Premise Smuggling | 2606.24902 | 前提走私检测 |
| RefChecker | 2405.14486 | 声明三元组 |
| AEGIS | 2603.20637 | 图引导推理 |
| 控制图理论 | — | EWMA 自适应阈值 |

---

## 测试

### 测试统计

```
总计: 507 tests across 43 files
通过: 500 pass
跳过: 6 skip (MiniMax API key)
失败: 1 fail (DataPipeline 网络超时)
错误: 1 error (OCR tesseract.js 依赖)
```

### 测试覆盖

| 模块 | 测试文件 | 测试数 |
|------|---------|--------|
| Planning | planning.test.ts | 15 |
| Routing | routing.test.ts | 7 |
| Trace Analyzer | trace-analyzer.test.ts | 7 |
| Activity Tracker | activity-tracker.test.ts | 9 |
| Tool Factory | tool-factory.test.ts | 8 |
| Tool Middleware | tool-middleware.test.ts | 5 |
| Tool Composition | tool-composition.test.ts | 7 |
| E2E Layout | e2e-layout.test.ts | 13 |
| Responsive | responsive.test.ts | 25 |

---

## 部署

### 环境要求

- Bun 1.3+
- Node.js 18+ (前端构建)
- SQLite (内置)
- 可选: PostgreSQL, Redis, llama.cpp

### 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/ListenJ/openclaw-fusion.git
cd openclaw-fusion

# 2. 安装依赖
bun install
cd frontend && npm install && cd ..

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 API 密钥

# 4. 启动服务
bun run start

# 5. 打开浏览器
open http://localhost:18789
```

### 环境变量

```bash
# 必需
OPENCLAW_AUTH_TOKEN=your-auth-token

# 可选 (至少一个 LLM 提供商)
SILICONFLOW_API_KEY=your-key
DEEPSEEK_API_KEY=your-key
OPENROUTER_API_KEY=your-key

# 可选 (搜索)
SERPAPI_API_KEY=your-key

# 可选 (GitHub)
GITHUB_TOKEN=your-token
```

### Docker

```bash
docker build -t openclaw .
docker run -p 18789:18789 -v ./data:/app/data openclaw
```

---

## 版本历史

| 版本 | 日期 | 主要变更 |
|------|------|---------|
| v2.8.2 | 2026-06-28 | 规划层 + 动态路由 + 工具系统 + 前端精简 |
| v2.3.0 | 2026-06-20 | Rust 原生核心 + 双版本 + 统一 TUI |
| v2.2.0 | 2026-06-10 | 扁平路由架构 + 快速键 CLI |
| v2.1.0 | 2026-06-01 | 智能任务分配 + 模型能力注册表 |
| v2.0.0 | 2026-05-20 | 初始发布 |

---

## 许可证

MIT License
