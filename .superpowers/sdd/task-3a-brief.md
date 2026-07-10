# Task 3a: Utils 层级违规 — read-optimizer.ts 解除 memory/blackboard.ts 依赖

## Problem
`src/utils/read-optimizer.ts:33` imports `getGlobalBlackboard` from `../memory/blackboard.js` — layer violation (utils → memory).

## Approach
Inject blackboard via `ReadOptimizerFacade` constructor instead of calling `getGlobalBlackboard()`.

## Files to Modify

### `src/utils/read-optimizer.ts`
Line 33 currently:
```typescript
import { getGlobalBlackboard, type ReadOptions, type ReadResult } from "../memory/blackboard.js";
```
Change to only import the types:
```typescript
import type { ReadOptions, ReadResult } from "../memory/blackboard.js";
```

The `ReadOptimizerFacade` constructor at line 99:
```typescript
constructor(options?: { cacheMaxSize?: number; defaultTtlMs?: number; redis?: boolean })
```
Add an optional `blackboard` parameter. Store it as a private field.

The `readFromBlackboard` method at line 455:
```typescript
private readFromBlackboard(request: ReadRequest): ReadResult {
    const bb = getGlobalBlackboard();
    ...
}
```
Change to use `this.blackboard` instead of `getGlobalBlackboard()`:
```typescript
private readFromBlackboard(request: ReadRequest): ReadResult {
    const bb = this.blackboard;
    if (!bb) throw new Error("Blackboard not injected");
    ...
}
```

### `src/main.ts` (line ~170)
When initializing read optimizers, import `getGlobalBlackboard` from `../memory/blackboard.js` (higher level is fine) and pass it.

Look for:
```typescript
const { getReadOptimizer } = await import("./utils/read-optimizer.js");
```
Change to also pass blackboard when constructing the facade.

### Other callers
All callers use `getReadOptimizer()` singleton pattern:
- `src/routes/vault.ts:6`
- `src/agents/opencode-tool-agent.ts:29`
- `src/agents/opencode-agent.ts:253`
- `src/utils/read-optimizer-init.ts:14`

These call `getReadOptimizer()` which returns the singleton. If the facade already exists (initialized in main.ts), these callers don't need changes — they use the singleton that was already wired with blackboard.

## Testing
- `bun run lint` — 0 errors (tsc --noEmit)
- `bun test:core` — all tests pass
- `grep -r "from.*memory/blackboard" src/utils/` — must return 0 results
