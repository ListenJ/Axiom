# @deprecated 仍有调用者 — dre/engine.ts

## Problem
`src/dre/engine.ts` has 6 `@deprecated` methods that still have callers:
- Line 380: `searchKnowledge()` — called from `src/mcp/server.ts` (or server/dre-tools.ts)
- Line 439-466: `createPlannerAgent`, `createCoderAgent`, `createRetrieverAgent`, `createReflectorAgent` — deprecation comment says use `createAgent` (Persona-based)

Also:
- `src/dre/index.ts:28` — `@deprecated` export
- `src/dre/harness/agent.ts:4` — entire file deprecated

## Approach
1. Check each deprecated function for actual callers
2. If callers exist, update them to use the recommended replacement
3. If no callers exist beyond the deprecated re-export chain, remove the functions

## Files
- `src/dre/engine.ts`
- `src/dre/index.ts`
- `src/dre/harness/agent.ts`
- Any file calling the deprecated functions

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all pass
