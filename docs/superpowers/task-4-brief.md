# Task 4: Pipeline Orchestrator

**Files:**
- Create: `src/knowledge/pipeline.ts`
- Modify: `src/knowledge/index.ts`

**Interfaces:**
- Consumes: `discoverGitHubRepos`, `formatTrendingTable` from `./sources/github-trending.js`, `discoverBooks`, `getPdfUrl` from `./sources/z-library.js`, `getGlobalVault` from `../memory/vault-manager.js`, `createPdfWorkerClient` from `../workers/pdf-worker.js`
- Produces: `runPipeline(opts) → PipelineResult`
- Types: `PipelineOptions`, `PipelineResult`

**Global Constraints:** TypeScript/Bun, no secrets committed, tests pass.

## Code to write

### `src/knowledge/pipeline.ts`

This file has 3 parts:

**Part 1: GLM content structuring helper** — Read plan lines 675-756 for:
- `ZHIPU_API_BASE` constant
- `STRUCTURE_SYSTEM_PROMPT` constant
- `StructureResult` interface
- `structureWithGLM(rawMarkdown)` function

**Part 2: Pipeline types and `runPipeline`** — Read plan lines 760-856 for:
- `PipelineOptions` interface
- `PipelineResult` interface  
- `runPipeline(opts)` function with:
  - GitHub trending section (writes to Vault note)
  - Book discovery section (writes to Vault note)
  - PDF conversion section (uses PdfWorkerClient if available, calls structureWithGLM, writes dataset + vault)

**Part 3: Update `src/knowledge/index.ts`** — Add:
```typescript
export { runPipeline } from "./pipeline.js"
export type { PipelineOptions, PipelineResult } from "./pipeline.js"
```

### `tests/knowledge/pipeline.test.ts`

Read plan lines 719-730 for test code:
```typescript
import { describe, it, expect, afterAll } from "bun:test"
import { runPipeline } from "../../src/knowledge/pipeline.js"

afterAll(async () => {
  const vault = (await import("../../src/memory/vault-manager.js")).getGlobalVault()
  try { await vault.deleteNote("00-Knowledge/GitHub/trending") } catch {}
  try { await vault.deleteNote("00-Knowledge/Books") } catch {}
})

describe("Pipeline", () => {
  it("runs with empty options without crashing", async () => {
    const result = await runPipeline({})
    expect(result.errors).toBeArray()
    expect(result.durationMs).toBeGreaterThan(0)
  })
  it("runs GitHub trending collection", async () => {
    const result = await runPipeline({ githubTrending: true })
    expect(result.errors.length).toBe(0)
  })
  it("discovers books for a topic without crashing", async () => {
    const result = await runPipeline({ bookTopics: ["machine learning"] })
    expect(result.errors.length).toBe(0)
  })
})
```

## Implementation notes
- The full source code is in the plan file at lines 675-856 (pipeline.ts) and 719-730 (tests)
- The `structureWithGLM` function and the PDF conversion code is inline commented in the pipeline — include it but make it conditional on `opts.convertPdf && opts.pdfWorkerUrl`
- Use `import { join } from "path"` for dataset path construction
- Dataset JSONL should go in `data/dataset/{topic}.jsonl`

## Steps
1. Create `src/knowledge/pipeline.ts`
2. Update `src/knowledge/index.ts`
3. Create `tests/knowledge/pipeline.test.ts`
4. Run: `bun test tests/knowledge/pipeline.test.ts`
5. Commit: `git add src/knowledge/pipeline.ts tests/knowledge/pipeline.test.ts src/knowledge/index.ts && git commit -m "feat(knowledge): add pipeline orchestrator with GLM content structuring"`
