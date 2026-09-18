# Agent 真实评测 + 真实场景测试集 + 基准标定计划（2026-09-05）

> **状态：已完成（deepseek 全量 66 例外）。** 计划文件（本次覆盖新任务，非增量）。
> **回写（2026-09-05）**：Phase A 三路全量——zhipu/sensenova 54 任务✅（run#5/#6）、66 任务 Wave-2✅（run#7/#10，见标定文档第十一节）、deepseek evolve ✅（run#8/#9，held-out baseline 94.7%→evolved 100%，job b7862dw8d）；仅 deepseek **全量 66（无 evolve）** ❌不可达（模型自竞争，需空闲期独立会话重试）。Phase B✅（+12 任务，commit 8fb0739）、Phase C✅（标定文档）、Phase D✅（知识文件）。**修订（复查）**：首版误记"deepseek evolve 两次不可达"，实际 run#8/#9 已成功，见标定文档第十一节。
> **用户指令**：执行真实评测（已授权真实 provider 调用）→ 按 Agent 真实场景使用规范设计测试集 → 完成能力测试与基准标定 → 用最新研究与评测数据完善。
> **用户选定**：① 三路 provider 全铺（opencode/deepseek-v4-flash + zhipu/glm-4.7-flash + sensenova/deepseek-v4-flash-sensenova）；② 在 deepseek 上跑一轮 `--evolve` 闭环（自进化能力标定）；③ 真实场景任务**扩展现有 6 族**（不新增第 7 族）。

---

## 现状盘点（2026-09-05 全读源码 + 查 registry）

- **基建已完成（S1–S5）**：`metrics`（成本/Token、延迟 p50/p95/p99、失败聚类）、`registry`（落库 + 回归检测 + exit_code 真值）、`report`（失败聚类段 + trend/compare）、`run-check`（autoCheckRegression/autoCheckEvolve 纯函数）、分级退出码（回归 2 > 能力失败 1 > 正常 0）。`bun test tests/agent-evals` **416 pass / 0 fail**。
- **任务集**：54 自建任务（6 族 × 9）+ 外部 HumanEval/MBPP（docker 沙箱真实执行）。`validateTasks` 强制每族必须有 train + held-out。
- **registry 现状**（`data/eval-registry.db`，36KB，旧 schema 缺 S1/S2/S3 列，`openRegistry` ensureColumn 自动迁移）：4 轮记录——2 轮 2026-08 历史存档（24 任务旧集）+ 2 轮 **2026-09-01 真实 zhipu glm-4.7-flash coding 族**（run#3 并发 3 → 7/8 限流错误；run#4 并发 1 → 8/8 通过，**验证了 zhipu 强制并发 1 的必要性**）。
- **历史基准**（24 任务旧集，2026-08-16）：deepseek-v4-flash + evolve + constraints **87.5% held-out**（历史最优）；deepseek-v4-flash 无 evolve 70.8%；默认路由 zhipu 16.7%。→ **54 任务新集尚无任何真实全量基线**，本计划补齐。
- **模型端点**（api-key-store）：opencode→`https://opencode.ai/zen/go/v1`（curl 直连，`-m 120` 已修）；zhipu→`open.bigmodel.cn/api/paas/v4`（glm-4.7-flash 免费，限流退避 5/10/10s×3，强制并发 1）；sensenova→`token.sensenova.cn/v1`（deepseek-v4-flash 国内免费端点）。
- **Agent 真实使用规范**（prompt-pool 8 角色 + router 19 TaskRole + persona 8 模式 + constitution plan/agent/yolo + 自进化闭环 + AGENTS.md 工程纪律 + 真实部署场景文档 08-17）——Phase B 测试集取材依据。

## 目标与交付物

| 交付物 | 说明 |
| --- | --- |
| A. 三路真实全量基线 | opencode/deepseek-v4-flash、zhipu/glm-4.7-flash、sensenova/deepseek-v4-flash 各跑 54 任务全量，registry 落库 |
| A-evolve. 自进化闭环 | deepseek 上 `--evolve`：train 归纳技能 → held-out 注入对比 + 回归检测 |
| B. 真实场景测试集 | 扩展现有 6 族，+12 任务（每族 1 train + 1 held-out，54 → 66），S4 AssertionSpec 声明式断言 |
| C. 基准标定文档 | `docs/agent-eval-baseline-2026-09-05.md`：三路对比 + 分族/泛化/成本/延迟/失败聚类 + 与历史对比 + 结论 |
| D. 最新研究完善 | Web 检索 2026 最新 agent 评测基准，产出 `docs/knowledge/agent-eval-benchmarks-2026-09-05.md`，并落进测试集设计与定位 |

