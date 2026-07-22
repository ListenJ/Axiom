# Runtime 规范 — 通用 Agent 运行时

> Axiom Runtime v4.0 通用运行时规范。第三方 Agent 实现 `AgentAdapter` 接口即可运行于 `RuntimeHost`。

## 1. 概述

`RuntimeHost` 是一个通用 Agent 宿主，负责：

- 管理 Agent 的注册 / 注销与生命周期
- 按 `task.type` 路由任务到匹配的 Agent
- 错误隔离：单个 Agent 异常不波及其他 Agent
- 资源管理：跟踪每个 Agent 的状态机

源码位置：`src/runtime/`

```
src/runtime/
├── types.ts    # 标准化类型定义 (AgentAdapter / RuntimeContext / RuntimeTask ...)
├── host.ts     # RuntimeHost 实现 + 默认 Context 工厂
└── index.ts    # 导出入口
```

## 2. AgentAdapter 接口

第三方 Agent 必须实现此接口。**最少 6 个必需项**（4 方法 + `id`/`capabilities` 等属性），`healthCheck` 与 `destroy` 为可选：

```typescript
export interface AgentAdapter {
  // 只读标识
  readonly id: string;            // 全局唯一 ID
  readonly name: string;          // 显示名称
  readonly version: string;       // 版本号
  readonly capabilities: string[]; // 可处理的任务 type 列表

  // 生命周期 (4 个必需方法)
  initialize(ctx: RuntimeContext): Promise<void>;  // 初始化
  start(ctx: RuntimeContext): Promise<void>;       // 启动
  stop(ctx: RuntimeContext): Promise<void>;        // 停止
  handleTask(task: RuntimeTask, ctx: RuntimeContext): Promise<RuntimeResult>; // 执行

  // 可选
  destroy?(): Promise<void>;                       // 销毁
  healthCheck?(): Promise<HealthStatus>;           // 健康检查
}
```

### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | Agent 全局唯一标识，用于注册 / 启动 / 停止 / 分发 |
| `name` | `string` | 是 | 显示名称（日志 / 健康检查） |
| `version` | `string` | 是 | 版本号 |
| `capabilities` | `string[]` | 是 | 可处理的任务 `type` 列表；`dispatchTask` 按 `task.type` 匹配 |
| `initialize` | 方法 | 是 | 初始化（加载配置 / 建立连接），由 `startAgent` 调用 |
| `start` | 方法 | 是 | 启动（开始接收任务），由 `startAgent` 调用 |
| `stop` | 方法 | 是 | 停止（释放活跃资源），由 `stopAgent` 调用 |
| `handleTask` | 方法 | 是 | 处理任务，**必须返回 `RuntimeResult`，不应抛出异常** |
| `destroy` | 方法 | 否 | 最终资源清理，由 `stopAgent` 在 `stop` 后调用 |
| `healthCheck` | 方法 | 否 | 返回健康状态，由 `getHealthStatus` 调用 |

## 3. RuntimeContext 提供的能力

`RuntimeHost` 构造 `RuntimeContext` 并在生命周期方法 / `handleTask` 中注入给 Agent。Agent 通过此上下文访问运行时能力，无需直接依赖具体实现：

```typescript
export interface RuntimeContext {
  logger: {            // 结构化日志
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
  scheduler: {         // 任务调度器 (Agent 可提交子任务)
    submit(task: { name; priority; payload; maxRetries; dependencies }): { id: string };
    getNext(): { id: string; name: string } | null;
    complete(id: string, result: unknown): void;
  };
  capabilityRegistry: { // 能力注册表 (按契约选择 Provider)
    select(contract: string): { id: string } | null;
    recordResult(id: string, success: boolean): void;
  };
  knowledge: {          // 知识库
    query(q: string): Promise<unknown[]>;
    store(item: unknown): Promise<void>;
  };
  emit(event: string, data: unknown): void;  // 事件发射
}
```

### 默认实现

`RuntimeHost` 默认提供内存级实现（零依赖）：

| 能力 | 默认实现 | 注入方式 |
|------|----------|----------|
| `logger` | `console.log/warn/error` | `new RuntimeHost({ logger })` |
| `scheduler` | 内存 FIFO 队列 | `new RuntimeHost({ scheduler })` |
| `capabilityRegistry` | 无 provider（`select` 返回 `null`） | `new RuntimeHost({ capabilityRegistry })` |
| `knowledge` | 内存数组 | `new RuntimeHost({ knowledge })` |
| `emit` | `console.log` | `new RuntimeHost({ emit })` |

> **对接 DRE**：可注入 DRE 的 `scheduler` / `capabilityRegistry` / `eventBus` 实例（需适配为 `RuntimeContext` 的最小接口形状）。

## 4. 生命周期管理流程

### 状态机

```
uninitialized ──initialize()──> initialized ──start()──> running
       │                                                       │
       │                                                       │ stop() + destroy()
       ↓                                                       ↓
     error <────────── error (任意阶段抛错) ──────────────── stopped
```

