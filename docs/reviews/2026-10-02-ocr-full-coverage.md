# OCR 全仓 src 扫描覆盖率报告（2026-10-02）

> 计划：`docs/superpowers/plans/2026-10-02-post-unify-remediation-plan.md` Step 12a。
> Provider/模型：SenseNova `deepseek-v4-flash`（Q3 用户裁决；智谱 `glm-4.7-flash` 扫描时工具调用不稳定）。
> OCR CLI：`@alibaba-group/open-code-review` v1.12.11。
> 原始输出：`/tmp/ocr-step12-src.txt`（99,246 B）；session：`1368fa22-bfac-4771-a650-a4a26fee0221`。

---

## 一、扫描元数据（实测）

| 项 | 值 |
|---|---|
| 范围 | `src/**`（排除 `src/**/__tests__/**`、sourcemap） |
| OCR 摘要 | **453 file(s) reviewed；163 comment(s)** |
| 严重度分布 | **high 13 / medium 74 / low 76 / critical 0** |
| 类别分布 | bug 81 / maintainability 54 / security 11 / performance 10 / style 2 / other 4 / documentation 1 |
| 有评论的文件 | **33 个**（其余文件扫描后 0 评论） |
| 耗时 | 40m58s |
| token 用量 | 约 2,017,378（input ~1,461,050 / output ~556,328；cache read ~608,512） |
| 预算 | `--max-tokens-budget 2000000` **触顶**：在 `src/decision/laya-triage.ts` batch #3 处停止，结果仍写出 |
| session 元数据 | 22 done / 101 fail（与摘要 453 reviewed 口径不一致，见 §四） |

**结论**：Step 12a 已产出可用结果，但**不是 100% 无失败覆盖**；高严重度发现已足以形成下一批修复计划。

---

## 二、评论最集中的文件（Top 15）

| 评论数 | 文件 |
|---|---|
| 9 | `src/cli.ts` |
| 9 | `src/context/context-manager.ts` |
| 8 | `src/agents/query-decomposer.ts` |
| 8 | `src/core/runtime-audit.ts` |
| 7 | `src/agents/prompt-pool.ts` |
| 6 | `src/agent-evals/tasks.ts` |
| 6 | `src/agents/approver-model.ts` |
| 6 | `src/agents/opencode-agent.ts` |
| 6 | `src/components/token-budget.ts` |
| 6 | `src/db/tool-invocations.ts` |
| 5 | `src/agent-evals/run.ts` |
| 5 | `src/agent-evals/real-usage.ts` |
| 5 | `src/agent-evals/runtime-metrics.ts` |
| 5 | `src/agent-evals/runtime-runner.ts` |
| 5 | `src/cli/commands/db.ts` |

---

## 三、13 条 high 发现 triage（OCR 候选，均需红→绿复现后才算确认）

| # | 文件:行 | 类别 | 问题摘要 | 初步判断 | 建议批次 |
|---|---|---|---|---|---|
| 1 | `src/agent-evals/registry.ts:87-94` | bug | `parseJson` 只防 JSON.parse 异常，不校验 shape；损坏行的 `null`/`{}` 会让 `Object.keys(null)` 崩溃 | 很可能真实；查询层声称 sanitize 但未覆盖 | E3 |
| 2 | `src/agent-evals/runtime-runner.ts:128-134` | bug | 审批调用异常时 `base.blocked` 保持 false，high-risk 拦截题被记为未拦截，违背 fail-closed | 很可能真实；catch 中未按审批阶段置 blocked | E3 |
| 3 | `src/agents/approver-model.ts:348-351` | security | 审批命令静默截断到 1000 字符，尾部可藏 `rm -rf /`；reviewed ≠ executed | 很可能真实；应截断即拒或显式告知 | E2 |
| 4 | `src/agents/consciousness/goal-tracker.ts:261-272` | bug | `lastCycleHistoryLen` 在 push/trim 前捕获；满容量后 previousHistory 含本轮快照，Jaccard=1.0 掩盖漂移 | 很可能真实；边界应在 trim 后记录 | E3 |
| 5 | `src/agents/opencode-tools/codegen.ts:73-84` | performance | stdout/stderr 顺序 drain 可死锁子进程（64KB pipe 写满），大输出每轮 30s 超时 | 很可能真实；应并发读双流 | E4 |
| 6 | `src/agents/prompt-pool.ts:539-543` | bug | `String.replace` 第二参按 replacement template 展开 `$$`/`$&`/`$'`，用户输入被破坏 | 很可能真实；应使用函数 replacer | E4 |
| 7 | `src/agents/prompt-pool.ts:581-583` | bug | `acquire()` 与 `release()` 双计 hits，hitRate 可 >1.0 | 很可能真实；应只在一处计数 | E4 |
| 8 | `src/agents/tool-classifications.ts:163-165` | security | 认知闭环/TaskGraph 工具被分类为 safe，可绕过 plan mode 风险门 | 很可能真实；至少升 caution | E1 |
| 9 | `src/cli/setup.ts:403` | security | 生成的 `.env` 含明文 API key，按默认 0644 写盘 | 很可能真实；改为 mode 0o600 | E1 |
| 10 | `src/components/recoverable-output.ts:32-34` | security | 只限条目数/TTL，不限单条/总字节；1000×10MB 可占 ~10GB | 很可能真实；加 maxTotalBytes/maxEntryBytes | E2 |
| 11 | `src/context/context-manager.ts:195` | bug | split 后只保留最后 preserveRecent 条，system prompt 被归档，后续轮丢系统指令 | 很可能真实；应保留/重注入 system | E3 |
| 12 | `src/db/session-lineage.ts:156-161` | security | 用户搜索词直入 FTS5 MATCH；`OR`/`AND`/`NEAR` 未处理，普通输入可致 syntax error 上抛；全剥离时 MATCH '' 空结果 | 很可能真实；逐词双引号 + 空串回退列表 | E1 |
| 13 | `src/decision/laya-calibrate.ts:266-267` | bug | 批响应缺结果/缺分布被强转为 `<none>`/margin 0；全缺失时 judgeDrift 误判 stable，strict 也 exit 0 | 很可能真实；缺失应标 insufficient | E4 |

