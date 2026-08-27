/**
 * axiom-dre-dsh MCP 桥 —— 以 stdio 拉起 Axiom MCP 服务器，把「DRE 白名单」内的工具
 * 以 `dre__<tool>` 名称注册进 dsh ToolRuntime，并把模型可见输出渲染为纯文本。
 * 实现参照 dsh 官方 mcp-client（packages/mcp/mcp-client）与 plugins/dsh 的桥：
 * 用 uncached tools/list + tools/call，避免 SDK 输出校验器缓存。
 *
 * 与 plugins/dsh 单块桥的唯一差异：按 toolFilter 白名单过滤（默认 DRE 族），
 * 其余（前缀生成、lossless JSON、isError 传播、生命周期）完全同构。
 */
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { DshContext, DshToolDefinition } from './types.js'

/** DeepSeek function-name 契约：最多 64 字符，仅 [A-Za-z0-9_-]。 */
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/**
 * 生成模型可见的公开工具名：`<serverName>__<rawName>`（本插件 serverName='dre'）。
 * 规范化/截断导致名字变化时追加 12 位 SHA-256 哈希，保证不同 MCP 身份不塌缩。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** DRE 能力面默认白名单：前缀（以 _ 结尾）或全名。 */
export const DEFAULT_DRE_FILTER: string[] = [
  'dre_',
  'cognitive_',
  'reasoning_',
  'constraint_',
  'actor_',
  'mental_model_',
  'mind_synapse_',
  'task_graph_execute',
  'mind_suggest',
]

/** 判断工具名是否命中白名单（前缀以 _ 结尾做 startsWith，否则精确匹配全名）。 */
export function matchTool(name: string, filter: string[]): boolean {
  return filter.some((f) => (f.endsWith('_') ? name.startsWith(f) : name === f))
}

/** 应用 synapseEnabled：false 时剔除突触工具。 */
export function applySynapseGate(filter: string[], synapseEnabled: boolean): string[] {
  if (synapseEnabled) return filter
  return filter.filter((f) => f !== 'mind_synapse_' && f !== 'mind_suggest')
}

export interface McpBridgeOptions {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  serverName: string
  toolCallTimeoutMs: number
  /** 白名单：前缀（以 _ 结尾）或全名数组。 */
  toolFilter: string[]
}

export interface McpToolMeta {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpBridge {
  /** 连接 MCP 服务器、按白名单同步工具并注册进 ctx.tools；幂等。 */
  connect(ctx: DshContext): Promise<void>
  /** 已桥接的工具数量（未连接为 0）。 */
  toolCount(): number
  /** 运行状态摘要（诊断用）。 */
  status(): { connected: boolean; toolCount: number; serverName: string }
  /** 关闭连接并卸载已注册工具。 */
  dispose(): void
}

/** 从 MCP content 块提取纯文本。 */
export function extractText(content: unknown, rawName: string): string {
  if (!Array.isArray(content)) return `[dre:${rawName}] no text content`
  const parts: string[] = []
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : `[dre:${rawName}] (no text content)`
}

/** 构造 dsh ToolDefinition（parameters 直接透传 MCP JSON Schema）。 */
export function toToolDefinition(tool: McpToolMeta, opts: McpBridgeOptions, getClient: () => Client | null): DshToolDefinition {
  const rawName = tool.name
  return {
    name: publicToolName(opts.serverName, rawName),
    description: tool.description ?? '',
    parameters: ((tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>),
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {},
        },
        required: ['content'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = (value ?? {}) as { content?: unknown }
        return [{ type: 'text', text: extractText(v.content, rawName) }]
      },
    },
    execute: async (args, exec) => {
      const client = getClient()
      if (!client) throw new Error(`[axiom-dre-dsh] MCP client not connected for tool ${rawName}`)
      const result = (await client.request(
        { method: 'tools/call', params: { name: rawName, arguments: args } },
        CallToolResultSchema,
        { signal: exec?.signal, timeout: opts.toolCallTimeoutMs },
      )) as { content?: unknown; structuredContent?: unknown; isError?: unknown }
      // MCP error frames surface as a real tool failure, not a successful text result.
      if (result.isError === true) {
        throw new Error(`[dre:${rawName}] ${extractText(result.content, rawName)}`)
      }
      // dsh requires tool output to be lossless JSON: an explicit
      // `structuredContent: undefined` property fails that check, so omit the
      // key unless it is actually present.
      const value: Record<string, unknown> = { content: result.content ?? [] }
      if (result.structuredContent !== undefined) value.structuredContent = result.structuredContent
      return value
    },
  }
}

/** 模块级状态容器（单实例桥：一个插件实例一个 bridge 对象）。 */
interface BridgeState {
  client: Client | null
  transport: StdioClientTransport | null
  disposers: Array<() => void>
  count: number
}

/** 创建 MCP 桥（惰性连接；按 toolFilter 白名单过滤）。 */
export function createMcpBridge(opts: McpBridgeOptions): McpBridge {
  const state: BridgeState = { client: null, transport: null, disposers: [], count: 0 }
  // 子进程环境 = 继承当前进程环境 + 显式覆盖（opts.env 优先，便于注入 AXIOM_AUTH_TOKEN 等）
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) env[k] = v

  async function connect(ctx: DshContext): Promise<void> {
    // 幂等：已连接则直接返回，避免重复拉起 MCP 子进程
    if (state.client) return
    const client = new Client({ name: 'axiom-dre-dsh', version: '0.1.0' }, { capabilities: {} })
    const transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd.length > 0 ? opts.cwd : undefined,
      env,
    })
    // 先 MCP 握手（initialize），再拉取工具清单
    await client.connect(transport)
    state.client = client
    state.transport = transport

    const resp = await client.request({ method: 'tools/list' }, ListToolsResultSchema)
    const tools = (resp.tools ?? []) as McpToolMeta[]
    // 白名单过滤：只注册 DRE 能力面工具，避免把 memory_*/web_*/github_* 等带入 dsh
    const selected = tools.filter((t) => matchTool(t.name, opts.toolFilter))
    const disposers: Array<() => void> = []
    for (const tool of selected) {
      // 每个注册返回一个卸载函数，dispose 时逐个调用以完整回滚
      disposers.push(ctx.tools.register(toToolDefinition(tool, opts, () => state.client)))
    }
    state.disposers = disposers
    state.count = selected.length
    ctx.logger?.info?.(
      `[axiom-dre-dsh] bridged ${selected.length}/${tools.length} DRE tools from Axiom MCP server (${opts.serverName})`,
    )
  }

  function dispose(): void {
    // 清理顺序：先卸载已注册工具（dsh 侧立即感知），再关闭子进程 transport，最后清空状态
    for (const d of state.disposers) {
      try {
        d()
      } catch {
        /* 卸载失败不阻塞清理 */
      }
    }
    state.disposers = []
    state.count = 0
    try {
      state.transport?.close()
    } catch {
      /* 已关闭 */
    }
    state.transport = null
    state.client = null
  }

  return {
    connect,
    toolCount: () => state.count,
    status: () => ({
      connected: state.client !== null,
      toolCount: state.count,
      serverName: opts.serverName,
    }),
    dispose,
  }
}
