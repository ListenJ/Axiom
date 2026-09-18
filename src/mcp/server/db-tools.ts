import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { ToolRegistry } from "../tool-registry.js";

export function registerDbTools(registry: ToolRegistry, db: Database): void {
  registry.add({
    name: "db_query",
    description: "执行 SQLite 查询（只读）",
    inputSchema: {
      sql: z.string().describe("SELECT 查询语句"),
      params: z.array(z.any()).optional().default([]),
    },
    handler: async (args) => {
      const normalized = (args.sql as string).trim().toLowerCase();
      if (!normalized.startsWith("select")) {
        return { error: "Only SELECT queries are allowed" };
      }
      try {
        return db.query(args.sql as string).all(...((args.params || []) as (string | number | boolean | null)[]));
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  registry.add({
    name: "list_free_models",
    description: "列出当前可用的免费模型",
    inputSchema: {},
    handler: async () => {
      return db.query("SELECT id, name, provider, context_length FROM free_models WHERE is_available = 1").all();
    },
  });
}
