/**
 * ReadTool — 文件/网络/记忆库读取基元
 *
 * 管道: validate → read → transform → return
 * 数据隔离: 每次执行独立 ToolContext，不共享可变状态
 */
import type { Tool, ToolInput, ToolOutput } from "./types.js";
import { createToolOutput } from "./types.js";
import * as safeFs from "../utils/safe-fs.js";
import { decideCapability } from "../utils/permissions.js";

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
  capability: ["fs.read", "net.outbound"],
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
        let buffer: Buffer;
        try {
          buffer = await safeFs.readFile(path, { principal: `tool:${this.name}` });
        } catch (err) {
          // 越权与"文件不存在"必须分流：把 denied 当成 miss 去回落 Vault，
          // 等于给被拒路径开第二条读取通道。
          if (err instanceof safeFs.CapabilityDeniedError) throw err;
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
        // L3：SSRF。旧实现直接 fetch(path)，可打 127.0.0.1:自家端口 与内网元数据地址。
        const decision = decideCapability({
          capability: "net.outbound",
          target: path,
          principal: `tool:${this.name}`,
        });
        if (!decision.allow) throw new Error(`denied: ${decision.reason}`);
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
