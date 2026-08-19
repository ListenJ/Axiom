/**
 * 真实冒烟：以 stdio 拉起插件内置后端（backend/server.js，Vault 记忆 + 知识图谱 + MCP 服务器），
 * 验证 axiom-kb-dsh 只桥接 KB 白名单工具（kb__* 前缀），且 memory 写读闭环、知识图谱
 * 写入与 kal_query 可真实调用。联网检索工具（web_*）不进入插件队列。
 */
import { describe, test, expect } from 'bun:test'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { apply } from '../src/index.js'
import { createMcpBridge, DEFAULT_KB_FILTER, matchTool, type McpBridge } from '../src/mcp-bridge.js'
import type { DshToolDefinition } from '../src/types.js'

const PLUGIN = path.resolve(import.meta.dir, '..')
// 内置后端：插件 bun build 产物（Vault 记忆 + 知识图谱 + MCP 服务器），自包含
const BUILTIN_BACKEND = path.join(PLUGIN, 'backend', 'server.js')
const DATA_DIR = path.join(PLUGIN, 'data')

function makeCtx() {
  const registered: DshToolDefinition[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register: (d: DshToolDefinition) => { registered.push(d); return () => {} } },
    effect() {},
    inject() {},
    get: () => undefined,
  }
  return { ctx, registered }
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting: ${label}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** 执行工具并拼接 text 块为纯文本。 */
async function callText(def: DshToolDefinition, args: Record<string, unknown>): Promise<string> {
  const out = (await def.execute(args)) as { content?: unknown[] }
  return (out.content ?? [])
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n')
    .trim()
}

