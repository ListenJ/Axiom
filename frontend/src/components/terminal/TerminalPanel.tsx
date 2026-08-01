/**
 * TerminalPanel — 可开合的终端栏（沙箱命令执行）
 *
 * 通过 onExecute 注入执行器（默认走后端 /sandbox/execute），
 * 展示 stdout / stderr / 退出码；支持命令历史（↑/↓）、清空。
 * 执行中禁用输入防止重复提交。
 */
import { useRef, useState } from 'react'
import { Terminal, Trash2, X } from 'lucide-react'

export interface TerminalResult {
  success: boolean
  stdout?: string
  stderr?: string
  exitCode?: number
  error?: string
  blocked?: boolean
  reason?: string
}

interface TerminalLine {
  id: number
  cmd: string
  result: TerminalResult | null
}

interface TerminalPanelProps {
  /** 命令执行器（注入便于测试与替换后端） */
  onExecute: (command: string) => Promise<TerminalResult>
  /** 关闭回调（由 Layout 控制开合） */
  onClose?: () => void
}

let lineSeq = 0

export function TerminalPanel({ onExecute, onClose }: TerminalPanelProps) {
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const historyRef = useRef<string[]>([])
  const histIdxRef = useRef<number>(-1)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const append = (cmd: string, result: TerminalResult | null) => {
    setLines((prev) => [...prev, { id: ++lineSeq, cmd, result }])
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    })
  }

  const run = async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed || running) return
    setRunning(true)
    historyRef.current.push(trimmed)
    histIdxRef.current = -1
    try {
      const result = await onExecute(trimmed)
      append(trimmed, result)
    } catch (e) {
      append(trimmed, { success: false, error: String((e as Error)?.message ?? e) })
    } finally {
      setRunning(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = input
      setInput('')
      void run(cmd)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const hist = historyRef.current
      if (hist.length === 0) return
      histIdxRef.current = Math.min(histIdxRef.current + 1, hist.length - 1)
      setInput(hist[hist.length - 1 - histIdxRef.current] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const hist = historyRef.current
      if (histIdxRef.current <= 0) {
        histIdxRef.current = -1
        setInput('')
        return
      }
      histIdxRef.current -= 1
      setInput(hist[hist.length - 1 - histIdxRef.current] ?? '')
    }
  }

  return (
    <div
      role="region"
      aria-label="终端"
      className="flex h-56 flex-col border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-sm"
    >
      {/* 头部 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <Terminal size={14} className="text-[var(--accent)]" />
        <span className="text-xs font-medium text-[var(--text)]">终端</span>
        <span className="text-2xs text-[var(--text-muted)]">沙箱执行 · 只读模式</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLines([])}
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

      {/* 输出区 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-[var(--text-muted)]">输入命令开始执行（如 git status、ls）…</p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="mb-2">
              <div className="text-[var(--text)]">
                <span className="text-[var(--accent)]">$</span> {l.cmd}
              </div>
              {l.result && (
                <>
                  {l.result.blocked && (
                    <div className="mt-0.5 whitespace-pre-wrap text-[var(--warning)]">
                      ⚠ {l.result.reason ?? '高危操作需要确认'}
                    </div>
                  )}
                  {l.result.stdout && (
                    <div className="whitespace-pre-wrap text-[var(--text-secondary)]">{l.result.stdout}</div>
                  )}
                  {l.result.stderr && (
                    <div className="whitespace-pre-wrap text-[var(--danger)]">{l.result.stderr}</div>
                  )}
                  {l.result.error && !l.result.stderr && (
                    <div className="whitespace-pre-wrap text-[var(--danger)]">{l.result.error}</div>
                  )}
                  {typeof l.result.exitCode === 'number' && (
                    <div className="mt-0.5 text-[var(--text-muted)]">
                      exit {l.result.exitCode}
                      {l.result.success ? '' : '（失败）'}
                    </div>
                  )}
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* 输入行 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-3 py-2">
        <span className="font-mono text-sm text-[var(--accent)]">$</span>
        <input
          aria-label="终端命令"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
          placeholder={running ? '执行中…' : '输入命令，Enter 执行'}
          className="h-8 min-w-0 flex-1 bg-transparent font-mono text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  )
}