---

## 四、覆盖率与口径 caveat（必须如实阅读）

1. **摘要 vs session 元数据口径不一致**：OCR 摘要写 “453 file(s) reviewed”，session 元数据写 “22 done / 101 fail”。两者一个是尝试计数、一个是 checkpoint 计数；本报告不把它们合并成“100% 覆盖”。
2. **token 预算触顶**：2,000,000 token 上限在 `src/decision/laya-triage.ts` batch #3 处触顶；其结果仍写出，但更靠后的文件可能未被完整审查。
3. **工具调用失败**：日志含 `file_read failed`（TS 项目按 `.js` 解析 import）、`code_comment failed`（非法转义）、`code_search failed`（git grep 正则括号）等；这些失败不表示代码有缺陷，但会降低覆盖。
4. **评论是候选发现**：本报告不做“已确认缺陷”声明；每条 high 都需按 `AGENTS.md` 规则 6/7 建红→绿复现后再修。
5. **Step 12b 未执行**：墙钟阈值 `perfBudget` 棘轮与测试并行化评估仍是待办；本轮只完成 12a 的 OCR 报告。

---

## 五、建议：新建 Batch E 修复计划（不在本报告内施工）

| 批次 | 内容 | 包含 high |
|---|---|---|
| E1 安全快修 | `.env` 0600（setup + cli.ts）、session-lineage FTS5 引号/空回退、tool-classifications 认知闭环升 caution、tool-invocations args 脱敏（medium） | #8 #9 #12 |
| E2 审批与内存边界 | approver-model 截断 fail-closed、recoverable-output 字节上限 | #3 #10 |
| E3 Agent 状态正确性 | agent-evals registry shape + runtime-runner fail-closed、goal-tracker 边界、context-manager 保留 system | #1 #2 #4 #11 |
| E4 工具/输出正确性 | codegen 双流并发、prompt-pool replace/metrics、laya-calibrate absent | #5 #6 #7 #13 |
| E5 medium 安全 triage | db.ts CLI 原始 SQL（本地开发工具定位）、browser-launch URL 日志、lightpanda language 插值、tool-invocations args 明文 | medium |

**建议**：新建 `docs/superpowers/plans/2026-10-03-ocr-src-high-remediation.md`（T3，8–10 个 Step），按 E1→E4 排序，E5 单列 triage；不要把这些混入当前 12 步计划的提交。

---

## 六、复现方式

- 原始输出：`sed -n '1,200p' /tmp/ocr-step12-src.txt`
- 解析脚本思路：按 `─── <file>:<line> ───` 切块，取每块 `[<category> · <severity>]`，统计 severity/category/文件分布；本次统计结果见 §一/§二。
- session 元数据：`~/.local/share/ocr/node_modules/.bin/ocr session list`（session `1368fa22-bfac-4771-a650-a4a26fee0221`）。
