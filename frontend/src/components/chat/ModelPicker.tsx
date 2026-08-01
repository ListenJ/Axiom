/**
 * ModelPicker — 输入框右下角模型选择器
 *
 * 设计（新约束）：
 *   - 圆环：输入框右下角一个圆环表示当前模型（首字符），hover 提示全名。
 *   - 点击圆环弹出模型列表，支持鼠标滚轮 / 触摸板滚动选择。
 *   - 弹窗内附思考强度（reasoning effort）三档：低/中/高（默认中）。
 *   - onSelect(modelId, effort?) 回调；effort 由后端按供应商格式透传。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Sparkles, Gauge } from 'lucide-react'

export interface ModelOption {
  id: string
  name: string
  provider: string
  enabled?: boolean
}

export type ReasoningEffort = 'low' | 'medium' | 'high'

const EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']
const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

interface ModelPickerProps {
  models: ModelOption[]
  selectedModel: string
  effort?: ReasoningEffort
  onSelect: (modelId: string, effort?: ReasoningEffort) => void
}

export function ModelPicker({ models, selectedModel, effort = 'medium', onSelect }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement | null>(null)

  const current = models.find((m) => m.id === selectedModel)
  const label = current?.name ?? selectedModel ?? '?'
  const initial = (current?.name ?? selectedModel ?? '?').slice(0, 1).toUpperCase()

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="relative shrink-0" ref={popRef}>
      {/* 圆环：当前模型首字符，hover 提示全名 */}
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`模型选择：${label}`}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-sm font-semibold text-[var(--accent)] transition-all duration-150 hover:border-[var(--accent)] hover:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
      >
        {initial}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="模型列表"
          className="absolute bottom-full right-0 z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
        >
          {/* 思考强度 */}
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <Gauge size={14} className="shrink-0 text-[var(--text-muted)]" />
            <span className="text-2xs text-[var(--text-muted)]">思考强度</span>
            <div className="ml-auto flex gap-1" role="radiogroup" aria-label="思考强度">
              {EFFORTS.map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={effort === e}
                  aria-label={EFFORT_LABELS[e]}
                  onClick={() => onSelect(selectedModel, e)}
                  className={`h-6 rounded-full px-2.5 text-2xs font-medium transition-colors ${
                    effort === e
                      ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text)]'
                  }`}
                >
                  {EFFORT_LABELS[e]}
                </button>
              ))}
            </div>
          </div>

          {/* 模型列表：滚轮 / 触摸板滚动 */}
          <div className="max-h-56 overflow-y-auto p-1.5">
            {models.length === 0 ? (
              <p className="p-3 text-center text-2xs text-[var(--text-muted)]">暂无可用模型</p>
            ) : (
              models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={m.id === selectedModel}
                  onClick={() => {
                    onSelect(m.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    m.id === selectedModel
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                  }`}
                >
                  <Sparkles size={14} className="shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-0" />
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
