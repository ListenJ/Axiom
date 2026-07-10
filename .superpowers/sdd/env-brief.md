# process.env 其他文件收口

## Problem
~30 `process.env.X` reads still scattered across files outside main.ts.

## Target files (with env reads remaining)

### Priority 1: `src/cli.ts` (6 reads)
```typescript
process.env.DATABASE_PATH
process.env.SILICONFLOW_API_KEY
process.env.OFOXAI_API_KEY
process.env.OPENROUTER_API_KEY
process.env.DEEPSEEK_API_KEY
process.env.KIMI_CODE_API_KEY
process.env.KIMI_CODE_BASE_URL
```
→ These should use readString() or config-center. But cli.ts doesn't import from utils/env.ts.

### Priority 2: `src/crawl/data-pipeline.ts`, `src/db/pg-client.ts`, `src/memory/bootstrap.ts`, `src/eval/`
Various `process.env.DATABASE_PATH`, `process.env.PG_HOST`, etc.

### Priority 3: `src/mcp/server.ts`, `src/mcp/tools/*`, `src/agents/*`
Various agent config env vars.

## Approach
For each file, either:
1. Add `import { readString, readInt } from "../utils/env.js"` and replace
2. Or use `getConfigCenter().getString("xxx")` if config-center has the key

Start with priority 1 (cli.ts) then work down.

## Files to modify
- `src/cli.ts`
- `src/db/pg-client.ts`
- `src/memory/bootstrap.ts`
- `src/eval/judge.ts`
- `src/eval/eval-runner.ts`
- `src/utils/security.ts`
- `src/utils/approval-bridge.ts`
- `src/utils/lazy-singleton.ts`
- `src/agents/opencode-agent.ts`
- `src/agents/opencode-tool-agent.ts`
- `src/crawl/data-pipeline.ts`
- `src/crawl/search-engines.ts`
- `src/crawl/serpapi-client.ts`
- `src/memory/archiver.ts`
- `src/memory/sqlite-memory.ts`
- `src/memory/knowledge-graph-builder.ts`
- `src/utils/logger.ts` — leave these (LOG_LEVEL is legitimate direct env access)

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all pass
