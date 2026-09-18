# Axiom Agent 组件化与 Day0 设计规格

> 状态：已获用户方向确认，等待规格复核。
> 目标：把当前“单体 Agent + 外部 CLI 适配器”改造成“完整、可复用、全线 Day0 可用的组件系统”。
> 范围：不写品牌叙事，只做底层工程架构。

## 1. 摘要

本项目已经拥有模型路由、内部 Agent、工具管道、MCP 注册、Vault/SQLite/KG 记忆、上下文压缩、读取优化、执行模式与审批、Pi Agent 本地代码引擎等大量原生能力。当前真正的问题是这些能力没有统一契约、没有统一启动编排、没有统一执行管线，并且用户可见的默认路径仍然绑定 OpenCode / Kimi Code / Hermes 等外部 CLI。

本设计定义一个 `Component Kernel + Contracts + Runtime` 三层结构：

- `contracts/`：定义 Agent、Tool、ModelBackend、Memory、ContextAssembler、TokenBudget、BrowserDriver、ExternalAdapter 等统一接口。
- `runtime/`：统一注册、生命周期、健康检查、启动编排、执行管线、追踪与权限门。
- `components/`：native-general / native-code / native-research 等核心组件，以及可选的浏览器与外部适配器。

Day0 的定义：全新 clone + `bun install` + 启动后，核心本地能力（记忆、工具、技能、上下文、确定性搜索、原生 Agent）必须可用；外部 CLI 和云 API 只作为可选能力，缺失时明确报告而不是破坏启动。

## 2. 现状盘点

### 2.1 已有组件

| 领域 | 模块 | 当前接口 | Day0 状态 |
|------|------|----------|-----------|
| 模型路由 | `src/router/model-router.ts`、`src/services/router.ts` | role + messages + retry/fallback/stream + token 记录 | 依赖 API Key；无 Key 时 LLM 不可用，但启动不失败 |
| 内部 Agent | `src/agents/internal-agent.ts` | `chat` / `stream` / `executeWithRole` | 依赖至少一个可用模型后端 |
| 工具管道 | `src/tools/types.ts`、`src/tools/pipeline.ts` | `Tool` + `runPipeline` | 核心工具 Day0 可用 |
| MCP 工具 | `src/mcp/tool-registry.ts`、`src/mcp/server/*` | `ToolDef` + 双传输注册 + 安全守卫 | 大部分 Day0；外部 API 工具需 Key |
| 记忆 | `src/memory/vault-manager.ts`、`src/memory/sqlite-memory.ts`、`src/memory/blackboard.ts`、`src/kg/*` | Vault / FTS5 / Blackboard / KG | Day0 |
| 上下文 | `src/context/context-manager.ts`、`src/context/rate-distortion-compressor.ts` | 分割/压缩/摘要/embedding | 已存在，但未接入统一 Agent 执行路径 |
| 读取优化 | `src/utils/read-optimizer.ts`、`src/utils/read-optimizer-init.ts` | 缓存/字段投影/批量/限流/降级 | Day0（codegraph 与 pi-tools 需本地可用） |
| 编排 | `src/agents/orchestrator.ts` | `AgentInterface` + Registry + TaskRouter | 已存在，但默认角色仍映射到 opencode/hermes |
| 原生代码引擎 | `src/pi-agent/pi-code-engine.ts`、`src/pi-agent/pi-code-tools.ts` | 本地检索 + model-router 生成 | 已存在；vendor 动态 import 有 fallback |
| 外部适配器 | `src/agents/opencode-agent.ts`、`src/agents/opencode-tools/`、`src/agents/hermes-agent.ts`、`src/agents/kimi-code-agent.ts` | spawn CLI / 直连 API | 非 Day0；维护成本高 |
| 执行模式 | `src/agents/execution-mode.ts`、`src/utils/approval-bridge.ts` | Plan/Agent/YOLO + HITL | Day0 |
| 浏览器/抓取 | `src/crawl/lightpanda-client.ts` | CDP 渲染/截图/交互元素/动作 | 可选；无真实浏览器标签控制 |
| 前端 | `frontend/src/*` | Dashboard + Panels + WebSocket | Day0 |
| 技能/Prompt | `src/agents/prompt-pool.ts`、`src/agents/prompt-engineer.ts`、`src/agents/prompt-optimizer.ts` | 角色模板/技能匹配/改写 | Day0 |

