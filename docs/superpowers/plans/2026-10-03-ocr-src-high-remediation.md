# OCR `src/**` High Findings Remediation Plan (Batch E)

> 来源：`docs/reviews/2026-10-02-ocr-full-coverage.md`。
> 基线：`main = 16980d66`（2026-10-05）；OCR provider/model = SenseNova `deepseek-v4-flash`。
> 目的：对 13 条 high 候选逐条 **RED → GREEN**；不做“扫描器说改就改”的盲修。
> 规则：遵守 `AGENTS.md` 规则 2/3/5/6/7/9/12；每步独立提交、可回滚、失败不扩面。

---

## 0. 冻结任务契约

**任务**：修复 OCR 报告中 13 条 high 候选；每条先建立能复现原症状的测试，再最小修改生产代码；最后执行全量 TS、文档和 Git 门禁。

**验收标准**：

1. 13 条 high 每一条都有明确处置：`confirmed+fixed`、`confirmed+deferred` 或 `false-positive+evidence`；不允许静默跳过。
2. 每个 `confirmed+fixed` 必须在修改前有 RED 证据，修改后有同测试 GREEN 证据。
3. 不改变非目标行为；安全边界只允许收紧，不允许放宽。
4. `bunx tsc --noEmit`、全量 `tests/**`、doc-contract、docs-consistency 全绿。
5. 每个 Step 有 ops log 条目、commit hash、推送目标和回滚点。

**改动清单（文件级）**：按下方 Step 逐项列出；不得在同一 commit 混入无关重构。

**不做项**：

- 不升级 OCR CLI/provider，不重跑 2M token 全扫。
- 不修 74 条 medium / 76 条 low；medium 只在 E5 triage 中单列。
- 不重构模块边界，不改变公开 API，除非该 Step 的回归测试证明必须。
- 不修改已发布历史，不使用 force push，不直接 amend `main` 已发布提交。

**全局验证命令**：

```bash
cd /run/media/listen/base/openclaw-fusion
bunx tsc --noEmit
bun test tests/doc-contract.test.ts
bun test tests/unit/docs-consistency.test.ts
bun test --timeout 15000 ./tests
git diff --check
git status --short --branch
```

**全局回滚**：每个 Step 单独 commit；问题出现时 `git revert <step_commit>`，不回退其他 Step。

---

## 1. Step E1-a — `.env` 权限收紧

**级别/优先级**：T2 / High（安全）

**Context brief**：OCR #9。`src/cli/setup.ts` 的向导和 `src/cli.ts` 的 `key` 命令会把 API key 写入 `.env`；默认 `writeFileSync` 可能生成 0644。修复必须同时覆盖“新建”和“已存在文件被重写”两条路径。

**改动清单**：

- `src/cli/setup.ts`：抽出可测试的安全写入 helper（或等价最小函数），写入后用 `chmodSync(..., 0o600)` 强制收紧。
- `src/cli.ts`：`key` / `key:remove` 写入 `.env` 时使用同样的安全写入语义；避免在日志回显 key。
- 新增或扩展定向测试：临时目录验证新建/覆盖后 mode 均为 `0o600`。

**RED**：测试在临时目录调用写入 helper；当前实现无 helper 或 mode 不为 0600，断言失败。
**GREEN**：最小实现后再跑定向测试通过。
**验证**：

```bash
bun test <新增/扩展的 env permission tests>
bunx tsc --noEmit
```

**退出判据**：不存在绕过安全写入 helper 的 `.env` 写入点；日志不回显 key。
**回滚**：revert 本 Step commit。

---

## 2. Step E1-b — FTS5 查询安全化 + 认知工具风险升级

**级别/优先级**：T2 / High（安全）

**Context brief**：OCR #12 将用户输入直入 FTS5 `MATCH`；`OR`、`AND`、`NEAR`、引号可触发 syntax error，剥离后为空会查询 `MATCH ''`，应降级为列表查询而非抛错。OCR #8 的 `cognitive_loop`、`cognitive_loop_full`、`task_graph_execute` 会执行完整认知/TaskGraph 流程，却标为 `safe`，会绕过 plan mode 风险门。

**改动清单**：

