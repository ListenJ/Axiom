# 工具能力声明登记表

**本文件由代码生成，禁止手改**：重生成 `bun run scripts/gen-capability-declarations.mjs --write`；
一致性由 `tests/doc-contract.test.ts` 的 D10 门逐字校验；抽取器与渲染器在 `src/testing/tool-declarations.ts`。

口径 = 经 `src/mcp/tool-registry.ts` 注册的执行面。固定名注册 **186** 处、动态名 **1** 处、打包产物内注册 **71** 处（另列，见末节）；声明 `proc.exec` 的 **25** 处，其中目标由实现固定 **24** 处、声明目标入参 **1** 处；未声明能力 **0** 处。

本表按**注册点**计数，与 `src/testing/tool-count.ts` 的**去重工具数**不是同一口径（后者按字面名去重、含 `adaptTool` 注册的基础工具，也不看打包产物），两个数各自成立，不能互相顶替。

## 判据分档

| 分档 | 含义 |
|---|---|
| 入参可裁决 | 目标字段在声明/规范/加速器清单里，派发前做**完整**裁决（越界 + 锚点） |
| 仅形态认领 | 字段名不在任何清单里，由值形态认领 ⇒ 只做锚点裁决，越界留给实际 I/O 点（I2） |
| 目标由实现固定 | 注册处声明 `fixed`：入参里没有可裁决对象，判定落在执行点 |
| 派发前不裁决 | 该档位按设计不在派发前取负载（外部 MCP 的参数形状由远端决定） |
| 无可裁决对象 | 声明字段与形态都不命中 ⇒ 由执行点与 I4 序列复核兜底（已登记，见 §2.7.5） |
| schema 不可静态核 | 入参 schema 是引用或远端透传，本表不声称已核对 |

## plugins/git-workflow-enhanced/index.js

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `generate_branch_name` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `generate_commit_message` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `generate_pr_template` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `update_changelog` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 

## src/mcp/register-external-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `minimax_web_search` | `net.outbound` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `minimax_image_understand` | `net.outbound` | — | 2 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `minimax_health` | `net.outbound` | — | 0 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `fs_read` | `fs.read` | — | 3 | fs.read：入参可裁决（path ⇒ 完整裁决） | 
 | `fs_write` | `fs.write` | — | 3 | fs.write：入参可裁决（path ⇒ 完整裁决） | 
 | `fs_list` | `fs.read` | — | 1 | fs.read：入参可裁决（path ⇒ 完整裁决） | 
 | `fs_search` | `fs.glob` `fs.read` | — | 3 | fs.glob：入参可裁决（path ⇒ 完整裁决）；fs.read：入参可裁决（path ⇒ 完整裁决） | 
 | `fs_delete` | `fs.delete` | — | 1 | fs.delete：入参可裁决（path ⇒ 完整裁决） | 
 | `fs_move` | `fs.delete` `fs.write` | — | 2 | fs.delete：入参可裁决（source/destination ⇒ 完整裁决）；fs.write：入参可裁决（source/destination ⇒ 完整裁决） | 
 | `terminal_exec` | `proc.exec` | `proc.exec→["command"]` | 3 | proc.exec：入参可裁决（command ⇒ 完整裁决） | 
 | `terminal_list` | `proc.exec` | `proc.exec→fixed` | 0 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `terminal_info` | `proc.exec` | `proc.exec→fixed` | 0 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `git_status` | `proc.exec` | `proc.exec→fixed` | 1 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `git_diff` | `proc.exec` | `proc.exec→fixed` | 4 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `git_log` | `proc.exec` | `proc.exec→fixed` | 3 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `git_branch` | `proc.exec` | `proc.exec→fixed` | 1 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `git_blame` | `proc.exec` | `proc.exec→fixed` | 2 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `code_symbols` | `fs.read` | — | 2 | fs.read：入参可裁决（filePath ⇒ 完整裁决） | 
 | `code_references` | `fs.glob` `fs.read` | — | 2 | fs.glob：入参可裁决（path ⇒ 完整裁决）；fs.read：入参可裁决（path ⇒ 完整裁决） | 
 | `code_diagnostics` | `proc.exec` `fs.read` | `proc.exec→fixed` | 1 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定；fs.read：入参可裁决（filePath ⇒ 完整裁决） | 
 | `code_outline` | `fs.read` | — | 1 | fs.read：入参可裁决（filePath ⇒ 完整裁决） | 
 | `code_analyze` | `fs.read` | — | 1 | fs.read：入参可裁决（filePath ⇒ 完整裁决） | 

