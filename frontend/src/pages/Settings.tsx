import { useState } from 'react'
import { Moon, Sun, Bell, Shield, Globe, Database, ChevronRight, Trash2 } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { useApp } from '@/state/useApp'
import { api } from '@/lib/api'

interface ToggleSetting {
  id: string
  icon: typeof Moon
  label: string
  desc: string
  storageKey: string
}

const TOGGLES: ToggleSetting[] = [
  { id: 'notifications', icon: Bell, label: '通知', desc: '启用桌面通知', storageKey: 'openclaw:notifications' },
  { id: 'safeMode', icon: Shield, label: '隐私', desc: '本地优先，数据不离开设备', storageKey: 'openclaw:safeMode' },
]

function readStored(key: string, fallback: boolean): boolean {
  if (typeof localStorage === 'undefined') return fallback
  const v = localStorage.getItem(key)
  if (v === null) return fallback
  return v === 'true'
}

function writeStored(key: string, value: boolean) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(key, String(value))
}

export default function Settings() {
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)
  const toast = useApp((s) => s.toast)
  const [values, setValues] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(TOGGLES.map((t) => [t.id, readStored(t.storageKey, true)])),
  )

  const toggle = (id: string) => {
    const t = TOGGLES.find((x) => x.id === id)!
    const next = !values[id]
    writeStored(t.storageKey, next)
    setValues({ ...values, [id]: next })
    toast(`${t.label} 已${next ? '开启' : '关闭'}`, 'info')
  }

  const clearCache = () => {
    api.clearCache()
    toast('API 缓存已清空', 'success')
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="text-text-secondary">自定义 OpenClaw 的外观与行为。</p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-text-muted">外观</h2>
        <ShimmerCard glow>
          <div className="flex items-center gap-4">
            {theme === 'dark' ? <Moon className="size-5 text-accent" /> : <Sun className="size-5 text-warning" />}
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">主题</h3>
              <p className="text-sm text-text-secondary">当前：{theme === 'dark' ? '深色' : '浅色'}</p>
            </div>
            <div className="flex gap-1 rounded-lg bg-bg-tertiary p-1">
              <button
                type="button"
                onClick={() => setTheme('dark')}
                className={`focus-ring rounded-md px-3 py-1 text-sm transition-colors ${theme === 'dark' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text'}`}
                aria-label="深色主题"
                aria-pressed={theme === 'dark'}
              >
                深色
              </button>
              <button
                type="button"
                onClick={() => setTheme('light')}
                className={`focus-ring rounded-md px-3 py-1 text-sm transition-colors ${theme === 'light' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text'}`}
                aria-label="浅色主题"
                aria-pressed={theme === 'light'}
              >
                浅色
              </button>
            </div>
          </div>
        </ShimmerCard>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-text-muted">行为</h2>
        {TOGGLES.map((t) => {
          const Icon = t.icon
          return (
            <ShimmerCard key={t.id}>
              <div className="flex items-center gap-4">
                <Icon className="size-5 text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium">{t.label}</h3>
                  <p className="text-sm text-text-secondary">{t.desc}</p>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(t.id)}
                  className={`focus-ring relative h-6 w-11 rounded-full transition-colors ${values[t.id] ? 'bg-accent' : 'bg-bg-tertiary'}`}
                  role="switch"
                  aria-checked={values[t.id]}
                  aria-label={`切换 ${t.label}`}
                >
                  <span
                    className={`absolute top-1 size-4 rounded-full bg-white transition-transform ${values[t.id] ? 'right-1' : 'left-1'}`}
                  />
                </button>
              </div>
            </ShimmerCard>
          )
        })}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-text-muted">数据</h2>
        <ShimmerCard>
          <div className="flex items-center gap-4">
            <Globe className="size-5 text-text-secondary" />
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">语言</h3>
              <p className="text-sm text-text-secondary">简体中文</p>
            </div>
            <ChevronRight className="size-5 text-text-muted" />
          </div>
        </ShimmerCard>
        <ShimmerCard>
          <div className="flex items-center gap-4">
            <Database className="size-5 text-text-secondary" />
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">数据存储</h3>
              <p className="text-sm text-text-secondary">本地 SQLite + 远程同步</p>
            </div>
            <button
              type="button"
              onClick={clearCache}
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-secondary transition hover:bg-surface-hover hover:text-text"
              aria-label="清空 API 缓存"
            >
              <Trash2 className="size-3.5" />
              清空缓存
            </button>
          </div>
        </ShimmerCard>
      </section>

      <p className="text-2xs text-text-muted">
        按 <kbd className="rounded bg-bg-tertiary px-1.5 py-0.5">?</kbd> 查看所有快捷键 ·
        <kbd className="ml-1 rounded bg-bg-tertiary px-1.5 py-0.5">Shift+T</kbd> 切换主题
      </p>
    </div>
  )
}