- `src/db/session-lineage.ts`：安全构造 FTS 查询；逐词转义/双引号；无可查询 token 时使用确定性回退（例如按 `updated_at` 列表查询）。
- `src/agents/tool-classifications.ts`：三个认知闭环/TaskGraph 工具从 `safe` 升为至少 `caution`。
- 扩展 `tests/db/session-lineage.test.ts`；新增或扩展风险分类测试。

**RED**：`OR`/`NEAR`/纯符号/空查询触发异常或错误结果；三类工具当前被断言为 safe。
**GREEN**：恶意语法不再抛、空查询有确定结果；三类工具为 caution。
**验证**：

```bash
bun test tests/db/session-lineage.test.ts <risk classification tests>
bunx tsc --noEmit
```

**退出判据**：FTS 查询无 SQL 语法错误上抛；普通中文/英文搜索仍命中；认知闭环工具不再走 safe 路径。
**回滚**：revert 本 Step commit。

---

## 3. Step E2-a — 审批命令截断 fail-closed

**级别/优先级**：T2 / High（安全）

**Context brief**：OCR #3。`buildApprovalPrompt` 静默 `command.slice(0, 1000)`，尾部可藏危险命令，审批模型看到的是截断版而非执行版，形成“reviewed ≠ executed”。

**改动清单**：

- `src/agents/approver-model.ts`：在构造提示前检测命令超限；超限直接返回/触发 fail-closed verdict，不把截断内容伪装成完整命令。
- 保持短命令审批路径及现有 fail-closed 语义不变。
- 新增定向测试：超过阈值的命令不得进入 provider 调用，结果 `decided:false` 或明确的拒绝 verdict。

**RED**：被测超长命令仍调用 provider，或截断内容被当作完整命令审批。
**GREEN**：超长命令不调用 provider，返回明确拒绝原因。
**验证**：

```bash
bun test <approver-model truncation tests>
bunx tsc --noEmit
```

**退出判据**：所有命令长度边界有测试；任何截断都不可产生 approved=true。
**回滚**：revert 本 Step commit。

---

## 4. Step E2-b — Recoverable output 字节上限

**级别/优先级**：T2 / High（安全/内存）

**Context brief**：OCR #10。`RecoverableOutputStore` 只限制条目数与 TTL，单条/总量无上限；1000 条 10MB 文本可占用约 10GB。

**改动清单**：

- `src/components/recoverable-output.ts`：新增 `maxEntryBytes`、`maxTotalBytes`（默认值需保守且可配置）；单条超限直接拒绝/降级，不写入 Map；总量超限淘汰最旧条目。
- `stats()` 暴露新上限或至少可观测实际总量。
- 扩展 `tests/components/recoverable-output.test.ts`：单条超限、总量淘汰、正常大输出回归。

**RED**：超限条目仍被保存/总量持续增长。
**GREEN**：单条与总量上限均生效，现有“大输出可读回”在不超限时保持。
**验证**：

```bash
bun test tests/components/recoverable-output.test.ts
bunx tsc --noEmit
```

**退出判据**：内存上界由构造参数决定，行为可在测试中确定复现。
**回滚**：revert 本 Step commit。

---

## 5. Step E3-a — Eval registry shape guard + runner 审批 fail-closed

**级别/优先级**：T2 / High（正确性）

**Context brief**：OCR #1。`parseJson` 只处理 JSON syntax，不校验 shape；DB 中 `null`/`{}` 可让后续 `Object.keys` 崩溃。OCR #2。`runtime-runner` 的 outer catch 不按已进入审批阶段设置 `blocked`，异常时可能把 high-risk 样本记为“未拦截”。

**改动清单**：

- `src/agent-evals/registry.ts`：JSON 解析后增加 shape/类型 guard；损坏 summary 降级为 `{}`，非法数组/标量不允许进入后续代码。
- `src/agent-evals/runtime-runner.ts`：记录审批阶段状态；catch 中若已进入审批且异常，按 fail-closed 设置 `blocked=true`、`executionError=true`，保留可读 reason。
- 扩展 `tests/agent-evals/registry.test.ts`；新增/扩展 runner 审批异常测试。

**RED**：`summary_by_family` 为 `null`/数组/标量导致崩溃或错误数据；审批抛异常时 `blocked=false`。
**GREEN**：脏数据降级且查询稳定；审批异常被标记为 blocked。
**验证**：