### RuntimeHost 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `registerAgent` | `(adapter: AgentAdapter): void` | 注册 Agent（初始状态 `uninitialized`） |
| `unregisterAgent` | `(id: string): void` | 注销 Agent（同步，推荐先 `stopAgent`） |
| `startAgent` | `(id: string): Promise<void>` | `initialize` → `start`，状态置 `running` |
| `stopAgent` | `(id: string): Promise<void>` | `stop` → `destroy`，状态置 `stopped` |
| `dispatchTask` | `(task: RuntimeTask): Promise<RuntimeResult>` | 按 `task.type` 路由到 `running` Agent |
| `getHealthStatus` | `(): Promise<{ agents; overall }>` | 聚合所有 Agent 健康状态 |

### 完整生命周期示例

```typescript
const host = createRuntimeHost();
host.registerAgent(new MyAgent());        // → uninitialized
await host.startAgent("my-agent");        // uninitialized → initialized → running
const result = await host.dispatchTask({  // → 调用 handleTask
  id: "t1", type: "my-type", input: data,
});
await host.stopAgent("my-agent");         // running → stopped (stop + destroy)
host.unregisterAgent("my-agent");         // 从注册表移除
```

## 5. 错误隔离机制

**核心原则：一个 Agent 的错误不会影响其他 Agent 与 Host 本身。**

### 隔离点

1. **`startAgent`**：`initialize` / `start` 抛错 → Agent 置 `error` 状态，不向上抛出。
2. **`stopAgent`**：`stop` 抛错 → Agent 置 `error`，仍尝试 `destroy`，不向上抛出。
3. **`dispatchTask`**：`handleTask` 抛错或超时 → 返回失败 `RuntimeResult`（`error.code = "AGENT_ERROR"`），不向上抛出。
4. **`getHealthStatus`**：某 Agent 的 `healthCheck` 抛错 → 该 Agent 记为不健康，不影响其他 Agent 检查。

### 错误结果格式

```typescript
{
  taskId: "t1",
  success: false,
  error: { code: "AGENT_ERROR", message: "错误描述" },
  durationMs: 12,
}
```

| 错误码 | 触发场景 |
|--------|----------|
| `NO_AGENT` | 无 `running` Agent 的 `capabilities` 包含 `task.type` |
| `AGENT_ERROR` | `handleTask` 抛异常或超时 |

### 超时保护

`RuntimeTask.timeout`（ms）启用超时：`dispatchTask` 通过 `Promise.race` 竞争执行与超时。超时后返回 `AGENT_ERROR`。

> 注意：超时后原 `handleTask` Promise 仍在后台运行（接口未提供取消信号）。Agent 应自行实现幂等或可中断逻辑。

## 6. 资源管理策略

- **状态跟踪**：Host 维护每个 Agent 的 `AgentState`，`dispatchTask` 仅路由到 `running` 状态的 Agent。
- **幂等停止**：对已停止 / 未初始化的 Agent 调用 `stopAgent` 为空操作（仅告警）。
- **尽力清理**：`stopAgent` 即使 `stop` 失败仍调用 `destroy`，确保资源释放。
- **注册覆盖**：重复注册同一 `id` 会覆盖旧记录并告警。

## 7. 第三方 Agent 集成步骤

### 最少适配代码

```typescript
import type { AgentAdapter, RuntimeContext, RuntimeResult, RuntimeTask } from "./runtime/index.js";

class MyAgent implements AgentAdapter {
  readonly id = "my-agent";
  readonly name = "MyAgent";
  readonly version = "1.0.0";
  readonly capabilities = ["my-task-type"];

  async initialize(_ctx: RuntimeContext): Promise<void> {}
  async start(_ctx: RuntimeContext): Promise<void> {}
  async stop(_ctx: RuntimeContext): Promise<void> {}

  async handleTask(task: RuntimeTask, _ctx: RuntimeContext): Promise<RuntimeResult> {
    const start = Date.now();
    // 业务逻辑
    return { taskId: task.id, success: true, output: null, durationMs: Date.now() - start };
  }
}
```

### 接入流程

1. **实现接口** — `implements AgentAdapter`，实现 4 个必需方法。
2. **声明能力** — `capabilities` 列出可处理的 `task.type`。
3. **创建 Host** — `const host = createRuntimeHost();`（或注入自定义 Context）。
4. **注册** — `host.registerAgent(new MyAgent());`
5. **启动** — `await host.startAgent("my-agent");`
6. **分发任务** — `await host.dispatchTask({ id, type: "my-task-type", input });`
7. **停止清理** — `await host.stopAgent("my-agent");`

### 注入自定义 Context

```typescript
import { createRuntimeHost } from "./runtime/index.js";
import { logger } from "./utils/logger.js";  // 复用项目日志器

const host = createRuntimeHost({
  logger: {
    info: (msg, ctx) => logger.info(msg, ctx),
    warn: (msg, ctx) => logger.warn(msg, ctx),
    error: (msg, ctx) => logger.error(msg, undefined, ctx),
  },
  // 也可注入 scheduler / capabilityRegistry / knowledge / emit
});
```

## 8. 类型导出

`src/runtime/index.ts` 导出：

```typescript
// 类型
export type { AgentAdapter, RuntimeContext, RuntimeTask, RuntimeResult, HealthStatus, AgentState, TaskPriority };

// 实现
export { RuntimeHost, type RuntimeHostOptions };
export { createRuntimeHost };
```

## 9. 示例

完整可运行示例见 [`examples/external-agent/simple-agent.ts`](../examples/external-agent/simple-agent.ts)。
