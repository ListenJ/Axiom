/**
 * 知识库 SQLite 路径的**单一解析口径**（2026-09-21）
 *
 * ## 为什么要有这个文件
 * 向量表与知识表**必须同库**（D4）。一旦"索引写入的是 A 库、查询读的是 B 库"，
 * 症状是"索引显示成功、检索恒空且不报错"—— 最难查的一类失效。
 * 故所有涉及知识库 embedding 的入口（索引脚本、CLI 采集收尾、MCP KB 后端）都走本函数。
 *
 * ## 口径（与既有实现对齐）
 * `KB_DB_PATH` → `DATABASE_PATH` → `./data/agent.db`
 * （`KB_DB_PATH` 是知识库隔离用的显式覆盖；后两者与 `src/mcp/server.ts`、`src/mcp/kb-backend.ts` 一致。）
 */
import { readString } from "../utils/env.js";

export function resolveKnowledgeDbPath(): string {
  return readString("KB_DB_PATH") || readString("DATABASE_PATH", "./data/agent.db");
}