## src/mcp/server.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `serpapi_search` | `net.outbound` `fs.write` `db.write` | — | 9 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；db.write：入参可裁决（query ⇒ 完整裁决） | 
 | `serpapi_search_and_crawl` | `net.outbound` `fs.write` `db.write` | — | 7 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；db.write：入参可裁决（query ⇒ 完整裁决） | 
 | `snapshot_create` | `proc.exec` `fs.read` `fs.write` | `proc.exec→fixed` | 1 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定；fs.read：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `snapshot_revert` | `proc.exec` `fs.read` `fs.write` | `proc.exec→fixed` | 1 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定；fs.read：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `snapshot_list` | `proc.exec` | `proc.exec→fixed` | 0 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `snapshot_diff` | `proc.exec` `fs.read` `fs.write` | `proc.exec→fixed` | 1 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定；fs.read：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `snapshot_status` | `proc.exec` | `proc.exec→fixed` | 0 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `proxy_status` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/arena-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `arena_collect` | `net.outbound` `db.write` | — | 1 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；db.write：入参可裁决（source ⇒ 完整裁决） | 
 | `arena_search_models` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `arena_get_model_scores` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `arena_benchmark_ranking` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `arena_composite_ranking` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `arena_role_recommendation` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `arena_stats` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `arena_sources` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/browser-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `browser_guide` | `net.outbound` `proc.exec` | `proc.exec→fixed` | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `browser_locate` | `net.outbound` `proc.exec` | `proc.exec→fixed` | 6 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `browser_launch` | `proc.exec` | `proc.exec→fixed` | 2 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `browser_locate_local` | `internal` | — | 5 | internal：无外部副作用，不进入裁决 | 
 | `frontend_visual_review` | `net.outbound` `proc.exec` | `proc.exec→fixed` | 3 | net.outbound：入参可裁决（url ⇒ 完整裁决）；proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `frontend_audit` | `fs.read` `fs.delete` `net.outbound` `proc.exec` | `proc.exec→fixed` | 3 | fs.read：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.delete：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 

## src/mcp/server/code-agent-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `code_generate` | `net.outbound` `proc.exec` `fs.read` `fs.write` `db.write` | `proc.exec→fixed` | 4 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定；fs.read：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `code_refactor` | `net.outbound` `fs.write` `db.write` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `code_review` | `net.outbound` `fs.write` `db.write` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `code_test` | `net.outbound` `fs.write` `db.write` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `opencode_status` | `proc.exec` | `proc.exec→fixed` | 0 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 

## src/mcp/server/db-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `db_query` | `db.write` | — | 2 | db.write：入参可裁决（sql ⇒ 完整裁决） | 
 | `list_free_models` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/document-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `knowledge_ingest_document` | `fs.read` `net.outbound` | — | 4 | fs.read：入参可裁决（file ⇒ 完整裁决）；net.outbound：入参可裁决（url ⇒ 完整裁决） | 

## src/mcp/server/dre-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `dre_constraint_inject` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `dre_write_knowledge` | `db.write` `net.outbound` `fs.write` | — | 6 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底；net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `dre_read_knowledge` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `dre_search_knowledge` | `internal` | — | 5 | internal：无外部副作用，不进入裁决 | 
 | `dre_subgraph` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `dre_consciousness_step` | `db.write` `net.outbound` `fs.write` | — | 2 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底；net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `dre_status` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `resource_status` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `persona_switch` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `persona_status` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `persona_list` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `cognitive_state` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `cognitive_pipeline_run` | `db.write` `net.outbound` `fs.write` | — | 1 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底；net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `cognitive_pipeline_run_full` | `db.write` `net.outbound` `fs.write` | — | 1 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底；net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `data_write` | `db.write` | — | 5 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `data_search` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `data_stats` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `data_persist` | `db.write` | — | 0 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `mental_model_list` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `mental_model_match` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `mental_model_predict` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `reasoning_build` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `reasoning_detect_gaps` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `reasoning_fill_gap` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `reasoning_result` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `procedure_parse` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `constraint_check` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `constraint_select_best` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `constraint_list` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `constraint_stats` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `actor_list` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `actor_send` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `cognitive_loop` | `net.outbound` | — | 1 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `cognitive_loop_full` | `db.write` `net.outbound` `fs.write` | — | 1 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底；net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `task_graph_execute` | `db.write` | — | 1 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 

