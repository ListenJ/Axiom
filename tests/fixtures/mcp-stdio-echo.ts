/**
 * MCP stdio 冒烟 fixture —— 极简 server，供 tests/mcp-stdio-live.test.ts
 * 验证 Bun 环境下 @modelcontextprotocol/sdk 的 StdioClientTransport 真实连通
 * （R-015 闭环：此前仅 fake 覆盖，真实子进程连通未验证）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "axiom-stdio-echo", version: "1.0.0" });

server.tool(
  "echo",
  { text: z.string() },
  async ({ text }) => ({ content: [{ type: "text" as const, text: `echo:${text}` }] }),
);

await server.connect(new StdioServerTransport());