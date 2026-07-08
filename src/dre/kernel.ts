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
  private _tickTimer: ReturnType<typeof setInterval> | null = null;

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
          // 将任务派发给 Actor 系统
          this.engine.actors.send(
            "kernel",
            nextTask.assignedTo || "knowledge",
            "request",
            "execute",
            nextTask
          );
          scheduler.complete(nextTask.id, { dispatched: true });
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
    if (this._tickTimer) return;
    const interval = this.config.tickInterval ?? 5000;
    this._tickTimer = setInterval(() => this.tick("auto"), interval);
    logger.info("[Kernel] Tick loop started", { interval });
  }

  stopTickLoop(): void {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
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
