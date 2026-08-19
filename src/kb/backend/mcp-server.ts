/**
 * KB 自包含 MCP 后端入口 —— 供 axiom-kb-dsh 插件打包（bun build 单文件）。
 *
 * 与 src/mcp/server.ts 的区别：只注册知识库能力面工具——
 *   - Vault 记忆库：memory_* 与 code_index（vault-tools.ts）
 *   - 知识图谱：kg_、kal_、dip_（kg-tools.ts）
 * 不挂载 web_、github_、skill_ 等其它工具面。联网检索（web_fetch / web_search /
 * search_engines_list）仅保留在宿主 Agent 个人使用，不进入插件队列。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Database } from "bun:sqlite";
import { registerVaultTools } from "../../mcp/server/vault-tools.js";
import { registerKgTools } from "../../mcp/server/kg-tools.js";
import { ToolRegistry } from "../../mcp/tool-registry.js";
import { getGlobalVault } from "../../memory/vault-manager.js";
import { readString } from "../../utils/env.js";

const mcp = new McpServer({ name: "Axiom KB MCP Server", version: "0.1.0" });
const registry = new ToolRegistry();

// 数据目录：默认当前工作目录（插件会以可写 data 目录作为 cwd 启动）。
// Vault 目录必须存在（DeterministicSearchEngine 构造时 readdirSync 扫描），先建目录再初始化；
// SQLite（KG/KAL）目录同理。
const vaultPath = readString("OBSIDIAN_VAULT_PATH", "./axiom-memory");
const dbPath = readString("KB_DB_PATH", "./data/kg.db");
mkdirSync(vaultPath, { recursive: true });
mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
const vault = getGlobalVault();

// 注册知识库全部工具：Vault 记忆（memory_*/code_index）+ 知识图谱（kg_*/kal_*/dip_*）
registerVaultTools(registry, vault);
registerKgTools(registry, db);
registry.registerWithMcp(mcp);

const useStdio = process.argv.includes("--stdio");
if (useStdio) {
  const stdio = new StdioServerTransport();
  await mcp.connect(stdio);
} else {
  // HTTP 模式（远程调试用；默认仅回环）
  const port = Number(process.env.KB_MCP_PORT ?? "3002");
  const hostname = process.env.KB_MCP_HOST ?? "127.0.0.1";
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  );
  Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const reqServer = new McpServer({ name: "Axiom KB MCP Server", version: "0.1.0" });
      registry.registerWithMcp(reqServer);
      const httpTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await reqServer.connect(httpTransport);
      return httpTransport.handleRequest(req);
    },
  });
}

process.on("SIGINT", () => { db.close(); process.exit(0); });
process.on("SIGTERM", () => { db.close(); process.exit(0); });
