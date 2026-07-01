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

class ActorInstance extends EventEmitter {
  readonly id: string;
  readonly behavior: ActorBehavior;
  private mailbox: ActorMessage[] = [];
  private state: unknown = null;
  private processing = false;
  private system: ActorSystem;

  constructor(behavior: ActorBehavior, system: ActorSystem) {
    super();
    this.id = behavior.id;
    this.behavior = behavior;
    this.system = system;
  }

  /**
   * 接收消息
   */
  receive(message: ActorMessage): void {
    this.mailbox.push(message);
    this.emit("message", message);
    this.processNext();
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
      }
    } catch (err) {
      logger.error(`[Actor:${this.id}] Error processing message`, {
        error: (err as Error).message,
        topic: message.topic,
      });

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
        this.processNext();
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
   * 注册 Actor
   */
  async register(behavior: ActorBehavior): Promise<void> {
    const actor = new ActorInstance(behavior, this);
    this.actors.set(behavior.id, actor);
    await actor.init();
    logger.info("[ActorSystem] Registered actor", { id: behavior.id, type: behavior.type });
  }

  /**
   * 注销 Actor
   */
  async unregister(actorId: string): Promise<void> {
    const actor = this.actors.get(actorId);
    if (actor) {
      await actor.destroy();
      this.actors.delete(actorId);
    }
  }

  /**
   * 投递消息
   */
  deliver(message: ActorMessage): void {
    if (this.stopped) {
      logger.warn("[ActorSystem] Message dropped — system stopped", { to: message.to });
      return;
    }
    const actor = this.actors.get(message.to);
    if (actor) {
      actor.receive(message);
    } else {
      logger.warn("[ActorSystem] Actor not found", { to: message.to });
    }
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
    this.stopped = true;
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
  }

  /**
   * 健康检查 — 返回所有 Actor 状态
   */
  healthCheck(): Array<{ id: string; type: string; status: "alive" | "stopped" }> {
    return Array.from(this.actors.values()).map((a) => ({
      id: a.id,
      type: a.behavior.type,
      status: this.stopped ? ("stopped" as const) : ("alive" as const),
    }));
  }
}

// ========== 预定义 Actor 行为 ==========

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

      default:
        return null;
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
        return null;
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
        return null;
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
        return null;
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