## src/mcp/server/github-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `github_list_repos` | `net.outbound` | — | 4 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_get_repo` | `net.outbound` | — | 2 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_create_repo` | `net.outbound` | — | 6 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_fork_repo` | `net.outbound` | — | 4 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_list_issues` | `net.outbound` | — | 7 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_create_issue` | `net.outbound` | — | 6 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_add_issue_comment` | `net.outbound` | — | 4 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_list_prs` | `net.outbound` | — | 6 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_create_pr` | `net.outbound` | — | 7 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_review_pr` | `net.outbound` | — | 5 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_get_pr_files` | `net.outbound` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_get_file_contents` | `net.outbound` | — | 4 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_list_directory` | `net.outbound` | — | 4 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_search_code` | `net.outbound` | — | 5 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_list_releases` | `net.outbound` | — | 4 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_create_release` | `net.outbound` | — | 8 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_list_workflows` | `net.outbound` | — | 2 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_trigger_workflow` | `net.outbound` | — | 5 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_list_workflow_runs` | `net.outbound` | — | 6 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_get_workflow_run` | `net.outbound` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_health` | `net.outbound` | — | 0 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `github_get_issue` | `net.outbound` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 

## src/mcp/server/hermes-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `project_research` | `proc.exec` `fs.read` `fs.write` `db.write` `net.outbound` | `proc.exec→fixed` | 2 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定；fs.read：入参可裁决（cwd ⇒ 完整裁决）；fs.write：入参可裁决（cwd ⇒ 完整裁决）；db.write：入参可裁决（cwd ⇒ 完整裁决）；net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `hermes_status` | `proc.exec` | `proc.exec→fixed` | 0 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 

## src/mcp/server/kg-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `kal_query` | `internal` | — | 5 | internal：无外部副作用，不进入裁决 | 
 | `kal_references` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `dip_ingest_document` | `db.write` | — | 3 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `dip_query_ast` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `kg_stats` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `kg_entities` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `kg_entity_detail` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `kg_traverse` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `kg_build` | `fs.glob` `fs.read` `db.write` | — | 2 | fs.glob：入参可裁决（projectPath ⇒ 完整裁决）；fs.read：入参可裁决（projectPath ⇒ 完整裁决）；db.write：入参可裁决（projectPath ⇒ 完整裁决） | 
 | `kg_search` | `internal` | — | 4 | internal：无外部副作用，不进入裁决 | 
 | `kg_graph` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `kg_add_node` | `db.write` | — | 7 | db.write：入参可裁决（filePath ⇒ 完整裁决） | 
 | `kg_add_edge` | `db.write` | — | 5 | db.write：入参可裁决（source/target ⇒ 完整裁决） | 
 | `kg_search_nodes` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `kg_subgraph` | `internal` | — | 3 | internal：无外部副作用，不进入裁决 | 
 | `kg_shortest_path` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `kg_detect_communities` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `kg_echarts_data` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `kg_d3_data` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `kg_nl_query` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `kg_enhanced_stats` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/lsp-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `code_quick_diagnostics` | `proc.exec` | `proc.exec→fixed` | 1 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定 | 
 | `code_actions` | `proc.exec` `fs.read` | `proc.exec→fixed` | 1 | proc.exec：目标由实现固定 ⇒ 不取入参负载，由执行点判定；fs.read：入参可裁决（filePath ⇒ 完整裁决） | 
 | `code_detect_language` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/mind-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `mind_synapse_create` | `db.write` | — | 5 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `mind_synapse_activate` | `db.write` | — | 2 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `mind_synapse_spread` | `db.write` | — | 3 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `mind_synapse_suggest` | `db.write` | — | 3 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `mind_synapse_verify` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `mind_synapse_trace` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `mind_suggest` | `db.write` | — | 4 | db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 

## src/mcp/server/mode-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `set_mode` | `cfg.write` | — | 2 | cfg.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `get_mode` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `list_mode_tools` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `revert_mode` | `cfg.write` | — | 0 | cfg.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 

## src/mcp/server/native-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `native_toolchain_status` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `native_agent_execute` | `net.outbound` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 

## src/mcp/server/orchestrator-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `orchestrator_execute_task` | `net.outbound` | — | 6 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `orchestrator_execute_plan` | `net.outbound` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `orchestrator_list_agents` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `orchestrator_health_check` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `orchestrator_status` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/prompt-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `prompt_pool_acquire` | `internal` | — | 4 | internal：无外部副作用，不进入裁决 | 
 | `prompt_pool_metrics` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `prompt_pool_status` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `prompt_pool_roles` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `prompt_pool_warmup` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `prompt_pool_evict` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/recoverable-output-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `read_tool_result` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `recoverable_output_stats` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/router-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `model_chat` | `net.outbound` `fs.write` | — | 2 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 

