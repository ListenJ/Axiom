/**
 * MCP 客户端连接器 (R-015 / R-023)
 * 消费 config/mcp-servers.yaml 中注册的外部 MCP server（stdio / remote HTTP），
 * 将远端工具以 `mcp_<server>_<tool>` 前缀注册进 ToolRegistry（防命名冲突）。
 * 连接失败 / 超时优雅降级：warn 日志跳过该 server，不影响主服务启动。
 * 已连接 client 登记在 activeClients，进程退出经 closeExternalMcpClients 关闭
 * （main.ts 注册 mcp-clients 关闭钩子），防止子进程/连接泄漏（R-023）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import YAML from "yaml";
import { logger } from "../utils/logger.js";
import { withTimeout } from "../utils/resilience.js";
import { readInt, readString } from "../utils/env.js";
import type { ToolRegistry } from "./tool-registry.js";

/** mcp-servers.yaml 中单个 server 的配置（type: "remote" 为远程 HTTP，含 command 为 stdio） */
export interface McpServerEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  optional?: boolean;
  timeoutMs?: number | string;
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
const activeClients = new Map<string, McpClientLike>();

/** 关闭全部已连接的外部 MCP client（幂等，失败仅告警）；返回关闭数量 */
export async function closeExternalMcpClients(): Promise<number> {
  const names = Array.from(activeClients.keys());
  await Promise.all(names.map(async (name) => {
    const client = activeClients.get(name);
    if (!client) return;
    activeClients.delete(name);
    await closeClientQuietly(client, name);
  }));
  return names.length;
}

/** 当前存活的外部 MCP client 数（审计/诊断用） */
export function getMcpClientStats(): { connected: number } {
  return { connected: activeClients.size };
}


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

/** 幂等关闭 client；失败仅告警，不阻断连接汇总 */
async function closeClientQuietly(client: McpClientLike, name: string): Promise<void> {
  try {
    await client.close();
  } catch (closeErr) {
    logger.warn("[MCP-Client] 关闭 client 失败", { server: name, error: (closeErr as Error).message });
  }
}

/**
 * 连接 yaml 中所有外部 MCP server，并将远端工具注册进 registry。
 * 各 server 并行连接，任一失败仅记录 warn 并跳过，不中断启动。
 */
function resolveEntryTimeout(value?: number | string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const str = String(value).trim();
  const envWithDefault = str.match(/^\$\{(\w+):-(\d+)\}$/);
  if (envWithDefault) {
    const [, varName, def] = envWithDefault;
    return readInt(varName, Number(def));
  }
  const envOnly = str.match(/^\$\{(\w+)\}$/);
  if (envOnly) {
    const [, varName] = envOnly;
    const v = process.env[varName];
    if (v !== undefined) {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : undefined;
}

export async function connectExternalMcpServers(
  registry: ToolRegistry,
  opts?: { configPath?: string; timeoutMs?: number; createClient?: McpClientFactory }
): Promise<McpConnectSummary> {
  const servers = await loadMcpServerConfigs(opts?.configPath);
  const globalTimeoutMs = opts?.timeoutMs ?? readInt("MCP_CONNECT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const createClient = opts?.createClient ?? createSdkClient;
  const summary: McpConnectSummary = { connected: [], failed: [], toolsRegistered: 0 };

  await Promise.all(Object.entries(servers).map(async ([name, entry]) => {
    const serverTimeoutMs = resolveEntryTimeout(entry.timeoutMs) ?? globalTimeoutMs;
    let client: McpClientLike | null = null;
    let clientPromise: Promise<McpClientLike> | null = null;
    try {
      clientPromise = createClient(name, entry);
      const connected = await withTimeout(clientPromise, serverTimeoutMs);
      client = connected;
      const existing = activeClients.get(name);
      if (existing && existing !== connected) {
        activeClients.delete(name);
        await closeClientQuietly(existing, name);
      }
      activeClients.set(name, connected);
      const { tools } = await withTimeout(connected.listTools(), serverTimeoutMs);
      for (const tool of tools) {
        registry.add({
          name: `mcp_${name}_${tool.name}`,
          description: `[${name}] ${tool.description ?? tool.name}`,
          inputSchema: tool.inputSchema ?? {},
          handler: async (args) => connected.callTool({ name: tool.name, arguments: args }),
          tags: ["external-mcp", name],
        });
        summary.toolsRegistered++;
      }
      summary.connected.push(name);
      logger.info("[MCP-Client] 外部 MCP server 已连接", { server: name, tools: tools.length });
    } catch (e: unknown) {
      if (client) {
        if (activeClients.get(name) === client) activeClients.delete(name);
        await closeClientQuietly(client, name);
      } else if (clientPromise) {
        // createClient 失败/超时：若迟到完成，立即关闭连接，防止孤儿子进程残留
        void clientPromise.then((c) => closeClientQuietly(c, name)).catch(() => {});
      }
      summary.failed.push({ name, error: (e as Error).message });
      // M2：optional=true 的 server 失败仅 info（预期可降级），非 optional 仍 warn
      if (entry.optional) {
        logger.info("[MCP-Client] optional MCP server failed (degraded)", { server: name, error: (e as Error).message });
      } else {
        logger.warn("[MCP-Client] 外部 MCP server 连接失败，已跳过", { server: name, error: (e as Error).message });
      }
    }
  }));

  return summary;
}
