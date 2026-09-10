/**
 * WriteTool — 文件/记忆库写入基元
 *
 * 管道: validate → prepare → write → return
 * 写入后自动从 localStore 清除缓存，避免后续读取读到脏数据
 */
import type { Tool, ToolInput, ToolOutput } from "./types.js";
import { createToolOutput } from "./types.js";
import { dirname, resolve } from "node:path";
import { isPathSafe } from "../utils/path-safety.js";

export interface WriteInput {
  target: "file" | "memory";
  path: string;
  content: string;
  /** 追加模式（默认覆盖） */
  append?: boolean;
}

export interface WriteOutput {
  path: string;
  bytesWritten: number;
  append: boolean;
}

export const writeTool: Tool<WriteInput, WriteOutput> = {
  name: "write",
  description: "写入文件或记忆库",
  consumesModelToken: false,

  validate(input: WriteInput): string | null {
    if (!input.target) return "target is required (file|memory)";
    if (!["file", "memory"].includes(input.target)) return `invalid target: ${input.target} (must be file|memory)`;
    if (!input.path) return "path is required";
    if (input.content === undefined) return "content is required";
    return null;
  },

  async execute(ctx: ToolInput<WriteInput>): Promise<ToolOutput<WriteOutput>> {
    const start = Date.now();
    const { target, path, content, append } = ctx.payload;
    const store = ctx.context.localStore;

    let bytesWritten = 0;

    switch (target) {
      case "file": {
        // P0-1 路径围栏（审计 N-H1，2026-08-29）：与 mcp/tools/filesystem.ts 同一守卫，
        // 相对路径按 cwd 解析，仅允许 cwd 内且不落敏感区域（.env/.git 等），防任意写。
        const resolved = resolve(process.cwd(), path);
        const safety = isPathSafe(resolved);
        if (!safety.safe) throw new Error(safety.error);
        const fs = await import("fs/promises");
        // 自动创建父目录
        const dir = dirname(resolved);
        if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => {});
        if (append) {
          await fs.appendFile(resolved, content, "utf-8");
        } else {
          await fs.writeFile(resolved, content, "utf-8");
        }
        bytesWritten = Buffer.byteLength(content, "utf-8");
        break;
      }

      case "memory": {
        const vault = store.get("vaultManager") as import("../memory/vault-manager.js").VaultManager;
        if (vault?.writeNote) {
          await vault.writeNote(path, content, { append });
          bytesWritten = Buffer.byteLength(content, "utf-8");
        } else {
          throw new Error("VaultManager not available in context");
        }
        break;
      }
    }

    // 清除本地缓存，防止后续读到脏数据
    store.delete(`cached:${path}`);

    return createToolOutput({ path, bytesWritten, append: !!append }, start);
  },
};
