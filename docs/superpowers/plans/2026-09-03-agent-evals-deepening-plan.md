# agent-evals 体系深化计划（2026-09-03）

> 基于 2026-09-03 现状盘点（metrics/runner/registry/report/tasks 全读）。方向由用户选定 **A — agent-evals 体系深化**。
> 目标：在**不破坏**既有回归防线（eval-registry、checkRegression、executionError 能力口径）的前提下，
> 补齐评估维度（成本/Token、延迟分位、失败聚类），让评测回答「能力多强 + 花多少钱 + 慢在哪儿 + 败在哪类」。
> **状态：主线 A（S1/S2/S3）2026-09-04 全部完成并合入 `47a966c`（3 路并行子代理 + TDD，单提交合入而非每片独立 commit）；主线 B（S4 任务集质量强化）2026-09-05 全量完成并合入 `441976a`（主线程基建 + 双路并行子代理 + TDD，任务集 48 → 54）。**

## 现状盘点（2026-09-03 全读源码）

- `src/agent-evals/metrics.ts`：通过率 + train/held-out 泛化率 + **均值**延迟/输出长度 + executionErrors。无分位、无成本。
- `src/agent-evals/runner.ts`：直连 provider 路径 `callWithProxy`/`callWithCurl` 解析 body 后只取 `content`，**丢弃 `usage`**；internalAgent 路径 `executeWithRole` 返回 `SmartAssignmentResponse`（含 `usage.cost_usd`/`prompt_tokens`），但 runner 只读 `content`/`model`。
- `src/agent-evals/registry.ts`：`eval_runs` + `eval_task_results` 已落库，含 executionError 列（ensureColumn 迁移先例），无 cost/token 列、无分位列。
- `src/agent-evals/report.ts`：单轮 Markdown/JSON；无失败聚类、无趋势/对比视图（registry 已有 getTrend/compare/checkRegression 但 report 未用）。
- `src/agent-evals/tasks.ts`：48 自建任务全为关键词验证；external（HumanEval/MBPP）已是真实执行断言（docker 沙箱）。
- 既有测试：`tests/agent-evals/registry.test.ts`（378 行）用 `makeMeta()/makeSummary()` 构造；`metrics.test.ts`（113 行）。新列可选/默认值即可向后兼容。

## 变更设计（规则 1 最小改动）

### 主线 A（本迭代必做）

- **S1 成本/Token 维度采集与落库**（✅ 2026-09-04 · `47a966c`）
  - `runner.ts` 两路径采集 token 用量：
    - 直连路径：`callWithProxy`/`callWithCurl` 的响应 body 增加 `usage` 解析（prompt/completion/total_tokens）。
    - internalAgent 路径：从 `SmartAssignmentResponse.usage` 取 token 与 `cost_usd`（有则取，无则 null）。
  - `metrics-types.ts` / `metrics.ts`：`TaskResult` 增加 `tokenUsage?` 与 `costUsd?`；`MetricsSummary` 增加 `avgCostUsd`、`totalCostUsd`、`avgPromptTokens`/`avgCompletionTokens`（无数据为 null/0，不破坏调用方）。
  - `registry.ts`：`eval_task_results` 增 `prompt_tokens`/`completion_tokens`/`cost_usd`；`eval_runs` 增 `summary_avg_cost_usd`/`summary_total_cost_usd`。ensureColumn 迁移（老库自动补列）。
  - `run.ts`：persistResults 透传新字段。
- **S2 延迟分位（p50/p95/p99）**（✅ 2026-09-04 · `47a966c`）
  - `metrics.ts`：`summarize` 增加 `latencyP50/p95/p99`（按 latencyMs 升序取分位；样本 <3 时 p95/p99 可回退 max 或 null，文档注明）。
  - `registry.ts`：`eval_runs` 增 `summary_latency_p50/p95/p99` 三列（ensureColumn）。
  - `report.ts`：Markdown 输出延迟分位行。
- **S3 失败原因聚类 + 趋势/对比视图**（✅ 2026-09-04 · `47a966c`）
  - `report.ts`：新增失败原因聚类段——按 reason 关键词分组（执行错误/限流/超时/内容缺失/JSON 缺失/其他），输出各簇计数。
  - `report.ts` 或独立小模块：`trendMarkdown(rows, byFamily)` 输出最近 N 轮通过率趋势；`compareMarkdown(a, b)` 输出两轮对比（直接消费 registry.getTrend/compare/checkRegression 返回，不新增查询逻辑）。
  - `run.ts`：新增 `--trend=N`（最近 N 轮趋势，需要 registry）与 `--compare=<tagA> --compare=<tagB>`（或 `--compare=a..b`）CLI 开关；默认行为不变（单轮报告）。

