/**
 * Providers 页面子组件与类型
 *
 * 从 pages/Providers.tsx 拆分出来，以满足"页面 < 600 行"的架构约束。
 * 包含：
 *  - 类型定义（ApiAdapter / ProviderRegion / ProviderStatus）
 *  - 适配器与区域元数据（ADAPTER_META / REGION_META）
 *  - ProviderRow（单个 provider 的密钥输入行）
 *  - AdapterSection（按 API 标准分组的区块）
 *  - OpenCodeSection（OpenCode Go 套餐服务专区）
 */
import { useEffect, useState } from 'react'
import {
  CheckCircle2, AlertTriangle, Wifi, WifiOff,
  Key, Trash2, Save, Eye, EyeOff, Sparkles, Info,
  ExternalLink, Rocket, Zap, XCircle,
} from 'lucide-react'
import { ShimmerCard, Button, Input } from '@/components/ui'
import { endpoints } from '@/lib/api'

// ─── 类型定义 ────────────────────────────────────────────────────────────

export type ApiAdapter = 'openai' | 'anthropic' | 'gemini' | 'opencode'
export type ProviderRegion = 'domestic' | 'overseas' | 'global'

export interface ProviderStatus {
  provider: string
  apiKeyEnv: string
  baseURL: string
  adapter: ApiAdapter
  region: ProviderRegion
  displayName: string
  hasRegionalVariants: boolean
  source: 'env' | 'runtime' | 'config' | 'none'
  configured: boolean
  masked: string
}

// ─── 适配器元数据（颜色必须用 CSS 变量，架构测试禁止 hex 字面量） ──────────
export const ADAPTER_META: Record<ApiAdapter, { label: string; description: string; color: string; softColor: string }> = {
  openai: {
    label: 'OpenAI 标准协议',
    description: '兼容 OpenAI Chat Completions（/v1/chat/completions）',
    color: 'var(--accent)',
    softColor: 'var(--accent-soft)',
  },
  anthropic: {
    label: 'Claude 母公司 API 标准',
    description: '兼容 Anthropic Messages API（/v1/messages）',
    color: 'var(--warning)',
    softColor: 'var(--warning-soft)',
  },
  gemini: {
    label: 'Google Gemini 标准',
    description: '兼容 Gemini GenerateContent API',
    color: 'var(--info)',
    softColor: 'var(--info-soft)',
  },
  opencode: {
    label: 'OpenCode Go 套餐服务',
    description: '基于 OpenAI 协议扩展，无缝使用 OpenCode 套餐功能',
    color: 'var(--success)',
    softColor: 'var(--success-soft)',
  },
}

export const REGION_META: Record<ProviderRegion, { label: string; short: string; color: string; softColor: string }> = {
  domestic: { label: '国内版本', short: '国内', color: 'var(--success)', softColor: 'var(--success-soft)' },
  overseas: { label: '海外版本', short: '海外', color: 'var(--info)', softColor: 'var(--info-soft)' },
  global: { label: '全球统一', short: '全球', color: 'var(--text-muted)', softColor: 'var(--surface)' },
}

/**
 * 各 provider 获取 API Key 的控制台地址。
 * 用于在 ProviderRow 中提供"获取密钥"外链，降低用户学习成本。
 */
export const PROVIDER_HELP_URLS: Record<string, string> = {
  siliconflow: 'https://cloud.siliconflow.cn',
  ofoxai: 'https://ofoxai.com',
  openrouter: 'https://openrouter.ai/keys',
  deepseek: 'https://platform.deepseek.com',
  'deepseek-overseas': 'https://platform.deepseek.com',
  kimi: 'https://platform.moonshot.cn',
  'kimi-overseas': 'https://platform.moonshot.ai',
  zhipu: 'https://open.bigmodel.cn',
  'zhipu-overseas': 'https://z.ai',
  minimax: 'https://platform.minimaxi.com',
  'minimax-overseas': 'https://www.minimax.io',
  nim: 'https://build.nvidia.com',
  'ofoxai-anthropic': 'https://ofoxai.com',
  opencode: 'https://opencode.ai',
}

// ─── 单个 Provider 行项 ─────────────────────────────────────────────────

