import { randomUUID } from "node:crypto";
import { estimateTokens } from "../context/token-estimator.js";
import type { ToolDef } from "../mcp/tool-registry.js";

export interface RecoverableOutputMeta {
  tool: string;
  bytes: number;
  tokens: number;
  createdAt: number;
}

interface StoredEntry {
  text: string;
  meta: RecoverableOutputMeta;
}

export interface RecoverableOutputStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export class RecoverableOutputStore {
  private entries = new Map<string, StoredEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: RecoverableOutputStoreOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 1000);
    this.ttlMs = Math.max(1000, options.ttlMs ?? 60 * 60 * 1000);
  }

  store(text: string, tool: string): string {
    this.prune();
    const id = randomUUID();
    this.entries.set(id, {
      text,
      meta: {
        tool,
        bytes: Buffer.byteLength(text, "utf8"),
        tokens: estimateTokens(text),
        createdAt: Date.now(),
      },
    });
    this.evict();
    return id;
  }

  read(id: string): { text: string; meta: RecoverableOutputMeta } | undefined {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry;
  }

  stats(): {
    entries: number;
    totalBytes: number;
    totalTokens: number;
    maxEntries: number;
    ttlMs: number;
  } {
    this.prune();
    let totalBytes = 0;
    let totalTokens = 0;
    for (const entry of this.entries.values()) {
      totalBytes += entry.meta.bytes;
      totalTokens += entry.meta.tokens;
    }
    return {
      entries: this.entries.size,
      totalBytes,
      totalTokens,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
    };
  }

  dispose(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.meta.createdAt > this.ttlMs) {
        this.entries.delete(id);
      }
    }
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

export interface RecoverableOutputPlaceholder {
  recoverable: true;
  toolId: string;
  tool: string;
  bytes: number;
  tokens: number;
  message: string;
}

export function wrapWithRecoverableOutput(
  tool: ToolDef,
  store: RecoverableOutputStore,
  thresholdBytes: number,
): ToolDef {
  if (tool.name === "read_tool_result" || tool.name === "recoverable_output_stats") {
    return tool;
  }
  return {
    ...tool,
    handler: async (args) => {
      const result = await tool.handler(args);
      const text =
        tool.format === "text"
          ? String(result)
          : result === undefined
            ? "undefined"
            : JSON.stringify(result);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes <= thresholdBytes) return result;
      const toolId = store.store(text, tool.name);
      return {
        recoverable: true,
        toolId,
        tool: tool.name,
        bytes,
        tokens: estimateTokens(text),
        message: `Output ${bytes} bytes exceeded ${thresholdBytes} byte threshold; use read_tool_result with toolId ${toolId}`,
      };
    },
  };
}