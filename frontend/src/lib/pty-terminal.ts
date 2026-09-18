/**
 * PtyTerminal — 交互终端会话客户端（深模块）
 *
 * 负责会话生命周期：create → stream → input → close。
 * 默认适配器走 /terminal/* REST + SSE；测试注入 fake adapter。
 */
import { endpoints } from './api'

export interface PtyTerminalAdapter {
  create(): Promise<{ sessionId: string }>
  input(sessionId: string, data: string): Promise<unknown>
  close(sessionId: string): Promise<unknown>
  stream(
    sessionId: string,
    onChunk: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<() => void>
}

/** 打开 SSE 流；解析 `data: <json>` 块并逐块回调。返回可幂等调用的停止函数。 */
export async function openTerminalStream(
  sessionId: string,
  onChunk: (chunk: string) => void,
  signal: AbortSignal,
): Promise<() => void> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  if (typeof localStorage !== 'undefined') {
    const token = localStorage.getItem('token')
    if (token) headers.Authorization = `Bearer ${token}`
  }

  let cancelled = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const run = async () => {
    try {
      const response = await fetch(`/terminal/session/${encodeURIComponent(sessionId)}/stream`, {
        headers,
        signal,
      })
      if (!response.ok) {
        onChunk(`\r\n[terminal] 连接失败 (HTTP ${response.status})\r\n`)
        return
      }
      if (!response.body) {
        onChunk('\r\n[terminal] 响应无数据流\r\n')
        return
      }
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!cancelled) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const dataLine = block.split('\n').find((line) => line.startsWith('data:'))
          if (dataLine) {
            const payload = dataLine.slice(5).trim()
            try {
              onChunk(JSON.parse(payload) as string)
            } catch {
              onChunk(payload)
            }
          }
          sep = buffer.indexOf('\n\n')
        }
      }
    } catch {
      /* aborted / network error：由 stop 或页面清理处理 */
    } finally {
      reader?.releaseLock()
      reader = null
    }
  }
  void run()

  return () => {
    cancelled = true
    void reader?.cancel().catch(() => {})
  }
}

export const defaultPtyTerminalAdapter: PtyTerminalAdapter = {
  create: () => endpoints.terminal.create(),
  input: (sessionId, data) => endpoints.terminal.input(sessionId, data),
  close: (sessionId) => endpoints.terminal.close(sessionId),
  stream: openTerminalStream,
}

export class PtyTerminal {
  private sessionId: string | null = null
  private stopStream: (() => void) | null = null
  private abort: AbortController | null = null
  private disposed = false

  constructor(private readonly adapter: PtyTerminalAdapter) {}

  get activeSessionId(): string | null {
    return this.sessionId
  }

  async start(onChunk: (chunk: string) => void): Promise<void> {
    if (this.sessionId) throw new Error('terminal already started')
    const { sessionId } = await this.adapter.create()
    this.sessionId = sessionId
    this.abort = new AbortController()
    try {
      this.stopStream = await this.adapter.stream(sessionId, onChunk, this.abort.signal)
    } catch (e) {
      await this.adapter.close(sessionId).catch(() => {})
      this.sessionId = null
      throw e
    }
  }

  send(data: string): void {
    if (!this.sessionId || this.disposed) return
    void this.adapter.input(this.sessionId, data).catch(() => {})
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopStream?.()
    this.stopStream = null
    this.abort?.abort()
    this.abort = null
    const id = this.sessionId
    this.sessionId = null
    if (id) await this.adapter.close(id).catch(() => {})
  }
}