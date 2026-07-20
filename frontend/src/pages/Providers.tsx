import { useEffect, useMemo, useState } from 'react'
import { Globe, Server, CheckCircle2, XCircle, Key, Shield, Search, X } from 'lucide-react'
import { ShimmerCard, PageHeader, Button, Input, Skeleton, InlineEmptyState, StatCard } from '@/components/ui'
import { endpoints } from '@/lib/api'
import {
  AdapterSection,
  OpenCodeSection,
  QuickstartBanner,
  type ApiAdapter,
  type ProviderStatus,
  type ProviderRegion,
} from '@/components/provider-sections'

export default function Providers() {
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const fetchProviders = async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      const data = await endpoints.apiKeys.list()
      const list = ((data as { providers?: ProviderStatus[] })?.providers) ?? []
      setProviders(list)
      setLoadError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLoadError(msg)
      if (!silent) setProviders([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchProviders()
  }, [])

  // 按适配器分组（OpenCode 单独走套餐专区），并应用搜索过滤
  const grouped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = q
      ? providers.filter(
          (p) =>
            p.displayName.toLowerCase().includes(q) ||
            p.provider.toLowerCase().includes(q) ||
            p.baseURL.toLowerCase().includes(q) ||
            p.apiKeyEnv.toLowerCase().includes(q),
        )
      : providers
    const groups: Record<Exclude<ApiAdapter, 'opencode'>, ProviderStatus[]> = {
      openai: [],
      anthropic: [],
      gemini: [],
    }
    const opencode: ProviderStatus[] = []
    for (const p of filtered) {
      if (p.adapter === 'opencode') {
        opencode.push(p)
      } else if (p.adapter in groups) {
        groups[p.adapter as keyof typeof groups].push(p)
      } else {
        groups.openai.push(p)
      }
    }
    // 国内/海外变体相邻排序：先国内后海外
    const sortFn = (a: ProviderStatus, b: ProviderStatus) => {
      const regionOrder: Record<ProviderRegion, number> = { domestic: 0, overseas: 1, global: 2 }
      const ra = regionOrder[a.region] ?? 99
      const rb = regionOrder[b.region] ?? 99
      if (ra !== rb) return ra - rb
      return a.displayName.localeCompare(b.displayName)
    }
    groups.openai.sort(sortFn)
    groups.anthropic.sort(sortFn)
    groups.gemini.sort(sortFn)
    opencode.sort(sortFn)
    return { groups, opencode }
  }, [providers])

  const stats = useMemo(() => {
    const total = providers.length
    const configured = providers.filter((p) => p.configured).length
    const runtimeOverride = providers.filter((p) => p.source === 'runtime').length
    return { total, configured, notConfigured: total - configured, runtimeOverride }
  }, [providers])

  return (
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<Globe className="size-5" />}
        title="Provider 管理"
        description="单密钥即可启用对应模型服务。支持 OpenAI 与 Claude 两套主流 API 标准，覆盖国内/海外开源模型。"
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={refreshing}
            onClick={() => fetchProviders()}
            icon={<Server className="size-3.5" />}
          >
            刷新
          </Button>
        }
      />

      {/* 统计概览 */}
      <section className="stagger grid grid-cols-2 gap-4 sm:grid-cols-4" aria-busy={loading}>
        <StatCard label="Provider 总数" value={stats.total} icon={<Server className="size-4" />} accent="default" loading={loading} />
        <StatCard label="已启用" value={stats.configured} icon={<CheckCircle2 className="size-4" />} accent="success" loading={loading} />
        <StatCard label="未配置" value={stats.notConfigured} icon={<XCircle className="size-4" />} accent="warning" loading={loading} />
        <StatCard label="运行时覆盖" value={stats.runtimeOverride} icon={<Key className="size-4" />} accent="default" loading={loading} />
      </section>

      {/* 加载错误提示 */}
      {loadError && !loading && (
        <ShimmerCard>
          <div className="flex items-start gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] p-3 text-sm text-[var(--danger)]">
            <Shield className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">加载 Provider 列表失败</p>
              <p className="mt-0.5 text-2xs">{loadError}</p>
              <p className="mt-1 text-2xs text-[var(--text-muted)]">
                提示：API Key 管理端点需要认证。请检查是否已登录（token 已配置）。
              </p>
            </div>
          </div>
        </ShimmerCard>
      )}

      {/* 加载骨架 / 空态 / 分组列表 */}
      {loading ? (
        <ShimmerCard>
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height="5rem" />
            ))}
          </div>
        </ShimmerCard>
      ) : providers.length === 0 && !loadError ? (
        <>
          <QuickstartBanner />
          <ShimmerCard>
            <InlineEmptyState
              icon={<Globe className="size-5" />}
              title="无 Provider 配置"
              description="可通过环境变量或上方表单配置 API Key 来启用提供商"
            />
          </ShimmerCard>
        </>
      ) : !loadError ? (
        <>
          {/* 快速上手引导：首次使用（无已配置 provider）时显示 */}
          {stats.configured === 0 && <QuickstartBanner />}

          {/* 搜索过滤 */}
          <ShimmerCard>
            <Input
              placeholder="搜索 provider（名称 / 端点 / 环境变量名）..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              iconLeft={<Search className="size-3.5" />}
              iconRight={
                searchQuery ? (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="pointer-events-auto text-[var(--text-muted)] hover:text-[var(--text)]"
                    tabIndex={-1}
                    aria-label="清除搜索"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : undefined
              }
            />
          </ShimmerCard>

          {/* 搜索无结果提示 */}
          {searchQuery &&
            grouped.opencode.length === 0 &&
            grouped.groups.openai.length === 0 &&
            grouped.groups.anthropic.length === 0 &&
            grouped.groups.gemini.length === 0 && (
              <ShimmerCard>
                <InlineEmptyState
                  icon={<Search className="size-5" />}
                  title="无匹配的 Provider"
                  description={`没有找到与「${searchQuery}」匹配的 provider，请尝试其他关键词。`}
                />
              </ShimmerCard>
            )}

          <OpenCodeSection providers={grouped.opencode} onSaved={() => fetchProviders(true)} />
          <AdapterSection adapter="anthropic" providers={grouped.groups.anthropic} onSaved={() => fetchProviders(true)} />
          <AdapterSection adapter="openai" providers={grouped.groups.openai} onSaved={() => fetchProviders(true)} />
          <AdapterSection adapter="gemini" providers={grouped.groups.gemini} onSaved={() => fetchProviders(true)} />
        </>
      ) : null}

      {/* 帮助说明 */}
      <ShimmerCard>
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <Shield className="size-4 text-[var(--accent)]" />
            使用说明与安全提示
          </h3>
          <ul className="space-y-1.5 text-2xs text-[var(--text-muted)]">
            <li>
              <strong className="text-[var(--text-secondary)]">单密钥启用</strong>
              ：每个 provider 仅需一个 API Key 即可使用对应模型服务，无需额外配置。
            </li>
            <li>
              <strong className="text-[var(--text-secondary)]">连接测试</strong>
              ：点击「测试」按钮可验证 API Key 是否有效（通过模型列表端点，不消耗 token），并查看延迟与可用模型数。
            </li>
            <li>
              <strong className="text-[var(--text-secondary)]">两套 API 标准</strong>
              ：OpenAI 标准协议（/v1/chat/completions）与 Claude 母公司 API 标准（/v1/messages）已统一接入。
            </li>
            <li>
              <strong className="text-[var(--text-secondary)]">国内/海外差异化</strong>
              ：KIMI、GLM、DeepSeek、MiniMax 等模型提供国内与海外两个变体，端点与 API Key 互不冲突，按需选择即可。
            </li>
            <li>
              <strong className="text-[var(--text-secondary)]">优先级</strong>
              ：运行时密钥 &gt; 环境变量 &gt; 配置默认值。运行时密钥持久化到 SQLite，重启后保留。
            </li>
            <li>
              <strong className="text-[var(--text-secondary)]">安全</strong>
              ：API Key 仅以脱敏形式返回（前 6 位 + 后 4 位），完整密钥永不通过 API 暴露；密钥管理端点始终需要认证。
            </li>
            <li>
              <strong className="text-[var(--text-secondary)]">OpenCode Go 套餐</strong>
              ：设置 OpenCode API Key 后，前端代码生成、重构、评审、测试等功能将自动通过套餐服务路由。
            </li>
          </ul>
        </div>
      </ShimmerCard>
    </div>
  )
}
