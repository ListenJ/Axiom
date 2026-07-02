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
  private maxLogSize = 1000;
  private stats = { published: 0, handled: 0, errors: 0 };

  publish(event: Omit<RuntimeEvent, "id" | "timestamp">): RuntimeEvent {
    const fullEvent: RuntimeEvent = {
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };

    this.stats.published++;
    this.eventLog.push(fullEvent);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog.shift();
    }

    const handlers = this.handlers.get(event.type) ?? [];
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

    this.emit(event.type, fullEvent);
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
    return this.eventLog.slice(-count);
  }

  getStats(): { published: number; handled: number; errors: number; subscriberCount: number } {
    let subscriberCount = 0;
    for (const handlers of this.handlers.values()) subscriberCount += handlers.length;
    return { ...this.stats, subscriberCount };
  }
}

export const eventBus = new EventBusImpl();
