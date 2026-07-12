# Task 5: CLI Integration

**Files:**
- Modify: `src/cli/commands/knowledge.ts` — add `handleKnowledgePipeline` export
- Modify: `src/cli.ts` — add import and command entry

**Global Constraints:** TypeScript/Bun, no secrets committed, tests pass.

## Changes

### 1. `src/cli/commands/knowledge.ts`

Add import at top:
```typescript
import { runPipeline } from "../../knowledge/pipeline.js"
```

Add function after existing handlers:
```typescript
export async function handleKnowledgePipeline(args: string[]): Promise<void> {
  const flags: Record<string, string> = {}
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=")
      flags[k] = v ?? "true"
    }
  }

  const result = await runPipeline({
    githubTrending: flags["github"] === "true",
    bookTopics: flags["topics"] ? flags["topics"].split(",") : undefined,
    pdfWorkerUrl: flags["pdf-worker"] || undefined,
    convertPdf: flags["convert"] === "true",
  })

  console.log(`\nPipeline Results:`)
  console.log(`  GitHub repos:  ${result.githubReposCollected}`)
  console.log(`  Books:         ${result.booksDiscovered}`)
  console.log(`  PDFs converted: ${result.pdfsConverted}`)
  console.log(`  Notes written: ${result.notesWritten}`)
  console.log(`  Duration:      ${(result.durationMs / 1000).toFixed(1)}s`)
  if (result.errors.length > 0) {
    console.log(`  Errors:        ${result.errors.length}`)
    for (const e of result.errors) console.log(`    - ${e}`)
  }
}
```

### 2. `src/cli.ts`

Add to existing import (line 63-65):
```typescript
  handleKnowledgePipeline,
```

Add command entry after `knowledge:stats`:
```typescript
"knowledge:pipeline": {
  desc: "运行完整知识采集管道 (knowledge:pipeline --github --topics=ml,algorithms --pdf-worker=http://192.168.2.11:8000)",
  run: async (args) => { await handleKnowledgePipeline(args); },
},
```

Add to subcommand group (around line 1209-1211):
```typescript
pipeline: commands["knowledge:pipeline"],
```

## Steps
1. Edit `src/cli/commands/knowledge.ts` — add import + handler function
2. Edit `src/cli.ts` — add import, command entry, subcommand entry
3. Test: `bun run src/cli.ts knowledge pipeline --help` — should show usage
4. Test: `bun run src/cli.ts knowledge pipeline --github` — should run trending collection
5. Run full suite to confirm no regressions: `bun test --timeout=60000 --filter="src/" 2>&1 | tail -5`
6. Commit: `git add src/cli.ts src/cli/commands/knowledge.ts && git commit -m "feat(cli): add knowledge:pipeline command"`
