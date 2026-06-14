import type { ReactNode } from 'react'

interface Tab {
  id: string
  label: string
  icon?: ReactNode
  badge?: number | string
}

interface TabsProps {
  tabs: Tab[]
  active: string
  onChange: (id: string) => void
  size?: 'sm' | 'md'
  fullWidth?: boolean
  className?: string
}

export default function Tabs({
  tabs,
  active,
  onChange,
  size = 'md',
  fullWidth = false,
  className = '',
}: TabsProps) {
  const sizeClasses = size === 'sm' ? 'h-8 text-xs' : 'h-10 text-sm'
  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className={`inline-flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-1 ${
        fullWidth ? 'w-full' : ''
      } ${className}`}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`
              press relative inline-flex flex-1 ${fullWidth ? 'flex-1' : ''} items-center justify-center gap-1.5
              rounded-lg px-3 font-medium
              ${sizeClasses}
              transition-colors duration-200
              focus:outline-none
              ${
                isActive
                  ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }
            `}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge !== undefined && tab.badge !== null && (
              <span
                className={`rounded-full px-1.5 text-2xs ${
                  isActive
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                }`}
              >
                {tab.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
