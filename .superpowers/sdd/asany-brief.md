# as any 残余修复

## Target files

### `src/agents/computer-use-agent.ts` (8 as any)
Lines 194-198: `(resolvedAction as any).x/y/text/keys/ms`
Lines 259: `(lastAction as any).ms`
Lines 457-461: `(action as any).elementIndex`

Fix: Add proper interfaces for the action types instead of as any.
```typescript
interface ResolvedAction {
  x?: number; y?: number; text?: string; keys?: string[]; ms?: number;
  elementIndex?: number;
}
```

### `src/agents/opencode-tool-agent.ts` (1 as any)
Line 379: `(s.value.result as any).provider`
Fix: Properly type the result.

## Files
- `src/agents/computer-use-agent.ts`
- `src/agents/opencode-tool-agent.ts`

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all pass
