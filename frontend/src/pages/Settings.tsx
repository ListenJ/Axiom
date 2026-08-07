import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Moon, Sun, Bell, Shield, Globe, Database, Bot, Brain, FileEdit,
  Wrench, KeyRound, CheckCircle2, Palette, Monitor, TerminalSquare,
} from 'lucide-react'
import { ShimmerCard, PageHeader, Button, Collapsible, Skeleton } from '@/components/ui'
import { useApp, resolveTheme } from '@/state/useApp'
import { ACCENT_PRESETS, SHELL_TONES, CANVAS_TONES, type AccentId, type ShellToneId, type CanvasToneId } from '@/lib/accents'
import { useChatPrefs, type ChatPrefs } from '@/state/useChatPrefs'
import { api, endpoints } from '@/lib/api'
import SettingsSearch from '@/components/settings/SettingsSearch'
import ModelManagementSection from '@/components/settings/models-section'
import MotionPreview from '@/components/settings/MotionPreview'
import DiagnosticsSection from '@/components/settings/DiagnosticsSection'
import DebugPanelsSection from '@/components/settings/DebugPanelsSection'
import { SETTINGS_CATALOG, SETTING_SECTIONS } from '@/components/settings/settings-data'

/* ───────── 搜索引擎可用状态（抓取分区） ───────── */

