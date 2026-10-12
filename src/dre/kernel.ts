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
import { logger } from "../utils/logger.js";
import { APP_VERSION } from "../version.js";

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
  /** 自动 tick 循环体 promise；stopTickLoop 等待它真正退出（含在途 tick） */
  private _loopPromise: Promise<void> | null = null;
  /** tick 间隔缺省值（轮 7 审计：worldState 与 startTickLoop 两处复制硬编码 5000 → 单一来源） */
  private static readonly DEFAULT_TICK_INTERVAL_MS = 5000;
  /** 当前睡眠的定时器与唤醒句柄；stopTickLoop 用它即时取消睡眠，不必等满 interval */
  private _sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private _sleepResolve: (() => void) | null = null;
  /** 在途 tick（含手动 tick）；shutdown 在关引擎前等待它们全部结束 */
  private _inFlightTicks = new Set<Promise<void>>();
  private _running = false;
  /** shutdown 已启动：此后 tick() 快速拒绝（防快照后到达的手动 tick 与 engine.close 并发） */
  private _shutdownStarted = false;

  constructor(config: KernelConfig) {
    this.config = config;
    this.engine = new DREngine(config);
    this._startTime = Date.now();
  }

  async init(): Promise<void> {
    logger.info("[Kernel] Initializing...");

    await this.engine.waitForReady();

    worldState.set("system.kernel", {
      version: APP_VERSION,
      startedAt: this._startTime,
      tickInterval: this.config.tickInterval ?? Kernel.DEFAULT_TICK_INTERVAL_MS,
    });

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
    // 轮 7 审计：shutdown 快照 _inFlightTicks 之后到达的手动 tick（如停机瞬间的
    // HTTP /dre/tick）此前会与 engine.close() 并发访问 actor/db——实测时间窗重叠。
    // 停止闸：shutdown 一旦启动，新 tick 一律快速拒绝（fail-loud 而非静默并发）。
    if (this._shutdownStarted) {
      throw new Error(`Kernel is shutting down; tick(${source}) rejected`);
    }
    const run = this.runTick(source);
    this._inFlightTicks.add(run);
    try {
      await run;
    } finally {
      this._inFlightTicks.delete(run);
    }
  }

  /** tick 实体；拆出以便 tick() 统一登记/注销在途 promise（供 shutdown 等待） */
  private async runTick(source: string): Promise<void> {
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
        // O4 代数守卫：dispatch 时快照代数，complete 回传以检测抢占后的陈旧完成
        const dispatchGen = nextTask.gen ?? 0;
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
            const payload = (reply.payload as { error?: string; code?: string } | null) ?? {};
            const errMsg = payload.error ?? `actor ${reply.from} returned error`;
            // 审计 B-1（2026-08-24）：不支持的主题属于确定性拒绝，重试必然
            // 再次 NACK——终态失败，不进入指数退避重试。
            const terminal = payload.code === "UNSUPPORTED_TOPIC";
            logger.warn("[Kernel] Task rejected by actor", {
              taskId: nextTask.id,
              error: errMsg,
              terminal,
            });
            scheduler.fail(nextTask.id, errMsg, { terminal });
          } else {
            scheduler.complete(nextTask.id, reply.payload, dispatchGen);
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
      // shutdown 已把状态置为 stopped 时，在途 tick 的 finally 不得将其复活为 idle
      if (!this.isStopped()) {
        this._state = prevState === "running" ? "running" : "idle";
      }
    }
  }

  startTickLoop(): void {
    if (this._running) return;
    this._running = true;
    const interval = this.config.tickInterval ?? Kernel.DEFAULT_TICK_INTERVAL_MS;
    // 单一驱动：while 循环串行 tick；睡眠用可取消的 sleep（stopTickLoop 即时唤醒）。
    this._loopPromise = (async () => {
      while (this._running) {
        await this.tick("auto");
        if (!this._running) break;
        await this.sleep(interval);
      }
    })()
      .catch((err) => logger.error("[Kernel] Tick loop error", err as Error))
      .finally(() => {
        this._loopPromise = null;
      });
    logger.info("[Kernel] Tick loop started", { interval });
  }

  /** 可取消睡眠：stopTickLoop 通过 _sleepResolve 立即唤醒，不必等满 interval */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        if (this._sleepTimer) {
          clearTimeout(this._sleepTimer);
          this._sleepTimer = null;
        }
        this._sleepResolve = null;
        resolve();
      };
      this._sleepResolve = wake;
      this._sleepTimer = setTimeout(wake, ms);
    });
  }

  /**
   * 停止 tick 循环并等待其真正退出（含在途 auto tick）。
   * 幂等；未启动时立即返回。
   */
  async stopTickLoop(): Promise<void> {
    this._running = false;
    // 取消当前睡眠：否则循环要等到 interval 走完才检查 _running
    if (this._sleepResolve) this._sleepResolve();
    if (this._loopPromise) {
      try {
        await this._loopPromise;
      } catch {
        // 循环体错误已在 startTickLoop 的 catch 记录，这里不再抛出
      }
    }
  }

  /** 独立读取状态，避免 runTick 内赋值后的控制流收窄把类型钉成 "running" */
  private isStopped(): boolean {
    return this._state === "stopped";
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
    // 停止闸先行：快照与 close 之间到达的手动 tick 会被 tick() 入口拒绝，
    // 而非与 engine.close() 并发（轮 7 审计：实测并发窗口真实存在）。
    this._shutdownStarted = true;
    this._state = "stopped";
    // 先停循环，再等在途 tick（含手动 tick）全部结束，最后才关引擎——
    // 避免 engine.close() 与在途 tick 并发关闭 actor/db。
    await this.stopTickLoop();
    if (this._inFlightTicks.size > 0) {
      await Promise.allSettled([...this._inFlightTicks]);
    }
    await this.engine.close();
    logger.info("[Kernel] Shut down", {
      ticks: this._tickCount,
      uptime: Date.now() - this._startTime,
    });
  }
}
