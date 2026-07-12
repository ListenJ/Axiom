# Task 2: GitHub Trending + API Search

**Files:**
- Create: `src/knowledge/sources/index.ts`
- Create: `src/knowledge/sources/github-trending.ts`
- Create: `tests/knowledge/sources/github-trending.test.ts`

**Interfaces:**
- Consumes: `logger` from `../../utils/logger.js`, `process.env.GITHUB_TOKEN`
- Produces: `fetchGitHubTrending(language?, since?) → TrendingRepo[]`, `searchHighPotentialRepos(opts?) → TrendingRepo[]`, `discoverGitHubRepos(opts?) → TrendingRepo[]`, `formatTrendingTable(repos) → string`

**Global Constraints:**
- All TypeScript, Bun runtime
- No secrets committed
- Tests must pass with `bun test`

## Code to write

### `src/knowledge/sources/github-trending.ts`

Contains all the code from the plan at lines 265-441 of the plan file. Key functions:
- `TrendingRepo` interface
- `fetchGitHubTrending()` — scrape github.com/trending
- `searchHighPotentialRepos()` — GitHub API search
- `discoverGitHubRepos()` — combine + dedup
- `formatTrendingTable()` — markdown table

### `src/knowledge/sources/index.ts`

```typescript
export { fetchGitHubTrending, searchHighPotentialRepos, discoverGitHubRepos, formatTrendingTable } from "./github-trending.js"
export type { TrendingRepo } from "./github-trending.js"
```

### `tests/knowledge/sources/github-trending.test.ts`

```typescript
import { describe, it, expect } from "bun:test"
import { formatTrendingTable } from "../../../src/knowledge/sources/github-trending.js"
import type { TrendingRepo } from "../../../src/knowledge/sources/github-trending.js"

describe("formatTrendingTable", () => {
  it("formats repos as markdown table", () => {
    const repos: TrendingRepo[] = [
      { name: "test-repo", fullName: "org/test-repo", url: "https://github.com/org/test-repo", description: "A test repo", language: "TypeScript", stars: 1000, forks: 50, starsToday: 100, topics: [], source: "api-search" },
    ]
    const table = formatTrendingTable(repos)
    expect(table).toContain("| 1 | [org/test-repo]")
    expect(table).toContain("TypeScript")
    expect(table).toContain("1000")
  })

  it("returns header for empty list", () => {
    const table = formatTrendingTable([])
    expect(table).toContain("Repository")
  })
})

describe("discoverGitHubRepos", () => {
  it("returns empty array without token (API) but will still scrape trending", async () => {
    const { discoverGitHubRepos } = await import("../../../src/knowledge/sources/github-trending.js")
    const repos = await discoverGitHubRepos({ limit: 3 })
    expect(Array.isArray(repos)).toBe(true)
  })
})
```

## Steps
1. Create `src/knowledge/sources/github-trending.ts` with all 4 functions
2. Create `src/knowledge/sources/index.ts` with barrel export
3. Create `tests/knowledge/sources/` directory and the test file
4. Run `bun test tests/knowledge/sources/github-trending.test.ts`
5. Commit: `git add src/knowledge/sources/ tests/knowledge/sources/ && git commit -m "feat(knowledge): add GitHub trending scraper + API search"`