## Phase A — 真实评测执行（CLI 直连，真实 provider）

- **A1 deepseek 全量**：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --concurrency=2 --rerun-each=2` → `eval-results/agent-evals-2026-09-05-deepseek-v4-flash.md`（stdout 去 info 行后落盘）。
- **A2 zhipu 全量**：`--provider=zhipu --model=glm-4.7-flash`（`--concurrency` 自动强制 1）→ `eval-results/agent-evals-2026-09-05-glm-4.7-flash.md`。
- **A3 sensenova 全量**：`--provider=sensenova --model=deepseek-v4-flash --concurrency=2` → `eval-results/agent-evals-2026-09-05-sensenova.md`。
- **A4 deepseek evolve**：`--provider=opencode --model=deepseek-v4-flash --evolve --concurrency=2` → `eval-results/agent-evals-2026-09-05-deepseek-evolve.md`（train 归纳 → held-out baseline → evolved 注入；autoCheckEvolve + 分级退出码）。
- **Wave-2（可选）**：Phase B 合入后，用 zhipu（免费）重跑 66 任务全量，测真实场景任务本身的通过率，零成本。
- 后台串行编排：Job1 = A1→A4（同 provider 串行防限流）；Job2 = A2→A3（并行于 Job1）。registry WAL + busy_timeout 承接并发落库。真实回归检测无同集基准 → 预期「no-baseline」跳过（首次全量），不误判。
- **耗时/成本预估**：deepseek×2 + zhipu + sensenova ≈ 45-55 分钟；全部走现有套餐/免费端点，近似零新增费用。

## Phase B — 真实场景测试集（扩展现有 6 族，+12 任务）

取材 Agent 真实使用规范（角色面 + 工程纪律面 + 自进化机制 + 本体知识），全部 S4 声明式断言（`t()` + `assert` + `expectedBehavior` + `maxTokens`）。每族 1 train + 1 held-out，维持 validateTasks 平衡。

| id | 族 | split | 场景取材 | assert 要点（示意） |
| --- | --- | --- | --- | --- |
| CODING-10 | coding | train | 工程纪律：改动前备份流程（规则 2） | 备份/backup + 验证 + 清理 |
| CODING-11 | coding | held-out | 规则 1 最小改动判定（评审越界提交） | 最小/无关 + 合规判断 + 重构/重命名 |
| KNOW-10 | knowledge | train | Agent 本体：model-router TaskRole 路由与 fallback | 角色/role + 模型 + fallback/降级 |
| KNOW-11 | knowledge | held-out | AGENTS 规则 9 git 安全护栏（列 ≥2 条禁令） | force push / reset --hard / checkout / clean -f 任一 ≥2 |
| PLAN-10 | planning | train | code-review 角色流程（读 diff→查上下文→建议→复核） | diff/变更 + review/评审 + 建议 + 复核 |
| PLAN-11 | planning | held-out | 自进化闭环评测规划（train→归纳→held-out 注入→回归） | train + held-out + 技能/归纳 + 回归/对比 |
| TOOL-10 | tool-use | train | web_search 工具参数构造（真实 schema：`{"query":...}`） | hasJSONKeys ["query"] |
| TOOL-11 | tool-use | held-out | 容器排障命令序（docker ps -a → docker logs 看什么） | ps -a + logs + 退出/状态 |
| MEM-10 | memory | train | 角色+模型约束保持（JSON 含 model/costUsd） | hasJSONKeys ["model","costUsd"] |
| MEM-11 | memory | held-out | 多约束整合（opencode + deepseek + 并发2 + 重试2） | opencode + deepseek + 2/并发/retry |
| EVOLVE-10 | self-evolve | train | 从 eval 失败轨迹提炼教训（含「下次」） | 下次 + 参数/字段 + 显式/检查 |
| EVOLVE-11 | self-evolve | held-out | 调试纪律 rule 6（先建反馈回路再提假设） | 反馈回路/复现 + 命令/测试 + 假设 |

实现与验证：TDD 红→绿（先写 `tests/agent-evals/tasks-real.test.ts` 验证新任务良构 + 关键断言行为，再写任务）；`validateTasks()` 全绿（每族 train/held-out 平衡）；`bunx tsc --noEmit` 0；`bun test tests/agent-evals` 不回退。**tasks.ts 单写入者**（一个 worker 顺序追加，避免并行写冲突）。

## Phase C — 基准标定文档

`docs/agent-eval-baseline-2026-09-05.md`（house 风格）：
- 三路 provider 全局/分族通过率 + train/held-out 泛化率 + 分族表；
- 成本/Token（S1：avg/total costUsd、prompt/completion tokens——三路免费/套餐，重点展示 token 口径）；
- 延迟分位（S2：p50/p95/p99）；
- 失败聚类（S3：簇计数 + 代表样例）；
- 与历史对比表（08-16 24 任务集：70.8% / 87.5%）+ 回归检测结果 + **结论与建议**（模型选型、校验器校准点、后续迭代）。

## Phase D — 最新研究完善（规则 10 知识文件）

- Web 检索（2026-09 时点）最新 agent 评测基准：SWE-bench Verified、τ-bench、GAIA、MLE-Bench、WebArena、AgentBench、国内 agent 评测（若 2026 有更新），及方法论（确定性验证器 vs LLM judge、held-out 泛化、轨迹级评测）。
- 产出 `docs/knowledge/agent-eval-benchmarks-2026-09-05.md`（摘要开头 + 来源 + 关键结论，规则 10）。
- 结论落进：Phase B 任务设计校准（任务类型是否有对标）与 Phase C 定位（本套件与既有基准的关系：为何自建 + 对标差异）。

## 验证策略

- A 轮：每轮跑完校验 `eval-results/*.md` 报告落盘 + `registry` 新增 run 记录（id/run_tag/model/provider/summary_* 新列齐全）；退出码符合分级（无回归基准 → 0 或能力失败 1）。
- B 轮：TDD 红→绿；`validateTasks()` 0 错误；`bunx tsc --noEmit` 0；`bun test tests/agent-evals` ≥ 416 pass（新增用例全过，不回退）。
- C 轮：文档数据与 registry 查询核对（不杜撰数字，全部来自真实 run）。
- D 轮：知识文件含可核验来源；结论标注 事实/推测/判断。

## 执行顺序与并行度

```
Phase A Job1 (bg): A1 deepseek → A4 evolve        ┐ 两个后台 Job 并行
Phase A Job2 (bg): A2 zhipu → A3 sensenova        ┘
Phase B  Worker:  tasks.ts + tests (单写入者 TDD)   ─ 与 A 并行
Phase D  Worker:  web 研究 + 知识文件 (与 B 并行)    ─ 与 A 并行
Phase C  (主线程): A 完成后依据 registry 写标定文档   └ 依赖 A
Wave-2  (可选):    B 合入后 zhipu 免费重跑 66 任务
```
并行度上限 2 个后台 Job + 2 个并行子代理（B/D 文件互斥：B 独占 tasks.ts/tests-real，D 独占 docs/knowledge）。

## 红线

- 规则 1：B 只追加新任务与对应测试，不改既有 54 任务语义/验证器（零基线风险）；A/C/D 为评测运行与文档，不改源码。
- 规则 2：改 `tasks.ts` 前备份到 `.tmp/backups/`；验证后删除。
- 规则 3：提交只 add 本任务文件（tasks.ts、tests-real、eval-results/*.md、标定文档、知识文件、plan、ops-log），不碰 `.serena/*`、`scripts/pdf-worker/*`、`CLAUDE.md`。
- 规则 5：每个业务提交在 `docs/operations-log.md` CRLF 追加一条（Commit 占位 → 独立 docs 提交回填）。
- 规则 9：无 force push / reset --hard / checkout .。
- 规则 11：三路 provider 密钥只从本地 `.env` 读取，报告/文档只记 provider/模型/用量，**不落密钥**；评测不纳入自动化测试（成本/网络敏感）。
