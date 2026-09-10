interface BarChartProps {
  data: Array<{ label: string; value: number }>
  maxValue?: number
  color?: 'accent' | 'success' | 'warning' | 'danger'
  className?: string
  height?: number
  showLabels?: boolean
}

const COLOR_CLASSES = {
  accent: 'bg-[var(--accent)]',
  success: 'bg-[var(--success)]',
  warning: 'bg-[var(--warning)]',
  danger: 'bg-[var(--danger)]',
} as const

export default function BarChart({
  data,
  maxValue,
  color = 'accent',
  className = '',
  height = 120,
  showLabels = true,
}: BarChartProps) {
  if (data.length === 0) {
    return (
      <div
        style={{ height }}
        className={`flex items-center justify-center text-sm text-[var(--text-muted)] ${className}`}
      >
        暂无数据
      </div>
    )
  }

  const max = maxValue ?? Math.max(...data.map((d) => d.value), 1)

  return (
    <div
      role="img"
      aria-label={`柱状图，共 ${data.length} 项`}
      style={{ height }}
      className={`flex items-end gap-1 ${className}`}
    >
      {data.map((d, i) => {
        const pct = max > 0 ? (d.value / max) * 100 : 0
        return (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <div className="relative w-full" style={{ height: '100%' }}>
              <div
                className={`absolute bottom-0 left-0 right-0 rounded-t-sm ${COLOR_CLASSES[color]} transition-opacity duration-500 ease-out hover:opacity-80`}
                style={{ height: `${Math.max(pct, 2)}%` }}
                title={`${d.label}: ${d.value}`}
              />
            </div>
            {showLabels && (
              <span className="line-clamp-1 w-full text-center text-2xs text-[var(--text-muted)]">
                {d.label}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
