# Item 6: 路由注册表 export * 替换为显式导出

## Problem
`src/router/models.ts:11` uses `export * from "./models/index.js"` which can cause silent naming conflicts and pulls in more than needed.

## Fix
Replace with explicit named exports matching what `models/index.js` actually exports.

```typescript
export type { ModelProvider, TaskRole, UnifiedModel, ProviderConfig } from "./models/types.js";
export { PROVIDER_CONFIG, isProviderConfigured, listConfiguredProviders } from "./models/providers.js";
export { UNIFIED_REGISTRY, findModelsForRole, getModel, getFallbackChain, listFreeModels, listAllModels, listAllRoles } from "./models/registry.js";
```

## Files
Only `src/router/models.ts`

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all pass
