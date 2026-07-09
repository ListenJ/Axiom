/**
 * WriteTool — 文件/记忆库写入基元
 *
 * 管道: validate → prepare → write → return
 * 写入后自动从 localStore 清除缓存，避免后续读取读到脏数据
 */
import type { Tool, ToolInput, ToolOutput } from "./types.js";
import { createToolOutput } from "./types.js";

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

  validate(input: WriteInput): string | null {
    if (!input.target) return "target is required (file|memory)";
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
        const fs = await import("fs/promises");
        if (append) {
          await fs.appendFile(path, content, "utf-8");
        } else {
          await fs.writeFile(path, content, "utf-8");
        }
        bytesWritten = Buffer.byteLength(content, "utf-8");
        break;
      }

      case "memory": {
        const vault = store.get("vaultManager") as any;
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
