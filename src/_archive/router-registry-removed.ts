/**
 * ARCHIVED: 路由注册表冗余函数
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
 * 如需恢复，将下面代码合并回 registry.ts。
 */
