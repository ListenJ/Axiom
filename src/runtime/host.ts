/**
 * RuntimeHost — 通用 Agent 运行时宿主
 *
 * 职责:
 * - 管理 AgentAdapter 实例的注册 / 注销
 * - 控制 Agent 生命周期 (initialize → start → stop → destroy)
 * - 分发任务到匹配的 Agent (按 task.type 匹配 agent.capabilities)
 * - 错误隔离: 单个 Agent 的异常不影响其他 Agent 与 Host 本身
 * - 资源管理: 跟踪每个 Agent 的状态机 (AgentState)
 *
 * 默认提供内存级 RuntimeContext (logger / scheduler / capabilityRegistry /
 * knowledge / emit)，零依赖、开箱即用；可通过构造参数注入自定义实现
 * (如对接 DRE 的 scheduler / capabilityRegistry / eventBus)。
 */

import { logger } from "../utils/logger.js";
import type {
  AgentAdapter,
  AgentState,
  HealthStatus,
  RuntimeContext,
  RuntimeResult,
  RuntimeTask,
} from "./types.js";

// ─── 内部 Agent 记录 ───────────────────────────────────────────────────────

interface AgentRecord {
  adapter: AgentAdapter;
  state: AgentState;
}

// ─── Host 构造选项 ─────────────────────────────────────────────────────────

export interface RuntimeHostOptions {
  /** 自定义日志器 (默认 console) */
  logger?: RuntimeContext["logger"];
  /** 自定义调度器 (默认内存队列) */
  scheduler?: RuntimeContext["scheduler"];
  /** 自定义能力注册表 (默认无 provider) */
  capabilityRegistry?: RuntimeContext["capabilityRegistry"];
  /** 自定义知识库 (默认内存数组) */
  knowledge?: RuntimeContext["knowledge"];
  /** 自定义事件发射器 (默认 console.log) */
  emit?: (event: string, data: unknown) => void;
}

// ─── 默认 Context 工厂 (内存级，零依赖) ─────────────────────────────────────

function createDefaultLogger(): RuntimeContext["logger"] {
  return {
    info: (msg, ctx) => logger.info(msg, ctx),
    warn: (msg, ctx) => logger.warn(msg, ctx),
    error: (msg, ctx) => logger.error(msg, undefined, ctx),
  };
}

function createDefaultScheduler(): RuntimeContext["scheduler"] {
  const pending: Array<{ id: string; name: string }> = [];
  const running = new Set<string>();
  let counter = 0;
  return {
    submit(task) {
      const id = `rt-task-${++counter}`;
      pending.push({ id, name: task.name });
      return { id };
    },
    getNext() {
      if (pending.length === 0) return null;
      const t = pending.shift()!;
      running.add(t.id);
      return { id: t.id, name: t.name };
    },
    complete(id) {
      running.delete(id);
    },
  };
}

function createDefaultCapabilityRegistry(): RuntimeContext["capabilityRegistry"] {
  // 默认无 provider；select 永远返回 null。注入真实实现以启用能力选择。
  return {
    select: () => null,
    recordResult: () => { /* 默认无 provider，记录无副作用 */ },
  };
}

function createDefaultKnowledge(): RuntimeContext["knowledge"] {
  const items: unknown[] = [];
  return {
    async query(_q) {
      return [...items];
    },
    async store(item) {
      items.push(item);
    },
  };
}

function createDefaultEmit(): (event: string, data: unknown) => void {
  return (event, data) => {
    logger.info(`[emit] ${event}`, data !== undefined ? { data } : undefined);
  };
}

// ─── RuntimeHost ───────────────────────────────────────────────────────────

export class RuntimeHost {
  private agents = new Map<string, AgentRecord>();
  private readonly ctx: RuntimeContext;

  constructor(opts: RuntimeHostOptions = {}) {
    this.ctx = {
      logger: opts.logger ?? createDefaultLogger(),
      scheduler: opts.scheduler ?? createDefaultScheduler(),
      capabilityRegistry: opts.capabilityRegistry ?? createDefaultCapabilityRegistry(),
      knowledge: opts.knowledge ?? createDefaultKnowledge(),
      emit: opts.emit ?? createDefaultEmit(),
    };
  }

