/**
 * DRE Kernel — 极薄启动器
 *
 * Kernel 只负责 init (启动所有模块) 和 tick (驱动循环)。
 * 所有业务逻辑在 DREngine 内管理。
 */

import { DREngine, type DREConfig } from "./engine.js";
import { eventBus, type RuntimeEvent } from "./runtime/event-bus.js";
import { worldState } from "./runtime/world-state.js";
import { scheduler } from "./runtime/scheduler.js";
import { getResourceBudgetManager } from "./system-resource.js";
import { logger } from "../utils/logger.js";

export interface KernelConfig extends DREConfig {
  tickInterval?: number;
  autoTick?: boolean;
  /** H1：任务派发给 Actor 的 ask 超时（ms），超时视为失败进入重试 */
  actorAskTimeoutMs?: number;
}

export interface KernelStatus {
  state: "initializing" | "running" | "idle" | "stopped";
  uptime: number;
  tickCount: number;
  lastTickTime: number;
  engineStatus: ReturnType<DREngine["getStatus"]>;
  schedulerStatus: ReturnType<typeof scheduler.getStatus>;
}

export class Kernel {
  readonly engine: DREngine;
  readonly config: KernelConfig;

  private _state: KernelStatus["state"] = "initializing";
  private _tickCount = 0;
  private _lastTickTime = 0;
  private _startTime = 0;
  private _tickTimer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;
  private _running = false;

  constructor(config: KernelConfig) {
    this.config = config;
    this.engine = new DREngine(config);
    this._startTime = Date.now();
  }

  async init(): Promise<void> {
    logger.info("[Kernel] Initializing...");

    await this.engine.waitForReady();

    worldState.set("system.kernel", {
      version: "3.0.0",
      startedAt: this._startTime,
      tickInterval: this.config.tickInterval ?? 5000,
    });

    const budget = getResourceBudgetManager();
    const resourceStatus = budget.getStatus();
    worldState.set("system.resource", resourceStatus.resource);

    if (!resourceStatus.canRunLocal) {
      logger.warn("[Kernel] Local inference not available", {
        availableMemory: resourceStatus.resource.availableMemory,
      });
    }

    this._state = "idle";

    if (this.config.autoTick !== false) {
      this.startTickLoop();
    }

    // 监控关键事件
    eventBus.subscribe("reasoning.request", (event: RuntimeEvent) => {
      worldState.set("cognitive.lastRequest", {
        type: event.type,
        timestamp: Date.now(),
      });
    });

    eventBus.subscribe("task.failed", (event: RuntimeEvent) => {
      logger.warn("[Kernel] Task failed", event.data as Record<string, unknown>);
    });

    logger.info("[Kernel] Ready", { state: this._state });
  }

  /**
   * 驱动循环 — 所有子系统的驱动点
   */
  async tick(source: string = "manual"): Promise<void> {
    this._tickCount++;
    this._lastTickTime = Date.now();
    const prevState = this._state;
    this._state = "running";

    try {
      worldState.set("system.heartbeat", {
        tick: this._tickCount,
        source,
        timestamp: this._lastTickTime,
      });

      // 驱动调度器: 尝试执行下一个待办任务
      const nextTask = scheduler.getNext();
      if (nextTask) {
        try {
          // H1 编排闭环修复：request/response 式派发 —— 依据 Actor 的真实响应
          // （response / 结构化 NACK / 超时）判定任务成败，失败进入 scheduler.fail()
          // 的指数退避重试，不再无条件标记成功。
          const reply = await this.engine.actors.ask(
            "kernel",
            nextTask.assignedTo || "knowledge",
            "request",
            "execute",
            nextTask,
            this.config.actorAskTimeoutMs ?? 5000,
          );
          if (reply.type === "error") {
            const errMsg =
              (reply.payload as { error?: string } | null)?.error ?? `actor ${reply.from} returned error`;
            logger.warn("[Kernel] Task rejected by actor", { taskId: nextTask.id, error: errMsg });
            scheduler.fail(nextTask.id, errMsg);
          } else {
            scheduler.complete(nextTask.id, reply.payload);
          }
        } catch (err) {
          scheduler.fail(nextTask.id, (err as Error).message);
        }
      }

      eventBus.publish({
        type: "kernel.tick",
        source: "kernel",
        data: { tick: this._tickCount, source },
        priority: "low",
      });

    } catch (err) {
      logger.error(`[Kernel] Tick #${this._tickCount} error: ${(err as Error).message}`);
    } finally {
      this._state = prevState === "running" ? "running" : "idle";
    }
  }

  startTickLoop(): void {
    if (this._running) return;
    this._running = true;
    const interval = this.config.tickInterval ?? 5000;
    // 占位 timer，保持 _tickTimer 非空以兼容旧的 stop 逻辑；真实驱动为 while 循环
    this._tickTimer = setInterval(() => {}, 1 << 30) as unknown as ReturnType<typeof setInterval>;
    const loop = async () => {
      while (this._running) {
        await this.tick("auto");
        if (!this._running) break;
        await new Promise<void>((resolve) => setTimeout(resolve, interval));
      }
    };
    loop().catch((err) => logger.error("[Kernel] Tick loop error", err as Error));
    logger.info("[Kernel] Tick loop started", { interval });
  }

  stopTickLoop(): void {
    this._running = false;
    if (this._tickTimer) {
      clearInterval(this._tickTimer as unknown as NodeJS.Timeout);
      clearTimeout(this._tickTimer as unknown as NodeJS.Timeout);
      this._tickTimer = null;
    }
  }

  getStatus(): KernelStatus {
    return {
      state: this._state,
      uptime: Date.now() - this._startTime,
      tickCount: this._tickCount,
      lastTickTime: this._lastTickTime,
      engineStatus: this.engine.getStatus(),
      schedulerStatus: scheduler.getStatus(),
    };
  }

  getEngine(): DREngine { return this.engine; }

  async shutdown(): Promise<void> {
    this._state = "stopped";
    this.stopTickLoop();
    await this.engine.close();
    logger.info("[Kernel] Shut down", {
      ticks: this._tickCount,
      uptime: Date.now() - this._startTime,
    });
  }
}
