# 外部 Agent 接入示例

本示例演示第三方 Agent 如何通过实现 `AgentAdapter` 接口接入 Axiom Runtime v4.0 的通用运行时宿主 (`RuntimeHost`)。

## 运行方式

在项目根目录 `d:\openclaw-fusion` 执行：

```bash
bun run examples/external-agent/simple-agent.ts
```

无需任何外部依赖或数据库 — `RuntimeHost` 默认提供内存级 `RuntimeContext`，开箱即用。

## 文件说明

- `simple-agent.ts` — `EchoAgent` 示例，实现 `AgentAdapter` 接口，将任务输入原样回显。

## 关键代码解读

### 1. 实现 AgentAdapter

第三方 Agent 只需实现 `AgentAdapter` 接口的 4 个必需方法（`initialize` / `start` / `stop` / `handleTask`），加上 4 个只读属性（`id` / `name` / `version` / `capabilities`）。`healthCheck` 与 `destroy` 为可选：

```typescript
class EchoAgent implements AgentAdapter {
  readonly id = "echo-1";
  readonly name = "EchoAgent";
  readonly version = "1.0.0";
  readonly capabilities = ["echo"];  // 声明可处理的任务类型

  async initialize(ctx: RuntimeContext): Promise<void> { /* ... */ }
  async start(ctx: RuntimeContext): Promise<void> { /* ... */ }
  async stop(ctx: RuntimeContext): Promise<void> { /* ... */ }
  async handleTask(task: RuntimeTask, ctx: RuntimeContext): Promise<RuntimeResult> {
    // 业务逻辑：回显输入
    return { taskId: task.id, success: true, output: { echoed: task.input }, durationMs: 0 };
  }

  // 可选
  async destroy?(): Promise<void> { /* ... */ }
  async healthCheck?(): Promise<HealthStatus> { /* ... */ }
}
```

### 2. 注册并运行

```typescript
import { createRuntimeHost } from "../../src/runtime/index.js";

const host = createRuntimeHost();
host.registerAgent(new EchoAgent());
await host.startAgent("echo-1");                    // initialize + start
const result = await host.dispatchTask({            // 按 type 路由
  id: "task-1", type: "echo", input: "hello",
});
await host.stopAgent("echo-1");                     // stop + destroy
host.unregisterAgent("echo-1");
```

### 3. 任务路由机制

`RuntimeHost.dispatchTask` 在所有 `running` 状态的 Agent 中查找 `capabilities` 包含 `task.type` 的首个 Agent。若找不到匹配 Agent，返回 `success: false` 的错误结果（错误码 `NO_AGENT`），不抛出异常。

### 4. 错误隔离

- Agent 的 `initialize` / `start` / `stop` / `handleTask` 抛错时，Host 捕获并将该 Agent 置为 `error` 状态，**不影响其他 Agent**。
- `dispatchTask` 中 Agent 异常或超时均返回失败 `RuntimeResult`，调用方不会被中断。

## 适配第三方 Agent 的步骤

1. **实现接口**：让你的 Agent 类 `implements AgentAdapter`，实现 4 个必需方法。
2. **声明能力**：在 `capabilities` 数组中列出该 Agent 可处理的任务 `type`。
3. **注册到 Host**：`host.registerAgent(agent)`。
4. **启动**：`await host.startAgent(agent.id)`（触发 `initialize` → `start`）。
5. **分发任务**：`await host.dispatchTask({ id, type, input })`（`type` 须匹配某 Agent 的 `capabilities`）。
6. **停止清理**：`await host.stopAgent(agent.id)`（触发 `stop` → `destroy`）。

完整规范见 [`docs/RUNTIME-SPEC.md`](../../docs/RUNTIME-SPEC.md)。