```bash
bun test tests/agent-evals/registry.test.ts <runner approval tests>
bunx tsc --noEmit
```

**退出判据**：异常不会把拦截题变成通过；所有 shape 边界有测试。
**回滚**：revert 本 Step commit。

---

## 6. Step E3-b — Goal tracker 漂移边界 + Context system 保留

**级别/优先级**：T2 / High（正确性）

**Context brief**：OCR #4。`trackHistory` 在 trim 前记录 `lastCycleHistoryLen`；满容量后 `previousHistory` 包含本轮新快照，漂移被掩盖。OCR #11。`splitContext` 只保留最近 `preserveRecent` 条，system prompt 可能被归档，后续轮丢失系统指令。

**改动清单**：

- `src/agents/consciousness/goal-tracker.ts`：先 push 当前快照再 trim，最后记录 `lastCycleHistoryLen`；补充满容量/边界测试。
- `src/context/context-manager.ts`：拆分时显式保留 system message（去重），再保留最近非 system 消息；`compressContext` 同步检查。
- 扩展对应测试。

**RED**：满容量后漂移分数错误为 1.0；system 消息不在 activeMessages。
**GREEN**：漂移恢复正常；system 消息始终保留且不重复。
**验证**：

```bash
bun test <goal tracker tests> <context manager tests>
bunx tsc --noEmit
```

**退出判据**：边界行为由测试锁住；没有新增消息顺序/去重回归。
**回滚**：revert 本 Step commit。

---

## 7. Step E4-a — Codegen 双流并发 drain

> **执行结果（2026-10-05）**：`false-positive+evidence`。在 Bun 1.4.2 / Linux 下用真实子进程写入 **8 MiB stderr 后再写 stdout**，旧顺序读取仍 13ms 完成，无法复现死锁；Bun 的 spawn 流层实际并行排空。**不修改生产代码**，保留回归守卫 `tests/opencode-codegen-dual-stream.test.ts`。

**级别/优先级**：T2 / High（性能/可靠性）

**Context brief**：OCR #5。先读完 stdout 再读 stderr；子进程若 stderr 先写满 64KB pipe 会阻塞，导致 30s 超时。

**改动清单**：

- `src/agents/opencode-tools/codegen.ts`：stdout/stderr 使用并发读取（`Promise.all` 或两个独立 async reader），确保两个 pipe 同时 drain。
- 保持 timeout、semaphore release once、错误语义不变。
- 新增/扩展 fake spawn 测试：stderr 大量输出时不再死锁/超时。

**RED**：模拟 stderr 先于 stdout 大量写入，进程无法完成或触发 timeout。
**GREEN**：双流并发读取，正常返回/报错。
**验证**：

```bash
bun test <codegen tests>
bunx tsc --noEmit
```

**退出判据**：并发读取不改变退出码/内容拼接语义；超时路径仍 release semaphore 一次。
**回滚**：revert 本 Step commit。

---

## 8. Step E4-b — Prompt pool replacer + hits 单计

**级别/优先级**：T2 / High（正确性）

**Context brief**：OCR #6。`String.replace` 第二参会被当成 replacement template，用户输入中的 `$&`、`$'`、`$$` 会改变结果。OCR #7。`acquire()` 与 `release()` 都递增 hits，hitRate 可超过 1。

**改动清单**：

