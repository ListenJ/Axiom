import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ShieldCheck, AlertTriangle } from 'lucide-react'
import { Button, Select, ShimmerCard } from '@/components/ui'
import { api } from '@/lib/api'

/**
 * 审批模型编辑器（security 分区）
 *
 * 后端契约（src/routes/settings.ts → handleApproverSettings）：
 *   GET  /settings/approver →
 *        { resolution: ApproverResolution, modelCount, mode, hint,
 *          configuredModels: ApproverCandidate[], explicit, envVar }
 *     其中 resolution = { ok, provider?, model?, source, candidates, message }
 *     ApproverCandidate = { provider, model, role, priority, keyAvailable }
 *   POST /settings/approver ← { model: string }（**必填非空**，空串返回 400）
 *     → { ok: true, model, envPath }；失败 → { error } + 400
 *
 * 重要语义（以 handler 为准，不猜）：
 *   - 「自动选择（按 review → decision 角色）」在 GET 侧由 `explicit` 为空 + `source`
 *     ∈ {review-role, decision-role, single-model} 表达，属于**运行期推导**，没有可写入的
 *     空值端点。因此该选项只作展示（保存按钮禁用并提示），要"回到自动"须由用户在
 *     .env / config/axiom.yaml 侧清空 AXIOM_APPROVER_MODEL —— 后端未提供该写接口，
 *     这里不臆造一个 POST。
 *   - POST 写入的是 `AXIOM_APPROVER_MODEL`（provider/model 或纯 model），与 `explicit` 同源。
 */

export interface ApproverCandidate {
  provider: string
  model: string
  role: string
  priority: number
  keyAvailable: boolean
}

export interface ApproverResolution {
  ok: boolean
  provider?: string
  model?: string
  source: 'explicit-config' | 'review-role' | 'decision-role' | 'single-model' | 'none'
  candidates: ApproverCandidate[]
  message: string
}

export interface ApproverSettingsPayload {
  resolution: ApproverResolution
  modelCount: number
  mode: 'single-model' | 'multi-model' | 'none'
  hint: string
  configuredModels: ApproverCandidate[]
  explicit: string
  envVar: string
}

/** 下拉里的自动选择哨兵值；不作为 POST body 的 model 发送。 */
const AUTO_VALUE = '__auto__'

export const SOURCE_LABEL: Record<ApproverResolution['source'], string> = {
  'explicit-config': '显式配置',
  'review-role': 'review 角色自动选择',
  'decision-role': 'decision 角色自动选择',
  'single-model': '单模型兜底',
  none: '无可用审批人',
}

export function candidateKey(c: ApproverCandidate): string {
  return `${c.provider}/${c.model}`
}

function isApproverPayload(v: unknown): v is ApproverSettingsPayload {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.resolution === 'object' && o.resolution !== null && Array.isArray(o.configuredModels)
}

/** 从 HttpError.data 里取后端的 { error } 文案（api.ts 对 4xx 只优先找 message 字段）。 */
function extractErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null)?.data
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error?: unknown }).error
    if (typeof e === 'string' && e) return e
  }
  if (err instanceof Error && err.message && err.message !== 'HTTP 400') return err.message
  return fallback
}

