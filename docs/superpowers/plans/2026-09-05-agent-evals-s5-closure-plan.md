# agent-evals S5 收尾计划（2026-09-05）

> 基于 S4（`441976a`）后的差距盘点。方向由用户选定：**报告落地补全 + 回归自动检测闭环 + 验证器直测补齐**（明确排除 HTML 报告视图）。
> 目标：把「S3 已实现但未接入主报告」的失败聚类段落地、把「checkRegression 已存在但 run.ts 不自动跑」的闭环接通、
> 把「verify.ts 14 导出仅直测 7 个」的直测补齐——三者均为既有能力的**接入收口**，零新算法。
> **状态：实施完成（详见 feat 提交）→ 回写见文末。**

## 现状盘点（S4 后全读源码）

- `src/agent-evals/report-extras.ts`：`clusterFailures(results)`（S3 已实现 + 已测）未被 `report.toMarkdown`/`toJSON` 消费——失败聚类段是「半成品」，报告不落地。
- `src/agent-evals/registry.ts`：`checkRegression()`（line 414）+ `RegressionCheck`（line 164）已实现 + CLI `--compare` 已可显式对比；但 `run.ts` 主路径评测落库后**不自动跑回归检测**——防线在，闸门没接。
- `src/agent-evals/run.ts`：`persistResults` 返回 void（落库后 runId 不对外），不可供后续判定使用。
- `tests/agent-evals/verify.test.ts`：仅直测 7/14 个 `verify.ts` 导出（S4 新增的 7 个未直测，被 guard/validators 侧路覆盖）。

## 变更设计（规则 1 最小改动）

### Slice 1 — 验证器直测补齐（TDD，仅测试）

- `tests/agent-evals/verify.test.ts`：新增第 4 个 describe「S4 assertion layer (direct)」，直接 import 并断言 S4 新增 7 导出
  （`assertSpecErrors`/`compileAssertion`/`extractLastNumber`/`mustReturnNumber`/`outputLength` + `ASSERTION_SPEC_KEYS` 相关面），
  补齐「S4 交付未直测」的测试债务。**不改 verify.ts 一行**。

### Slice 2 — 报告落地补全（`report.ts`，消费既有 `clusterFailures`）

- `report.ts` 顶部 `import { clusterFailures } from "./report-extras.js";`（report-extras 仅 type-import metrics 系，无环）。
- `toMarkdown`：明细表之后追加 `## 失败聚类` → `| 桶 | 数量 | 代表样例 |` 表（samples 以 `；` 连接）；
  **仅在有失败轮次时输出该段**（`clusterFailures(results).length > 0`）——全绿轮次省略段，输出逐字节不变（兼容红线）。
- `toJSON`：`JSON.stringify({ summary, results, failures: clusterFailures(results) }, null, 2)`——结构化 failures 恒在（空数组兜底）。

### Slice 3 — 回归检测纯函数（`run-check.ts` 新建，无副作用可测）

- `autoCheckRegression(registry, { runId, baseline?, maxDropPp? })`：runId null（`--no-persist`）→ 纯无操作；
  候选缺失 → `skipped: "no-candidate"`；无可比基准 → `skipped: "no-baseline"`；正常 → `{ checked, regressed, check }`。
- 复用 `registry.checkRegression`（自动取同族同模型同 split 历史最优，或显式 `--baseline`），不新增查询逻辑。
- 因 run.ts 是带顶层副作用的 CLI（不可 import），判定逻辑剥离至此供 `openRegistry(":memory:")` 直测。

### Slice 4 — run.ts 胶水（CLI 接线 + 分级退出码）

- `persistResults` 返回 `number | null`（成功时 runId；`--no-persist`/落盘失败为 null）。
- 新 flag：`--baseline=<id|tag>`（复用 runRef 双形态）、`--max-drop=N`（回落阈值 pp，默认 10）、`--no-check-regression`（逃生舱）。
- 主路径落库后自动跑 `autoCheckRegression`：告警走 `logger.warn`（stderr，不污染 `--json` stdout 流）；跳过原因走 `logger.info`。
- **分级退出码**：回归 → 2；能力失败 → 1；正常 → 0。`--no-persist` 时 runId null → 自然跳过检测。
- evolve 路径不接自动检测（保持现状）。

## 兼容红线

- `- 平均延迟:` 行前缀、表格形状、`latency-percentile.test.ts` 的行数不变量（147-163）必须通过。
- 全绿轮次 `toMarkdown` 输出逐字节不变（聚类段省略）。

## 验证策略

每片 TDD 红→绿；`bunx tsc --noEmit` 0；`bun test tests/agent-evals` 全量（基线 392 → 预期 410）；
`--help` 含新 flag、`--dry-run` exit 0 smoke。真实回归判定不连 provider（规则 11），由 run-check.test.ts 以 `:memory:` 全覆盖。
