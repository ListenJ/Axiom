# 拆 GitHub 工具块 (~650行) 从 mcp/server.ts

## Problem
`src/mcp/server.ts` has ~650 lines of inline GitHub tool registrations (~lines 386-1036). These should be extracted to `src/mcp/server/github-tools.ts`.

## Approach
Follow the existing pattern from other `server/*-tools.ts` files. Create a `registerGitHubTools(registry, deps)` factory function.

## Look for in server.ts
The GitHub tools start around line 386 with `// -- GitHub MCP 工具` and continue for ~650 lines. They register tools like:
- `github_list_repos`, `github_get_repo`, `github_create_repo`, `github_fork_repo`
- `github_list_issues`, `github_create_issue`, `github_add_issue_comment`
- `github_list_prs`, `github_get_pr`, `github_create_pr`, `github_review_pr`, `github_get_pr_files`
- `github_get_file_contents`, `github_list_directory`, `github_search_code`
- `github_list_releases`, `github_create_release`
- `github_list_workflows`, `github_trigger_workflow`, `github_list_workflow_runs`, `github_get_workflow_run`
- `github_health`, `github_info`, `github_get_issue`

Dependencies from server.ts:
- `z` (zod)
- `registry` (ToolRegistry)
- GitHub functions imported at top (`listRepos`, `getRepo`, `createRepo`, etc. from `./tools/github.js`)

Create the file with:
```typescript
import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
// import all GitHub functions
import { listRepos, getRepo, createRepo, ... } from "../tools/github.js";

export function registerGitHubTools(registry: ToolRegistry): void {
  registry.add({ name: "github_list_repos", ... });
  // ... all ~30 tools
}
```

Then in server.ts, replace the inline block with:
```typescript
import { registerGitHubTools } from "./server/github-tools.js";
// ...
registerGitHubTools(registry);
```

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all pass
- Tool names must remain identical
