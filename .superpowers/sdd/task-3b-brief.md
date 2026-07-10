# Task 3b: Utils 层级违规 — api-key-store.ts 解除 router/models.ts 依赖

## Problem
`src/utils/api-key-store.ts:20` imports `PROVIDER_CONFIG` and `type ModelProvider` from `../router/models.js` — layer violation.

## What PROVIDER_CONFIG is used for
Two uses:
1. Line 115: `Object.entries(PROVIDER_CONFIG)` iterates to build status list (using `cfg.apiKeyEnv` and `cfg.baseURL`)
2. Line 143-144: `isKnownProvider` checks `provider in PROVIDER_CONFIG`

## Approach
Instead of importing the full `PROVIDER_CONFIG` from the router, define a local configuration map with only the fields needed (`apiKeyEnv`, `baseURL`).

```typescript
interface ProviderEntry {
  apiKeyEnv: string;
  baseURL: string;
}

const PROVIDER_CONFIG: Record<string, ProviderEntry> = {
  siliconflow: { apiKeyEnv: "SILICONFLOW_API_KEY", baseURL: "https://api.siliconflow.cn/v1" },
  ofoxai: { apiKeyEnv: "OFOXAI_API_KEY", baseURL: "https://api.ofox.ai/v1" },
  openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" },
  deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY", baseURL: "https://api.deepseek.com/v1" },
  kimi: { apiKeyEnv: "KIMI_API_KEY", baseURL: "https://api.moonshot.cn/v1" },
  minimax: { apiKeyEnv: "MINIMAX_API_KEY", baseURL: "https://api.minimax.chat/v1" },
  nim: { apiKeyEnv: "NIM_API_KEY", baseURL: "https://integrate.api.nvidia.com/v1" },
};
```

Replace `import { PROVIDER_CONFIG, type ModelProvider }` with the local map.
Also define `type ModelProvider = keyof typeof PROVIDER_CONFIG;` locally.

## Files
Only `src/utils/api-key-store.ts`

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all tests pass  
- `grep -r "from.*router/" src/utils/` — 0 results