### 2.2 关键缺口

1. 没有统一组件契约：`AgentInterface`、`Tool`、`ToolDef`、PluginRegistry、services 各自定义接口，无法统一组合和替换。
2. 没有统一生命周期：部分模块 import 时初始化，部分懒加载，部分失败静默，无法形成标准的 `init -> health -> dispose`。
3. 上下文压缩和 token 预算没有接入 Agent 执行路径：`contextManager` 和 `RateDistortionCompressor` 已存在，但 InternalAgent / CodeAgent / ResearchAgent 默认不调用。
4. token 估算逻辑重复：`context-manager`、`rate-distortion-compressor`、`opencode-tools/types`、`tools/types` 各有一套估算。
5. 外部 CLI 仍是第一类公民：routes/agents 和 orchestrator 的命名与默认路由让用户感觉系统依赖 OpenCode/Hermes。
6. 没有统一的组件健康面：`/health`、`/agents`、MCP status 分散，缺少“核心组件 vs 可选适配器”的单一视图。
7. 浏览器控制缺少 Driver 契约：未来扩展、真实 Chrome、夸克、远程 Gateway 应通过同一个 `BrowserDriver` 接口接入。
8. 启动编排分散在 `main.ts`、`services/`、`routes/`、`mcp/server.ts`，新增能力需要多处接线。

## 3. 目标架构

```
frontend / CLI / MCP / HTTP
          │
          ▼
   Component Facade（统一入口）
          │
   ┌──────┴─────────────────────────────┐
   │           runtime/                  │
   │  Registry / Lifecycle / Health      │
   │  Bootstrap / ExecutionPipeline      │
   │  ApprovalGate / Trace / TokenBudget │
   └──────┬─────────────────────────────┘
          │
   ┌──────┴─────────────────────────────┐
   │           contracts/                │
   │  AgentComponent  ToolComponent      │
   │  ModelBackend    MemoryComponent    │
   │  ContextAssembler BrowserDriver     │
   │  SkillProvider   ExternalAdapter    │
   └──────┬─────────────────────────────┘
          │
   ┌──────┴─────────────────────────────┐
   │           components/               │
   │  native-general  native-code        │
   │  native-research memory tools       │
   │  skills browser  adapters           │
   └─────────────────────────────────────┘
```

原则：

- 一切可替换能力都是组件；组件通过契约被 Runtime 使用。
- 组件只声明依赖，不直接 `new` 别的组件；依赖由 Registry 注入。
- 核心组件 Day0 注册；可选组件健康检查失败不影响启动。
- API/MCP/CLI 不直接 import 具体实现，只调用 Component Facade。

## 4. 组件契约

### 4.1 生命周期

```ts
export interface ComponentLifecycle {
  id: string;
  version: string;
  kind: "agent" | "tool" | "model" | "memory" | "context" | "skill" | "browser" | "adapter";
  dependencies?: string[];
  init(ctx: ComponentContext): Promise<void>;
  health(): Promise<ComponentHealth>;
  dispose(): Promise<void>;
}
```

`ComponentHealth` 至少包含：

```ts
export interface ComponentHealth {
  id: string;
  ready: boolean;
  optional: boolean;
  reason?: string;
  metrics?: Record<string, number | string>;
}
```

### 4.2 AgentComponent

```ts
export interface AgentComponent extends ComponentLifecycle {
  capabilities: string[];
  execute(task: AgentTask, ctx: ExecutionContext): Promise<AgentResult>;
}
```

`AgentTask` 包含 `type`、`description`、`input`、`context`、`budget`、`mode`。

### 4.3 ToolComponent

```ts
export interface ToolComponent extends ComponentLifecycle {
  name: string;
  description: string;
  inputSchema: unknown;
  consumesModelToken: boolean;
  risk: "safe" | "caution" | "destructive";
  execute(args: Record<string, unknown>, ctx: ExecutionContext): Promise<unknown>;
}
```

现有 `ToolRegistry` 与 `ToolDef` 作为兼容层适配到该契约。

### 4.4 ModelBackend

```ts
export interface ModelBackend extends ComponentLifecycle {
  roles: TaskRole[];
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ModelResponse>;
  stream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatStreamEvent>;
  embeddings(texts: string[]): Promise<number[][]>;
}
```

`router` 作为聚合 ModelBackend，原生 ModelBackend 可独立注册。