  /** 获取运行时上下文 (供外部观察 / 注入子任务时引用) */
  getContext(): RuntimeContext {
    return this.ctx;
  }

  /**
   * 注册 Agent。
   * 重复注册同一 id 会覆盖并告警。
   */
  registerAgent(adapter: AgentAdapter): void {
    if (this.agents.has(adapter.id)) {
      this.ctx.logger.warn("Agent already registered, overwriting", { id: adapter.id });
    }
    this.agents.set(adapter.id, { adapter, state: "uninitialized" });
    this.ctx.emit("agent.registered", { id: adapter.id, name: adapter.name });
    this.ctx.logger.info("Agent registered", {
      id: adapter.id,
      name: adapter.name,
      version: adapter.version,
      capabilities: adapter.capabilities,
    });
  }

  /**
   * 注销 Agent。
   * 同步接口: 若 Agent 仍在运行，仅记录告警，不阻塞等待停止。
   * 推荐先调用 stopAgent 再注销。
   */
  unregisterAgent(id: string): void {
    const rec = this.agents.get(id);
    if (!rec) {
      this.ctx.logger.warn("unregisterAgent: agent not found", { id });
      return;
    }
    if (rec.state === "running") {
      this.ctx.logger.warn("unregisterAgent: agent still running, force-remove", { id });
    }
    this.agents.delete(id);
    this.ctx.emit("agent.unregistered", { id });
    this.ctx.logger.info("Agent unregistered", { id });
  }

  /**
   * 启动 Agent (initialize + start)。
   * 错误隔离: initialize / start 抛错时将 Agent 置为 error 状态，不向上抛出。
   */
  async startAgent(id: string): Promise<void> {
    const rec = this.agents.get(id);
    if (!rec) {
      this.ctx.logger.error("startAgent: agent not found", { id });
      return;
    }
    if (rec.state === "running") {
      this.ctx.logger.warn("startAgent: agent already running", { id });
      return;
    }

    // initialize (仅在未初始化时执行)
    if (rec.state === "uninitialized") {
      try {
        await rec.adapter.initialize(this.ctx);
        rec.state = "initialized";
      } catch (err) {
        rec.state = "error";
        const msg = this.errMsg(err);
        this.ctx.logger.error("Agent initialize failed", { id, error: msg });
        this.ctx.emit("agent.error", { id, phase: "initialize", error: msg });
        return; // 不抛出，隔离错误
      }
    }

    // start
    try {
      await rec.adapter.start(this.ctx);
      rec.state = "running";
      this.ctx.emit("agent.started", { id });
      this.ctx.logger.info("Agent started", { id });
    } catch (err) {
      rec.state = "error";
      const msg = this.errMsg(err);
      this.ctx.logger.error("Agent start failed", { id, error: msg });
      this.ctx.emit("agent.error", { id, phase: "start", error: msg });
    }
  }

  /**
   * 停止 Agent (stop + destroy)。
   * 错误隔离: stop / destroy 抛错时记录告警，尽力继续清理。
   * 已停止 / 未初始化的 Agent 调用此方法为空操作。
   */
  async stopAgent(id: string): Promise<void> {
    const rec = this.agents.get(id);
    if (!rec) {
      this.ctx.logger.error("stopAgent: agent not found", { id });
      return;
    }
    if (rec.state === "stopped" || rec.state === "uninitialized") {
      this.ctx.logger.warn("stopAgent: agent not running", { id, state: rec.state });
      return;
    }

    // stop
    try {
      await rec.adapter.stop(this.ctx);
    } catch (err) {
      rec.state = "error";
      const msg = this.errMsg(err);
      this.ctx.logger.error("Agent stop failed", { id, error: msg });
      this.ctx.emit("agent.error", { id, phase: "stop", error: msg });
      // 即使 stop 失败也尝试 destroy，确保资源释放
    }

    // destroy (可选)
    if (rec.adapter.destroy) {
      try {
        await rec.adapter.destroy();
      } catch (err) {
        this.ctx.logger.error("Agent destroy failed", { id, error: this.errMsg(err) });
      }
    }

    if (rec.state !== "error") {
      rec.state = "stopped";
    }
    this.ctx.emit("agent.stopped", { id, finalState: rec.state });
    this.ctx.logger.info("Agent stopped", { id, state: rec.state });
  }

