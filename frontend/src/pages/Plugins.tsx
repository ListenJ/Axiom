import { useEffect, useState } from 'react'
import {
  Puzzle,
  Download,
  Trash2,
  Power,
  PowerOff,
  Settings,
  Check,
} from 'lucide-react'
import {
  ShimmerCard,
  Button,
  PageHeader,
  Tabs,
  Input,
  Skeleton,
  InlineEmptyState,
} from '@/components/ui'
import { endpoints } from '@/lib/api'
import {
  normalizeInstalled,
  normalizeAvailable,
  normalizeTools,
  type Plugin,
  type AvailablePlugin,
  type ActiveTool,
} from '@/lib/normalize'

export default function Plugins() {
  const [installed, setInstalled] = useState<Plugin[]>([])
  const [available, setAvailable] = useState<AvailablePlugin[]>([])
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'installed' | 'available' | 'tools'>('installed')
  const [installing, setInstalling] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, string>>({})

  const tabs = [
    { id: 'installed' as const, label: '已安装', icon: <Puzzle className="size-3.5" />, badge: installed.length },
    { id: 'available' as const, label: '可用插件', icon: <Download className="size-3.5" />, badge: available.length },
    { id: 'tools' as const, label: '活跃工具', icon: <Settings className="size-3.5" />, badge: activeTools.length },
  ]

  useEffect(() => {
    Promise.allSettled([
      endpoints.plugins.list().then(normalizeInstalled).catch(() => []),
      endpoints.plugins.available().then(normalizeAvailable).catch(() => []),
      endpoints.plugins.activeTools().then(normalizeTools).catch(() => []),
    ]).then(([i, a, t]) => {
      setInstalled(i.status === 'fulfilled' ? i.value : [])
      setAvailable(a.status === 'fulfilled' ? a.value : [])
      setActiveTools(t.status === 'fulfilled' ? t.value : [])
      const failed = [i, a, t].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
      if (failed) setError(String(failed.reason?.message ?? failed.reason))
      setLoading(false)
    })
  }, [])

  const handleInstall = async (pluginId: string) => {
    setInstalling(pluginId)
    try {
      await endpoints.plugins.install(pluginId, true)
      const [i, a] = await Promise.allSettled([
        endpoints.plugins.list(),
        endpoints.plugins.available(),
      ])
      if (i.status === 'fulfilled') setInstalled(normalizeInstalled(i.value))
      if (a.status === 'fulfilled') setAvailable(normalizeAvailable(a.value))
    } catch (e) {
      setError(String(e))
    } finally {
      setInstalling(null)
    }
  }

  const handleUninstall = async (pluginId: string) => {
    try {
      await endpoints.plugins.uninstall(pluginId)
      setInstalled((prev) => prev.filter((p) => p.id !== pluginId))
      const a = await endpoints.plugins.available()
      setAvailable(normalizeAvailable(a))
    } catch (e) {
      setError(String(e))
    }
  }

  const handleToggle = async (pluginId: string, enabled: boolean) => {
    try {
      if (enabled) {
        await endpoints.plugins.enable(pluginId)
      } else {
        await endpoints.plugins.disable(pluginId)
      }
      setInstalled((prev) =>
        prev.map((p) => (p.id === pluginId ? { ...p, enabled } : p))
      )
      const t = await endpoints.plugins.activeTools()
      setActiveTools(normalizeTools(t))
    } catch (e) {
      setError(String(e))
    }
  }

  const handleConfig = async (pluginId: string) => {
    try {
      await endpoints.plugins.config(pluginId, configValues)
      setConfiguring(null)
      setConfigValues({})
      const i = await endpoints.plugins.list()
      setInstalled(normalizeInstalled(i))
    } catch (e) {
      setError(String(e))
    }
  }

  const errorBanner = error && (
    <p
      role="alert"
      className="flex items-center gap-2 rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]"
    >
      操作失败：{error}
    </p>
  )

  const renderInstalled = () => {
    if (loading) {
      return (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      )
    }
    if (installed.length === 0) {
      return (
        <InlineEmptyState
          icon={<Puzzle className="size-5" />}
          title="暂无已安装插件"
        />
      )
    }
    return (
      <div className="stagger space-y-3">
        {installed.map((plugin) => (
          <div
            key={plugin.id}
            className="rounded-xl border border-[var(--border)] p-4 transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium text-[var(--text)]">{plugin.name}</h3>
                  {plugin.enabled && (
                    <span className="flex items-center gap-1 rounded-full border border-[var(--success-soft)] bg-[var(--success-soft)] px-2 py-0.5 text-xs text-[var(--success)]">
                      <Check className="size-3" />
                      已启用
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-[var(--text-muted)]">{plugin.description}</p>
                {plugin.tools && plugin.tools.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {plugin.tools.map((tool) => (
                      <span
                        key={tool}
                        className="rounded border border-[var(--border)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-xs text-[var(--accent)]"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => handleToggle(plugin.id, !plugin.enabled)}
                  title={plugin.enabled ? '禁用' : '启用'}
                  className={plugin.enabled ? 'text-[var(--success)]' : ''}
                >
                  {plugin.enabled ? (
                    <Power className="size-4" />
                  ) : (
                    <PowerOff className="size-4" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setConfiguring(plugin.id)}
                  title="配置"
                >
                  <Settings className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => handleUninstall(plugin.id)}
                  title="卸载"
                  className="text-[var(--danger)] hover:bg-[var(--danger-soft)]"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>

            {configuring === plugin.id && (
              <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
                <h4 className="mb-2 text-sm font-medium text-[var(--text)]">插件配置</h4>
                {plugin.config && Object.keys(plugin.config).length > 0 ? (
                  <div className="space-y-2">
                    {Object.entries(plugin.config).map(([key, value]) => (
                      <Input
                        key={key}
                        label={key}
                        defaultValue={String(value)}
                        onChange={(e) =>
                          setConfigValues((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-muted)]">此插件无可配置项</p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => handleConfig(plugin.id)}>保存</Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setConfiguring(null)
                      setConfigValues({})
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    )
  }

  const renderAvailable = () => {
    if (loading) {
      return (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      )
    }
    if (available.length === 0) {
      return (
        <InlineEmptyState
          icon={<Download className="size-5" />}
          title="暂无可用插件"
        />
      )
    }
    return (
      <div className="stagger space-y-3">
        {available.map((plugin) => (
          <div
            key={plugin.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-4 transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-[var(--text)]">{plugin.name}</h3>
              </div>
              <p className="mt-1 text-xs text-[var(--text-muted)]">{plugin.description}</p>
              <p className="mt-1 text-2xs text-[var(--text-muted)]">{plugin.author}</p>
            </div>
            <Button
              size="sm"
              onClick={() => handleInstall(plugin.id)}
              loading={installing === plugin.id}
              icon={<Download className="size-3.5" />}
            >
              安装
            </Button>
          </div>
        ))}
      </div>
    )
  }

  const renderTools = () => {
    if (loading) {
      return (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      )
    }
    if (activeTools.length === 0) {
      return (
        <InlineEmptyState
          icon={<Settings className="size-5" />}
          title="暂无活跃工具"
        />
      )
    }
    return (
      <div className="stagger space-y-2">
        {activeTools.map((tool) => (
          <div
            key={tool.name}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3 transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
                <Puzzle className="size-4 text-[var(--accent)]" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--text)]">{tool.name}</p>
                <p className="truncate text-xs text-[var(--text-muted)]">{tool.description}</p>
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
              {tool.pluginId}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Puzzle className="size-5" />}
        title="插件市场"
        description="管理已安装插件、浏览可用插件、查看活跃工具。"
      />

      {errorBanner}

      <Tabs
        tabs={tabs}
        active={activeTab}
        onChange={(id) => setActiveTab(id as typeof activeTab)}
      />

      <ShimmerCard>
        {activeTab === 'installed' && renderInstalled()}
        {activeTab === 'available' && renderAvailable()}
        {activeTab === 'tools' && renderTools()}
      </ShimmerCard>
    </div>
  )
}