### 4.5 MemoryComponent

```ts
export interface MemoryComponent extends ComponentLifecycle {
  read(request: MemoryReadRequest): Promise<unknown>;
  write(request: MemoryWriteRequest): Promise<unknown>;
  search(query: string, options?: SearchOptions): Promise<unknown[]>;
}
```

Vault、Blackboard、KG、SQLite 都实现或适配该接口。

### 4.6 ContextAssembler 与 TokenBudget

```ts
export interface TokenBudget {
  estimate(text: string): number;
  trimMessage(message: ChatMessage, maxTokens: number): ChatMessage;
  compress(messages: ChatMessage[], budget: number): Promise<CompressedMessages>;
  report(): TokenBudgetReport;
}

export interface ContextAssembler {
  build(task: AgentTask, messages: ChatMessage[], budget: ContextBudget): Promise<BuiltContext>;
}
```

`TokenBudget` 是全系统唯一 token 估算/裁剪/压缩入口，后续各模块逐步迁移到该组件。

### 4.7 BrowserDriver

```ts
export interface BrowserDriver extends ComponentLifecycle {
  listTabs(): Promise<BrowserTab[]>;
  snapshot(tabId: string, mode: "a11y" | "dom" | "text" | "screenshot"): Promise<BrowserSnapshot>;
  act(tabId: string, action: BrowserAction): Promise<BrowserActionResult>;
  subscribe(tabId: string, handler: (event: BrowserEvent) => void): () => void;
}
```

Lightpanda、Chrome 扩展 relay、未来夸克驱动都实现该接口。

### 4.8 ExternalAdapter

```ts
export interface ExternalAdapter extends ComponentLifecycle {
  available(): Promise<boolean>;
  run(task: AdapterTask): Promise<AdapterResult>;
  installGuide(): string;
}
```

OpenCode CLI、Hermes CLI、Kimi Code API/CLI 全部收敛为该契约，不再散落在 routes/agents 中直接 spawn。

## 5. Day0 启动序列

```
1. bun install / migrate（如需）
2. 加载配置与环境校验（strict=false）
3. 初始化 Component Kernel
4. 注册核心组件：
   - Memory（Vault / SQLite / Blackboard / KG）
   - Tools（本地工具 + MCP 工具）
   - ContextAssembler + TokenBudget
   - ModelBackend（router 聚合）
   - Native Agents（general / code / research）
   - Skills + PromptPool
   - ApprovalGate + ExecutionMode
5. 检测可选适配器：
   - OpenCode / Hermes / Kimi / Lightpanda / Browser extension
   - 不阻塞启动，只记录 optional health
6. 生成组件健康报告
7. 启动 HTTP / MCP / CLI / Frontend
8. 暴露统一状态面：/health、/components、/agents/native/status
```

Day0 验收标准：

- 全新环境 `bun install && bun run start` 能启动。
- 不安装任何外部 CLI，核心 Agent 和本地工具可用。
- 未配置 API Key 时，LLM 相关能力明确降级，其他能力不崩。
- `/components` 返回核心组件 ready，适配器标记为 `optional=true`，可用/不可用都不阻塞系统。
- 前端 Agents 页面默认展示 native 组件，外部适配器标为“可选”。

## 6. 统一执行管线

```
TaskIntent
  -> IntentRouter 识别任务类型
  -> ContextAssembler 组装上下文 + TokenBudget
  -> AgentComponent.execute
       -> ToolRegistry.select（按能力/成本/并发）
       -> ExecutionMode + ApprovalGate
       -> ToolComponent.execute
       -> ReadOptimizer / MemoryComponent
       -> 结果聚合
  -> Memory 沉淀 + Trace + TokenTracker
  -> AgentResult
```

该管线对 coding、research、general、browser 任务复用同一骨架，Agent 只负责策略差异。

## 7. Native Agent 默认路径

### 7.1 native-general

- 能力：general-chat、general-tool、planning、decision。
- 实现：InternalAgent + PromptPool + ContextAssembler。

### 7.2 native-code

- 能力：code-generation、code-review、refactoring、testing。
- 实现：PiCodeEngine 本地上下文检索 + InternalAgent 生成；OpenCode CLI 不作为依赖。

### 7.3 native-research

