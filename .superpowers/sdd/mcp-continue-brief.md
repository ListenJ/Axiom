# MCP server.ts 继续拆 — 抽取剩余 ~500行

## Current state
`src/mcp/server.ts` = 1745 lines. Already split:
- `server/vault-tools.ts` — vault + web tools
- `server/dre-tools.ts` — DRE + Persona + Cognitive Pipeline
- `server/kg-tools.ts` — KAL + DIP + KG
- `server/skill-tools.ts` — skill management

## Remaining tool blocks still inline in server.ts

Look for these comment markers and extract each group:

1. `// -- GitHub MCP 工具` (~line 386-1036, ~650 lines — BIG, maybe too much)
   - Actually skip GitHub since it's 650 lines, focus on smaller remaining blocks
   
2. `// -- 编码 Agent 工具 --` (~line 1037-1122, ~85 lines)
   - Extract to `server/code-agent-tools.ts`

3. `// -- Hermes 工具 --` (~line 1123-1146, ~23 lines)
   - Add to code-agent-tools.ts or separate `server/hermes-tools.ts`

4. `// -- 模型路由工具 --` (~line 1147-1164, ~17 lines)
   - Extract to `server/router-tools.ts`

5. `// -- 数据库工具 --` (~line 1165-1194, ~29 lines)
   - Extract to `server/db-tools.ts`

6. `// -- LSP 增强工具 --` (~line 1195-1227, ~32 lines)
   - Extract to `server/lsp-tools.ts`

7. `// -- Token 使用统计工具 --` (~line 1310-1374, ~64 lines)
   - Extract to `server/token-tools.ts`

8. `// -- 执行模式管理工具 --` (~line 1375-1459, ~84 lines)
   - Extract to `server/mode-tools.ts`

9. `// -- Workspace Snapshot 工具 --` (~line 1460-1512, ~52 lines)
   - Already in `tools/workspace-snapshot.js` — just keep inline reference

10. `// -- 竞技场榜单采集工具 --` (~line 1513-1613, ~100 lines)
    - Extract to `server/arena-tools.ts`

11. `// -- Prompt 连接池工具 --` (~line 1614-1696, ~82 lines)
    - Extract to `server/prompt-tools.ts`

12. `// -- 多 Agent 编排工具 --` (~line 1697-1819, ~122 lines)
    - Extract to `server/orchestrator-tools.ts`

## Approach
Skip GitHub (too large, ~650 lines). Focus on blocks 2-12:
- Total: ~690 lines to extract
- Target: server.ts 1745 → ~1055 lines

For each, create `server/<name>-tools.ts` with `registerXxxTools(registry, deps)` pattern.

## Dependencies in server.ts
- `opencodeAgent` functions (from opencode-agent.ts)
- `hermesAgent` functions (from hermes-agent.ts)
- `router` (from model-router.ts)
- `db` (Database from bun:sqlite)
- Code analysis functions (from tools/code-analysis.js)
- Token tracker (from token-tracker.ts)
- Execution mode / constitution
- Arena collector
- Prompt pool
- Agent orchestrator

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all pass
- Tool names must remain identical