  /**
   * 分发任务到匹配的 Agent。
   * 路由: 在 running 状态的 Agent 中查找 capabilities 包含 task.type 的首个。
   * 错误隔离: handleTask 抛错或超时均返回失败 RuntimeResult，不向上抛出。
   */
  async dispatchTask(task: RuntimeTask): Promise<RuntimeResult> {
    const start = Date.now();

    // 查找匹配的 running Agent
    let target: AgentRecord | null = null;
    for (const rec of this.agents.values()) {
      if (rec.state === "running" && rec.adapter.capabilities.includes(task.type)) {
        target = rec;
        break;
      }
    }

    if (!target) {
      const durationMs = Date.now() - start;
      this.ctx.logger.warn("No agent available for task type", {
        taskId: task.id,
        type: task.type,
      });
      return {
        taskId: task.id,
        success: false,
        error: { code: "NO_AGENT", message: `No running agent handles task type: ${task.type}` },
        durationMs,
      };
    }

    const agentId = target.adapter.id;
    this.ctx.emit("task.dispatched", { taskId: task.id, agentId, type: task.type });

    // 错误隔离: 包装 handleTask，捕获异常与超时
    try {
      const execPromise = target.adapter.handleTask(task, this.ctx);
      let result: RuntimeResult;
      if (task.timeout && task.timeout > 0) {
        result = await this.withTimeout(execPromise, task.timeout, task.id);
      } else {
        result = await execPromise;
      }
      this.ctx.emit("task.completed", {
        taskId: task.id,
        agentId,
        success: result.success,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const msg = this.errMsg(err);
      this.ctx.logger.error("Agent handleTask failed", { taskId: task.id, agentId, error: msg });
      this.ctx.emit("task.failed", { taskId: task.id, agentId, error: msg });
      return {
        taskId: task.id,
        success: false,
        error: { code: "AGENT_ERROR", message: msg },
        durationMs,
      };
    }
  }

  /**
   * 整体健康检查。
   * 调用每个 Agent 的 healthCheck (若实现)；未实现则按状态推断 (running=healthy)。
   * healthCheck 自身抛错时记为不健康，不影响其他 Agent 检查。
   */
  async getHealthStatus(): Promise<{ agents: Record<string, HealthStatus>; overall: boolean }> {
    const agents: Record<string, HealthStatus> = {};
    let overall = true;

    for (const [id, rec] of this.agents) {
      try {
        if (rec.adapter.healthCheck) {
          const status = await rec.adapter.healthCheck();
          agents[id] = status;
          if (!status.healthy) overall = false;
        } else {
          // 无 healthCheck 时按状态推断
          const healthy = rec.state === "running";
          agents[id] = { healthy, details: { state: rec.state } };
          if (!healthy) overall = false;
        }
      } catch (err) {
        agents[id] = {
          healthy: false,
          details: { error: this.errMsg(err), state: rec.state },
        };
        overall = false;
      }
    }

    return { agents, overall };
  }

  // ─── 内部工具 ──────────────────────────────────────────────

  /** 为 Promise 增加超时保护。超时后 reject (原 Promise 仍在后台运行，无法取消) */
  private async withTimeout<T>(p: Promise<T>, ms: number, taskId: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Task ${taskId} timed out after ${ms}ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

// ─── 工厂函数 ──────────────────────────────────────────────────────────────

/** 创建 RuntimeHost 实例 (等价于 new RuntimeHost(opts)) */
export function createRuntimeHost(opts?: RuntimeHostOptions): RuntimeHost {
  return new RuntimeHost(opts);
}
