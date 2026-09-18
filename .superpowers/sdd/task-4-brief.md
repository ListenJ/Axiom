# Task 4: mcp/server.ts 继续按域抽取

## Problem
`src/mcp/server.ts` is 2862 lines with 100+ tool registrations. Vault + Web tools already extracted to `server/vault-tools.ts`. Need to extract 3 more domains.

## Existing Pattern
```typescript
// server/vault-tools.ts
export function registerVaultTools(registry: ToolRegistry, vault: VaultManager): void {
  registry.add({ name: "...", description: "...", inputSchema: {...}, handler: ... });
  // ...
}
```

## Files to Create

### `src/mcp/server/kg-tools.ts`
Knowledge Graph + DIP tools from server.ts (~lines 2544 to ~2900).

Look for `registry.add({` blocks in server.ts around these comments:
- `// ===== 统一知识访问层 (KAL) 工具 =====`
- `// ===== 知识图谱工具 (PostgreSQL + SQLite 统一降级) =====`
- `// ===== DIP 文档处理管道工具 =====`
- `// ===== 知识图谱增强工具 (SQLite 后端，统一实例) =====`

Dependencies: `registry`, `z`, `vault` (VaultManager), `pg` (Database from bun:sqlite), `kernel` (DRE Kernel), `KnowledgeGraphEnhanced`

### `src/mcp/server/dre-tools.ts`
DRE + Persona + Cognitive Pipeline tools from server.ts (~lines 1820 to ~2450).

Look for `registry.add({` blocks around:
- `// ===== DRE 确定性推理引擎工具 =====`
- `// ===== Persona 工具 =====`
- `// ===== 认知管道工具 =====`
- `// ===== 心智模型工具 =====`
- `// ===== 推理图工具 =====`
- `// ===== 约束求解器工具 =====`
- `// ===== 认知闭环 (CognitivePipeline) 工具 =====`

Dependencies: `registry`, `z`, `kernel`, `cognitivePipeline`, `vault`, `getResourceBudgetManager`

### `src/mcp/server/skill-tools.ts`
Skill management tools from server.ts (~lines 1228 to ~1310).

Look for:
- `// -- Skill 管理工具 --`

Dependencies: `registry`, `z`, `loadSkillsFromDirectories`, `saveSkillFile`, `createSkillFileBoilerplate`, `clearSkillCache`

## Files to Modify

### `src/mcp/server.ts`
For each extracted group, remove the `registry.add({...})` blocks and replace with:
```typescript
import { registerKgTools } from "./server/kg-tools.js";
registerKgTools(registry, { vault, pg, kernel, kg });
```

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all tests pass
- The tool names must remain identical so existing MCP clients don't break
- After extraction, `server.ts` should be visibly smaller (~500 fewer lines)

Do NOT commit. Report Status, files changed, line count changes, test results.