function EngineStatusList() {
  const [engines, setEngines] = useState<Array<{ name: string; available: boolean }> | null>(null)
  useEffect(() => {
    endpoints.system
      .engines()
      .then((d) => setEngines(d?.engines ?? null))
      .catch(() => setEngines(null))
  }, [])
  if (!engines) {
    return <p className="text-xs text-[var(--text-muted)]">加载中…</p>
  }
  return (
    <ul className="space-y-1">
      {engines.map((e) => (
        <li key={e.name} className="flex items-center justify-between text-xs">
          <span className="font-mono text-[var(--text-secondary)]">{e.name}</span>
          <span className={`flex items-center gap-1 ${e.available ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
            <CheckCircle2 className="size-3" />
            {e.available ? '可用' : '未配置'}
          </span>
        </li>
      ))}
    </ul>
  )
}

/* ───────── 强调色选择器（外观分区） ───────── */

function themeLabel(t: 'system' | 'dark' | 'light'): string {
  return t === 'system' ? '系统' : t === 'dark' ? '深色' : '浅色'
}

function AccentPicker({ highlight }: { highlight: boolean }) {
  const accent = useApp((s) => s.accent)
  const setAccent = useApp((s) => s.setAccent)
  const theme = useApp((s) => s.theme)
  const resolved = resolveTheme(theme)
  const currentHex = ACCENT_PRESETS[accent][resolved].accent
  return (
    <ShimmerCard padding="md" className={highlight ? 'ring-2 ring-[var(--accent)]' : undefined}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          <Palette className="size-5" />
        </div>
        <div className="min-w-[10rem] flex-1 sm:min-w-0">
          <h3 className="text-sm font-medium text-[var(--text)]">Agent 颜色</h3>
          <p className="text-xs text-[var(--text-secondary)]">
            自定义 Agent 的强调色，背景光效同步跟随；「墨色」随主题自动黑白，其余预设立即生效并持久化。
          </p>
          <p className="mt-0.5 font-mono text-xs text-[var(--accent)]">
            {ACCENT_PRESETS[accent].label} · {currentHex}
          </p>
        </div>
        <div role="radiogroup" aria-label="Agent 颜色" className="flex flex-wrap items-center justify-end gap-2">
          {(Object.keys(ACCENT_PRESETS) as AccentId[]).map((id) => {
            const preset = ACCENT_PRESETS[id]
            const active = accent === id
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={preset.label}
                title={`${preset.label}（${id === 'mono' ? '随主题' : preset.swatch}）`}
                onClick={() => setAccent(id)}
                className={`press size-7 rounded-full transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  active ? 'ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--bg)]' : ''
                }`}
                style={{ background: id === 'mono' ? 'var(--accent)' : preset.swatch }}
              />
            )
          })}
        </div>
      </div>
    </ShimmerCard>
  )
}

/* ───────── 层级色调：外壳颜色 / 工作区背景（分层配色） ───────── */

function LayerTonePicker({ highlight }: { highlight: boolean }) {
  const shellTone = useApp((s) => s.shellTone)
  const setShellTone = useApp((s) => s.setShellTone)
  const canvasTone = useApp((s) => s.canvasTone)
  const setCanvasTone = useApp((s) => s.setCanvasTone)
  return (
    <ShimmerCard padding="md" className={highlight ? 'ring-2 ring-[var(--accent)]' : undefined}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          <Monitor className="size-5" />
        </div>
        <div className="min-w-[10rem] flex-1 sm:min-w-0">
          <h3 className="text-sm font-medium text-[var(--text)]">层级配色</h3>
          <p className="text-xs text-[var(--text-secondary)]">
            为外壳与工作区分层定制背景明暗，实时生效并持久化。
          </p>
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-xs text-[var(--text-secondary)]">外壳颜色</span>
              <div role="radiogroup" aria-label="外壳颜色" className="flex gap-1 rounded-lg bg-[var(--bg-tertiary)] p-1">
                {(Object.keys(SHELL_TONES) as ShellToneId[]).map((id) => (
                  <Button
                    key={id}
                    size="sm"
                    variant={shellTone === id ? 'primary' : 'ghost'}
                    onClick={() => setShellTone(id)}
                    role="radio"
                    aria-checked={shellTone === id}
                  >
                    {SHELL_TONES[id].label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-xs text-[var(--text-secondary)]">工作区背景</span>
              <div role="radiogroup" aria-label="工作区背景" className="flex gap-1 rounded-lg bg-[var(--bg-tertiary)] p-1">
                {(Object.keys(CANVAS_TONES) as CanvasToneId[]).map((id) => (
                  <Button
                    key={id}
                    size="sm"
                    variant={canvasTone === id ? 'primary' : 'ghost'}
                    onClick={() => setCanvasTone(id)}
                    role="radio"
                    aria-checked={canvasTone === id}
                  >
                    {CANVAS_TONES[id].label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </ShimmerCard>
  )
}

/* ───────── 通用开关行（图标 + 标题 + 精确说明 + 开关） ───────── */

interface ToggleRowProps {
  icon: ReactNode
  label: string
  desc: string
  checked: boolean
  onChange: (next: boolean) => void
  highlight?: boolean
}

function ToggleRow({ icon, label, desc, checked, onChange, highlight }: ToggleRowProps) {
  return (
    <ShimmerCard padding="md" className={highlight ? 'ring-2 ring-[var(--accent)]' : undefined}>
      <div className="flex items-center gap-4">
        <div
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
            checked ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-[var(--text)]">{label}</h3>
          <p className="text-xs text-[var(--text-secondary)]">{desc}</p>
        </div>
        <button
          type="button"
          onClick={() => onChange(!checked)}
          className={`press relative h-6 w-11 shrink-0 rounded-full touch-manipulation transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] ${
            checked ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]'
          }`}
          role="switch"
          aria-checked={checked}
          aria-label={`切换 ${label}`}
        >
          <span
            className={`absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
              checked ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
    </ShimmerCard>
  )
}

/* ───────── 分区内容渲染器 ───────── */

type SectionRenderer = (props: {
  toast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning') => void
  highlightKey: string | null
  sysConfig: { gateway?: { port?: number; bind?: string }; crawler?: { maxConcurrent?: number } } | null
  agents: Array<{ name: string; available: boolean }>
  permMode: boolean | null
  togglePermissionMode: (next: boolean) => Promise<void>
  clearCache: () => void
  prefs: ChatPrefs
}) => ReactNode

const sectionRenderers: Record<string, SectionRenderer> = {
  appearance: ({ highlightKey }) => (
    <div className="stagger space-y-3">
      <ShimmerCard variant="accent" padding="md" className={highlightKey === 'appearance.theme' ? 'ring-2 ring-[var(--accent)]' : undefined}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            {useApp.getState().theme === 'system' ? (
              <Monitor className="size-5" />
            ) : useApp.getState().theme === 'dark' ? (
              <Moon className="size-5" />
            ) : (
              <Sun className="size-5 text-[var(--warning)]" />
            )}
          </div>
          <div className="min-w-[10rem] flex-1 sm:min-w-0">
            <h3 className="text-sm font-medium text-[var(--text)]">主题</h3>
            <p className="text-xs text-[var(--text-secondary)]">
              当前：{themeLabel(useApp.getState().theme)}；跟随系统时随系统深/浅实时切换。
            </p>
          </div>
          <div
            role="radiogroup"
            aria-label="主题切换"
            className="flex gap-1 rounded-lg bg-[var(--bg-tertiary)] p-1"
          >
            {(['system', 'dark', 'light'] as const).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={useApp.getState().theme === t ? 'primary' : 'ghost'}
                onClick={() => useApp.getState().setTheme(t)}
                role="radio"
                aria-checked={useApp.getState().theme === t}
                aria-label={`${themeLabel(t)}主题`}
              >
                {themeLabel(t)}
              </Button>
            ))}
          </div>
        </div>
      </ShimmerCard>
      <AccentPicker highlight={highlightKey === 'appearance.accent'} />
      <LayerTonePicker highlight={highlightKey === 'appearance.layer'} />
      <MotionPreview highlight={highlightKey === 'appearance.motion'} />
    </div>
  ),

  behavior: ({ toast, highlightKey, permMode, togglePermissionMode, prefs }) => (
    <div className="stagger space-y-3">
      <ToggleRow
        icon={<Bell className="size-5" />}
        label="桌面通知"
        desc="启用后，任务完成、审批请求、搜索结果等事件会弹出系统桌面通知。"
        checked={readStored('axiom:notifications', true)}
        onChange={(v) => { writeStored('axiom:notifications', v); toast(`桌面通知已${v ? '开启' : '关闭'}`, 'info') }}
        highlight={highlightKey === 'behavior.notifications'}
      />
      <ToggleRow
        icon={<Shield className="size-5" />}
        label="隐私模式"
        desc="本地优先：数据不离开设备；关闭后允许使用云端模型与外部服务。"
        checked={readStored('axiom:safeMode', true)}
        onChange={(v) => { writeStored('axiom:safeMode', v); toast(`隐私模式已${v ? '开启' : '关闭'}`, 'info') }}
        highlight={highlightKey === 'privacy.safeMode'}
      />
      <ToggleRow
        icon={<Brain className="size-5" />}
        label="显示思考过程"
        desc="在对话中展开显示 Agent 的推理轨迹（reasoning trace）；默认关闭。"
        checked={prefs.showThinking}
        onChange={() => { prefs.toggleShowThinking(); toast(`思考过程已${!prefs.showThinking ? '开启' : '关闭'}`, 'info') }}
        highlight={highlightKey === 'chat.showThinking'}
      />
      <ToggleRow
        icon={<FileEdit className="size-5" />}
        label="展开文件修改"
        desc="对话默认展开文件变更明细（新建/编辑/删除及 diff）；默认开启。"
        checked={prefs.expandFileChanges}
        onChange={() => { prefs.toggleExpandFileChanges(); toast(`文件修改明细已${!prefs.expandFileChanges ? '开启' : '关闭'}`, 'info') }}
        highlight={highlightKey === 'chat.expandFileChanges'}
      />
      <ToggleRow
        icon={<Wrench className="size-5" />}
        label="展开工具调用"
        desc="对话默认展开每次工具调用的参数与结果细节；默认关闭。"
        checked={prefs.expandToolCalls}
        onChange={() => { prefs.toggleExpandToolCalls(); toast(`工具调用明细已${!prefs.expandToolCalls ? '开启' : '关闭'}`, 'info') }}
        highlight={highlightKey === 'chat.expandToolCalls'}
      />
      <ToggleRow
        icon={<TerminalSquare className="size-5" />}
        label="终端覆盖显示"
        desc="终端以浮层覆盖显示（不占位、不推挤内容）；关闭后内嵌于内容区底部。"
        checked={useApp.getState().terminalOverlay}
        onChange={() => {
          const next = !useApp.getState().terminalOverlay
          useApp.getState().setTerminalOverlay(next)
          toast(`终端已切换为${next ? '覆盖' : '内嵌'}显示`, 'info')
        }}
        highlight={highlightKey === 'chat.terminalOverlay'}
      />
      <ToggleRow
        icon={<KeyRound className="size-5" />}
        label="会话内自动接收权限"
        desc="当前会话 normal 级别权限自动放行；high-risk 始终要求手动确认。"
        checked={prefs.autoAcceptPermissions}
        onChange={() => { prefs.toggleAutoAcceptPermissions(); toast(`会话内自动接收已${!prefs.autoAcceptPermissions ? '开启' : '关闭'}`, 'info') }}
        highlight={highlightKey === 'chat.autoAcceptPermissions'}
      />
      <ToggleRow
        icon={<Shield className="size-5" />}
        label="全局权限自动接收"
        desc={
          permMode === null
            ? '后端全局权限模式（/permissions/mode），加载中…'
            : `影响所有会话；high-risk 永远确认，当前：${permMode ? '自动放行' : '手动确认'}。`
        }
        checked={permMode === true}
        onChange={togglePermissionMode}
        highlight={highlightKey === 'permissions.autoAccept'}
      />
    </div>
  ),

  data: ({ highlightKey, clearCache }) => (
    <div className="stagger space-y-3">
      <ShimmerCard padding="md" className={highlightKey === 'data.language' ? 'ring-2 ring-[var(--accent)]' : undefined}>
        <div className="flex items-center gap-4">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--info-soft)] text-[var(--info)]">
            <Globe className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-[var(--text)]">界面语言</h3>
            <p className="text-xs text-[var(--text-secondary)]">简体中文（随系统区域设置）</p>
          </div>
        </div>
      </ShimmerCard>
      <ShimmerCard padding="md" className={highlightKey === 'data.storage' ? 'ring-2 ring-[var(--accent)]' : undefined}>
        <div className="flex items-center gap-4">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
            <Database className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-[var(--text)]">数据存储</h3>
            <p className="text-xs text-[var(--text-secondary)]">本地 SQLite + Obsidian Vault（可选远程同步）</p>
          </div>
        </div>
      </ShimmerCard>
      <ShimmerCard padding="md" className={highlightKey === 'data.cache' ? 'ring-2 ring-[var(--accent)]' : undefined}>
        <div className="flex items-center gap-4">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
            <Database className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-[var(--text)]">清空 API 缓存</h3>
            <p className="text-xs text-[var(--text-secondary)]">清除搜索与模型的临时缓存，释放内存与磁盘空间。</p>
          </div>
          <Button size="sm" variant="secondary" onClick={clearCache} aria-label="清空 API 缓存">
            清空
          </Button>
        </div>
      </ShimmerCard>
    </div>
  ),

  models: ({ toast }) => <ModelManagementSection toast={toast} />,

  agent: ({ highlightKey, agents }) => (
    <ShimmerCard padding="md" className={highlightKey === 'agent.status' ? 'ring-2 ring-[var(--accent)]' : undefined}>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]">
        <Bot className="size-4 text-[var(--accent)]" />
        编码 Agent 状态
      </h3>
      {agents.length === 0 ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} height="1.5rem" />)}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {agents.map((a) => (
            <li key={a.name} className="flex items-center justify-between rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm">
              <span className="font-mono text-xs text-[var(--text-secondary)]">{a.name}</span>
              <span className={`flex items-center gap-1.5 text-xs ${a.available ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
                <CheckCircle2 className="size-3.5" />
                {a.available ? '可用' : '不可用'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        可用状态与 `/agents/status` 一一对应；不可用 Agent 可参考安装指引补齐。
      </p>
    </ShimmerCard>
  ),

  gateway: ({ highlightKey, sysConfig }) => (
    <ShimmerCard padding="md">
      <div className="space-y-2 text-sm">
        <div className={`flex items-center justify-between rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 ${highlightKey === 'gateway.port' ? 'ring-2 ring-[var(--accent)]' : ''}`}>
          <span className="text-[var(--text)]">网关端口</span>
          <span className="font-mono text-xs text-[var(--text-secondary)]">
            {sysConfig?.gateway?.port ?? '—'}
          </span>
        </div>
        <div className={`flex items-center justify-between rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 ${highlightKey === 'gateway.bind' ? 'ring-2 ring-[var(--accent)]' : ''}`}>
          <span className="text-[var(--text)]">绑定地址</span>
          <span className="font-mono text-xs text-[var(--text-secondary)]">
            {sysConfig?.gateway?.bind ?? '—'}
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        数值与 config/axiom.yaml 一一对应；改动请通过 config 文件或 /config 接口并重启服务。
      </p>
    </ShimmerCard>
  ),

  crawler: ({ highlightKey, sysConfig }) => (
    <ShimmerCard padding="md">
      <div className="space-y-2 text-sm">
        <div className={`flex items-center justify-between rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 ${highlightKey === 'crawler.maxConcurrent' ? 'ring-2 ring-[var(--accent)]' : ''}`}>
          <span className="text-[var(--text)]">最大并发抓取</span>
          <span className="font-mono text-xs text-[var(--text-secondary)]">
            {sysConfig?.crawler?.maxConcurrent ?? '—'}
          </span>
        </div>
        <div className="rounded-lg bg-[var(--bg-tertiary)] px-3 py-2">
          <p className="mb-1.5 text-[var(--text)]">搜索引擎可用状态</p>
          <EngineStatusList />
        </div>
      </div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        DuckDuckGo / SearXNG 免 Key 可用；Bing / SerpAPI 等需在 .env 配置对应 API Key。
      </p>
    </ShimmerCard>
  ),

  diagnostics: ({ toast }) => (
    <div className="stagger space-y-3">
      <DiagnosticsSection toast={toast} />
      <DebugPanelsSection />
    </div>
  ),
}

/* ───────── 设置页 ───────── */

export default function Settings() {
  const theme = useApp((s) => s.theme)
  const toast = useApp((s) => s.toast)
  const prefs = useChatPrefs()

  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(SETTING_SECTIONS.filter((s) => s.defaultOpen).map((s) => s.id)),
  )
  const [highlightKey, setHighlightKey] = useState<string | null>(null)
  const [permMode, setPermMode] = useState<boolean | null>(null)
  const [sysConfig, setSysConfig] = useState<{
    gateway?: { port?: number; bind?: string }
    crawler?: { maxConcurrent?: number }
  } | null>(null)
  const [agents, setAgents] = useState<Array<{ name: string; available: boolean }>>([])

  useEffect(() => {
    endpoints.permissions.getMode().then((d) => setPermMode(d.autoAccept)).catch(() => setPermMode(null))
    api.get('/config').then((d) => setSysConfig(d as typeof sysConfig)).catch(() => setSysConfig(null))
    endpoints.agents.status().then((d) => {
      const data = d as unknown
      const list = Array.isArray(data) ? data : (data as { agents?: Array<{ name: string; available: boolean }> })?.agents ?? []
      setAgents(list)
    }).catch(() => setAgents([]))
  }, [])

  const toggleSection = (id: string, open: boolean) => {
    setOpenSections((prev) => {
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }

  /** 搜索选中 → 展开所属分区 + 高亮该设置项 2 秒 */
  const handleSearchSelect = (key: string) => {
    const item = SETTINGS_CATALOG.find((i) => i.key === key)
    if (item) {
      setOpenSections((prev) => new Set(prev).add(item.section))
    }
    setHighlightKey(key)
    setTimeout(() => setHighlightKey(null), 2000)
  }

  const clearCache = () => {
    api.clearCache()
    toast('API 缓存已清空', 'success')
  }

  const togglePermissionMode = async (next: boolean) => {
    try {
      const d = await endpoints.permissions.setMode(next)
      setPermMode(d.autoAccept)
      toast(`全局权限自动接收已${d.autoAccept ? '开启' : '关闭'}`, 'success')
    } catch {
      toast('权限模式同步失败', 'error')
    }
  }

  const sectionOpen = (id: string) => openSections.has(id)

  return (
    <div className="space-y-6">
      <PageHeader
        icon={theme === 'dark' ? <Moon className="size-5" /> : <Sun className="size-5 text-[var(--warning)]" />}
        title="设置"
        description="自定义 Axiom 的外观、对话行为与 Agent 适配，支持语义搜索定位设置项。"
      />

      <SettingsSearch onSelect={handleSearchSelect} />

      {SETTING_SECTIONS.map((section) => {
        const Icon = section.icon
        const renderer = sectionRenderers[section.id]
        if (!renderer) return null

        const sectionMeta = {
          appearance: { description: '主题与动效' },
          behavior: { description: '通知、隐私与 Agent 对话偏好（与 Chat 页开关一一对应）' },
          data: { description: '语言、存储与缓存' },
          models: { description: '模型配置管理（提供商 / 模型 ID / 层级）' },
          agent: { description: '编码 Agent 可用状态与权限行为（与后端配置一一对应）' },
          gateway: { description: 'HTTP 服务监听配置（读取自 /config，修改需重启生效）' },
          crawler: { description: '爬取并发上限与搜索引擎可用状态（读取自 /config、/engines）' },
          diagnostics: { description: '运行环境与核心服务健康检查、性能/Token/路由/代理/评估面板，可一键复制诊断快照' },
        }[section.id]

        return (
          <Collapsible
            key={section.id}
            icon={<Icon className="size-4" />}
            title={section.label}
            description={sectionMeta?.description}
            open={sectionOpen(section.id)}
            onToggle={(o) => toggleSection(section.id, o)}
          >
            {renderer({
              toast,
              highlightKey,
              sysConfig,
              agents,
              permMode,
              togglePermissionMode,
              clearCache,
              prefs,
            })}
          </Collapsible>
        )
      })}
    </div>
  )
}

/* ───────── localStorage 辅助 ───────── */

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
