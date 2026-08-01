/**
 * TerminalPanel — 交互式终端栏（xterm.js + 常驻 PTY 会话）
 *
 * 挂载时创建后端 /terminal/session，SSE 推送输出到 xterm；
 * onData 经 /terminal/session/:id/input 写回 stdin。
 * 卸载/关闭时停止流并关闭会话，避免 shell 子进程残留。
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Terminal as TerminalIcon, Trash2, X } from 'lucide-react'
import { defaultPtyTerminalAdapter, PtyTerminal, type PtyTerminalAdapter } from '@/lib/pty-terminal'

interface TerminalPanelProps {
  /** 关闭回调（由 Layout 控制开合） */
  onClose?: () => void
  /** 会话适配器（默认走 /terminal/* REST + SSE；测试注入 fake） */
  adapter?: PtyTerminalAdapter
}

type ConnState = 'connecting' | 'connected' | 'error'

export function TerminalPanel({ onClose, adapter = defaultPtyTerminalAdapter }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const [state, setState] = useState<ConnState>('connecting')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: 'JetBrains Mono, Consolas, monospace',
      theme: {
        background: 'transparent',
        foreground: '#d4d4d8',
        cursor: '#22d3ee',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    termRef.current = term

    const client = new PtyTerminal(adapter)
    const onData = term.onData((data) => client.send(data))
    let disposed = false

    const onChunk = (chunk: string) => {
      if (!disposed) term.write(chunk)
    }

    client
      .start(onChunk)
      .then(() => {
        if (!disposed) setState('connected')
      })
      .catch((e) => {
        if (disposed) return
        setState('error')
        term.write(`\r\n[terminal] 启动失败: ${String((e as Error)?.message ?? e)}\r\n`)
      })

    const onResize = () => {
      try {
        fit.fit()
      } catch {
        /* 容器尚未布局 */
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      onData.dispose()
      void client.dispose()
      fit.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [adapter])

  const statusLabel =
    state === 'connecting' ? '正在连接…' : state === 'error' ? '连接失败' : '交互终端 · 常驻会话'

  return (
    <div
      role="region"
      aria-label="终端"
      className="flex h-56 flex-col border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-sm"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <TerminalIcon size={14} className="text-[var(--accent)]" />
        <span className="text-xs font-medium text-[var(--text)]">终端</span>
        <span className="text-2xs text-[var(--text-muted)]">{statusLabel}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => termRef.current?.clear()}
            aria-label="清空终端"
            className="press flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none"
          >
            <Trash2 size={14} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭终端"
              className="press flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  )
}