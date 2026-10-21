/**
 * Defensive data normalization helpers shared by page components.
 *
 * The backend can occasionally return malformed responses (e.g. an object
 * instead of an array, a string of HTML, or items with missing fields).
 * These helpers guarantee the page-level state stays in a shape React can
 * safely render, even when the API misbehaves.
 *
 * The same logic also lives inline in the page components for now; this
 * module is the canonical, testable copy.
 */

export interface Plugin {
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

export interface AvailablePlugin {
  id: string
  name: string
  description: string
  version: string
  author: string
}

export interface ActiveTool {
  name: string
  pluginId: string
  description: string
}

export interface PerfMetrics {
  cpu?: number
  memory?: number
  rps?: number
  p50?: number
  p95?: number
}

/** 解析后端 /metrics 的 Prometheus 文本（text/plain）为 PerfMetrics；非文本/无指标返回 null。 */
export function normalizePromMetrics(text: string): PerfMetrics | null {
  if (typeof text !== 'string' || !text.trim()) return null
  const lines = text.split('\n')
  const first = (prefixes: string[]): number | undefined => {
    const line = lines.find((l) => prefixes.some((p) => l.startsWith(p)))
    if (!line) return undefined
    const m = line.match(/([-+]?\d+(?:\.\d+)?)/)
    return m ? Number(m[1]) : undefined
  }
  return {
    cpu: first(['process_cpu', 'nodejs_cpu', 'cpu']),
    memory: first(['process_memory', 'nodejs_memory', 'memory']),
    rps: first(['http_requests', 'requests']),
    p95: first(['http_request_duration_seconds_bucket', 'p95']),
  }
}

/**
 * Eval 页数据形状（2026-10-22 契约修复）。
 *
 * 真实后端契约（来源：src/eval/model-eval-service.ts rowToEvalResult / dynamic-model-assigner.ts）：
 *   GET /eval/results     → ModelEvalResult[]：{ modelId, provider, evaluatedAt(ISO),
 *                            scores:{ capability, speed, cost, safety, overall } }（**0-100 整数**）
 *   GET /eval/assignments → DynamicAssignment[]：{ modelId, provider, model, assignedRoles[],
 *                            evalScore(0-100), priority, reason, evaluatedAt(ISO) }
 *   GET /eval/models      → OpenRouterModelInfo[]：{ id, name, pricing:{prompt,completion}(USD 字符串),
 *                            context_length, ... }
 * 前端展示层统一使用 0-100 的 `overall/quality/speed/cost/score`。
 */
export interface EvalResult {
  id: string
  provider: string
  /** 0-100（后端 scores.overall） */
  overall: number
  /** 0-100（后端 scores.capability） */
  quality: number
  speed: number
  cost: number
  /** 0-100（后端 scores.safety；仅用于排序展示） */
  safety: number
  lastEvaluated: string
}

export interface EvalAssignment {
  id: string
  role: string
  model: string
  provider: string
  /** 0-100（后端 evalScore） */
  score: number
  lastAssigned: string
}

export interface EvalModel {
  id: string
  name: string
  provider: string
  contextLength: number
  pricing: { prompt: number; completion: number }
}

// --- Plugin normalizers (mirrors Plugins.tsx) ---

export function normalizeInstalled(raw: unknown): Plugin[] {
  if (Array.isArray(raw)) return raw as Plugin[]
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { installed?: unknown }).installed)
  ) {
    return (raw as { installed: Plugin[] }).installed
  }
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { plugins?: unknown }).plugins)
  ) {
    return (raw as { plugins: Plugin[] }).plugins
  }
  return []
}

export function normalizeAvailable(raw: unknown): AvailablePlugin[] {
  if (Array.isArray(raw)) return raw as AvailablePlugin[]
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { available?: unknown }).available)
  ) {
    return (raw as { available: AvailablePlugin[] }).available
  }
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { plugins?: unknown }).plugins)
  ) {
    return (raw as { plugins: AvailablePlugin[] }).plugins
  }
  return []
}

