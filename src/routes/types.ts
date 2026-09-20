/**
 * Route types and shared context for route handlers
 */
import type { Database } from "bun:sqlite";
import type { VaultManager } from "../memory/vault-manager.js";
import type { DataPipeline } from "../crawl/data-pipeline.js";
import type { HealthMonitor } from "../utils/resilience.js";
import type { VaultFileWatcher } from "../memory/file-watcher.js";
import type { MemoryDistiller } from "../memory/distiller.js";

export interface RouteContext {
  url: URL;
  req: Request;
  vault: VaultManager | null;
  db: Database;
  pipeline: DataPipeline;
  healthMonitor: HealthMonitor;
  fileWatcher: VaultFileWatcher | null;
  startupTime: number;
  baseHeaders: Record<string, string>;
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response | null>;

/** Request body for POST /api-keys */
export interface ApiKeyRequestBody {
  /** 自定义 provider 的协议（openai/anthropic/gemini/opencode）；内置 provider 不需要 */
  adapter?: string;
  /** 自定义 provider 的展示名（可选，缺省用 provider 名） */
  displayName?: string;
  provider: string;
  apiKey: string;
  baseURL?: string;
}

/** WebSocket connection data */
export interface WebSocketData {
  clientId: string;
}
