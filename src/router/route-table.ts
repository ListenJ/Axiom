import type { TaskRole } from "./model-capability-registry.js";

export const INTENT_ROUTE_TABLE: Record<string, { role: TaskRole; useTool: boolean }> = {
  // intent-router.ts 的 6 大类意图映射（与 src/agents/intent-router.ts CATEGORY_INTENTS 对齐）
  code:           { role: "code-generation", useTool: true },
  knowledge:      { role: "research", useTool: false },
  write:          { role: "general-tool", useTool: true },
  plan:           { role: "architecture", useTool: false },
  chat:           { role: "general-chat", useTool: false },
  strategy:     { role: "decision", useTool: false },
  evaluation:   { role: "decision", useTool: false },
  decision:     { role: "decision", useTool: false },
  architecture:   { role: "architecture", useTool: false },
  "system-design": { role: "architecture", useTool: false },
  infra:          { role: "architecture", useTool: false },
  engineering:        { role: "code-generation", useTool: true },
  "game-development": { role: "code-generation", useTool: true },
  integrations:       { role: "code-generation", useTool: true },
  testing:            { role: "code-review", useTool: true },
  english:            { role: "general-tool", useTool: true },
  translation:        { role: "general-tool", useTool: true },
  localization:       { role: "general-tool", useTool: true },
  rl:                 { role: "general-tool", useTool: true },
  reasoning:          { role: "general-tool", useTool: true },
  optimization:       { role: "general-tool", useTool: true },
  research:           { role: "research", useTool: false },
  deep_research:      { role: "research", useTool: false },
  code_review:        { role: "code-review", useTool: true },
  review:             { role: "code-review", useTool: true },
};

export const DEFAULT_ROLE: TaskRole = "general-chat";
