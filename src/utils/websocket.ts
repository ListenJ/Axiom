/**
 * WebSocket 实时推送层
 * 用于 Dashboard 实时更新、系统事件广播
 */
import type { ServerWebSocket } from "bun";

export type WsEventType =
  | "system.status"
  | "search.completed"
  | "crawl.completed"
  | "vault_change"
  | "model.usage"
  | "health.check"
  | "heartbeat"
  | "agent.intent";

export interface WsMessage {
  type: WsEventType;
  payload: Record<string, unknown>;
  timestamp: string;
}

interface WsClient {
  ws: ServerWebSocket<unknown>;
  subscriptions: Set<WsEventType>;
  connectedAt: number;
}

export class WebSocketManager {
  private clients = new Map<string, WsClient>();
  private messageHistory: WsMessage[] = [];
  private maxHistory = 100;

  /** 客户端连接 */
  onOpen(ws: ServerWebSocket<{ clientId: string }>): void {
    const clientId = ws.data.clientId;
    this.clients.set(clientId, {
      ws,
      subscriptions: new Set(),
      connectedAt: Date.now(),
    });

    // 发送历史消息
    for (const msg of this.messageHistory.slice(-20)) {
      ws.send(JSON.stringify(msg));
    }

    this.broadcast({
      type: "system.status",
      payload: { event: "client_connected", clientCount: this.clients.size },
      timestamp: new Date().toISOString(),
    }, clientId); // 不广播给自己
  }

  /** 客户端消息 */
  onMessage(ws: ServerWebSocket<{ clientId: string }>, message: string): void {
    try {
      const data = JSON.parse(message);
      const client = this.clients.get(ws.data.clientId);
      if (!client) return;

      if (data.action === "subscribe" && data.types) {
        for (const t of data.types) client.subscriptions.add(t);
        ws.send(JSON.stringify({ type: "system.status", payload: { subscribed: Array.from(client.subscriptions) }, timestamp: new Date().toISOString() }));
      }
      if (data.action === "unsubscribe" && data.types) {
        for (const t of data.types) client.subscriptions.delete(t);
      }
      if (data.action === "ping") {
        ws.send(JSON.stringify({ type: "system.status", payload: { pong: true }, timestamp: new Date().toISOString() }));
      }
    } catch {
      // 忽略无效消息
    }
  }

  /** 客户端断开 */
  onClose(ws: ServerWebSocket<{ clientId: string }>): void {
    this.clients.delete(ws.data.clientId);
    this.broadcast({
      type: "system.status",
      payload: { event: "client_disconnected", clientCount: this.clients.size },
      timestamp: new Date().toISOString(),
    });
  }

  /** 广播消息给所有订阅了该类型的客户端 */
  broadcast(msg: WsMessage, excludeClientId?: string): void {
    const json = JSON.stringify(msg);
    for (const [id, client] of this.clients) {
      if (id === excludeClientId) continue;
      if (client.subscriptions.size > 0 && !client.subscriptions.has(msg.type)) continue;
      try { client.ws.send(json); } catch { /* ignore closed */ }
    }

    // 保存到历史
    this.messageHistory.push(msg);
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory.shift();
    }
  }

  /** 获取连接统计 */
  getStats(): { connectedClients: number; subscriptions: Record<string, number> } {
    const subs: Record<string, number> = {};
    for (const client of this.clients.values()) {
      for (const t of client.subscriptions) {
        subs[t] = (subs[t] || 0) + 1;
      }
    }
    return { connectedClients: this.clients.size, subscriptions: subs };
  }
}

export const wsManager = new WebSocketManager();