export function ProviderRow({
  provider,
  onSaved,
}: {
  provider: ProviderStatus
  onSaved: () => void
}) {
  const [keyInput, setKeyInput] = useState('')
  const [baseURLInput, setBaseURLInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latency?: number; modelCount?: number; error?: string } | null>(null)

  useEffect(() => {
    setKeyInput('')
    setBaseURLInput('')
    setError(null)
    setSuccess(null)
    setTestResult(null)
  }, [provider.masked, provider.source])

  const handleSave = async () => {
    setError(null)
    setSuccess(null)
    if (keyInput.trim().length < 8) {
      setError('API Key 至少 8 个字符')
      return
    }
    setSaving(true)
    try {
      await endpoints.apiKeys.set({
        provider: provider.provider,
        apiKey: keyInput.trim(),
        baseURL: baseURLInput.trim() || undefined,
      })
      setSuccess('已保存')
      setKeyInput('')
      setBaseURLInput('')
      onSaved()
      setTimeout(() => setSuccess(null), 2500)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setError(null)
    setSuccess(null)
    if (!provider.configured) return
    if (!confirm(`确认清除 ${provider.displayName} 的运行时密钥？\n清除后将回退到环境变量（如已配置）。`)) {
      return
    }
    setClearing(true)
    try {
      await endpoints.apiKeys.clear(provider.provider)
      setSuccess('已清除运行时密钥')
      onSaved()
      setTimeout(() => setSuccess(null), 2500)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg || '清除失败')
    } finally {
      setClearing(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      const result = await endpoints.apiKeys.test(provider.provider)
      setTestResult(result)
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const regionInfo = REGION_META[provider.region]
  const isRuntimeOverride = provider.source === 'runtime'
  const isEnvConfigured = provider.source === 'env'
  const helpUrl = PROVIDER_HELP_URLS[provider.provider]

  return (
    <div
      className="rounded-xl border border-[var(--border)] p-3 transition-colors hover:bg-[var(--surface-hover)]"
      data-provider={provider.provider}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div
            className={`flex size-9 items-center justify-center rounded-lg ${
              provider.configured ? 'bg-[var(--success-soft)]' : 'bg-[var(--bg-tertiary)]'
            }`}
          >
            {provider.configured ? (
              <Wifi className="size-4 text-[var(--success)]" />
            ) : (
              <WifiOff className="size-4 text-[var(--text-muted)]" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-[var(--text)]">{provider.displayName}</p>
              <span
                className="rounded-full px-1.5 py-0.5 text-2xs font-medium"
                style={{ backgroundColor: regionInfo.softColor, color: regionInfo.color }}
                title={regionInfo.label}
              >
                {regionInfo.short}
              </span>
              {helpUrl && (
                <a
                  href={helpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-0.5 text-2xs text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
                  title={`前往 ${provider.displayName} 控制台获取 API Key`}
                >
                  获取密钥 <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            <p className="font-mono text-2xs text-[var(--text-muted)]">{provider.baseURL}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isRuntimeOverride && (
            <span
              className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-2xs text-[var(--accent)]"
              title="通过前端设置的运行时密钥"
            >
              运行时
            </span>
          )}
          {isEnvConfigured && (
            <span
              className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-2xs text-[var(--text-muted)]"
              title="通过环境变量配置"
            >
              环境变量
            </span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              provider.configured
                ? 'bg-[var(--success-soft)] text-[var(--success)]'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
            }`}
          >
            {provider.configured ? '已启用' : '未配置'}
          </span>
        </div>
      </div>

      {provider.configured && provider.masked && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--bg-secondary)] px-2.5 py-1.5">
          <Key className="size-3 text-[var(--text-muted)]" />
          <span className="font-mono text-2xs text-[var(--text-secondary)]">{provider.masked}</span>
          <span className="text-2xs text-[var(--text-muted)]">· {provider.apiKeyEnv}</span>
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-2">
          <Input
            type={showKey ? 'text' : 'password'}
            placeholder={
              provider.configured
                ? '输入新密钥以覆盖当前配置'
                : '粘贴 API Key（仅需一个密钥即可启用）'
            }
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            iconLeft={<Key className="size-3.5" />}
            iconRight={
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="pointer-events-auto text-[var(--text-muted)] hover:text-[var(--text)]"
                tabIndex={-1}
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            }
            error={error ?? undefined}
          />
          {provider.hasRegionalVariants && (
            <Input
              placeholder={`自定义 baseURL（留空使用默认：${provider.baseURL}）`}
              value={baseURLInput}
              onChange={(e) => setBaseURLInput(e.target.value)}
            />
          )}
        </div>
        <div className="flex items-end gap-1.5">
          <Button
            size="sm"
            variant="primary"
            loading={saving}
            disabled={!keyInput.trim() || saving}
            onClick={handleSave}
            icon={<Save className="size-3.5" />}
          >
            保存
          </Button>
          {provider.configured && (
            <>
              <Button
                size="sm"
                variant="outline"
                loading={testing}
                disabled={testing}
                onClick={handleTest}
                icon={<Zap className="size-3.5" />}
                title="测试 API Key 连通性（不消耗 token）"
              >
                测试
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={clearing}
                disabled={clearing}
                onClick={handleClear}
                icon={<Trash2 className="size-3.5" />}
                title="清除运行时密钥（回退到环境变量）"
              >
                清除
              </Button>
            </>
          )}
        </div>
      </div>

      {success && (
        <div className="mt-2 flex items-center gap-1.5 text-2xs text-[var(--success)]">
          <CheckCircle2 className="size-3" /> {success}
        </div>
      )}

      {testResult && (
        <div
          className={`mt-2 flex items-start gap-1.5 rounded-lg p-2 text-2xs ${
            testResult.ok
              ? 'bg-[var(--success-soft)] text-[var(--success)]'
              : 'bg-[var(--danger-soft)] text-[var(--danger)]'
          }`}
        >
          {testResult.ok ? (
            <>
              <CheckCircle2 className="mt-0.5 size-3 shrink-0" />
              <span>
                连接成功 · 延迟 {testResult.latency}ms
                {testResult.modelCount !== undefined && ` · 可用模型 ${testResult.modelCount} 个`}
              </span>
            </>
          ) : (
            <>
              <XCircle className="mt-0.5 size-3 shrink-0" />
              <span>连接失败：{testResult.error}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── 适配器分组区块 ─────────────────────────────────────────────────────

export function AdapterSection({
  adapter,
  providers,
  onSaved,
}: {
  adapter: ApiAdapter
  providers: ProviderStatus[]
  onSaved: () => void
}) {
  if (providers.length === 0) return null
  const meta = ADAPTER_META[adapter]
  return (
    <ShimmerCard>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text)]">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ backgroundColor: meta.color }}
              aria-hidden
            />
            {meta.label}
          </h2>
          <p className="mt-0.5 text-2xs text-[var(--text-muted)]">{meta.description}</p>
        </div>
        <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-2xs text-[var(--text-muted)]">
          {providers.length} 个
        </span>
      </div>
      <div className="space-y-2">
        {providers.map((p) => (
          <ProviderRow key={p.provider} provider={p} onSaved={onSaved} />
        ))}
      </div>
    </ShimmerCard>
  )
}

// ─── OpenCode Go 套餐服务专区 ──────────────────────────────────────────

export function OpenCodeSection({
  providers,
  onSaved,
}: {
  providers: ProviderStatus[]
  onSaved: () => void
}) {
  if (providers.length === 0) return null
  const opencodeProvider = providers[0]
  const meta = ADAPTER_META.opencode
  return (
    <ShimmerCard>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          <div
            className="flex size-10 items-center justify-center rounded-xl"
            style={{ backgroundColor: meta.softColor }}
          >
            <Sparkles className="size-5" style={{ color: meta.color }} />
          </div>
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text)]">
              OpenCode Go 套餐服务
              <span
                className="rounded-full px-1.5 py-0.5 text-2xs font-medium"
                style={{ backgroundColor: meta.softColor, color: meta.color }}
              >
                套餐
              </span>
            </h2>
            <p className="mt-0.5 text-2xs text-[var(--text-muted)]">
              集成 OpenCode Go 套餐：仅需添加单个 API Key 即可无缝使用代码生成、重构、评审、测试等全套功能。
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {providers.map((p) => (
          <ProviderRow key={p.provider} provider={p} onSaved={onSaved} />
        ))}
      </div>

      <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-[var(--bg-secondary)] p-2.5 text-2xs text-[var(--text-muted)]">
        <Info className="mt-0.5 size-3 shrink-0" />
        <p>
          OpenCode Go 套餐基于 OpenAI 协议扩展。设置 API Key 后，前端代码生成、重构、评审、测试入口将自动通过套餐服务路由，
          无需额外配置。套餐余额与功能请前往 OpenCode 官方控制台查看。
        </p>
      </div>
      {opencodeProvider && !opencodeProvider.configured && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] p-2.5 text-2xs text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <p>当前未配置 OpenCode API Key，相关功能将不可用。请在上方输入密钥以启用套餐服务。</p>
        </div>
      )}
    </ShimmerCard>
  )
}

// ─── 快速上手引导横幅 ───────────────────────────────────────────────────

/**
 * 新用户快速上手引导。当无任何 provider 配置时显示 3 步入门指南，
 * 降低学习成本，确保用户能够快速开始使用当前 runtime。
 */
export function QuickstartBanner() {
  const steps = [
    {
      n: 1,
      title: '选择一个 Provider',
      desc: '推荐国内用户选择 KIMI（国内）或 GLM 智谱（国内）；海外用户选择 DeepSeek（海外）或 OpenRouter。',
    },
    {
      n: 2,
      title: '获取 API Key',
      desc: '点击对应 provider 的「获取密钥」链接，前往平台控制台创建并复制 API Key（仅需一个密钥）。',
    },
    {
      n: 3,
      title: '粘贴、保存并测试',
      desc: '将密钥粘贴到输入框，点击「保存」即可启用。可点击「测试」按钮验证密钥是否有效（不消耗 token）。密钥持久化到本地，重启后保留。',
    },
  ]
  return (
    <ShimmerCard>
      <div className="flex items-center gap-2 border-b border-[var(--border)] pb-3">
        <div
          className="flex size-8 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'var(--accent-soft)' }}
        >
          <Rocket className="size-4" style={{ color: 'var(--accent)' }} />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">快速上手</h2>
          <p className="text-2xs text-[var(--text-muted)]">3 步即可开始使用，无需复杂配置</p>
        </div>
      </div>
      <ol className="mt-3 space-y-3">
        {steps.map((s) => (
          <li key={s.n} className="flex items-start gap-3">
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-bold"
              style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              {s.n}
            </span>
            <div>
              <p className="text-xs font-medium text-[var(--text)]">{s.title}</p>
              <p className="mt-0.5 text-2xs leading-relaxed text-[var(--text-muted)]">{s.desc}</p>
            </div>
          </li>
        ))}
      </ol>
    </ShimmerCard>
  )
}
