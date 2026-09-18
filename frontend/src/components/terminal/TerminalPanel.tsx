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
import { buildTerminalTheme, cssVarReader } from './xterm-theme'
import { useApp } from '@/state/useApp'

interface TerminalPanelProps {
  /** 关闭回调（由 Layout 控制开合） */
  onClose?: () => void
  /** 会话适配器（默认走 /terminal/* REST + SSE；测试注入 fake） */
  adapter?: PtyTerminalAdapter
}

type ConnState = 'connecting' | 'connected' | 'error'

const TERMINAL_HEIGHT_KEY = 'axiom:terminal-height'
const DEFAULT_HEIGHT = 224
const MIN_HEIGHT = 128
const MAX_HEIGHT_RATIO = 0.6

function maxTerminalHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_HEIGHT
  return Math.max(MIN_HEIGHT, Math.round(window.innerHeight * MAX_HEIGHT_RATIO))
}

function readInitialHeight(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_HEIGHT
  const v = Number(localStorage.getItem(TERMINAL_HEIGHT_KEY))
  if (Number.isFinite(v) && v >= MIN_HEIGHT) return Math.min(v, maxTerminalHeight())
  return DEFAULT_HEIGHT
}

export function TerminalPanel({ onClose, adapter = defaultPtyTerminalAdapter }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [height, setHeight] = useState(readInitialHeight)
  // 跟随全局主题（dark/light）与强调色（accent）：变化时重建 xterm 配色
  const theme = useApp((s) => s.theme)
  const accent = useApp((s) => s.accent)

  // 拖拽调整高度：手柄在面板顶部，向上拖拽增高，向下拖拽降低
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const heightRef = useRef(height)
  heightRef.current = height

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: e.clientY, startHeight: heightRef.current }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  useEffect(() => {
    if (!dragRef.current) return
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const maxHeight = Math.max(MIN_HEIGHT, Math.round(window.innerHeight * MAX_HEIGHT_RATIO))
      const next = Math.min(maxHeight, Math.max(MIN_HEIGHT, drag.startHeight - (e.clientY - drag.startY)))
      setHeight(next)
    }
    const onUp = () => {
      dragRef.current = null
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(TERMINAL_HEIGHT_KEY, String(heightRef.current))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  // 窗口尺寸变化时同步钳制已恢复/已拖拽的高度，避免小视口下终端占比过大
  useEffect(() => {
    const clamp = () => {
      setHeight((current) => Math.min(maxTerminalHeight(), Math.max(MIN_HEIGHT, current)))
    }
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  // 从 CSS 变量读取当前主题令牌并应用到 xterm
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = buildTerminalTheme(cssVarReader())
  }, [theme, accent])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: 'JetBrains Mono, Consolas, monospace',
      theme: buildTerminalTheme(cssVarReader()),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    term.focus?.()
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
        if (!disposed) {
          setState('connected')
          term.focus?.()
        }
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
      style={{ height }}
      className="glass flex flex-col border-t border-[var(--border)] backdrop-blur-md"
    >
      {/* 高度拖拽手柄 */}
      <div
        className="group/term cursor-ns-resize select-none touch-none"
        onPointerDown={onPointerDown}
        aria-label="调整终端高度"
        role="separator"
        aria-orientation="horizontal"
      >
        <div className="h-1.5 w-full transition-colors group-hover/term:bg-[var(--accent)]/40 group-active/term:bg-[var(--accent)]" />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)]/60 px-3">
        <TerminalIcon size={14} className="text-[var(--accent)]" />
        <span className="text-xs font-medium text-[var(--text)]">终端</span>
        <span className="text-2xs text-[var(--text-muted)]">{statusLabel}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => termRef.current?.clear()}
            aria-label="清空终端"
            className="press flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Trash2 size={14} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭终端"
              className="press flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
