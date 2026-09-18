/**
 * Runtime — 通用 Agent 运行时入口
 *
 * 导出 Agent 接入接口与 RuntimeHost 实现。
 * 第三方 Agent 实现 AgentAdapter 即可注册到 RuntimeHost 运行。
 *
 * 用法:
 *   import { createRuntimeHost } from "./runtime/index.js";
 *   const host = createRuntimeHost();
 *   host.registerAgent(new MyAgent());
 *   await host.startAgent("my-agent");
 *   const result = await host.dispatchTask(task);
 */

export type { AgentAdapter, RuntimeContext, RuntimeTask, RuntimeResult, HealthStatus, AgentState, TaskPriority } from "./types.js";
export { RuntimeHost, type RuntimeHostOptions } from "./host.js";
export { createRuntimeHost } from "./host.js";
