/**
 * DRE 自包含 MCP 后端入口 —— 供 axiom-dre-dsh 插件打包（bun build 单文件）。
 *
 * 与 src/mcp/server.ts 的区别：只注册 DRE 能力面工具（dre-tools.ts），
 * 不挂载 vault/kg/web/github 等其它工具面，产物更小、更适合内嵌插件。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDreTools, shutdownKernel } from "./server/dre-tools.js";
import { registerMindTools } from "./server/mind-tools.js";
import { ToolRegistry } from "./tool-registry.js";
import { readString, readInt } from "../utils/env.js";

const mcp = new McpServer({ name: "Axiom DRE MCP Server", version: "0.1.0" });
const registry = new ToolRegistry();
// 注册 DRE 全部工具（dre_*/cognitive_*/reasoning_*/constraint_*/actor_*/mental_model_* 等）与突触记忆工具（mind_synapse_*）
registerDreTools(registry);
registerMindTools(registry);
registry.registerWithMcp(mcp);

// 数据目录：默认当前工作目录（插件会以可写 data 目录作为 cwd 启动）；
// DRE_DB_PATH 由 ConfigLoader（src/dre/config.ts）经 readString 读取，缺省即 ./data/dre.db，无需在此写入。

const useStdio = process.argv.includes("--stdio");
if (useStdio) {
  const stdio = new StdioServerTransport();
  await mcp.connect(stdio);
  // stdio 通道关闭（dsh/父进程退出或断开）→ 有界关停退出；
  // 避免 autoTick 定时器使孤儿进程持续占用 SQLite（锁死后续实例）。
  stdio.onclose = () => void shutdownAndExit();
} else {
  // HTTP 模式（远程调试用；默认仅回环）
  const port = readInt("DRE_MCP_PORT", 3001);
  const hostname = readString("DRE_MCP_HOST", "127.0.0.1");
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
      return httpTransport.handleRequest(req);
    },
  });
}

/** 有界关停：停内核 → 退出；2s 未完成则强制退出（防 shutdown 挂起）。 */
function shutdownAndExit(): void {
  const timer = setTimeout(() => process.exit(0), 2000);
  void shutdownKernel().finally(() => process.exit(0));
}
process.on("SIGINT", shutdownAndExit);
process.on("SIGTERM", shutdownAndExit);
// 兜底：stdin EOF（父进程死亡/管道关闭）也触发退出
process.stdin.on("end", shutdownAndExit);
process.stdin.on("close", shutdownAndExit);
