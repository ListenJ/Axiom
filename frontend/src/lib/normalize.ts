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

export interface EvalResult {
  id: string
  provider: string
  overall: number
  quality: number
  speed: number
  cost: number
  lastEvaluated: string
}

export interface EvalAssignment {
  id: string
  role: string
  model: string
  provider: string
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

/**
 * The native endpoint sometimes returns raw HTML in dev; only keep structured
 * payloads (arrays/objects). Anything else is treated as "no data".
 */
export function normalizeNative(raw: unknown): unknown {
  if (typeof raw === 'string') return null
  if (Array.isArray(raw) || (raw && typeof raw === 'object')) return raw
  return null
}

// --- Eval normalizers (mirrors Eval.tsx) ---

export function normalizeEvalResults(raw: unknown): EvalResult[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (item && typeof item === 'object' ? (item as EvalResult) : null))
    .filter((r): r is EvalResult => Boolean(r && r.id && typeof r.overall === 'number'))
}

export function normalizeEvalAssignments(raw: unknown): EvalAssignment[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (item && typeof item === 'object' ? (item as EvalAssignment) : null))
    .filter((a): a is EvalAssignment => Boolean(a && a.id && typeof a.score === 'number'))
}

export function normalizeEvalModels(raw: unknown): EvalModel[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (item && typeof item === 'object' ? (item as EvalModel) : null))
    .filter((m): m is EvalModel => Boolean(m && m.id && typeof m.contextLength === 'number'))
}
