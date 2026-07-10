# Task 5: 收口高频 process.env 直读

## Problem
`src/main.ts` has ~18 direct `process.env.X` reads scattered throughout. These bypass the centralized `readString()`/`readInt()` from `src/utils/env.ts`.

## Approach
Replace `process.env.X || default` patterns with `readString()`/`readInt()` calls.

## Common patterns to replace in main.ts

```typescript
// Before:
const val = process.env.XXX || "default";

// After:
import { readString, readInt } from "./utils/env.js";
const val = readString("XXX", "default");
```

Or if config-center already has the key:
```typescript
const val = getConfigCenter().getString("xxx");
```

## Specific replacements needed (search main.ts for each):

1. `process.env.AXIOM_NATIVE` → readString
2. `process.env.OBSIDIAN_VAULT_PATH` → readString
3. `process.env.DATABASE_PATH` → readString
4. `process.env.DATABASE_URL` → readString
5. `process.env.REDIS_URL` → readString
6. `process.env.NODE_ENV` → readString
7. `process.env.CONSCIOUSNESS_ENABLED` → readString
8. `process.env.MAX_BODY_SIZE` → readInt
9. `process.env.CORS_ORIGINS` → readString
10. `process.env.CORS_CREDENTIALS` → readString
11. `process.env.AXIOM_AUTH_TOKEN` → readString
12. `process.env.HOST` → readString
13. `process.env.AXIOM_GATEWAY_PORT` → readInt
14. `process.env.AXIOM_BIND` → readString

## Files
Only `src/main.ts`

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all tests pass

Do NOT commit. Report Status, files changed, test results.