describe('smoke: 桥对内置知识库后端的 KB 白名单过滤与真实调用', () => {
  test('只注册 kb__* 工具；memory 写读闭环 + kg 节点/边/子图/搜索 + atomic/dip/kal 真实调用', async () => {
    const { ctx, registered } = makeCtx()
    mkdirSync(DATA_DIR, { recursive: true })
    const bridge: McpBridge = createMcpBridge({
      command: 'bun',
      args: [BUILTIN_BACKEND, '--stdio'],
      cwd: DATA_DIR,
      serverName: 'kb',
      toolCallTimeoutMs: 60_000,
      toolFilter: DEFAULT_KB_FILTER,
    })
    try {
      await bridge.connect(ctx)
      expect(bridge.status().connected).toBe(true)
      await waitFor(() => registered.some((d) => d.name.startsWith('kb__')), 30_000, 'bridge tools registered')

      // 1) 全部注册工具都是 kb__ 前缀
      for (const d of registered) {
        expect(d.name.startsWith('kb__'), d.name).toBe(true)
      }
      // 2) 数量 > 0 且每个工具名都命中白名单
      expect(registered.length).toBeGreaterThan(0)
      for (const d of registered) {
        const raw = d.name.replace(/^kb__/, '')
        expect(matchTool(raw, DEFAULT_KB_FILTER), raw).toBe(true)
      }
      // 3) 联网检索工具不应出现（个人使用，不进插件队列）；DRE 等其它能力面也不应出现
      expect(registered.some((d) => d.name === 'kb__web_search')).toBe(false)
      expect(registered.some((d) => d.name === 'kb__web_fetch')).toBe(false)
      expect(registered.some((d) => d.name === 'kb__search_engines_list')).toBe(false)
      expect(registered.some((d) => d.name === 'kb__dre_status')).toBe(false)

      // 4) memory 写读闭环：写唯一 token → 搜回
      const token = `smoke-${Date.now()}`
      const writeDef = registered.find((d) => d.name === 'kb__memory_write')
      expect(writeDef, 'kb__memory_write 存在').toBeDefined()
      const wout = await writeDef!.execute({
        path: `00-Meta/${token}.md`,
        content: `# ${token}\n\n确定性记忆写读闭环验证 ${token}`,
        title: token,
        tags: ['smoke', 'kb'],
        overwrite: true,
      })
      // lossless JSON 契约：不得包含 structuredContent: undefined
      expect(JSON.stringify(wout)).not.toContain('structuredContent: undefined')
      expect(JSON.stringify(wout)).toContain('savedTo')

      const searchDef = registered.find((d) => d.name === 'kb__memory_search')
      expect(searchDef, 'kb__memory_search 存在').toBeDefined()
      const sText = await callText(searchDef!, { query: token, limit: 5 })
      expect(sText.length).toBeGreaterThan(0)
      expect(sText).toContain(token)

      // 5) 知识图谱：写入节点 + 统计（kg 表可查询）
      const addDef = registered.find((d) => d.name === 'kb__kg_add_node')
      expect(addDef, 'kb__kg_add_node 存在').toBeDefined()
      const aText = await callText(addDef!, { type: 'concept', name: `node-${token}`, description: 'KB smoke node' })
      expect(aText).toContain('nodeId')

      const statsDef = registered.find((d) => d.name === 'kb__kg_stats')
      expect(statsDef, 'kb__kg_stats 存在').toBeDefined()
      const statsText = await callText(statsDef!, {})
      expect(statsText.length).toBeGreaterThan(0)

      // 6) 统一知识查询（KAL）：容忍缺失存储，必须返回结构化结果
      const kalDef = registered.find((d) => d.name === 'kb__kal_query')
      expect(kalDef, 'kb__kal_query 存在').toBeDefined()
      const kalText = await callText(kalDef!, { query: token, limit: 10 })
      expect(kalText.length).toBeGreaterThan(0)

      // 7) 知识图谱深度闭环：双节点 + 边 + 子图 + 节点搜索
      const aJson = JSON.parse(aText)
      const addBText = await callText(addDef!, { type: 'concept', name: `node-b-${token}`, description: 'KB smoke node B' })
      const bJson = JSON.parse(addBText)
      const edgeDef = registered.find((d) => d.name === 'kb__kg_add_edge')
      expect(edgeDef, 'kb__kg_add_edge 存在').toBeDefined()
      const eText = await callText(edgeDef!, { source: aJson.nodeId, target: bJson.nodeId, type: 'related-to', description: 'smoke edge' })
      expect(eText).toContain('edgeId')
      const subDef = registered.find((d) => d.name === 'kb__kg_subgraph')
      expect(subDef, 'kb__kg_subgraph 存在').toBeDefined()
      const sub = JSON.parse(await callText(subDef!, { nodeId: aJson.nodeId, depth: 2, maxNodes: 50 })) as { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }
      expect(sub.edges.length).toBeGreaterThanOrEqual(1)
      expect(sub.nodes.some((n) => n.id === bJson.nodeId), '子图含目标节点').toBe(true)
      const searchNodesDef = registered.find((d) => d.name === 'kb__kg_search_nodes')
      expect(searchNodesDef, 'kb__kg_search_nodes 存在').toBeDefined()
      const found = JSON.parse(await callText(searchNodesDef!, { query: token, limit: 20 }))
      expect(Array.isArray(found) && found.length > 0, 'kg_search_nodes 命中').toBe(true)

      // 8) memory_atomic → memory_search 闭环（新写笔记经 SQLite FTS 立即可检索）
      const atomicDef = registered.find((d) => d.name === 'kb__memory_atomic')
      expect(atomicDef, 'kb__memory_atomic 存在').toBeDefined()
      const atomic = JSON.parse(await callText(atomicDef!, { title: `atomic-${token}`, idea: `原子笔记 ${token}`, tags: ['smoke-atomic'] }))
      expect(atomic.notePath).toContain('atomic-notes')
      const atomicSearch = await callText(searchDef!, { query: `atomic-${token}`, limit: 5 })
      expect(atomicSearch).toContain(`atomic-${token}`)

      // 9) dip_ingest_document → 文档→KG 管道（零 LLM）
      const dipDef = registered.find((d) => d.name === 'kb__dip_ingest_document')
      expect(dipDef, 'kb__dip_ingest_document 存在').toBeDefined()
      const dip = JSON.parse(await callText(dipDef!, {
        markdown: '# Demo\n\n```ts\nfunction smokeFn_' + token.slice(-6) + '(): void {}\n```\n',
        title: `dip-${token}`,
      }))
      expect(dip.success).toBe(true)
      expect(dip.document).toBe(`dip-${token}`)
    } finally {
      bridge.dispose()
    }
  })
})

describe('smoke: apply() 插件入口（容忍模式）', () => {
  test('注册 kb_plugin_status 诊断工具 + kb__* 桥接工具', async () => {
    const { ctx, registered } = makeCtx()
    // 自包含：插件默认拉起内置后端（Vault 记忆 + 知识图谱）
    apply(ctx, { mcpToolCallTimeoutMs: 30_000, mcpFailOnStartupError: false })
    // kb_plugin_status 同步注册
    expect(registered.some((d) => d.name === 'kb_plugin_status')).toBe(true)
    // 桥接异步完成
    await waitFor(() => registered.some((d) => d.name.startsWith('kb__')), 30_000, 'apply bridge tools')
    expect(registered.some((d) => d.name === 'kb__memory_stats')).toBe(true)
    expect(registered.some((d) => d.name === 'kb__kg_stats')).toBe(true)
    // 诊断工具可调用且无密钥
    const statusDef = registered.find((d) => d.name === 'kb_plugin_status')!
    const out = (await statusDef.execute({})) as Record<string, unknown>
    expect(out).toHaveProperty('bridge')
    expect(JSON.stringify(out)).not.toContain('sk-')
  })
})
