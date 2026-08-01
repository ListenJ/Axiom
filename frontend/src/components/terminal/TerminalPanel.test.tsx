/**
 * TerminalPanel 终端栏组件测试（xterm mock）
 *
 * 行为：挂载即创建 PTY 会话并打开输出流；输出块写入 xterm；
 * 键入命令发送 stdin；卸载关闭会话并清理 xterm；清空按钮；创建失败显示错误。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TerminalPanel } from './TerminalPanel'
import type { PtyTerminalAdapter } from '@/lib/pty-terminal'

const h = vi.hoisted(() => ({
  onDataHandlers: [] as Array<(data: string) => void>,
  open: vi.fn(),
  loadAddon: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
  fit: vi.fn(),
  fitDispose: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function () {
    return {
      open: h.open,
      loadAddon: h.loadAddon,
      write: h.write,
      clear: h.clear,
      dispose: h.dispose,
      onData: vi.fn((cb: (data: string) => void) => {
        h.onDataHandlers.push(cb)
        return { dispose: vi.fn() }
      }),
    }
  }),
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function () {
    return { fit: h.fit, dispose: h.fitDispose }
  }),
}))

function fakeAdapter(): PtyTerminalAdapter {
  return {
    create: vi.fn().mockResolvedValue({ sessionId: 's1' }),
    input: vi.fn().mockResolvedValue({ ok: true }),
    close: vi.fn().mockResolvedValue({ ok: true }),
    stream: vi.fn().mockResolvedValue(() => {}),
  }
}

beforeEach(() => {
  h.onDataHandlers.length = 0
  h.open.mockClear()
  h.loadAddon.mockClear()
  h.write.mockClear()
  h.clear.mockClear()
  h.dispose.mockClear()
  h.fit.mockClear()
  h.fitDispose.mockClear()
})

describe('TerminalPanel', () => {
  it('挂载后创建会话并打开输出流', async () => {
    const adapter = fakeAdapter()
    render(<TerminalPanel adapter={adapter} />)
    await waitFor(() => expect(adapter.create).toHaveBeenCalledTimes(1))
    expect(adapter.stream).toHaveBeenCalledWith('s1', expect.any(Function), expect.any(AbortSignal))
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(h.fit).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByText('交互终端 · 常驻会话')).toBeVisible())
  })

  it('SSE 输出块写入 xterm', async () => {
    const adapter = fakeAdapter()
    let onChunk: ((chunk: string) => void) | undefined
    adapter.stream = vi.fn().mockImplementation((_id, cb) => {
      onChunk = cb
      return Promise.resolve(() => {})
    })
    render(<TerminalPanel adapter={adapter} />)
    await waitFor(() => expect(onChunk).toBeDefined())
    onChunk!('hello\r\n')
    expect(h.write).toHaveBeenCalledWith('hello\r\n')
  })

  it('键入命令发送到会话 stdin', async () => {
    const adapter = fakeAdapter()
    render(<TerminalPanel adapter={adapter} />)
    await waitFor(() => expect(h.onDataHandlers.length).toBeGreaterThan(0))
    h.onDataHandlers[0]!('ls\r')
    await waitFor(() => expect(adapter.input).toHaveBeenCalledWith('s1', 'ls\r'))
  })

  it('卸载时关闭会话并清理 xterm', async () => {
    const adapter = fakeAdapter()
    const { unmount } = render(<TerminalPanel adapter={adapter} />)
    await waitFor(() => expect(adapter.create).toHaveBeenCalledTimes(1))
    unmount()
    await waitFor(() => expect(adapter.close).toHaveBeenCalledWith('s1'))
    expect(h.dispose).toHaveBeenCalledTimes(1)
    expect(h.fitDispose).toHaveBeenCalledTimes(1)
  })

  it('清空按钮调用 xterm clear', async () => {
    const adapter = fakeAdapter()
    render(<TerminalPanel adapter={adapter} />)
    await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '清空终端' }))
    expect(h.clear).toHaveBeenCalledTimes(1)
  })

  it('创建失败时显示错误状态并写入提示', async () => {
    const adapter = fakeAdapter()
    adapter.create = vi.fn().mockRejectedValue(new Error('session limit'))
    render(<TerminalPanel adapter={adapter} />)
    await waitFor(() => expect(screen.getByText('连接失败')).toBeVisible())
    expect(h.write).toHaveBeenCalledWith(expect.stringContaining('session limit'))
  })
})