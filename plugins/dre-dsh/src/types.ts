/**
 * axiom-dre-dsh —— 与 DeepSeek Harness (dsh) 运行面的最小结构性类型。
 *
 * 刻意不与 @deepseek-ai/cordis / @deepseek-ai/dsh-tools 强绑定：
 * dsh 处于 developer preview、API 迭代快，本插件只用「注册工具 / effect /
 * 可选服务注入」这几个稳定接缝，按鸭子类型对齐即可，运行时由 dsh 侧校验。
 */

/** dsh ToolDefinition 的结构性子集（与 @deepseek-ai/dsh-tools 对齐）。 */
export interface DshToolDefinition {
  name: string
  description: string
  /** JSON Schema 对象；dsh-tools 的 parameters DSL 兼容 JSON Schema。 */
  parameters: Record<string, unknown>
  output: {
    schema?: Record<string, unknown>
    render?: (args: Record<string, unknown>, value: unknown) => Array<{ type: string; text: string }>
  }
  execute: (args: Record<string, unknown>, exec?: { signal?: AbortSignal }) => Promise<unknown>
}

/** dsh Context 的结构性子集（@deepseek-ai/cordis）。 */
export interface DshContext {
  logger: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
    debug?(...args: unknown[]): void
  }
  tools: {
    register(definition: DshToolDefinition): () => void
  }
  /** Cordis effect：注册随 fiber 清理的资源；返回 cleanup。 */
  effect(register: () => void | (() => void), label?: string): void
  /** 可选服务就绪后挂载子上下文（如 webServer）。 */
  inject(services: string[], mount: (child: DshContext) => void): void
  get<T = unknown>(key: string): T | undefined
}
