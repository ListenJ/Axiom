/**
 * axiom-dsh MCP 桥 —— 以 stdio 拉起 Axiom MCP 服务器，把它的工具
 * 以 `axiom__<tool>` 名称注册进 dsh ToolRuntime，并把模型可见输出
 * 渲染为纯文本。实现参照 dsh 官方 mcp-client（packages/mcp/mcp-client）：
 * 用 uncached tools/list + tools/call，避免 SDK 输出校验器缓存。
 */
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListToolsResultSchema, CallToolResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { DshContext, DshToolDefinition } from './types.js'

/** DeepSeek function-name 契约：最多 64 字符，仅 [A-Za-z0-9_-]。 */
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/**
 * 生成模型可见的公开工具名：`axiom__<rawName>`。
 * 规范化/截断导致名字变化时追加 12 位 SHA-256 哈希，保证不同 MCP 身份不塌缩。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

export interface McpBridgeOptions {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  serverName: string
  toolCallTimeoutMs: number
}

export interface McpToolMeta {
  name: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
}

export interface McpBridge {
  /** 连接 MCP 服务器、同步工具并注册进 ctx.tools；幂等。 */
  connect(ctx: DshContext): Promise<void>
  /** 已桥接的工具数量（未连接为 0）。 */
  toolCount(): number
  /** 运行状态摘要（诊断用）。 */
  status(): { connected: boolean; toolCount: number; serverName: string }
  /** 关闭连接并卸载已注册工具。 */
  dispose(): void
  /**
   * 订阅连接状态变化（服务器意外退出、dispose 等）。
   * 返回取消订阅函数；回调在状态流转时同步触发。
   */
  onConnectionChange(listener: (connected: boolean) => void): () => void
}

/** 从 MCP content 块提取纯文本。 */
export function extractText(content: unknown, rawName: string): string {
  if (!Array.isArray(content)) return `[axiom:${rawName}] no text content`
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
  return parts.length > 0 ? parts.join('\n') : `[axiom:${rawName}] (no text content)`
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
      if (!client) throw new Error(`[axiom-dsh] MCP client not connected for tool ${rawName}`)
      const result = (await client.request(
        { method: 'tools/call', params: { name: rawName, arguments: args } },
        CallToolResultSchema,
        { signal: exec?.signal, timeout: opts.toolCallTimeoutMs },
      )) as { content?: unknown; structuredContent?: unknown; isError?: unknown }
      // MCP error frames surface as a real tool failure, not a successful text result.
      if (result.isError === true) {
        throw new Error(`[axiom:${rawName}] ${extractText(result.content, rawName)}`)
      }
      // dsh requires tool output to be lossless JSON: an explicit
      // `structuredContent: undefined` property fails that check (Axiom's server
      // returns only `content`), so omit the key unless it is actually present.
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
  /** dispose 中标记，避免 onclose 与 dispose 重复清理。 */
  disposing: boolean
  listeners: Array<(connected: boolean) => void>
}

/** 创建 MCP 桥（惰性连接）。 */
export function createMcpBridge(opts: McpBridgeOptions): McpBridge {
  const state: BridgeState = { client: null, transport: null, disposers: [], count: 0, disposing: false, listeners: [] }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) env[k] = v

  function notify(connected: boolean): void {
    for (const l of state.listeners) {
      try {
        l(connected)
      } catch {
        /* 监听器异常不影响桥 */
      }
    }
  }

  /** 卸载已注册工具并清空连接状态（dispose 与意外断连共用）。 */
  function teardown(): void {
    for (const d of state.disposers) {
      try {
        d()
      } catch {
        /* 卸载失败不阻塞清理 */
      }
    }
    state.disposers = []
    state.count = 0
    state.client = null
    state.transport = null
  }

  /**
   * 拉取并注册工具列表（跟随 nextCursor 分页；同一名字出现两次视为非法列表）。
   * 先构建新工具、成功后再卸载旧工具，避免拉取中途失败造成空窗。
   */
  async function syncTools(client: Client, ctx: DshContext): Promise<void> {
    const disposers: Array<() => void> = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const resp = await client.request(
        { method: 'tools/list', params: cursor ? { cursor } : {} },
        ListToolsResultSchema,
      )
      const tools = (resp.tools ?? []) as McpToolMeta[]
      for (const tool of tools) {
        const def = toToolDefinition(tool, opts, () => state.client)
        if (seen.has(def.name)) {
          throw new Error(
            `[axiom-dsh] Axiom MCP server (${opts.serverName}) listed tool "${tool.name}" more than once`,
          )
        }
        seen.add(def.name)
        disposers.push(ctx.tools.register(def))
      }
      cursor = resp.nextCursor
    } while (cursor)

    for (const d of state.disposers) {
      try {
        d()
      } catch {
        /* 旧工具卸载失败不阻塞新工具上线 */
      }
    }
    state.disposers = disposers
    state.count = disposers.length
  }

  /** 串行化所有工具同步：初始同步与 list_changed 重同步不能交错卸载/注册。 */
  let syncChain: Promise<void> = Promise.resolve()
  function enqueueSync(client: Client, ctx: DshContext): Promise<void> {
    const run = syncChain.then(() => {
      if (state.client === client) return syncTools(client, ctx)
      return undefined
    })
    syncChain = run.catch(() => {})
    return run
  }

  async function connect(ctx: DshContext): Promise<void> {
    if (state.client) return
    const client = new Client({ name: 'axiom-dsh', version: '0.1.0' }, { capabilities: {} })
    const transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd.length > 0 ? opts.cwd : undefined,
      env,
    })
    // 服务器进程退出时 transport 触发 close：及时摘掉已失效的工具，
    // 否则 status() 会长期谎报 connected，且工具调用到死客户端才报错。
    client.onclose = () => {
      if (state.disposing) return
      if (state.client !== client) return // 已被新一轮连接替换，忽略旧连接事件
      ctx.logger?.warn?.(`[axiom-dsh] Axiom MCP server (${opts.serverName}) closed; unbridging stale tools`)
      teardown()
      notify(false)
    }
    // 服务器动态增删工具时重同步（对齐 dsh 官方 mcp-client 行为）
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (state.client !== client) return
      enqueueSync(client, ctx).catch((err) => {
        ctx.logger?.warn?.(`[axiom-dsh] tool re-sync failed: ${String(err)}`)
      })
    })
    await client.connect(transport)
    state.client = client
    state.transport = transport
    await enqueueSync(client, ctx)
    notify(true)
    ctx.logger?.info?.(`[axiom-dsh] bridged ${state.count} tools from Axiom MCP server (${opts.serverName})`)
  }

  function dispose(): void {
    state.disposing = true
    // 先取走引用再 close：teardown 会清空 state.transport，
    // 但 close 必须执行——否则 stdio 子进程不会被关闭，留下孤儿进程。
    const transport = state.transport
    teardown()
    try {
      void transport?.close()
    } catch {
      /* 已关闭 */
    }
    state.disposing = false
    notify(false)
  }

  return {
    connect,
    toolCount: () => state.count,
    status: () => ({
      connected: state.client !== null,
      toolCount: state.count,
      serverName: opts.serverName,
    }),
    onConnectionChange: (listener) => {
      state.listeners.push(listener)
      return () => {
        const i = state.listeners.indexOf(listener)
        if (i >= 0) state.listeners.splice(i, 1)
      }
    },
    dispose,
  }
}


