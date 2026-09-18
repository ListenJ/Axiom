/**
 * 示例: 最简第三方 Agent — EchoAgent
 *
 * 演示如何实现 AgentAdapter 接口并注册到 RuntimeHost 运行。
 * EchoAgent 将任务输入原样回显，覆盖完整生命周期:
 *   init → start → handleTask → stop → destroy
 *
 * 运行:
 *   bun run examples/external-agent/simple-agent.ts
 */

import { createRuntimeHost } from "../../src/runtime/index.js";
import type {
  AgentAdapter,
  RuntimeContext,
  RuntimeResult,
  RuntimeTask,
} from "../../src/runtime/index.js";

// ─── EchoAgent ─────────────────────────────────────────────────────────────

/**
 * 回显 Agent — 接收任务输入并原样返回。
 * 实现 AgentAdapter 的 4 个必需方法 + 2 个可选方法 (healthCheck / destroy)。
 */
class EchoAgent implements AgentAdapter {
  readonly id = "echo-1";
  readonly name = "EchoAgent";
  readonly version = "1.0.0";
  /** 声明可处理 type="echo" 的任务 */
  readonly capabilities = ["echo"];

  private startedAt = 0;

  async initialize(ctx: RuntimeContext): Promise<void> {
    ctx.logger.info("EchoAgent 初始化", { id: this.id });
  }

  async start(ctx: RuntimeContext): Promise<void> {
    this.startedAt = Date.now();
    ctx.logger.info("EchoAgent 启动", { id: this.id });
    ctx.emit("echo.started", { id: this.id });
  }

  async stop(ctx: RuntimeContext): Promise<void> {
    const uptime = Date.now() - this.startedAt;
    ctx.logger.info("EchoAgent 停止", { id: this.id, uptimeMs: uptime });
  }

  async destroy(): Promise<void> {
    console.log("[EchoAgent] destroy — 资源已清理");
  }

  async handleTask(task: RuntimeTask, ctx: RuntimeContext): Promise<RuntimeResult> {
    const start = Date.now();
    ctx.logger.info("EchoAgent 处理任务", { taskId: task.id, type: task.type });
    ctx.emit("echo.task.received", { taskId: task.id });

    // 回显输入 — 实际 Agent 在此处执行业务逻辑
    const output = {
      echoed: task.input,
      agent: this.name,
      timestamp: Date.now(),
    };

    return {
      taskId: task.id,
      success: true,
      output,
      durationMs: Date.now() - start,
    };
  }

  async healthCheck() {
    return {
      healthy: this.startedAt > 0,
      details: { id: this.id, name: this.name, uptimeMs: Date.now() - this.startedAt },
    };
  }
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Runtime 外部 Agent 示例 ===\n");

  // 1. 创建 Host (使用默认内存级 RuntimeContext)
  const host = createRuntimeHost();
  console.log("步骤 1: 已创建 RuntimeHost\n");

  // 2. 注册 Agent
  const agent = new EchoAgent();
  host.registerAgent(agent);
  console.log();

  // 3. 启动 Agent (initialize + start)
  console.log("步骤 3: 启动 Agent");
  await host.startAgent(agent.id);
  console.log();

  // 4. 健康检查
  console.log("步骤 4: 健康检查");
  const health = await host.getHealthStatus();
  console.log(JSON.stringify(health, null, 2));
  console.log();

  // 5. 分发任务 (type="echo" 匹配 EchoAgent.capabilities)
  console.log("步骤 5: 分发 echo 任务");
  const task: RuntimeTask = {
    id: "task-001",
    type: "echo",
    input: { message: "Hello, Runtime!" },
    priority: "normal",
  };
  const result = await host.dispatchTask(task);
  console.log("任务结果:", JSON.stringify(result, null, 2));
  console.log();

  // 6. 演示错误隔离 — 分发无匹配 Agent 的任务
  console.log("步骤 6: 分发无匹配 Agent 的任务 (演示错误隔离)");
  const unknownTask: RuntimeTask = {
    id: "task-002",
    type: "nonexistent",
    input: null,
  };
  const unknownResult = await host.dispatchTask(unknownTask);
  console.log("结果 (success=false, 不影响已注册 Agent):", JSON.stringify(unknownResult, null, 2));
  console.log();

  // 7. 演示超时保护 — Agent 正常返回，超时不触发
  console.log("步骤 7: 带超时的任务");
  const timedTask: RuntimeTask = {
    id: "task-003",
    type: "echo",
    input: { msg: "fast" },
    timeout: 5000,
  };
  const timedResult = await host.dispatchTask(timedTask);
  console.log("结果:", JSON.stringify(timedResult, null, 2));
  console.log();

  // 8. 停止 Agent (stop + destroy)
  console.log("步骤 8: 停止 Agent");
  await host.stopAgent(agent.id);
  console.log();

  // 9. 注销 Agent
  console.log("步骤 9: 注销 Agent");
  host.unregisterAgent(agent.id);

  console.log("\n=== 示例完成 ===");
}

main().catch((err) => {
  console.error("示例运行失败:", err);
  process.exit(1);
});
