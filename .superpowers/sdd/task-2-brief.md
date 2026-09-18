# Task 2: VaultManager 统一单例化

## Problem
6 places in the codebase use `new VaultManager()` which opens new SQLite connections each time, causing connection leaks since `close()` is never called.

## Files to Modify
- `src/cli.ts:333,352,368,381,398` — 5 instances of `new VaultManager()`
- `src/crawl/data-pipeline.ts:794` — 1 instance
- `src/launcher.ts:198` — 1 instance
- `src/mcp/server.ts:113` — 1 instance

All 8 instances across 4 files must be changed.

## Fix
Replace `new VaultManager()` with `getGlobalVault()` (singleton from `vault-manager.ts:753-758`). Update import statements accordingly.

Before:
```typescript
import { VaultManager } from "../memory/vault-manager.js";
const vault = new VaultManager();
```

After:
```typescript
import { getGlobalVault } from "../memory/vault-manager.js";
const vault = getGlobalVault();
```

## Testing
- Run `bun test:core` — all 108 tests must pass
- Run `bun run lint` (tsc --noEmit) — 0 errors
- Verify: `grep -r "new VaultManager()" src/` should return only the singleton definition in `vault-manager.ts:756`
