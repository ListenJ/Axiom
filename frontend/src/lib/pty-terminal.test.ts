import { describe, expect, it, vi } from 'vitest'
import { PtyTerminal, openTerminalStream, type PtyTerminalAdapter } from './pty-terminal'

function fakeAdapter(): PtyTerminalAdapter {
  return {
    create: vi.fn().mockResolvedValue({ sessionId: 's1' }),
    input: vi.fn().mockResolvedValue({ ok: true }),
    close: vi.fn().mockResolvedValue({ ok: true }),
    stream: vi.fn().mockResolvedValue(vi.fn()),
  }
}

describe('PtyTerminal', () => {
  it('start 创建会话并打开输出流', async () => {
    const adapter = fakeAdapter()
    const client = new PtyTerminal(adapter)
    const onChunk = vi.fn()
    await client.start(onChunk)
    expect(adapter.create).toHaveBeenCalledTimes(1)
    expect(adapter.stream).toHaveBeenCalledWith('s1', onChunk, expect.any(AbortSignal))
    expect(client.activeSessionId).toBe('s1')
  })

  it('send 将输入写到当前会话', async () => {
    const adapter = fakeAdapter()
    const client = new PtyTerminal(adapter)
    await client.start(() => {})
    client.send('ls\r')
    await vi.waitFor(() => expect(adapter.input).toHaveBeenCalledWith('s1', 'ls\r'))
  })

  it('dispose 停止流并关闭会话（幂等）', async () => {
    const adapter = fakeAdapter()
    const stop = vi.fn()
    adapter.stream = vi.fn().mockResolvedValue(stop)
    const client = new PtyTerminal(adapter)
    await client.start(() => {})
    await client.dispose()
    await client.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(adapter.close).toHaveBeenCalledTimes(1)
    expect(adapter.close).toHaveBeenCalledWith('s1')
  })

  it('start 流失败时关闭会话并抛出', async () => {
    const adapter = fakeAdapter()
    adapter.stream = vi.fn().mockRejectedValue(new Error('stream down'))
    const client = new PtyTerminal(adapter)
    await expect(client.start(() => {})).rejects.toThrow('stream down')
    expect(adapter.close).toHaveBeenCalledWith('s1')
  })
})

describe('openTerminalStream', () => {
  it('解析 SSE data 块并回调 chunk', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: "hello"\n\ndata: " world"\n\n'))
        controller.close()
      },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    try {
      const onChunk = vi.fn()
      await openTerminalStream('s1', onChunk, new AbortController().signal)
      await vi.waitFor(() => expect(onChunk).toHaveBeenCalledTimes(2))
      expect(onChunk).toHaveBeenNthCalledWith(1, 'hello')
      expect(onChunk).toHaveBeenNthCalledWith(2, ' world')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})