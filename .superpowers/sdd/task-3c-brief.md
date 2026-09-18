# Task 3c: Utils 层级违规 — read-optimizer-init.ts 解除 codegraph + pi-agent 依赖

## Problem
`src/utils/read-optimizer-init.ts:16-23` imports from `../memory/codegraph-index.js`
`src/utils/read-optimizer-init.ts:24` imports from `../pi-agent/pi-code-tools.js`

Both are layer violations (utils → memory, utils → pi-agent).

## Approach
Pass these dependencies as a parameter object to `initializeReadOptimizers()`.

## Files to Modify

### `src/utils/read-optimizer-init.ts`

Change the function signature:
```typescript
// Before:
export function initializeReadOptimizers(cwd?: string): void {

// After:
export interface ReadOptimizerDeps {
  searchSymbols?: (query: string, opts?: any) => Promise<any[]>;
  searchFiles?: (pattern: string, opts?: any) => Promise<any[]>;
  buildContext?: (task: string, opts?: any) => Promise<any>;
  getCallers?: (symbol: string, opts?: any) => Promise<any[]>;
  getCallees?: (symbol: string, opts?: any) => Promise<any[]>;
  getImpact?: (symbol: string, opts?: any) => Promise<any>;
  getStatus?: (projectPath?: string) => Promise<any>;
  PiCodeToolsAdapter?: new (workDir: string) => any;
}

export function initializeReadOptimizers(cwd?: string, deps?: ReadOptimizerDeps): void {
```

When calling the codegraph functions, use `deps?.searchSymbols ?? searchSymbols` (fallback to local import if no deps provided, for backward compatibility). OR more strictly: require deps and remove the local imports entirely.

Since we want to clean the layer violation, use the strict approach:
- Remove all direct imports from `../memory/codegraph-index.js` and `../pi-agent/pi-code-tools.js`
- Use `deps.xxx` instead of `searchSymbols(...)` etc.
- If `deps` is not provided, throw an error

### `src/main.ts` (around line 73)
Change:
```typescript
import { initializeReadOptimizers } from "./utils/read-optimizer-init.js";
```
To pass the deps object:
```typescript
import { initializeReadOptimizers } from "./utils/read-optimizer-init.js";
import {
  searchSymbols, searchFiles, buildContext,
  getCallers, getCallees, getImpact, getStatus,
} from "./memory/codegraph-index.js";
import { PiCodeToolsAdapter } from "./pi-agent/pi-code-tools.js";
```

Then at the call site:
```typescript
initializeReadOptimizers(cwd, {
  searchSymbols, searchFiles, buildContext,
  getCallers, getCallees, getImpact, getStatus,
  PiCodeToolsAdapter,
});
```

### `src/agents/opencode-agent.ts` (around line 258)
Same pattern — pass the same deps object.

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all tests pass
- `grep -r "from.*memory/codegraph\|from.*pi-agent/" src/utils/` — 0 results