export default function ApproverSettingsSection({
  toast,
  highlightKey,
}: {
  toast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning') => void
  highlightKey?: string | null
}): ReactNode {
  const [data, setData] = useState<ApproverSettingsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [selection, setSelection] = useState<string>(AUTO_VALUE)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .get<unknown>('/settings/approver', { cache: false })
      .then((raw) => {
        if (cancelled) return
        if (!isApproverPayload(raw)) {
          setLoadError('审批模型响应格式异常（缺少 resolution / configuredModels）')
          setData(null)
          return
        }
        setData(raw)
        setLoadError(null)
        // GET 的 explicit 即当前生效的显式配置，空 ⇒ 自动选择
        setSelection(raw.explicit ? raw.explicit : AUTO_VALUE)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setData(null)
        setLoadError(extractErrorMessage(err, '读取审批模型配置失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const options = useMemo<ApproverCandidate[]>(
    () => data?.configuredModels ?? data?.resolution?.candidates ?? [],
    [data],
  )

  /** 当前生效的审批人描述（后端 resolution 为唯一权威口径）。 */
  const activeLabel = data
    ? data.resolution.provider && data.resolution.model
      ? `${data.resolution.provider}/${data.resolution.model}`
      : (data.resolution.model ?? '（未确定）')
    : ''

  const isAuto = selection === AUTO_VALUE
  const canSave = !loading && !saving && Boolean(data) && !isAuto
  const dirty = Boolean(data) && selection !== (data?.explicit ? data.explicit : AUTO_VALUE)

  const save = useCallback(async () => {
    const model = selection.trim()
    if (!model || isAuto) {
      const msg = '「自动选择」由后端按 review → decision 推导，无法通过保存写入；请选择一个具体模型。'
      setSaveError(msg)
      toast(msg, 'warning')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await api.post<{ ok?: boolean; model?: string; envPath?: string; error?: string }>(
        '/settings/approver',
        { model },
      )
      if (res?.ok !== true) {
        throw { data: { error: res?.error ?? '后端未确认写入成功' } }
      }
      // 成功回显：以后端返回的 model 为准（后端已 trim）
      const saved = (res.model ?? model).trim()
      setSelection(saved)
      setData((prev) =>
        prev
          ? {
              ...prev,
              explicit: saved,
              envVar: prev.envVar,
              resolution: {
                ...prev.resolution,
                ok: true,
                source: 'explicit-config',
                provider: saved.includes('/') ? saved.slice(0, saved.indexOf('/')) : undefined,
                model: saved.includes('/') ? saved.slice(saved.indexOf('/') + 1) : saved,
                message: `审批模型来自你的显式配置：${saved}。`,
              },
            }
          : prev,
      )
      toast(`审批模型已保存：${saved}`, 'success')
    } catch (err) {
      // 失败回滚显示：恢复到后端确认过的 explicit
      setSelection((prev) => {
        const confirmed = data?.explicit ? data.explicit : AUTO_VALUE
        return prev === AUTO_VALUE ? prev : confirmed
      })
      const msg = extractErrorMessage(err, '保存审批模型失败')
      setSaveError(msg)
      toast(`保存失败：${msg}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [data, isAuto, selection, toast])

  return (
    <ShimmerCard
      variant="accent"
      padding="md"
      className={highlightKey === 'security.approver' ? 'ring-2 ring-[var(--accent)]' : undefined}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
            <ShieldCheck className="size-4" />
          </span>
          <h3 className="text-sm font-medium text-[var(--text)]">高危操作审批模型</h3>
          <code className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-2xs text-[var(--text-muted)]">
            security.approver
          </code>
        </div>

        {loading && <p className="text-xs text-[var(--text-muted)]">正在读取审批模型配置…</p>}

        {loadError && (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-xs text-[var(--danger)]"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{loadError}</span>
          </p>
        )}

        {data && !loading && (
          <>
            <div className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
              <p data-testid="approver-current-model">
                当前审批模型：
                <span className="font-mono text-[var(--text)]">{activeLabel}</span>
                <span className="ml-2 text-[var(--text-muted)]">
                  （来源：{SOURCE_LABEL[data.resolution.source]}）
                </span>
              </p>
              <p>{data.resolution.message}</p>
              <p className="text-[var(--text-muted)]">{data.hint}</p>
              <p className="text-[var(--text-muted)]">
                写入目标：<code className="font-mono">{data.envVar}</code>
                {data.resolution.ok === false && (
                  <span className="ml-2 text-[var(--danger)]">
                    当前无可用审批人，高危操作按 fail-closed 一律拒绝。
                  </span>
                )}
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <Select
                label="审批模型"
                aria-label="审批模型"
                value={selection}
                disabled={saving || options.length === 0}
                onChange={(e) => {
                  setSelection(e.target.value)
                  setSaveError(null)
                }}
                hint={
                  options.length === 0
                    ? '当前没有可用模型，请先在「模型」分区配置。'
                    : '不选具体模型时按 review → decision 角色自动选择（后端推导，不可保存为空）。'
                }
                className="min-w-[18rem] flex-1"
              >
                <option value={AUTO_VALUE}>自动选择（按 review → decision 角色）</option>
                {options.map((c) => (
                  <option key={candidateKey(c)} value={candidateKey(c)}>
                    {candidateKey(c)} · {c.role}
                    {c.keyAvailable ? '' : '（无 API Key）'}
                  </option>
                ))}
              </Select>

              <Button
                size="md"
                loading={saving}
                disabled={!canSave || !dirty}
                onClick={() => {
                  void save()
                }}
              >
                保存
              </Button>
            </div>

            {isAuto && !saving && (
              <p className="text-2xs text-[var(--text-muted)]">
                当前为自动选择（由后端按角色推导，{SOURCE_LABEL[data.resolution.source]}）。
                后端 POST 只接受非空 model，因此要「保存」需先选定一个具体模型。
              </p>
            )}

            {saveError && (
              <p role="alert" className="flex items-start gap-1.5 text-xs text-[var(--danger)]">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{saveError}</span>
              </p>
            )}
          </>
        )}
      </div>
    </ShimmerCard>
  )
}