## src/mcp/server/safety-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `hallucination_feedback` | `db.write` | — | **不可静态核** | db.write：schema 不可静态核 ⇒ 入参可裁决性未核对 | 

## src/mcp/server/scene-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `scene_suggest_tools` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `scene_list` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/token-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `token_stats` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `token_stats_by_model` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `token_stats_by_role` | `internal` | — | 2 | internal：无外部副作用，不进入裁决 | 
 | `token_daily_stats` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 
 | `rate_tier_status` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `cache_stats` | `internal` | — | 1 | internal：无外部副作用，不进入裁决 | 

## src/mcp/server/vault-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `memory_search` | `fs.read` | — | 5 | fs.read：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `memory_read` | `fs.read` | — | 1 | fs.read：入参可裁决（path ⇒ 完整裁决） | 
 | `memory_write` | `fs.write` `db.write` | — | 7 | fs.write：入参可裁决（path/source ⇒ 完整裁决）；db.write：入参可裁决（path/source ⇒ 完整裁决） | 
 | `memory_atomic` | `fs.write` `db.write` | — | 5 | fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；db.write：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底 | 
 | `memory_browse` | `fs.read` | — | 3 | fs.read：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `memory_network` | `fs.read` | — | 2 | fs.read：入参可裁决（path ⇒ 完整裁决） | 
 | `memory_stats` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 
 | `code_index` | `fs.glob` `fs.read` `fs.write` | — | 0 | fs.glob：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.read：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 

## src/mcp/server/web-tools.ts

| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |
|---|---|---|---|---|
 | `web_fetch` | `fs.write` `net.outbound` | — | 1 | fs.write：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁；net.outbound：入参可裁决（url ⇒ 完整裁决） | 
 | `web_search` | `net.outbound` | — | 3 | net.outbound：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁 | 
 | `search_engines_list` | `internal` | — | 0 | internal：无外部副作用，不进入裁决 | 

## 不可静态核的注册（动态名 / 远端形状）

| 位置 | 名字来源 | 声明能力 | 说明 |
|---|---|---|---|
 | `src/mcp/client-connector.ts` | `mcp_${name}_${tool.name}` | `mcp.external` | 名字由运行时拼出（外部 MCP 子进程包装）；能力仍按注册处声明判定，逐个工具的入参形状不在本表声称已核对 | 

## 打包产物内的注册面（不在本表口径内）

| 产物 | 内含注册 | 其中带能力声明 |
|---|---|---|
| `plugins/dre-dsh/backend/server.js` | 42 | 0 |
| `plugins/kb-dsh/backend/server.js` | 29 | 0 |

这两个产物是提交进仓库的压缩文件（存在超长单行），由 `plugins/dre-dsh/package.json` 与 `plugins/kb-dsh/package.json` 的 `build:backend` 从 `src/mcp/dre-backend.ts` / `src/mcp/kb-backend.ts` 打包，里面是那一份注册器的**编译副本**。因此本表不声称它们的派发经过 `src/mcp/tool-registry.ts` 的守卫。

「其中带能力声明」一列为 0 时，说明该副本早于能力内核（源码注册点逐个带 `capability`，如 `src/mcp/server/dre-tools.ts`）：里面生效的是按工具名/字段名正则的旧守卫，重建产物后此列才会随源码变化。风险登记见 `docs/SECURITY-MEASURES.md` §2.7.5。

## 这张表不证明什么

- 它只登记**声明与派发前可达性**，不证明执行点判定已接线：`safeFs`（I2）与出网执行点各自另有门。
- 「目标由实现固定」的真实性由人保证：机器只核「声明的字段名确实存在于 schema」与「缺声明即不可注册」（S-8），逐条证据在提交说明与 `docs/operations-log.md`。
- `db.write` 的判据是 filesystem：`sql`/`query`/`statement` 里的 SQL 文本按路径裁决，既不构成有效防护也可能误伤 ⇒ 已登记债（`docs/SECURITY-MEASURES.md` §2.7.5），本表如实显示为「可裁决」而不声称已防护。
- 未出现在本表的执行面（运行期由远端 `listTools()` 决定的外部工具、未走 `add()` 的调用面）不冒充已核对。
