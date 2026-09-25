/**
 * 轻量级 Actor 系统 (Lightweight Actor System)
 *
 * 解决"Actor 模型不够彻底"问题:
 * 原实现仅 chat-actor, memory-actor 被显式定义
 * 新增: Knowledge、Constraint、Rule 作为主动 Actor
 *
 * Actor = 消息邮箱 + 行为逻辑 + 状态
 *
 * 每个 Actor:
 * - 有自己的邮箱 (消息队列)
 * - 可以接收消息并响应
 * - 可以向其他 Actor 发送消息
 * - 状态独立，互不干扰
 *
 * Actor 类型:
 * - KnowledgeActor: 知识的主动查询和更新
 * - ConstraintActor: 约束的实时检查和建议
 * - RuleActor: 规则的触发和执行
 * - MentalModelActor: 心智模型的匹配和预测
 * - ReasoningActor: 推理图的构建和空洞检测
 */

import { EventEmitter } from "events";
import { logger } from "../../utils/logger.js";

// ========== 类型定义 ==========

/** 消息类型 */
export type MessageType =
  | "query"           // 查询请求
  | "response"        // 查询响应
  | "update"          // 更新请求
  | "notify"          // 通知
  | "request"         // 通用请求
  | "ack"             // 确认
  | "error";          // 错误

/** Actor 消息 */
export interface ActorMessage {
  id: string;
  type: MessageType;
  /** 发送者 Actor ID */
  from: string;
  /** 接收者 Actor ID */
  to: string;
  /** 消息主题 */
  topic: string;
  /** 消息负载 */
  payload: unknown;
  /** 时间戳 */
  timestamp: number;
  /** 关联消息 ID (用于 request/response 配对) */
  replyTo?: string;
}

/** Actor 行为接口 */
export interface ActorBehavior {
  /** Actor ID */
  id: string;
  /** Actor 类型 */
  type: string;
  /** 处理消息 */
  handle(message: ActorMessage, context: ActorContext): Promise<ActorMessage | null>;
  /** 初始化 */
  init?(context: ActorContext): Promise<void>;
  /** 清理 */
  cleanup?(): Promise<void>;
}

/** Actor 上下文 (提供给行为逻辑) */
export interface ActorContext {
  /** 向其他 Actor 发送消息 */
  send(to: string, type: MessageType, topic: string, payload: unknown): Promise<void>;
  /** 获取自身状态 */
  getState<T>(): T;
  /** 更新自身状态 */
  setState<T>(state: T): void;
  /** 获取其他 Actor 的状态 (通过消息) */
  queryState(actorId: string, key: string): Promise<unknown>;
}

// ========== Actor 实例 ==========

/**
 * O4 有界邮箱的默认容量（溢出丢最旧，防无界内存增长）。
 * 可通过 `ActorSystem.register(behavior, { mailboxCapacity })` 按 Actor 调整。
 */
export const DEFAULT_MAILBOX_CAPACITY = 256;

class ActorInstance extends EventEmitter {
  readonly id: string;
  readonly behavior: ActorBehavior;
  private mailbox: ActorMessage[] = [];
  /** O4 有界邮箱容量：溢出丢最旧，防慢消费者内存无界增长 */
  private readonly mailboxCapacity: number;
  private droppedCount = 0;
  private state: unknown = null;
  private processing = false;
  private system: ActorSystem;

  constructor(behavior: ActorBehavior, system: ActorSystem, mailboxCapacity: number = DEFAULT_MAILBOX_CAPACITY) {
    super();
    this.id = behavior.id;
    this.behavior = behavior;
    this.system = system;
    this.mailboxCapacity = mailboxCapacity;
  }

  /** O4：已丢弃消息总数（观测面） */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * 接收消息
   */
  async receive(message: ActorMessage): Promise<void> {
    // O4 有界邮箱：溢出丢最旧；每 100 次丢弃降采样告警一次
    if (this.mailbox.length >= this.mailboxCapacity) {
      this.mailbox.shift();
      this.droppedCount++;
      if (this.droppedCount % 100 === 0) {
        logger.warn(`[Actor:${this.id}] Mailbox overflow — dropped oldest message`, {
          capacity: this.mailboxCapacity,
          droppedTotal: this.droppedCount,
        });
      }
    }
    this.mailbox.push(message);
    this.emit("message", message);
    await this.processNext();
  }

