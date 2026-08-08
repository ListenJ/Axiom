import { useEffect, useState } from 'react'
import { Box, Plus, Trash2, X } from 'lucide-react'
import { ShimmerCard, Button, Input, Select, InlineEmptyState, Skeleton } from '@/components/ui'
import { api } from '@/lib/api'

/* ───────── 模型管理 ───────── */

interface ModelItem {
  id: string
  name: string
  provider: string
  model: string
  baseURL?: string
  tier?: string
  purpose?: string
  freeOnly?: boolean
  enabled: boolean
}

const PROVIDER_OPTIONS = [
  { value: 'siliconflow', label: 'SiliconFlow' },
  { value: 'zhipu', label: '智谱AI' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'custom', label: '自定义' },
]

export default function ModelManagementSection({
  toast,
}: {
  toast: (msg: string, type?: 'info' | 'success' | 'error' | 'warning') => void
}) {
  const [models, setModels] = useState<ModelItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', provider: 'siliconflow', model: '', apiKey: '', tier: '', purpose: '' })

  const fetchModels = () => {
    setLoading(true)
    api.get<{ models: ModelItem[] }>('/models')
      .then((d) => setModels(d.models ?? []))
      .catch(() => setModels([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchModels() }, [])

  const addModel = async () => {
    if (!form.name || !form.model) {
      toast('名称和模型 ID 为必填项', 'warning')
      return
    }
    try {
      await api.post('/models', form)
      toast('模型已添加', 'success')
      setShowForm(false)
      setForm({ name: '', provider: 'siliconflow', model: '', apiKey: '', tier: '', purpose: '' })
      fetchModels()
    } catch {
      toast('添加失败', 'error')
    }
  }

  const deleteModel = async (id: string, name: string) => {
    if (!confirm(`确认删除模型「${name}」？\n此操作不可撤销。`)) {
      return
    }
    try {
      await api.delete(`/models/${encodeURIComponent(id)}`)
      toast('模型已删除', 'info')
      fetchModels()
    } catch {
      toast('删除失败', 'error')
    }
  }

  return (
    <ShimmerCard>
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--text)]">
          <Box className="size-4 text-[var(--accent)]" />
          已配置模型
        </h3>
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setShowForm(true)}>
          添加模型
        </Button>
      </div>

      {showForm && (
        <div className="mb-4 rounded-xl border border-[var(--accent-soft)] bg-[var(--bg-secondary)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-secondary)]">添加新模型</span>
            <Button variant="ghost" size="icon" icon={<X className="size-4" />} onClick={() => setShowForm(false)} aria-label="关闭表单" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="名称" placeholder="如：DeepSeek V4" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Select label="提供商" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
              {PROVIDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
            <Input label="模型 ID" placeholder="如：deepseek-v4-flash" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            <Input label="API Key（可选）" type="password" placeholder="sk-…" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
            <Select label="层级" value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
              <option value="">默认</option>
              <option value="free">免费</option>
              <option value="standard">标准</option>
              <option value="premium">高级</option>
            </Select>
            <Input label="用途（可选）" placeholder="如：chat, code" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>取消</Button>
            <Button size="sm" onClick={addModel}>确认添加</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} height="2.5rem" />
          ))}
        </div>
      ) : models.length === 0 ? (
        <InlineEmptyState
          icon={<Box className="size-5" />}
          title="暂无模型"
          description="点击「添加模型」按钮添加新模型"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-2xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                <th className="px-3 py-2 text-left">名称</th>
                <th className="px-3 py-2 text-left">提供商</th>
                <th className="px-3 py-2 text-left">模型 ID</th>
                <th className="px-3 py-2 text-left">层级</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-hover)]">
                  <td className="px-3 py-2.5 font-medium text-[var(--text)]">{m.name}</td>
                  <td className="px-3 py-2.5 text-[var(--text-secondary)]">{m.provider}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-[var(--text-secondary)]">{m.model}</td>
                  <td className="px-3 py-2.5">
                    {m.tier ? (
                      <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-2xs text-[var(--text-muted)]">
                        {m.tier === 'free' ? '免费' : m.tier === 'premium' ? '高级' : m.tier}
                      </span>
                    ) : (
                      <span className="text-[var(--text-muted)]">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => deleteModel(m.id, m.name)}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ShimmerCard>
  )
}
