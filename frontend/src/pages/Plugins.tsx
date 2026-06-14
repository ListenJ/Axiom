import { useEffect, useState } from 'react'
import {
  Puzzle,
  Download,
  Trash2,
  Power,
  PowerOff,
  Settings,
  RefreshCw,
  Check,
} from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { endpoints } from '@/lib/api'

interface Plugin {
  id: string
  name: string
  description: string
  version: string
  author: string
  enabled: boolean
  installed: boolean
  config?: Record<string, unknown>
  tools?: string[]
}

interface AvailablePlugin {
  id: string
  name: string
  description: string
  version: string
  author: string
}

interface ActiveTool {
  name: string
  pluginId: string
  description: string
}

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

  useEffect(() => {
    Promise.allSettled([
      endpoints.plugins.list().then((d) => d as Plugin[]).catch(() => []),
      endpoints.plugins.available().then((d) => d as AvailablePlugin[]).catch(() => []),
      endpoints.plugins.activeTools().then((d) => d as ActiveTool[]).catch(() => []),
    ]).then(([i, a, t]) => {
      setInstalled(i.status === 'fulfilled' ? (i.value as Plugin[]) : [])
      setAvailable(a.status === 'fulfilled' ? (a.value as AvailablePlugin[]) : [])
      setActiveTools(t.status === 'fulfilled' ? (t.value as ActiveTool[]) : [])
      const failed = [i, a, t].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
      if (failed) setError(String(failed.reason?.message ?? failed.reason))
      setLoading(false)
    })
  }, [])

  const handleInstall = async (pluginId: string) => {
    setInstalling(pluginId)
    try {
      await endpoints.plugins.install(pluginId, true)
      // Refresh lists
      const [i, a] = await Promise.allSettled([
        endpoints.plugins.list(),
        endpoints.plugins.available(),
      ])
      if (i.status === 'fulfilled') setInstalled(i.value as Plugin[])
      if (a.status === 'fulfilled') setAvailable(a.value as AvailablePlugin[])
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
      // Refresh available
      const a = await endpoints.plugins.available()
      setAvailable(a as AvailablePlugin[])
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
      // Refresh active tools
      const t = await endpoints.plugins.activeTools()
      setActiveTools(t as ActiveTool[])
    } catch (e) {
      setError(String(e))
    }
  }

  const handleConfig = async (pluginId: string) => {
    try {
      await endpoints.plugins.config(pluginId, configValues)
      setConfiguring(null)
      setConfigValues({})
      // Refresh
      const i = await endpoints.plugins.list()
      setInstalled(i as Plugin[])
    } catch (e) {
      setError(String(e))
    }
  }

  const tabs = [
    { id: 'installed' as const, label: '已安装', icon: Puzzle, count: installed.length },
    { id: 'available' as const, label: '可用插件', icon: Download, count: available.length },
    { id: 'tools' as const, label: '活跃工具', icon: Settings, count: activeTools.length },
  ]

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Puzzle className="size-6 text-accent" />
          插件市场
        </h1>
        <p className="text-text-secondary">管理已安装插件、浏览可用插件、查看活跃工具。</p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-warning">
          操作失败：{error}
        </p>
      )}

      {/* 标签页 */}
      <div className="flex gap-1 rounded-lg border border-border p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-bg-secondary'
            }`}
          >
            <tab.icon className="size-3.5" />
            {tab.label}
            <span className="ml-1 rounded-full bg-bg-tertiary px-1.5 text-xs text-text-muted">
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* 已安装插件 */}
      {activeTab === 'installed' && (
        <ShimmerCard>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-20 w-full animate-pulse rounded bg-bg-tertiary" />
              ))}
            </div>
          ) : installed.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-muted">
              <Puzzle className="mb-3 size-12 opacity-30" />
              <p>暂无已安装插件</p>
              <p className="text-sm">前往"可用插件"标签页安装</p>
            </div>
          ) : (
            <div className="space-y-3">
              {installed.map((plugin) => (
                <div
                  key={plugin.id}
                  className="rounded-xl border border-border p-4 hover:bg-bg-secondary/50"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{plugin.name}</h3>
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
                          v{plugin.version}
                        </span>
                        {plugin.enabled && (
                          <span className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs text-green-500">
                            <Check className="size-3" />
                            已启用
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-text-muted">{plugin.description}</p>
                      {plugin.tools && plugin.tools.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {plugin.tools.map((tool) => (
                            <span
                              key={tool}
                              className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent"
                            >
                              {tool}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleToggle(plugin.id, !plugin.enabled)}
                        className={`rounded-lg p-2 transition-colors ${
                          plugin.enabled
                            ? 'text-green-500 hover:bg-green-500/10'
                            : 'text-text-muted hover:bg-bg-secondary'
                        }`}
                        title={plugin.enabled ? '禁用' : '启用'}
                      >
                        {plugin.enabled ? <Power className="size-4" /> : <PowerOff className="size-4" />}
                      </button>
                      <button
                        onClick={() => setConfiguring(plugin.id)}
                        className="rounded-lg p-2 text-text-muted hover:bg-bg-secondary"
                        title="配置"
                      >
                        <Settings className="size-4" />
                      </button>
                      <button
                        onClick={() => handleUninstall(plugin.id)}
                        className="rounded-lg p-2 text-text-muted hover:bg-red-500/10 hover:text-red-500"
                        title="卸载"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>

                  {/* 配置面板 */}
                  {configuring === plugin.id && (
                    <div className="mt-4 rounded-lg border border-border bg-bg p-3">
                      <h4 className="mb-2 text-sm font-medium">插件配置</h4>
                      {plugin.config && Object.keys(plugin.config).length > 0 ? (
                        <div className="space-y-2">
                          {Object.entries(plugin.config).map(([key, value]) => (
                            <div key={key} className="flex items-center gap-2">
                              <label className="w-32 text-xs text-text-muted">{key}</label>
                              <input
                                type="text"
                                defaultValue={String(value)}
                                onChange={(e) =>
                                  setConfigValues((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                className="flex-1 rounded border border-border bg-bg-secondary px-2 py-1 text-sm text-text focus:outline-none focus:ring-2 focus:ring-accent"
                              />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-text-muted">此插件无可配置项</p>
                      )}
                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={() => handleConfig(plugin.id)}
                          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
                        >
                          保存
                        </button>
                        <button
                          onClick={() => {
                            setConfiguring(null)
                            setConfigValues({})
                          }}
                          className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-secondary"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>
      )}

      {/* 可用插件 */}
      {activeTab === 'available' && (
        <ShimmerCard>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-16 w-full animate-pulse rounded bg-bg-tertiary" />
              ))}
            </div>
          ) : available.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-muted">
              <Download className="mb-3 size-12 opacity-30" />
              <p>暂无可用插件</p>
            </div>
          ) : (
            <div className="space-y-3">
              {available.map((plugin) => (
                <div
                  key={plugin.id}
                  className="flex items-center justify-between rounded-xl border border-border p-4 hover:bg-bg-secondary/50"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{plugin.name}</h3>
                      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
                        v{plugin.version}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-text-muted">{plugin.description}</p>
                    <p className="mt-1 text-xs text-text-muted">作者: {plugin.author}</p>
                  </div>
                  <button
                    onClick={() => handleInstall(plugin.id)}
                    disabled={installing === plugin.id}
                    className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {installing === plugin.id ? (
                      <RefreshCw className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    安装
                  </button>
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>
      )}

      {/* 活跃工具 */}
      {activeTab === 'tools' && (
        <ShimmerCard>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 w-full animate-pulse rounded bg-bg-tertiary" />
              ))}
            </div>
          ) : activeTools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-muted">
              <Settings className="mb-3 size-12 opacity-30" />
              <p>暂无活跃工具</p>
              <p className="text-sm">安装并启用插件后，工具将在此显示</p>
            </div>
          ) : (
            <div className="space-y-2">
              {activeTools.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-center justify-between rounded-xl border border-border p-3 hover:bg-bg-secondary/50"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-accent/10">
                      <Puzzle className="size-4 text-accent" />
                    </div>
                    <div>
                      <p className="font-medium">{tool.name}</p>
                      <p className="text-xs text-text-muted">{tool.description}</p>
                    </div>
                  </div>
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
                    {tool.pluginId}
                  </span>
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>
      )}
    </div>
  )
}
