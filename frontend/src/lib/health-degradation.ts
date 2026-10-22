/**
 * P3.5C：/health 降级信息的展示模型（纯函数，可单测）
 *
 * P2.1/D3=C1 给 `/health` 增加了 `toolRuntime` / `sceneRouter` / `security.secondFactor` 三个
 * 降级可见字段，但前端一直没消费——运维/用户只能在接口里看到。本模块把「后端真实降级状态」
 * 折叠成一行可展示的原因摘要（不制造新状态、不改变任何接口语义）。
 *
 * 约定：这些字段缺失（旧后端 / 部分响应）时按「无降级」处理，不得凭空报降级。
 */
export interface ToolRuntimeHealth {
  vault?: string
  searchEngine?: string
  degraded?: string[]
}

export interface SceneRouterHealth {
  totalScenes?: number
  availableScenes?: number
  degraded?: boolean
  missingTools?: string[]
}

export interface SecondFactorHealth {
  configured?: boolean
  writeTier?: string
  readTier?: string
  missingEnv?: string
}

export interface HealthPayload {
  status?: string
  version?: string
  uptime?: number
  toolRuntime?: ToolRuntimeHealth
  sceneRouter?: SceneRouterHealth | null
  security?: { secondFactor?: SecondFactorHealth }
}

export interface HealthDegradation {
  degraded: boolean
  reasons: string[]
  /** 单行摘要，用于 title / aria-label */
  summary: string
}

const TOOL_RUNTIME_REASONS: Record<string, string> = {
  'vault-unavailable': '记忆库不可用',
  'search-engine-unavailable': '统一搜索不可用',
}

/** 把 /health 的降级字段折叠为可展示原因；无降级时 reasons 为空。 */
export function summarizeHealthDegradation(health: HealthPayload | null | undefined): HealthDegradation {
  const reasons: string[] = []

  const runtime = health?.toolRuntime
  if (runtime) {
    const degraded = runtime.degraded ?? []
    for (const code of degraded) {
      reasons.push(TOOL_RUNTIME_REASONS[code] ?? `工具运行时降级（${code}）`)
    }
    // 防御式补充：即使没有 degraded 数组，状态字段为 unavailable 也算降级
    if (runtime.vault === 'unavailable' && !degraded.includes('vault-unavailable')) reasons.push('记忆库不可用')
    if (runtime.searchEngine === 'unavailable' && !degraded.includes('search-engine-unavailable')) {
      reasons.push('统一搜索不可用')
    }
  }

  const scene = health?.sceneRouter
  if (scene?.degraded) {
    reasons.push(`场景降级（${scene.availableScenes ?? 0}/${scene.totalScenes ?? 0} 可用）`)
  }

  const secondFactor = health?.security?.secondFactor
  if (secondFactor && secondFactor.configured === false) {
    reasons.push('二因子未配置（只读放行）')
  }

  const unique = [...new Set(reasons)]
  return { degraded: unique.length > 0, reasons: unique, summary: unique.join(' · ') }
}