- `src/agents/prompt-pool.ts`：所有动态变量替换改为函数 replacer，避免 `$` 展开；hits 只在一个生命周期点计数。
- 增加测试覆盖 `$&`、`$$`、`$'`、`$`` 等输入；统计测试断言 hitRate ≤ 1 且数值符合定义。
- 不改变 prompt 文本的稳定前缀/缓存 marker。

**RED**：用户输入被 `$` 模板改写；hits 双计。
**GREEN**：输入原样进入 prompt；hitRate 统计正确。
**验证**：

```bash
bun test <prompt-pool tests>
bunx tsc --noEmit
```

**退出判据**：替换行为与统计口径由测试锁住；缓存相关既有测试全绿。
**回滚**：revert 本 Step commit。

---

## 9. Step E4-c — Laya drift 缺失结果按 insufficient

**级别/优先级**：T2 / High（正确性）

**Context brief**：OCR #13。批响应缺结果/缺分布时被强转为 `<none>` / margin 0；全缺失可被误判 stable，`--strict` 也返回 0。

**改动清单**：

- `src/decision/laya-calibrate.ts`：缺失 answer/probabilities 不伪造 choice/margin；样本标记为 missing/insufficient，聚合为 `verdict:"insufficient"`。
- `--strict` 只要存在 unstable 或 insufficient 就返回 1（现有判据保持并锁定）。
- 扩展 `tests/decision/laya-drift.test.ts`：部分缺失、全缺失、strict 三个用例。

**RED**：缺结果被写成 `<none>` 且 verdict=stable；strict 返回 0。
**GREEN**：缺失样本为 insufficient，strict 返回 1。
**验证**：

```bash
bun test tests/decision/laya-drift.test.ts
bunx tsc --noEmit
```

**退出判据**：缺失数据不产生假稳定；JSON 报告可区分 `stable/unstable/insufficient`。
**回滚**：revert 本 Step commit。

---

## 10. Step E5 — 全量回归 + OCR 增量复核

**级别/优先级**：T3 / Closeout

**Context brief**：所有 high Step 完成后，验证非目标面未回归，并对 high 相关文件做 OCR delta review（只审查本批 diff，不重跑全仓）。

**动作**：

1. 对 13 条 high 建处置表：每条给出结论、测试命令、RED/GREEN 证据、commit。
2. 运行全量门禁：

```bash
bunx tsc --noEmit
bun test tests/doc-contract.test.ts
bun test tests/unit/docs-consistency.test.ts
bun test --timeout 15000 ./tests
git diff --check
```

3. OCR delta（若 CLI/provider 可用）：

```bash
ocr review --audience agent \
  --background "Batch E: OCR src high findings remediation, security/correctness only" \
  --from 16980d66 --to HEAD \
  --output /tmp/ocr-batch-e-delta.txt
