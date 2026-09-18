# Agent Prompt / Harness 优化说明（2026-08-08）

## 1. 现状扫描

本仓库的 Agent 提示词收敛在三个地方：

1. `src/agents/prompt-pool.ts` — 8 角色缓存友好前缀（main_coding / code_review / research / architecture / decision / general_chat / tool_use / computer_use）。
2. `src/dre/persona/prompt-store.ts` — Persona 系统提示模板（plan / code / retrieve / reflect / audit / creative / research / general）。
3. `src/agents/constitution.ts` — 执行模式宪法（plan / agent / yolo）。

工作区还包含大量可复用的 open agent skills（除 `arkcli-*` 之外）：

- 工程类：`code-review`、`git-workflow`、`tdd`、`systematic-debugging`、`performance`、`architecture`、`typescript-advanced-types`、`nodejs-backend-patterns`。
- 前端类：`frontend-design`、`design-taste-frontend`、`web-design-guidelines`、`material-3`、`vercel-composition-patterns`。
- 文档/办公类：`documents`、`presentations`、`spreadsheets`、`pdf`、`visualize`。
- 运维/安全类：`mcp-manager`、`find-skills`、`web-search`、`browser:control-in-app-browser`、`chrome:control-chrome`、`computer-use`。
- 测试类：`tdd`、`visual-test-runner`。

## 2. 本次落地

- `prompt-code`：补充仓库强约束（AGENTS.md、最小改动、垂直切片、验证后清理），让 coding 状态直接携带项目纪律。
- `prompt-general`：补充日常任务 harness（优先确定性工具、先结论后证据、可核验引用、不编造能力）。
- `prompt-pool` 的 `main_coding` / `general_chat` 前缀同步增加约束（读 AGENTS.md、一个测试一个实现、用工具获取确定性事实）。

## 3. 后续建议

- 将常用 skill 摘要注入 `bootstrap` 上下文，使 Agent 在会话开始就知道可用能力边界。
- 按任务类型（coding / daily / research / docs）做系统提示分层，避免 general 模板承载过多内容。
- 在 `prompt-pool` 中为 skill 模板增加独立缓存桶，避免与角色模板互相污染命中率。