- 能力：research、deep-research、architecture。
- 实现：搜索引擎/爬虫 + Vault 记忆 + InternalAgent 综合；Hermes CLI 不作为依赖。

Orchestrator 的 `roleMapping` 改为：

```ts
{
  "main_coding": "native-code",
  "coding": "native-code",
  "code-generation": "native-code",
  "research": "native-research",
  "architecture": "native-research",
  "decision": "native-general",
  "general-chat": "native-general",
  "general-tool": "native-general"
}
```

`opencode` / `hermes` 仅在外设适配器 available 时作为别名注册。

## 8. TokenBudget 作为核心组件

统一能力：

- 统一估算：中英文混合估算，支持覆盖函数。
- 单消息截断：默认单消息预算。
- 总量压缩：超过预算时按“截断 -> rate-distortion -> 摘要”顺序降级。
- 报告：返回 originalTokens、compressedTokens、rate、mode。
- 与 TokenTracker 联动：每次 Agent 调用记录预算与压缩统计。

接入点：

- `ContextAssembler.build` 默认调用；
- `internal-agent` 提供 `chatBudgeted` 或由 Runtime 包裹；
- `ReadOptimizer` 负责数据读取侧的缓存/字段投影；
- `TokenBudget` 负责 LLM 上下文侧的估算/压缩。

## 9. 外部适配器迁移

将以下模块收敛为 `components/adapters/`：

- `opencode-adapter.ts`：CLI 与免费模型列表。
- `hermes-adapter.ts`：CLI 与 Vault 沉淀。
- `kimi-adapter.ts`：API/CLI。
- `browser-adapter.ts`：Lightpanda/CDP，未来扩展 Chrome relay。

每个 adapter 都实现 `ExternalAdapter`，注册到 Component Kernel。现有 routes/agents 保留兼容层，但读取状态改为组件健康面。

## 10. 落地阶段

### Phase 1：Component Kernel + Native Day0

- 新增 `src/components/kernel.ts`：Registry / Lifecycle / Health / Facade。
- 新增 `src/components/token-budget.ts`：统一估算/裁剪/压缩。
- 新增 `src/components/agents/native-*.ts`：native-general / native-code / native-research。
- Orchestrator 默认注册 native agents，roleMapping 改为 native。
- 新增 `GET /components` 与 `GET /agents/native/status`。
- MCP 新增 `native_toolchain_status`。
- 测试：kernel 生命周期、token-budget、orchestrator native routing、status 契约。

### Phase 2：统一 ContextAssembler

- 所有 Agent 执行前走 `ContextAssembler.build`。
- 删除重复 token 估算，收敛到 `TokenBudget`。
- TokenTracker 记录 context 压缩率。

### Phase 3：适配器组件化

- OpenCode / Hermes / Kimi 迁入 adapter 契约。
- routes/agents 改为读取组件健康面。
- 旧直接 spawn 路径保留兼容但不作为默认。

### Phase 4：BrowserDriver

- 定义 BrowserDriver 契约。
- Lightpanda 先适配。
- Chrome 扩展 relay 按 `docs/BROWSER-AGENT-STRATEGY-2026-08-09.md` 作为独立 Driver 接入。

## 11. 测试策略

- `tests/components/kernel.test.ts`：注册、依赖注入、健康聚合、dispose。
- `tests/components/token-budget.test.ts`：估算、截断、压缩、报告。
- `tests/components/native-agents.test.ts`：无外部 CLI 时 native agents 可用。
- `tests/components/day0-boot.test.ts`：模拟无 Key/无 CLI 环境，核心组件 ready。
- `tests/components/adapters.test.ts`：adapter 缺失时 optional health 为 false。
- 现有测试保持兼容：不删除旧接口，先加适配层。

## 12. 风险与边界

- Day0 不等于免费 LLM：模型能力仍依赖 API Key 或本地模型，但必须是显式降级而不是系统不可用。
- Pi Agent vendor 依赖动态 import：如果 vendor 缺失，native-code 必须回退到 ReadOptimizer + InternalAgent。
- 外部适配器保留兼容层：Phase 1 不删除旧 routes，避免破坏前端和用户脚本。
- 组件 Kernel 不能成为新的“上帝对象”：只做注册/生命周期/健康，不承载业务逻辑。
- “全线 Day0”要诚实：浏览器扩展、远程 Gateway、真实 Chrome 控制属于可选能力，不能伪装成核心 Day0。