```

4. 不把 medium/low 混入本批；只记录为 E5 后续 triage。

**退出判据**：13/13 有处置结论；全量测试 0 fail；文档契约 0 fail；main 可 fast-forward。
**回滚**：按 Step revert；Step 10 不改生产代码。

---

## 10.1 13 条 high 处置结果（2026-10-05）

| OCR # | 文件 | 处置 | 证据 |
|---|---|---|---|
| #9 | `src/cli/setup.ts` / `src/cli.ts` | `confirmed+fixed` | `tests/utils/env-file-permissions.test.ts`；commit `f0128a71` |
| #8 | `src/agents/tool-classifications.ts` | `confirmed+fixed` | `tests/unit/tool-classifications.test.ts`；commit `0021fda7` |
| #12 | `src/db/session-lineage.ts` | `confirmed+fixed` | `tests/db/session-lineage.test.ts`；commit `0021fda7` |
| #3 | `src/agents/approver-model.ts` | `confirmed+fixed` | `tests/agents/approver-model-truncation.test.ts`；commit `c338c17e` |
| #10 | `src/components/recoverable-output.ts` | `confirmed+fixed` | `tests/components/recoverable-output.test.ts`；commit `e49848cf` |
| #1 | `src/agent-evals/registry.ts` | `confirmed+fixed` | `tests/agent-evals/registry.test.ts`；commit `4336fb41` |
| #2 | `src/agent-evals/runtime-runner.ts` | `confirmed+fixed` | `tests/agent-evals/runtime-runner-approval.test.ts`；commit `4336fb41` |
| #4 | `src/agents/consciousness/goal-tracker.ts` | `confirmed+fixed` | `tests/consciousness-goal-tracker.test.ts`；commit `05bf7b57` |
| #11 | `src/context/context-manager.ts` | `confirmed+fixed` | `tests/context/context-manager-system.test.ts`；commit `05bf7b57` |
| #5 | `src/agents/opencode-tools/codegen.ts` | `false-positive+evidence` | 8 MiB stderr 真实子进程回归 18.81ms 完成；commit `ae11f5ae` |
| #6 | `src/agents/prompt-pool.ts` | `confirmed+fixed` | `tests/prompt-pool-template.test.ts` 字面替换；commit `2c5cdfd3` |
| #7 | `src/agents/prompt-pool.ts` | `confirmed+fixed` | `tests/prompt-pool-template.test.ts` hits 单计；commit `2c5cdfd3` |
| #13 | `src/decision/laya-calibrate.ts` | `confirmed+fixed` | `tests/decision/laya-drift.test.ts` 缺失响应边界；commit `1ed7e7c6` |

### 10.2 最终门禁证据

- `bunx tsc --noEmit` rc=0。
- `bun test tests/doc-contract.test.ts tests/unit/docs-consistency.test.ts` 45 pass / 0 fail。
- 全量 `bun test --timeout 15000 ./tests`：**4,637 pass / 67 skip / 0 fail**（4,704 tests / 482 files；119.08s；E5.1 triage 修复后终态）。
- 首次全量暴露并修复的收口问题：两个新 recoverable env 未登记、`ARCHITECTURE.md` 统计未同步、审批测试 spy 污染并行 DRE 测试；修复后全量复跑为 0 fail。
- OCR delta review：见本节执行记录；不把 OCR 原始报告候选直接表述为确认缺陷。

### 10.3 OCR diff 增量复核（2026-10-05/06）

- 工具：`open-code-review v1.12.12`（用户授权升级；隔离安装于 `~/.local/share/ocr-latest`）。
- 范围：`16980d66..HEAD`。
- 第一轮（默认并发）：14 files reviewed / 2 comments；13/14 selected items 因 SenseNova `429 rpm exhausted` 失败。
- 第二轮（`--concurrency 1`）：14 files reviewed / **9 comments**；仍有 4/14 selected items 因 429 未完整复核。因此本记录不宣称 OCR 100% 覆盖。
- 增量发现与处置：
  - M1 recoverable output：超过 `maxEntryBytes` 时 wrapper 直接抛错。已修为返回 `available:false` 的不可取回占位，工具调用不再因超限中断。
  - M2 context-manager：旧 compaction summary 被当作 policy 永久保留，反复压缩会累积摘要。已把旧摘要降级为可再压缩历史，只保留真正的 policy system message。
  - M3 session-lineage：FTS 清洗允许 `_`，但 `unicode61` 把 `_` 当分隔符，`___` 会走到空 FTS 查询。已要求 token 至少含一个 letter/digit，纯分隔符回退最近列表。
  - M4 laya-calibrate：单键分布被当作有效 margin=1，可能伪造 stable。已要求至少两个概率项；缺失样本在报告中输出 `missing` 与 `null` choice/margin。
  - L1 external skill env 文档：已在 `mcp/external/SKILL.md` 补登 `MAX_ENTRY_BYTES`/`MAX_TOTAL_BYTES` 与 fail-closed 语义。
  - L2 context split 日志 activeMessages 少计 system：已按实际返回数组计数。
  - L3 context split 早退路径 system 顺序不一致：已统一为 policy system 在前。
  - L4 session-lineage dead quote escape：已移除。
  - L5 laya missing 报告不可辨：已显式序列化 `missing`，缺失 margin/choice 用 `null`。
- 终态验证：定向回归 **34 pass / 0 fail**；全量 **4,637 pass / 67 skip / 0 fail**；`bunx tsc --noEmit` rc=0；`arch:stats` 同步为 **38 模块 / 441 文件 / 119,767 行**。
- OCR 仍为**部分复核**：4/14 文件因 provider 限流失败，后续可在限流恢复后再次低并发重跑。

## 11. 对抗性自检（主代理执行）

- **范围审查**：只修 high；E1 的安全写入 helper 不得演变为 CLI 重构。
- **依赖审查**：Step 1/2 同属 E1，若同文件必须串行；E2/E3/E4 文件互不重叠，可按依赖顺序提交。
- **行为审查**：审批截断、输出字节上限、FTS 回退均属行为收紧；必须由测试明确结果，不靠“应该安全”。
- **测试审查**：每条 RED 必须因目标 bug 失败，而不是 setup/import 错误。
- **回滚审查**：每步独立 commit 且不依赖后续 Step 才能回滚。
- **已知不充分**：本计划不声明 OCR 覆盖 100%；报告已记录 token budget 触顶与工具失败，Step 10 只做 delta review。

---

## 12. 变更协议

任何新增修复、扩大文件面、改变默认上限或放宽安全语义，必须先在本文件追加变更记录并说明原因，再施工；不得以“顺手修复”为由扩面。