export function normalizeTools(raw: unknown): ActiveTool[] {
  if (Array.isArray(raw)) return raw as ActiveTool[]
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { tools?: unknown }).tools)
  ) {
    return (raw as { tools: ActiveTool[] }).tools
  }
  return []
}

// --- Perf normalizers (mirrors Perf.tsx) ---

export function normalizeMetrics(raw: unknown): PerfMetrics | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  const pick = (key: keyof PerfMetrics) =>
    typeof m[key] === 'number' ? (m[key] as number) : undefined
  return {
    cpu: pick('cpu'),
    memory: pick('memory'),
    rps: pick('rps'),
    p50: pick('p50'),
    p95: pick('p95'),
  }
}

// --- Eval normalizers：把后端真实形状映射为前端展示形状（2026-10-22 修复）---

const toFiniteNumber = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

/** 宽松数值解析：后端 pricing 是 USD 字符串（如 "0.00001"），也接受 number。 */
const toNumber = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** ModelEvalResult[] → EvalResult[]（模型名取 modelId，质量取 scores.capability）。 */
export function normalizeEvalResults(raw: unknown): EvalResult[] {
  if (!Array.isArray(raw)) return []
  const out: EvalResult[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as {
      modelId?: unknown
      provider?: unknown
      evaluatedAt?: unknown
      scores?: { overall?: unknown; capability?: unknown; speed?: unknown; cost?: unknown; safety?: unknown }
    }
    if (typeof r.modelId !== 'string' || !r.modelId) continue
    const scores = r.scores && typeof r.scores === 'object' ? r.scores : {}
    out.push({
      id: r.modelId,
      provider: typeof r.provider === 'string' ? r.provider : '',
      overall: toFiniteNumber(scores.overall),
      quality: toFiniteNumber(scores.capability),
      speed: toFiniteNumber(scores.speed),
      cost: toFiniteNumber(scores.cost),
      safety: toFiniteNumber(scores.safety),
      lastEvaluated: typeof r.evaluatedAt === 'string' ? r.evaluatedAt : '',
    })
  }
  return out
}

/** DynamicAssignment[] → EvalAssignment[]（role 由 assignedRoles 连接，score 取 evalScore）。 */
export function normalizeEvalAssignments(raw: unknown): EvalAssignment[] {
  if (!Array.isArray(raw)) return []
  const out: EvalAssignment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const a = item as {
      modelId?: unknown
      provider?: unknown
      model?: unknown
      assignedRoles?: unknown
      evalScore?: unknown
      evaluatedAt?: unknown
    }
    if (typeof a.modelId !== 'string' || !a.modelId) continue
    const roles = Array.isArray(a.assignedRoles)
      ? a.assignedRoles.filter((r): r is string => typeof r === 'string')
      : []
    out.push({
      id: a.modelId,
      role: roles.join(' / '),
      model: typeof a.model === 'string' ? a.model : a.modelId,
      provider: typeof a.provider === 'string' ? a.provider : '',
      score: toFiniteNumber(a.evalScore),
      lastAssigned: typeof a.evaluatedAt === 'string' ? a.evaluatedAt : '',
    })
  }
  return out
}

/** OpenRouterModelInfo[] → EvalModel[]（pricing 字符串转 number，context_length → contextLength）。 */
export function normalizeEvalModels(raw: unknown): EvalModel[] {
  if (!Array.isArray(raw)) return []
  const out: EvalModel[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const m = item as {
      id?: unknown
      name?: unknown
      pricing?: { prompt?: unknown; completion?: unknown }
      context_length?: unknown
    }
    if (typeof m.id !== 'string' || !m.id) continue
    out.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : m.id,
      provider: m.id.includes('/') ? m.id.split('/')[0] : '',
      contextLength: toNumber(m.context_length),
      pricing: {
        prompt: toNumber(m.pricing?.prompt),
        completion: toNumber(m.pricing?.completion),
      },
    })
  }
  return out
}
