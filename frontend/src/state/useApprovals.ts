/**
 * HITL 审批队列（Zustand store + WebSocket 订阅）。
 *
 * 后端闭环：执行层强制审批 → ApprovalBridge → WS 广播 approval.requested
 * → 本 store 入队 → ApprovalModal 逐条展示 → 用户经 REST
 * POST /approvals/:id/resolve 提交决定 → 出队。
 *
 * 注意：浏览器 WebSocket 无法自定义请求头，后端 /ws 升级校验对 localhost
 * 放行（isLocal），同源本地访问无需 x-api-key；远程访问需后端另行支持。
 */
import { create } from 'zustand'
import { api } from '@/lib/api'

export type ApprovalRisk = 'safe' | 'caution' | 'destructive' | 'unknown'

export interface ApprovalItem {
  id: string
  tool: string
  args: unknown
  risk: ApprovalRisk
  requestedAt?: number
  timeoutMs?: number
}

interface ApprovalsState {
  queue: ApprovalItem[]
  connected: boolean
  enqueue: (item: ApprovalItem) => void
  dequeue: (id: string) => void
  resolve: (id: string, approved: boolean, reason?: string) => Promise<void>
  connect: () => void
  disconnect: () => void
}

const RISKS: readonly string[] = ['safe', 'caution', 'destructive', 'unknown']

/** 处理一条 WS 文本消息：approval.requested 入队，approval.resolved 出队。 */
export function handleApprovalWsMessage(raw: string): void {
  let msg: { type?: unknown; payload?: unknown }
  try {
    msg = JSON.parse(raw) as typeof msg
  } catch {
    return
  }
  const payload = (msg.payload ?? {}) as Record<string, unknown>
  if (msg.type === 'approval.requested') {
    if (typeof payload.id !== 'string' || typeof payload.tool !== 'string') return
    const item: ApprovalItem = {
      id: payload.id,
      tool: payload.tool,
      args: payload.args,
      risk: (RISKS.includes(payload.risk as string) ? payload.risk : 'unknown') as ApprovalRisk,
    }
    if (typeof payload.requestedAt === 'number') item.requestedAt = payload.requestedAt
    if (typeof payload.timeoutMs === 'number') item.timeoutMs = payload.timeoutMs
    useApprovals.getState().enqueue(item)
  } else if (msg.type === 'approval.resolved') {
    if (typeof payload.id !== 'string') return
    useApprovals.getState().dequeue(payload.id)
  }
}

// ----- WS 连接管理（模块级单例，断线指数退避重连） -----

let ws: WebSocket | null = null
let stopped = true
let retries = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

const BASE_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 15_000

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

function openWs(): void {
  const socket = new WebSocket(wsUrl())
  ws = socket
  socket.onopen = () => {
    retries = 0
    useApprovals.setState({ connected: true })
  }
  socket.onmessage = (e) => handleApprovalWsMessage(String(e.data))
  socket.onerror = () => socket.close()
  socket.onclose = () => {
    useApprovals.setState({ connected: false })
    ws = null
    if (stopped) return
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** retries, MAX_RETRY_DELAY_MS)
    retries += 1
    reconnectTimer = setTimeout(openWs, delay)
  }
}

export const useApprovals = create<ApprovalsState>((set, get) => ({
  queue: [],
  connected: false,
  enqueue: (item) => {
    const queue = get().queue
    if (queue.some((a) => a.id === item.id)) return
    set({ queue: [...queue, item] })
  },
  dequeue: (id) => set({ queue: get().queue.filter((a) => a.id !== id) }),
  resolve: async (id, approved, reason) => {
    await api.post(`/approvals/${encodeURIComponent(id)}/resolve`, {
      approved,
      ...(reason ? { reason } : {}),
    })
    get().dequeue(id)
  },
  connect: () => {
    if (!stopped || typeof WebSocket === 'undefined') return
    stopped = false
    openWs()
  },
  disconnect: () => {
    stopped = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    ws?.close()
    ws = null
    set({ connected: false })
  },
}))
