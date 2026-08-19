/**
 * DRE 自包含 MCP 后端入口 —— 供 axiom-dre-dsh 插件打包（bun build 单文件）。
 *
 * 与 src/mcp/server.ts 的区别：只注册 DRE 能力面工具（dre-tools.ts），
 * 不挂载 vault/kg/web/github 等其它工具面，产物更小、更适合内嵌插件。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDreTools, shutdownKernel } from "../../mcp/server/dre-tools.js";
import { registerMindTools } from "../../mcp/server/mind-tools.js";
import { ToolRegistry } from "../../mcp/tool-registry.js";

const mcp = new McpServer({ name: "Axiom DRE MCP Server", version: "0.1.0" });
const registry = new ToolRegistry();
// 注册 DRE 全部工具（dre_*/cognitive_*/reasoning_*/constraint_*/actor_*/mental_model_* 等）与突触记忆工具（mind_synapse_*）
registerDreTools(registry);
registerMindTools(registry);
registry.registerWithMcp(mcp);

// 数据目录：默认当前工作目录（插件会以可写 data 目录作为 cwd 启动）
if (!process.env.DRE_DB_PATH) {
  process.env.DRE_DB_PATH = "./data/dre.db";
}

const useStdio = process.argv.includes("--stdio");
if (useStdio) {
  const stdio = new StdioServerTransport();
  await mcp.connect(stdio);
} else {
  // HTTP 模式（远程调试用；默认仅回环）
  const port = Number(process.env.DRE_MCP_PORT ?? "3001");
  const hostname = process.env.DRE_MCP_HOST ?? "127.0.0.1";
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  );
  Bun.serve({
    port,
    hostname,
    async fetch(req, server) {
      const reqServer = new McpServer({ name: "Axiom DRE MCP Server", version: "0.1.0" });
      registry.registerWithMcp(reqServer);
      const httpTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await reqServer.connect(httpTransport);
      return httpTransport.handleRequest(req, server);
    },
  });
}

process.on("SIGINT", () => { void shutdownKernel().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdownKernel().then(() => process.exit(0)); });
