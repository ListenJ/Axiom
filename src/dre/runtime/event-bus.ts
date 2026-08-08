/**
 * EventBus — 统一事件总线 (from cognitive-runtime kernel)
 *
 * 所有模块通信通过事件总线, 不允许直接函数调用。
 *
 * 特性:
 * - 发布/订阅模式, 按优先级排序处理
 * - 事件日志 (最近 1000 条)
 * - 一次性订阅 (subscribeOnce)
 * - 统计追踪
 * - 兼容 Node EventEmitter
 */

import { EventEmitter } from "events";
import { logger } from "../../utils/logger.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type EventPriority = "critical" | "high" | "normal" | "low" | "background";

export interface RuntimeEvent {
  id: string;
  type: string;
  source: string;
  data: unknown;
  priority: EventPriority;
  timestamp: number;
  correlationId?: string;
  replyTo?: string;
}

export interface EventHandler {
  id: string;
  eventType: string;
  handler: (event: RuntimeEvent) => Promise<void> | void;
  priority: number;
  once?: boolean;
}

// ─── EventBus ──────────────────────────────────────────────────────────────

class EventBusImpl extends EventEmitter {
  private handlers = new Map<string, EventHandler[]>();
  private eventLog: RuntimeEvent[] = [];
  private eventLogIndex = 0;
  private maxLogSize = 1000;
  private stats = { published: 0, handled: 0, errors: 0 };
  private eidCounter = 0;

  publish(event: Omit<RuntimeEvent, "id" | "timestamp">): RuntimeEvent {
    const now = Date.now();
    const fullEvent: RuntimeEvent = {
      type: event.type,
      source: event.source,
      data: event.data,
      priority: event.priority,
      correlationId: event.correlationId,
      replyTo: event.replyTo,
      id: `evt_${now}_${this.eidCounter++}`,
      timestamp: now,
    };

    this.stats.published++;
    if (this.eventLog.length < this.maxLogSize) {
      this.eventLog.push(fullEvent);
    } else {
      this.eventLog[this.eventLogIndex] = fullEvent;
    }
    this.eventLogIndex = (this.eventLogIndex + 1) % this.maxLogSize;

    const handlers = this.handlers.get(event.type);
    if (handlers !== undefined && handlers.length > 0) {
      const sorted = [...handlers].sort((a, b) => b.priority - a.priority);
      for (const h of sorted) {
        try {
          const result = h.handler(fullEvent);
          if (result instanceof Promise) {
            result.catch((err) => {
              this.stats.errors++;
              logger.error(`[EventBus] Handler ${h.id} failed for ${event.type}`, err instanceof Error ? err : new Error(String(err)));
            });
          }
          this.stats.handled++;
          if (h.once) this.unsubscribe(h.id);
        } catch (err) {
          this.stats.errors++;
          logger.error(`[EventBus] Handler ${h.id} failed for ${event.type}`, err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
    if (this.listenerCount(event.type) > 0) {
      this.emit(event.type, fullEvent);
    }

    return fullEvent;
  }

  subscribe(eventType: string, handler: (event: RuntimeEvent) => Promise<void> | void, priority = 0): string {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.handlers.has(eventType) || this.handlers.set(eventType, []);
    this.handlers.get(eventType)!.push({ id, eventType, handler, priority });
    return id;
  }

  subscribeOnce(eventType: string, handler: (event: RuntimeEvent) => Promise<void> | void, priority = 0): string {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.handlers.has(eventType) || this.handlers.set(eventType, []);
    this.handlers.get(eventType)!.push({ id, eventType, handler, priority, once: true });
    return id;
  }

  unsubscribe(id: string): void {
    for (const [type, handlers] of this.handlers) {
      const idx = handlers.findIndex((h) => h.id === id);
      if (idx !== -1) {
        handlers.splice(idx, 1);
        if (handlers.length === 0) this.handlers.delete(type);
        return;
      }
    }
  }

  getRecentEvents(count = 20): RuntimeEvent[] {
    const len = this.eventLog.length;
    if (len === 0) return [];
    if (len < this.maxLogSize) {
      return this.eventLog.slice(-count);
    }
    const take = Math.min(count, len);
    const start = (this.eventLogIndex - take + this.maxLogSize) % this.maxLogSize;
    // Rotate the array so the oldest event comes first: [start..end, 0..start)
    return start === 0
      ? this.eventLog.slice(0, take)
      : this.eventLog.slice(start, len).concat(this.eventLog.slice(0, start));
  }

  getStats(): { published: number; handled: number; errors: number; subscriberCount: number } {
    let subscriberCount = 0;
    for (const handlers of this.handlers.values()) subscriberCount += handlers.length;
    return { ...this.stats, subscriberCount };
  }

  /** 指定事件类型的当前 handler 数（供诊断与测试隔离）。 */
  getHandlerCount(eventType: string): number {
    return this.handlers.get(eventType)?.length ?? 0;
  }
}

export const eventBus = new EventBusImpl();
