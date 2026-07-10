/**
 * ARCHIVED: 路由注册表冗余函数 & DRE 弃用导出
 *
 * 这些函数在 2026-07-10 的路由注册表合并中被删除：
 *
 * 1. getModelsForTask(task)
 *    - 原位置: src/router/models/registry.ts
 *    - 原因: 0 内部调用者，已被 findModelsForRole 替代
 *    - 签名: (task: string) => UnifiedModel[]
 *
 * 2. getProviderConfig(modelId)
 *    - 原位置: src/router/models/registry.ts
 *    - 原因: 0 内部调用者
 *    - 签名: (modelId: string) => ProviderConfig | undefined
 *
 * 3. isProviderConfigured(provider)
 *    - 原位置: src/router/models/registry.ts
 *    - 原因: 与 src/router/models/providers.ts 完全重复
 *    - 签名: (provider: ModelProvider) => boolean
 *    - 注意: canonical 版本在 providers.ts:51
 *
 * 4. listConfiguredProviders()
 *    - 原位置: src/router/models/registry.ts
 *    - 原因: 与 src/router/models/providers.ts 完全重复
 *    - 签名: () => ModelProvider[]
 *    - 注意: canonical 版本在 providers.ts:58
 *
 * ─────────────────────────────────────────────
 * 2026-07-10 (第二批): 弃用导出清理
 *
 * 5. GPU_CONSTRAINTS (export)
 *    - 原位置: src/dre/constraint/solver.ts:538
 *    - 原因: @deprecated — 使用 RESOURCE_CONSTRAINTS 替代, 0 外部调用者
 *    - 签名: Constraint[]
 *    - 定义仍留在 solver.ts 中, export 移除
 *
 * 6. findModelsForRole (export from registry.ts)
 *    - 原位置: src/router/models/registry.ts:976
 *    - 原因: @deprecated — 使用 model-capability-registry.ts 版本替代, 0 外部调用者
 *    - 签名: (role: TaskRole) => UnifiedModel[]
 *    - 定义仍留在 registry.ts 中 (被 getFallbackChain 内部使用), export 移除
 *
 * 如需恢复, 将上面 export 加回对应源文件。
 */
