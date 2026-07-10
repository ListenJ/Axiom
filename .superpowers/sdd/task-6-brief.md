# Task 6: 收尾 — as any 类型逃逸修复

## Problem
59 `as any` casts across the codebase. ~20 are for Bun internal APIs and SQLite row types (legitimate). ~39 can be fixed with proper types.

## Focus on these files (prioritized by impact):

### Priority 1: tools/ (easy wins, test-covered)

1. `src/tools/read-tool.ts:55,78` — `store.get("vaultManager") as any`
   - Fix: define or import the types from vault-manager
   ```typescript
   const vault = store.get("vaultManager") as import("../../memory/vault-manager.js").VaultManager;
   ```

2. `src/tools/write-tool.ts:61` — same pattern

3. `src/tools/query-tool.ts:49,50,88` — `store.get(...) as any`
   - Use proper type assertions:
   ```typescript
   const vault = store.get("vaultManager") as VaultManager;
   const kg = store.get("knowledgeGraph") as KnowledgeGraph;
   ```

4. `src/services/knowledge.ts:73` — `result.stepResults[0] as any`
   ```typescript
   const queryOutput = result.stepResults[0] as QueryOutput;
   ```

### Priority 2: core/ and route files

5. `src/core/config-center.ts:577` — `(cc as any).yamlData`
   - Fix: make `yamlData` accessible or add an accessor method

### Priority 3: others (need domain knowledge)

6. `src/cli.ts:1228,1232,1295,1301,1317` — various as any
7. `src/db/pg-client.ts:145,181` — SQLite row results
8. `src/dre/presets.ts:68,81,100,101,115` — LLM presets

## Files to fix
- `src/tools/read-tool.ts`
- `src/tools/write-tool.ts`
- `src/tools/query-tool.ts`
- `src/services/knowledge.ts`
- `src/core/config-center.ts`
- `src/cli.ts`
- `src/db/pg-client.ts`

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all tests pass

Do NOT commit. Report Status, files changed, test results.