### 主线 B（条件/下迭代，不在本计划实施）

- **S4 任务集质量强化**（✅ 2026-09-05 · `441976a`）：48 个关键词验证任务**全量补 `expectedBehavior` 语义标定**（闭包一字不动，零基线风险）+ 引入**可内省的结构化断言层** —— `AssertionSpec` 8 字段 1:1 映射既有验证器（containsAll/Any/AllAny/notContains/matchesAll/hasJSONKeys + 新 mustReturnNumber/outputLength），`compileAssertion`（畸形 spec fail-closed 桩不 throw）、`assertSpecErrors`（compileAssertion 与 validateTasks 共用）、`t()` 工厂 overload（AssertionSpec 派生 verify，显式闭包最高优先）、validateTasks 质量门（assert 良构 + expectedBehavior 必填）+ 6 个跨族新任务（CODING-09/KNOW-09/PLAN-09/TOOL-09/MEM-09/EVOLVE-09，任务集 48 → 54）。外部 HumanEval/MBPP 任务补 expectedBehavior 元数据。实施计划详见本迭代 plan 文件（声明式断言 + t() overload + 文件独占并行）。

## 验证修订（TDD 红→绿，规则 7）

- 每片先写测试（红）→ 最小实现（绿）→ `bunx tsc --noEmit` 0 → 相关 `bun test tests/agent-evals` 全绿。
- 全量回归：`bun run test:full`（3280 pass/34 skip/0 fail 基线）不得下降。
- ✅ 实测（2026-09-04）：`bunx tsc --noEmit` 0 错误；`bun test tests/agent-evals` **212 pass / 0 fail**（新增 cost-token 12 + latency-percentile 13 + report-extras 14）；`bun run test:full` **3368 pass / 34 skip / 0 fail**（基线 3280 不下滑，多出 88 个新用例全过）。
- ✅ 实测（2026-09-05 · 主线 B / S4）：`bunx tsc --noEmit` 0 错误；`bun test tests/agent-evals` **392 pass / 0 fail / 29 files**（基线 212，+180）；影响面穷举 `tests/agent-evals + tests/utils + tests/native-bridge + tests/main` 421 pass / 0 fail；外部消费方 `tests/external-eval-sandbox.test.ts` 3 pass。新增用例 assertion-validators 25 + assertion-spec-guard（红队）99 + tasks-s4-assert 49 + external +2 + tasks +1。全仓 test:full 未跑（用户中断，已穷举 src 无其他 agent-evals 消费方）。
- 兼容红线：既有 registry 测试（makeMeta/makeSummary 不传新字段）必须仍绿——新列全部可选/默认值；既有 report 调用（单轮输出）必须仍绿。
- 真实 provider 调用**不**纳入本计划自动化测试（成本/网络敏感）；S1 采集逻辑用注入 fake provider 响应断言 usage 解析，不连真实网络。

## 执行顺序

S1 → S2 → S3，每片独立 commit + ops-log（规则 5），并行度限 2。S1/S2 共享 `metrics.ts`/`registry.ts` 文件（均向后兼容，可顺序执行）。

## 红线

- 规则 1：只加新字段/新输出，不改既有字段语义（passRate 能力口径、executionError、generalizationRatio 全部保持）。
- 规则 3：只 add 本任务文件（计划/测试/源码），不碰 `.serena/*`、`scripts/pdf-worker/*`、`CLAUDE.md` 等无关改动。
- 规则 9：无 force push / reset --hard / checkout .。
- 规则 11：测试不写真实 provider 密钥；cost 为估算展示，不落敏感定价配置。

## Self-Review（writing-plans 强制自检）

- **Spec 覆盖**：S1 成本维度（runner 两路径 + metrics + registry + CLI 透传）；S2 延迟分位；S3 失败聚类 + 趋势/对比视图。三类缺口全部可验证。
- **注入隔离红线**：S1 用 fake provider 响应（usage 字段）断言解析，不连真实 API；S3 用内存 registry（openRegistry(":memory:") 或临时 .db）断言趋势/对比输出。
- **兼容性红线**：新列可选默认值 → 老测试不传新字段仍绿；report 单轮输出默认行为不变。
- **风险**：S1 的 internalAgent 路径 cost_usd 可能为 undefined（部分 provider 不给成本）→ 设计为可空，缺省 null 不阻断评测；直连路径 usage 也可能缺失 → 同处理。
