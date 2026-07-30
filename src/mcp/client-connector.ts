/**
 * MCP 客户端连接器 (R-015)
 * 消费 config/mcp-servers.yaml 中注册的外部 MCP server（stdio / remote HTTP），
 * 将远端工具以 `mcp_<server>_<tool>` 前缀注册进 ToolRegistry（防命名冲突）。
 * 连接失败 / 超时优雅降级：warn 日志跳过该 server，不影响主服务启动。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import YAML from "yaml";
import { logger } from "../utils/logger.js";
import { withTimeout } from "../utils/resilience.js";
import { readString } from "../utils/env.js";
import type { ToolRegistry } from "./tool-registry.js";

/** mcp-servers.yaml 中单个 server 的配置（type: "remote" 为远程 HTTP，含 command 为 stdio） */
export interface McpServerEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 连接结果汇总 */
export interface McpConnectSummary {
  connected: string[];
  failed: Array<{ name: string; error: string }>;
  toolsRegistered: number;
}

/** SDK Client 的最小接口（便于测试注入 fake，不真实连接外部 server） */
export interface McpClientLike {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

/** 可注入的 client 工厂（测试用 fake） */
export type McpClientFactory = (name: string, entry: McpServerEntry) => Promise<McpClientLike>;

const DEFAULT_CONFIG_PATH = "config/mcp-servers.yaml";
const DEFAULT_TIMEOUT_MS = 10_000;

/** 解析 mcp-servers.yaml；文件缺失 / 格式错误返回空表（优雅降级） */
export async function loadMcpServerConfigs(configPath: string = DEFAULT_CONFIG_PATH): Promise<Record<string, McpServerEntry>> {
  try {
    const text = await Bun.file(configPath).text();
    const doc = YAML.parse(text) as { servers?: Record<string, McpServerEntry> } | null;
    return doc?.servers ?? {};
  } catch (e: unknown) {
    logger.warn("[MCP-Client] 读取 MCP server 配置失败", { path: configPath, error: (e as Error).message });
    return {};
  }
}

/** 展开 env 值中的 ${VAR} 占位符（如 yaml 中的 OPENCODE_API_KEY） */
function expandEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(/\$\{(\w+)\}/g, (_, varName: string) => readString(varName));
  }
  return out;
}

/** 默认 client 工厂：按配置类型建立 stdio / remote HTTP 连接 */
async function createSdkClient(name: string, entry: McpServerEntry): Promise<McpClientLike> {
  const client = new Client({ name: `axiom-mcp-client-${name}`, version: "1.0.0" });
  if (entry.type === "remote" && entry.url) {
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url)));
  } else if (entry.command) {
    await client.connect(new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env ? { ...getDefaultEnvironment(), ...expandEnv(entry.env) } : undefined,
      stderr: "inherit",
    }));
  } else {
    throw new Error(`server "${name}" 配置无效：缺少 url (remote) 或 command (stdio)`);
  }
  return client;
}

/**
 * 连接 yaml 中所有外部 MCP server，并将远端工具注册进 registry。
 * 各 server 并行连接，任一失败仅记录 warn 并跳过，不中断启动。
 */
export async function connectExternalMcpServers(
  registry: ToolRegistry,
  opts?: { configPath?: string; timeoutMs?: number; createClient?: McpClientFactory }
): Promise<McpConnectSummary> {
  const servers = await loadMcpServerConfigs(opts?.configPath);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createClient = opts?.createClient ?? createSdkClient;
  const summary: McpConnectSummary = { connected: [], failed: [], toolsRegistered: 0 };

  await Promise.all(Object.entries(servers).map(async ([name, entry]) => {
    try {
      const client = await withTimeout(createClient(name, entry), timeoutMs);
      const { tools } = await withTimeout(client.listTools(), timeoutMs);
      for (const tool of tools) {
        registry.add({
          name: `mcp_${name}_${tool.name}`,
          description: `[${name}] ${tool.description ?? tool.name}`,
          inputSchema: tool.inputSchema ?? {},
          handler: async (args) => client.callTool({ name: tool.name, arguments: args }),
          tags: ["external-mcp", name],
        });
        summary.toolsRegistered++;
      }
      summary.connected.push(name);
      logger.info("[MCP-Client] 外部 MCP server 已连接", { server: name, tools: tools.length });
    } catch (e: unknown) {
      summary.failed.push({ name, error: (e as Error).message });
      logger.warn("[MCP-Client] 外部 MCP server 连接失败，已跳过", { server: name, error: (e as Error).message });
    }
  }));

  return summary;
}