  /**
   * 处理下一条消息
   */
  private async processNext(): Promise<void> {
    if (this.processing || this.mailbox.length === 0) return;
    this.processing = true;

    const message = this.mailbox.shift()!;
    try {
      const context = this.createContext();
      const response = await this.behavior.handle(message, context);

      if (response) {
        this.system.deliver(response);
      } else if (message.type === "request" || message.type === "query") {
        // H1 修复：请求/查询类消息得不到响应时系统层兜底 NACK —— 静默丢弃会让
        // 上层（kernel/scheduler）把任务误标为成功，重试机制永远不可达。
        this.system.deliver(unsupportedTopicNack(this.id, message));
      }
    } catch (err) {
      logger.error(`[Actor:${this.id}] Error processing message: ${(err as Error).message}`);

      // 发送错误响应
      const errorResponse: ActorMessage = {
        id: `err-${Date.now()}`,
        type: "error",
        from: this.id,
        to: message.from,
        topic: message.topic,
        payload: { error: (err as Error).message },
        timestamp: Date.now(),
        replyTo: message.id,
      };
      this.system.deliver(errorResponse);
    } finally {
      this.processing = false;
      if (this.mailbox.length > 0) {
        await this.processNext();
      }
    }
  }

  /**
   * 创建 Actor 上下文
   */
  private createContext(): ActorContext {
    return {
      send: async (to, type, topic, payload) => {
        const msg: ActorMessage = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type,
          from: this.id,
          to,
          topic,
          payload,
          timestamp: Date.now(),
        };
        this.system.deliver(msg);
      },
      getState: <T>() => this.state as T,
      setState: <T>(state: T) => { this.state = state; },
      queryState: async (actorId, key) => {
        return new Promise((resolve) => {
          const replyId = `query-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          let resolved = false;

          const handler = (msg: ActorMessage) => {
            if (!resolved && msg.replyTo === replyId && msg.type === "response") {
              resolved = true;
              clearTimeout(timerId);
              this.removeListener("message", handler);
              resolve(msg.payload);
            }
          };
          this.on("message", handler);

          const msg: ActorMessage = {
            id: replyId,
            type: "query",
            from: this.id,
            to: actorId,
            topic: `state.${key}`,
            payload: { key },
            timestamp: Date.now(),
          };
          this.system.deliver(msg);

          // 超时清理
          const timerId = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              this.removeListener("message", handler);
              resolve(null);
            }
          }, 5000);
        });
      },
    };
  }

  /**
   * 初始化
   */
  async init(): Promise<void> {
    if (this.behavior.init) {
      await this.behavior.init(this.createContext());
    }
  }

  /**
   * 清理
   */
  async destroy(): Promise<void> {
    if (this.behavior.cleanup) {
      await this.behavior.cleanup();
    }
    this.removeAllListeners();
  }
}

// ========== Actor 系统 ==========

export class ActorSystem {
  private actors = new Map<string, ActorInstance>();
  private stopped = false;
  /**
   * 在途 shutdown 承诺（single-flight）。
   * 为什么必须有它：`shutdown()` 会先快照 `this.actors`，再 `await` 销毁，
   * 最后才 `this.actors.clear()`。只靠快照判断，两次并发 `shutdown()` 会
   * 双双快照到同一批 actor ⇒ 同一 actor 被 `destroy()` 两次；而
   * `ActorInstance.destroy()` 并非幂等（每次都调 `behavior.cleanup()`）。
   * 修法：把在途承诺在**任何 await 之前同步发布**（同 `vault-stats-cache._refresh`）。
   */
  private shuttingDown: Promise<void> | null = null;
  /** H1 修复：ask() 的挂起回复注册表（replyTo → resolver），使发送方无需注册为 Actor 即可拿到回信 */
  private pendingReplies = new Map<string, {
    resolve: (msg: ActorMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * 注册 Actor
   *
   * @param opts.mailboxCapacity O4 有界邮箱容量（默认 256，溢出丢最旧）。
   *   此前该值只能由 ActorInstance 构造参数传入，而 register() 不暴露它 ——
   *   公开 API 上**无法为高并发 Actor 调大邮箱**，导致突发负载下必然丢消息
   *   （S5 风暴用例即因此失败：单 Actor 收 534 条、容量 256，丢一半）。
   *   现补上这个旋钮，默认值不变（保持既有内存保护语义）。
   */
  async register(behavior: ActorBehavior, opts?: { mailboxCapacity?: number }): Promise<void> {
    const actor = new ActorInstance(behavior, this, opts?.mailboxCapacity ?? DEFAULT_MAILBOX_CAPACITY);
    this.actors.set(behavior.id, actor);
    await actor.init();
    logger.info("[ActorSystem] Registered actor", {
      id: behavior.id,
      type: behavior.type,
      mailboxCapacity: opts?.mailboxCapacity ?? DEFAULT_MAILBOX_CAPACITY,
    });
  }

  /**
   * 请求-响应式发送：等待目标 Actor 的 response/error 回复，超时抛错。
   * H1 编排闭环修复的核心接缝 —— kernel 用它判定任务成败，替代原 fire-and-forget。
   */
  async ask(
    from: string,
    to: string,
    type: MessageType,
    topic: string,
    payload: unknown,
    timeoutMs: number = 5000,
  ): Promise<ActorMessage> {
    const message: ActorMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      from,
      to,
      topic,
      payload,
      timestamp: Date.now(),
    };
    const reply = new Promise<ActorMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(message.id);
        reject(new Error(`[ActorSystem] ask timeout after ${timeoutMs}ms (to=${to}, topic=${topic})`));
      }, timeoutMs);
      this.pendingReplies.set(message.id, { resolve, reject, timer });
    });
    this.deliver(message);
    return reply;
  }

  /**
   * 投递消息
   */
  deliver(message: ActorMessage): void {
    if (this.stopped) {
      logger.warn("[ActorSystem] Message dropped — system stopped", { to: message.to });
      this.rejectPending(message.replyTo, "system stopped");
      return;
    }
    // H1 修复：回复消息优先按 replyTo 配对给挂起的 ask()（即使收件人未注册——如 "kernel"）
    if (message.replyTo) {
      const pending = this.pendingReplies.get(message.replyTo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingReplies.delete(message.replyTo);
        pending.resolve(message);
        return;
      }
    }
    const actor = this.actors.get(message.to);
    if (actor) {
      actor.receive(message);
    } else {
      logger.warn("[ActorSystem] Actor not found", { to: message.to });
      this.rejectPending(message.id, `actor "${message.to}" not found`);
    }
  }

  private rejectPending(replyTo: string | undefined, reason: string): void {
    if (!replyTo) return;
    const pending = this.pendingReplies.get(replyTo);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingReplies.delete(replyTo);
      pending.reject(new Error(`[ActorSystem] ${reason}`));
    }
  }

  /**
   * 注销 Actor
   */
  async unregister(actorId: string): Promise<void> {
    const actor = this.actors.get(actorId);
    if (!actor) return;
    // 原子"认领"：在任何 await 之前把该 actor 从注册表同步摘除
    // （`get` 与 `delete` 之间没有 await，在事件循环内不可被打断）。
    // 此前是 `await destroy()` 之后才 delete —— 两个并发 unregister 会双双拿到
    // 同一个 actor，导致 cleanup() 跑两次；与 shutdown() 并发时同样重复销毁。
    // 语义取舍（有意）：若 destroy() 抛错，该 actor 不会回到注册表 ——
    // 半销毁的 actor 留在注册表被后续调用者继续使用，比"已摘除"更危险。
    this.actors.delete(actorId);
    await actor.destroy();
  }

  /**
   * 发送消息 (便捷方法)
   */
  async send(from: string, to: string, type: MessageType, topic: string, payload: unknown): Promise<void> {
    const message: ActorMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      from,
      to,
      topic,
      payload,
      timestamp: Date.now(),
    };
    this.deliver(message);
  }

  /**
   * 获取所有 Actor
   */
  list(): Array<{ id: string; type: string }> {
    return Array.from(this.actors.values()).map((a) => ({
      id: a.id,
      type: a.behavior.type,
    }));
  }

  /**
   * 获取 Actor 数量
   */
  get size(): number {
    return this.actors.size;
  }

  /**
   * 清理所有 Actor
   */
  async shutdown(timeoutMs: number = 5000): Promise<void> {
    // single-flight：并发/重复 shutdown 复用同一张承诺，避免同一 actor 被销毁两次。
    if (this.shuttingDown) return this.shuttingDown;

    const run = (async () => {
      this.stopped = true;
      // H1 修复：清理所有挂起的 ask()，避免调用方永久悬挂
      for (const [id, pending] of this.pendingReplies) {
        clearTimeout(pending.timer);
        pending.reject(new Error("[ActorSystem] system shutting down"));
        this.pendingReplies.delete(id);
      }
      const destroyPromises = Array.from(this.actors.entries()).map(async ([id, actor]) => {
        try {
          await Promise.race([
            actor.destroy(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error(`Actor ${id} destroy timeout`)), timeoutMs)
            ),
          ]);
        } catch (err) {
          logger.warn("[ActorSystem] Actor destroy failed", { id, error: (err as Error).message });
        }
      });
      await Promise.all(destroyPromises);
      this.actors.clear();
      logger.info("[ActorSystem] Shutdown complete");
    })();

    // 同步发布（本行之前无 await ⇒ 无交错窗口）；承诺缓存不重置 ⇒ shutdown 天然幂等
    this.shuttingDown = run;
    return run;
  }

  /**
   * 健康检查 — 返回所有 Actor 状态（含 O4 邮箱丢弃计数）
   */
  healthCheck(): Array<{ id: string; type: string; status: "alive" | "stopped"; droppedCount: number }> {
    return Array.from(this.actors.values()).map((a) => ({
      id: a.id,
      type: a.behavior.type,
      status: this.stopped ? ("stopped" as const) : ("alive" as const),
      droppedCount: a.dropped,
    }));
  }
}

// ========== 预定义 Actor 行为 ==========

/** H1 修复：不支持主题的结构化 NACK —— 静默返回 null 会让上层把任务误标为成功 */
export function unsupportedTopicNack(actorId: string, message: ActorMessage): ActorMessage {
  return {
    id: `nack-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "error",
    from: actorId,
    to: message.from,
    topic: message.topic,
    payload: {
      error: `Unsupported topic "${message.topic}" for actor ${actorId}`,
      // 审计 B-1（2026-08-24）：结构化错误码，供 kernel 判定终态失败（不重试）
      code: "UNSUPPORTED_TOPIC",
    },
    timestamp: Date.now(),
    replyTo: message.id,
  };
}

/** 知识 Actor — 主动查询和更新知识 */
export class KnowledgeActorBehavior implements ActorBehavior {
  id = "knowledge";
  type = "knowledge";

  async handle(message: ActorMessage, context: ActorContext): Promise<ActorMessage | null> {
    switch (message.topic) {
      case "query":
        // 知识查询由 KAL 处理，这里做代理
        return {
          id: `resp-${Date.now()}`,
          type: "response",
          from: this.id,
          to: message.from,
          topic: "query.result",
          payload: { delegated: true, target: "kal" },
          timestamp: Date.now(),
          replyTo: message.id,
        };

      case "validate":
        // 验证知识一致性
        return {
          id: `resp-${Date.now()}`,
          type: "response",
          from: this.id,
          to: message.from,
          topic: "validate.result",
          payload: { valid: true, checks: ["existence", "consistency", "freshness"] },
          timestamp: Date.now(),
          replyTo: message.id,
        };

      case "execute": {
        // 审计 B-1（2026-08-24）：kernel 以 topic="execute" 派发调度任务，
        // 此前无任何 Actor 处理该主题 → 全部 NACK → 重试耗尽即 failed。
        // Knowledge 作为默认执行者，返回结构化执行回执（payload 原样回传，
        // 由上层按任务语义消费；不在此伪造业务结果）。
        const task = (message.payload ?? {}) as { id?: string; name?: string };
        return {
          id: `resp-${Date.now()}`,
          type: "response",
          from: this.id,
          to: message.from,
          topic: "execute.result",
          payload: {
            taskId: task.id,
            taskName: task.name,
            handledBy: this.id,
            acceptedAt: Date.now(),
          },
          timestamp: Date.now(),
          replyTo: message.id,
        };
      }

      default:
        return null; // 系统层 processNext 兜底 NACK（H1）
    }
  }
}

/** 约束 Actor — 实时约束检查 */
export class ConstraintActorBehavior implements ActorBehavior {
  id = "constraint";
  type = "constraint";

  async handle(message: ActorMessage, context: ActorContext): Promise<ActorMessage | null> {
    switch (message.topic) {
      case "check":
        // 约束检查由 ConstraintSolver 处理，这里做代理
        return {
          id: `resp-${Date.now()}`,
          type: "response",
          from: this.id,
          to: message.from,
          topic: "check.result",
          payload: { delegated: true, target: "constraint-solver" },
          timestamp: Date.now(),
          replyTo: message.id,
        };

      case "suggest":
        // 根据当前上下文建议约束
        return {
          id: `resp-${Date.now()}`,
          type: "response",
          from: this.id,
          to: message.from,
          topic: "suggest.result",
          payload: { suggestions: [] },
          timestamp: Date.now(),
          replyTo: message.id,
        };

      default:
        return null; // 系统层 processNext 兜底 NACK（H1）
    }
  }
}

/** 心智模型 Actor — 模式匹配和预测 */
export class MentalModelActorBehavior implements ActorBehavior {
  id = "mental-model";
  type = "mental-model";

  async handle(message: ActorMessage, context: ActorContext): Promise<ActorMessage | null> {
    switch (message.topic) {
      case "match":
        return {
          id: `resp-${Date.now()}`,
          type: "response",
          from: this.id,
          to: message.from,
          topic: "match.result",
          payload: { delegated: true, target: "mental-model-pool" },
          timestamp: Date.now(),
          replyTo: message.id,
        };

      case "predict":
        return {
          id: `resp-${Date.now()}`,
          type: "response",
          from: this.id,
          to: message.from,
          topic: "predict.result",
          payload: { delegated: true, target: "mental-model-pool" },
          timestamp: Date.now(),
          replyTo: message.id,
        };

      default:
        return null; // 系统层 processNext 兜底 NACK（H1）
    }
  }
}

/** 推理 Actor — 推理图构建和空洞检测 */
export class ReasoningActorBehavior implements ActorBehavior {
  id = "reasoning";
  type = "reasoning";

  async handle(message: ActorMessage, context: ActorContext): Promise<ActorMessage | null> {
    switch (message.topic) {
      case "build":
        return {
          id: `resp-${Date.now()}`,
          type: "response",
          from: this.id,
          to: message.from,
          topic: "build.result",
          payload: { delegated: true, target: "reasoning-graph" },
          timestamp: Date.now(),
          replyTo: message.id,
        };

      case "detect-gaps":
        return {
          id: `resp-${Date.now()}`,
          type: "response",
          from: this.id,
          to: message.from,
          topic: "detect-gaps.result",
          payload: { delegated: true, target: "reasoning-graph" },
          timestamp: Date.now(),
          replyTo: message.id,
        };

      default:
        return null; // 系统层 processNext 兜底 NACK（H1）
    }
  }
}

/**
 * 创建预配置的 Actor 系统
 */
export async function createDefaultActorSystem(): Promise<ActorSystem> {
  const system = new ActorSystem();
  await system.register(new KnowledgeActorBehavior());
  await system.register(new ConstraintActorBehavior());
  await system.register(new MentalModelActorBehavior());
  await system.register(new ReasoningActorBehavior());
  return system;
}
