import { useState } from 'react'
import { Moon, Sun, Bell, Shield, Globe, Database, Trash2 } from 'lucide-react'
import { ShimmerCard, PageHeader, Button } from '@/components/ui'
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
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<SettingsIcon theme={theme} />}
        title="设置"
        description="自定义 OpenClaw 的外观与行为。"
      />

      {/* Appearance Section */}
      <section className="space-y-3">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          外观
        </h2>
        <ShimmerCard variant="accent" padding="md">
          <div className="flex items-center gap-4">
            <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
              {theme === 'dark' ? (
                <Moon className="size-5" />
              ) : (
                <Sun className="size-5 text-[var(--warning)]" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-[var(--text)]">主题</h3>
              <p className="text-xs text-[var(--text-secondary)]">
                当前：{theme === 'dark' ? '深色' : '浅色'}
              </p>
            </div>
            <div
              role="radiogroup"
              aria-label="主题切换"
              className="flex gap-1 rounded-lg bg-[var(--bg-tertiary)] p-1"
            >
              {(['dark', 'light'] as const).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={theme === t ? 'primary' : 'ghost'}
                  onClick={() => setTheme(t)}
                  role="radio"
                  aria-checked={theme === t}
                  aria-label={t === 'dark' ? '深色主题' : '浅色主题'}
                >
                  {t === 'dark' ? '深色' : '浅色'}
                </Button>
              ))}
            </div>
          </div>
        </ShimmerCard>
      </section>

      {/* Behavior Section */}
      <section className="space-y-3">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          行为
        </h2>
        <div className="stagger space-y-3">
          {TOGGLES.map((t) => {
            const Icon = t.icon
            const isOn = values[t.id]
            return (
              <ShimmerCard key={t.id} padding="md">
                <div className="flex items-center gap-4">
                  <div
                    className={`flex size-10 items-center justify-center rounded-xl transition-colors ${
                      isOn
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                    }`}
                  >
                    <Icon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-[var(--text)]">{t.label}</h3>
                    <p className="text-xs text-[var(--text-secondary)]">{t.desc}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(t.id)}
                    className={`press relative h-6 w-11 rounded-full transition-colors ${
                      isOn ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]'
                    }`}
                    role="switch"
                    aria-checked={isOn}
                    aria-label={`切换 ${t.label}`}
                  >
                    <span
                      className={`absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                        isOn ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
              </ShimmerCard>
            )
          })}
        </div>
      </section>

      {/* Data Section */}
      <section className="space-y-3">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          数据
        </h2>
        <div className="stagger space-y-3">
          <ShimmerCard padding="md">
            <div className="flex items-center gap-4">
              <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--info-soft)] text-[var(--info)]">
                <Globe className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium text-[var(--text)]">语言</h3>
                <p className="text-xs text-[var(--text-secondary)]">简体中文</p>
              </div>
            </div>
          </ShimmerCard>
          <ShimmerCard padding="md">
            <div className="flex items-center gap-4">
              <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                <Database className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium text-[var(--text)]">数据存储</h3>
                <p className="text-xs text-[var(--text-secondary)]">本地存储 + 远程同步</p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={clearCache}
                aria-label="清空 API 缓存"
                icon={<Trash2 className="size-3.5" />}
              >
                清空缓存
              </Button>
            </div>
          </ShimmerCard>
        </div>
      </section>
    </div>
  )
}

function SettingsIcon({ theme }: { theme: string }) {
  return theme === 'dark' ? (
    <Moon className="size-5" />
  ) : (
    <Sun className="size-5" />
  )
}
