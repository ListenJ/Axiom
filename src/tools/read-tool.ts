/**
 * ReadTool — 文件/网络/记忆库读取基元
 *
 * 管道: validate → read → transform → return
 * 数据隔离: 每次执行独立 ToolContext，不共享可变状态
 */
import type { Tool, ToolInput, ToolOutput } from "./types.js";
import { createToolOutput } from "./types.js";
import { resolve } from "node:path";
import { isPathSafe } from "../utils/path-safety.js";

export interface ReadInput {
  /** 读取源: "file" | "web" | "memory" */
  source: "file" | "web" | "memory";
  /** 路径 / URL / 查询 */
  path: string;
  /** 可选: 读取偏移 */
  offset?: number;
  /** 可选: 最大读取长度 */
  limit?: number;
}

export interface ReadOutput {
  content: string;
  source: string;
  mimeType?: string;
  length: number;
}

export const readTool: Tool<ReadInput, ReadOutput> = {
  name: "read",
  description: "读取文件/网页/记忆库内容",
  consumesModelToken: false,

  validate(input: ReadInput): string | null {
    if (!input.source) return "source is required (file|web|memory)";
    if (!["file", "web", "memory"].includes(input.source)) return `invalid source: ${input.source} (must be file|web|memory)`;
    if (!input.path || input.path.length === 0) return "path is required";
    return null;
  },

  async execute(ctx: ToolInput<ReadInput>): Promise<ToolOutput<ReadOutput>> {
    const start = Date.now();
    const { source, path, offset, limit } = ctx.payload;
    const store = ctx.context.localStore; // 工具专属存储，不跨工具交联

    let content = "";
    let mimeType = "";

    switch (source) {
      case "file": {
        const fs = await import("fs/promises");
        // P0-1 路径围栏（审计 N-H1，2026-08-29）：与 mcp/tools/filesystem.ts 同一守卫，
        // 相对路径按 cwd 解析，仅允许 cwd 内且不落敏感区域（.env/.git 等），防任意读窃密钥。
        const resolved = resolve(process.cwd(), path);
        const safety = isPathSafe(resolved);
        if (!safety.safe) throw new Error(safety.error);
        let buffer: Buffer;
        try {
          buffer = await fs.readFile(resolved);
        } catch {
          const vault = store.get("vaultManager") as import("../memory/vault-manager.js").VaultManager;
          if (vault?.readNote) {
            const note = vault.readNote(path);
            content = note?.content ?? "";
          } else {
            throw new Error(`File not found: ${path}`);
          }
          break;
        }
        content = buffer.toString("utf-8");
        break;
      }

      case "web": {
        const response = await fetch(path, {
          signal: AbortSignal.timeout(ctx.context.maxCpuMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
        content = await response.text();
        mimeType = response.headers.get("content-type") ?? "text/html";
        break;
      }

      case "memory": {
        const vault = store.get("vaultManager") as import("../memory/vault-manager.js").VaultManager;
        if (vault) {
          const results = vault.search(path, { limit: limit ?? 10 });
          content = JSON.stringify(results);
        } else {
          throw new Error("VaultManager not available in context");
        }
        break;
      }
    }

    // 偏移/限制
    const truncated = content.slice(offset ?? 0, limit ? (offset ?? 0) + limit : undefined);

    return createToolOutput(
      { content: truncated, source: path, mimeType, length: truncated.length },
      start,
    );
  },
};
