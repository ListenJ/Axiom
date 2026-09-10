# P2 收尾迭代实施计划（S6 定稿入库 + 评估回写 + 验收收口）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **状态回写（2026-09-06）**：Task1-5 全部完成并核实——S6 基准 100k 档入库 9fa1a8c（scripts/bench-kal-retrieval.ts SCALES 三档 + kal-benchmark-2026-08-30.md）、评估报告 §8 回写 e355d97、spec 验收勾选 36a9231、ops hash 回填；验收清单 5 项此前已勾。checkbox 本次补勾（记录维护）。

**Goal:** 收口 P2 收尾迭代：S6 KAL 基准补全 100k 档并定稿入库，评估报告杠杆清单回写全清，spec 验收清单勾选，ops-log 留痕 + spec hash 回填，终验后提交推送。

**Architecture:** S1–S5 已提交（270f3f6/c3b2d35/3ecccbe/d549c64/f0c8db2）。剩余 = S6 资产（`scripts/bench-kal-retrieval.ts` + `docs/knowledge/kal-benchmark-2026-08-30.md`，均未跟踪）→ 按 spec §S6 补 100k 档并将报告文本的规模/格数硬编码改动态 → 定稿重跑 → 提交；评估报告（`agent-decision-chain-assessment-2026-08-29.md`）追加 §8 P2 收尾回写（杠杆清单全清）；spec（`2026-08-30-p2-closeout-design.md`）验收清单 5 项勾选；ops-log 逐提交留痕 + 回填 spec 提交 hash `5abfe4b`；最后 `bun run test:full` + `bunx tsc --noEmit` 终验。

**Tech Stack:** Bun 1.3.14 / TypeScript strict / bun:sqlite（bench 脚本）/ bun:test。

**Spec:** `docs/superpowers/specs/2026-08-30-p2-closeout-design.md` §S6 + 验收清单。
**审计证据：** `docs/reviews/2026-08-29-joint-verification-audit.md` §7（强化迭代完成后 P2 收尾）。
**deviation flag（规则 10）：** 已交付脚本 `SCALES=[10_000, 50_000]` 与 spec "10k/50k/100k" 不符，且 `buildReport` 硬编码 "10k/50k 两档 / 6 格"；本计划在 Task 1 修复并补 100k 档，使 S6 交付与 spec 逐字对齐。

## Global Constraints

- 分支 `codex/self-evolving-agent`；每任务 `git add <仅本任务文件>` → commit → `git push internal211 codex/self-evolving-agent`（AGENTS 规则 3）。
- 每任务修改前备份 `.tmp/backups/<相对路径>` → 通读全文 → 最小改动 → 验证通过 → 删备份（规则 2）。
- 每提交前 `docs/operations-log.md` 追加条目，规则 5（一次一条，hash 先待填后回填，回填走 bun 脚本唯一锚点，禁止 sed）。
- `data/real-usage-traces.jsonl`、`.serena/*`、`scripts/pdf-worker/*`、`docs/superpowers/plans/2026-08-28-plan-amendment-most-stable.md` 与本任务无关，**不得暂存**（前四文件内容与 HEAD 逐字节一致，仅 stat 缓存噪音；traces 为 .jsonl 未被 gitignore 覆盖但非本任务产物）。
- bench 脚本不进 test:full（spec 明示 "bench 非测试"），脚本自带冒烟反馈回路（FTS 行数一致 + probe 命中）。
- 终验基线：`bun run test:full` 全绿 + `bunx tsc --noEmit` 0；scripts/ 不在 tsconfig include（src/** tests/**），脚本类型正确性以实跑绿为准。

---

### Task 1: S6 脚本补全 100k 档 + 报告文本规模/格数动态化（TDD 红→绿）

**Files:**
- Modify: `scripts/bench-kal-retrieval.ts:33`（SCALES）、`:12-16`（文档头）、`:47` 附近（新增 scaleLabel 助手）、`:464-466`（tierTable 用 scaleLabel）、`:556`（摘要档位串动态）、`:572`（门禁格数动态）、`:578`（降级档标题）+ `:606`（结论格数动态）

**Interfaces:**
- Produces: `SCALES=[10_000,50_000,100_000]`；`scaleLabel(v:number):string`（k 缩写）；报告文本中规模串/格数由 SCALES 派生（`${SCALES.length}`/`${SCALES.length*3}`）。

- [x] **Step 1: 写失败测试（红）**

基准脚本无单测库（spec 明示不进 test:full），红态定义为：现脚本只跑 10k/50k 两档、摘要文本仍写死 "10k/50k 两档"。先把脚本跑一遍确认当前红态：

Run: `bun run scripts/bench-kal-retrieval.ts`
Expected: 日志仅 `10000 行完成` 与 `50000 行完成`（无 100000）；随后报告无 `### 100k 行` 小节（可 `rg "### 100k 行" docs/knowledge/kal-benchmark-2026-08-30.md` → 无匹配）。

- [x] **Step 2: 补 100k 档 + 引入 scaleLabel**

Run: 先备份
```powershell
Copy-Item scripts/bench-kal-retrieval.ts .tmp\backups\scripts\bench-kal-retrieval.ts -Force
```

Edit 1（`scripts/bench-kal-retrieval.ts:33`）：SCALES 补 100k
```ts
const SCALES = [10_000, 50_000, 100_000];
```

Edit 2（`:47` REPORT_PATH 之后）新增助手：
```ts
const scaleLabel = (v: number): string => (v >= 1000 ? `${v / 1000}k` : String(v));
```

Edit 3（`:464-466` tierTable）标题段改 `scaleLabel(scale)`：
```ts
  lines.push(`### ${scaleLabel(scale)} 行`);
```

Edit 4（`:556` 摘要）档位串动态化：
```ts
    `> **摘要**：W5/W8 重立项前置门禁数据。合成 kg_nodes（CJK+英文混合）${SCALES.map(scaleLabel).join("/")} 共 ${SCALES.length} 档，对照组 A=现状 LIKE（照抄 \`src/kal/knowledge-access-layer.ts\` queryKG 的 LIKE SQL），B=FTS5 trigram（S2 基建同款虚拟表+触发器，脚本内内存库，非生产迁移）。3 类查询 × 每类 20 条，预热 1 次后计时 3 次取中位数，p50/p95 跨 20 查询。数字全部来自本次实跑（seed=${SEED} 可复现），总耗时 ${totalMs} ms。`,
```

Edit 5（`:572` 门禁口径）格数动态化：
```ts
    lines.push(`- **门禁口径**：p95 增益 = LIKE p95 / FTS p95（FTS p95 下限 0.01ms 防除零，即增益上限封顶 100x 量级）；**中位增益 = ${SCALES.length} 规模 × 3 类型共 ${SCALES.length * 3} 格 p95 增益的中位数**；<2x → W5/W8 正式关闭（LIKE 现状保留），>=2x → 立项排期。`);
```

Edit 6（`:578` 降级档标题）：`lines.push(\`### ${r.scale / 1000}k 行\`)` → `lines.push(\`### ${scaleLabel(r.scale)} 行\`)`

Edit 7（`:606` 结论）格数动态化：
```ts
  lines.push(`- **p95 中位增益（${SCALES.length * 3} 格中位数）：${medianGain.toFixed(2)}x**`);
```

Edit 8（`:12-16` 文件头注释）档位改为 `10k / 50k / 100k 三档`。

- [x] **Step 3: 重跑验证（绿）**

Run: `bun run scripts/bench-kal-retrieval.ts`
Expected: 日志出现 `100000 行完成（...）`；报告写入成功，`rg "### 100k 行" docs/knowledge/kal-benchmark-2026-08-30.md` 命中；摘要含 `10k/50k/100k 共 3 档`；门禁行含 `3 规模 × 3 类型共 9 格`；结论行含 `（9 格中位数）` 与 `**结论行：`。

Run: `rg "10k/50k 两档|2 规模|6 格" docs/knowledge/kal-benchmark-2026-08-30.md`
Expected: 无匹配（硬编码全部消除）。

- [x] **Step 4: 报告逐字段核对 + 备份清理**

Run: `Get-Content docs/knowledge/kal-benchmark-2026-08-30.md`
Check: 3 档表格（10k/50k/100k）、FTS 召回均值、p95 增益列、门禁结论行存在；若任一档 degraded 必须如实保留（不得造假数据）。核对后删除备份。

Run: `Remove-Item .tmp\backups\scripts\bench-kal-retrieval.ts -Force`

---

### Task 2: S6 资产入库提交

**Files:**
- Add: `scripts/bench-kal-retrieval.ts`、`docs/knowledge/kal-benchmark-2026-08-30.md`
- Modify: `docs/operations-log.md`（追加 S6 条目）

- [x] **Step 1: ops-log 追加 S6 条目**

在 `docs/operations-log.md` 末尾追加一条（hash 先写 `待回填`）：

```markdown
## 2026-08-30 — feat(bench): P2-S6 KAL 检索基准定稿（补 100k 档 + 报告文本动态化，W5/W8 门禁判定）

- **任务**：docs/superpowers/specs/2026-08-30-p2-closeout-design.md §S6 收口：基准脚本补 spec 要求的 100k 档（SCALES 三档）并将报告摘要/门禁/结论的"两档/6 格"硬编码改为 SCALES 派生；seed=42 可复现。
- **工具**：Bash（bun 重跑基准/备份/验证）、Edit（脚本 8 处最小改动）、Write（ops-log）。
- **操作**（文件级）：scripts/bench-kal-retrieval.ts（SCALES+100k、scaleLabel 助手、tierTable/降级标题/摘要/门禁/结论文本动态化、文件头注释同步）；docs/knowledge/kal-benchmark-2026-08-30.md（重跑后定稿报告）；本条目追加。
- **验证**：脚本重跑绿（三档均非 degraded）；报告含 `### 100k 行`、`10k/50k/100k 共 3 档`、`3 规模 × 3 类型共 9 格`、`（9 格中位数）` 与结论行；`rg "10k/50k 两档|2 规模|6 格"` 零命中；tsc 非 include 范围（scripts/），以实跑绿为准。
- **Commit**：feat(bench): P2-S6 KAL 基准定稿（100k 档 + 文本动态化，W5/W8 门禁判定） — hash 待回填
```

- [x] **Step 2: 提交 C1 并推送**

```bash
git add scripts/bench-kal-retrieval.ts docs/knowledge/kal-benchmark-2026-08-30.md docs/operations-log.md
git commit -m "feat(bench): P2-S6 KAL 基准定稿（补 100k 档 + 报告文本动态化，W5/W8 门禁判定）"
git push internal211 codex/self-evolving-agent
```

- [x] **Step 3: 回填 C1 hash**

用 bun 脚本唯一锚点替换 `P2-S6 ... — hash 待回填` 行尾的占位符（禁止 sed）；该回填并入下个提交一起推送（见 Task 4 Step 3），此为记录维护不再追加业务条目。

---

### Task 3: 评估报告 P2 终版回写（杠杆清单全清）

**Files:**
- Modify: `docs/knowledge/agent-decision-chain-assessment-2026-08-29.md`（追加 §8）

- [x] **Step 1: 备份 + 通读末尾**

```powershell
Copy-Item docs/knowledge/agent-decision-chain-assessment-2026-08-29.md .tmp\backups\docs\knowledge\agent-decision-chain-assessment-2026-08-29.md -Force
```
Read: 文件全文（已通读，含 §七 P1 回写表）。

- [x] **Step 2: 追加 §8 回写表**

在文件 §七 之后追加：

```markdown
---

## 八、P2 收尾回写（2026-08-30，杠杆清单全清）

| 杠杆 | 状态 | Commit | 实施要点 |
|------|------|--------|---------|
| P2-1 约束再校准 | ✅ | 270f3f6 | temp0 拒绝采样 n=1（三票同值数学等价单票，省 2/3 成本）、DRE maxTokens 512→2048、Anthropic high 4096→8192 |
| P2-2 幽灵裁剪 | ✅ | c3b2d35 | mathContext 休眠链 4 模块规则4 归档（-2552 行）、autoRoute 死代码删除、RateDistortion 保留 |
| P2-3 test:full 自动发现 | ✅ | 3ecccbe | --isolate 根治组合序 + EXCLUDE_FILES flaky 账本，3199 pass/0 fail |
| P2-4 HITL 真值标注管道 | ✅ | d549c64 | hallucination_verdicts label 列 + hallucination_feedback 工具 + calibrate 真值优先，tool-count 189 |
| P2-5 M10 降级上下文补全 | ✅ | f0c8db2 | 本地工作记忆摘要随行云端 prompt（≤2KB），记忆不可用逐字节现状 |
| P2-6 W5/W8 基准门禁 | ✅ | 见本条目 | 10k/50k/100k 三档合成库 LIKE vs FTS5 trigram（seed=42，3 次实跑 p95 中位增益 2.07/2.11/2.27x 均 ≥2x），**gate ≥2x → W5/W8 立项排期**（推翻 2 档草稿"关闭"结论——100k 档如实改变判定；落地形态：kg_nodes fts5 trigram 虚拟表+触发器 + queryKG MATCH 主腿 + 2 字 CJK LIKE 兜底腿）；精确词 ~1.1x 为兜底腿期然，前缀/语序改写 2-8x 为真实增益 |

**结论**：评估报告 §五 提升路线全部杠杆（P0×3 / P1×5 / P2×6）已清账；`docs/superpowers/specs/2026-08-30-p2-closeout-design.md` 验收清单全部勾选。本迭代闭环。
```

- [x] **Step 3: ops-log 追加回写条目 + 提交 C2 + 推送**

ops-log 末尾追加（hash 待填→回填）：

```markdown
## 2026-08-30 — docs(report): P2 评估报告终版回写（§八 杠杆清单全清）

- **任务**：docs/superpowers/specs/2026-08-30-p2-closeout-design.md 验收清单末项"评估报告终版回写（杠杆清单全清）+ operations-log 留痕"：评估报告追加 §8 P2 回写表（S1-S6 commit 锚点 + 结论），宣告杠杆清单全清。
- **工具**：Edit（最小追加）。
- **操作**（文件级）：docs/knowledge/agent-decision-chain-assessment-2026-08-29.md 追加 §8；本条目追加。
- **验证**：§8 六行回写表 commit 与 ops-log/S1-S5 提交一一对应；结论行与 spec 验收口径一致。
- **Commit**：docs(report): P2 评估报告终版回写（§八 杠杆清单全清） — hash 待回填
```

Run:
```bash
git add docs/knowledge/agent-decision-chain-assessment-2026-08-29.md docs/operations-log.md
git commit -m "docs(report): P2 评估报告终版回写（§八 杠杆清单全清）"
git push internal211 codex/self-evolving-agent
```

---

### Task 4: spec 验收清单勾选 + ops hash 回填（记录维护收口）

**Files:**
- Modify: `docs/superpowers/specs/2026-08-30-p2-closeout-design.md`（验收清单勾选 + S6 验收口径同步 100k 三档）
- Modify: `docs/operations-log.md`（回填 C1/C2 与 spec 提交 5abfe4b 的 hash，记录维护）

- [x] **Step 1: 备份 + 勾选验收清单 + S6 措辞对齐 spec**

```powershell
Copy-Item docs/superpowers/specs/2026-08-30-p2-closeout-design.md .tmp\backups\docs\superpowers\specs\2026-08-30-p2-closeout-design.md -Force
```

Edit A（§S6 验收行，:34）：「脚本能跑（本地生成合成库不入库 data/ 真实库）」→「脚本能跑（本地生成合成库不入库 data/ 真实库，10k/50k/100k 三档）；报告产出；结论明确（p95 中位增益 ≥2x，W5/W8 立项排期）」——保持与最终交付一致。

Edit B（验收清单 S6 行，:43）：`- [ ] S6 基准报告落 docs/knowledge/ 且结论明确` → `- [x] S6 基准报告落 docs/knowledge/ 且结论明确`
Edit C（:39 勾选）：
```markdown
## 验收清单
- [x] S1-S6 各红→绿或产出证据；`bun run test:full` 全绿（3199→含 P2 新增）；tsc 0
- [x] S2 归档按规则 4（archive/ + ARCHIVE-LOG + git rm）——c3b2d35
- [x] S4 tool-count 189 联动（tool-count.ts/docs/architecture-integrity）——d549c64
- [x] S6 基准报告落 docs/knowledge/ 且结论明确——kal-benchmark-2026-08-30.md，W5/W8 立项排期
- [x] 评估报告终版回写（杠杆清单全清）+ operations-log 留痕——评估报告 §8
```

- [x] **Step 2: 回填 hash（bun 脚本唯一锚点，禁 sed）**

回填三点：
1. spec 提交 `docs(spec): P2 收尾迭代设计（6 切片） — hash 待回填`（ops-log:7990）→ `5abfe4b`
2. C1 `P2-S6 KAL 基准定稿 ... — hash 待回填` → C1 实际 hash
3. C2 `P2 评估报告终版回写 ... — hash 待回填` → C2 实际 hash

用 bun 单行脚本对唯一锚点做 `replace(待填, hash)`，先 `rg` 校验各占位符唯一命中再替换。

- [x] **Step 3: 提交 C3 + 推送**

```bash
git add docs/superpowers/specs/2026-08-30-p2-closeout-design.md docs/operations-log.md
git commit -m "docs(closeout): P2 spec 验收清单勾选 + ops hash 回填（记录维护）"
git push internal211 codex/self-evolving-agent
```

---

### Task 5: 终验 + 收口

- [x] **Step 1: 全量终验**

Run: `bun run test:full`
Expected: 全绿 0 fail（P2-S3 自动发现基线 3199 pass，S4/S5/T1 后数字只增不减；bench 不进 test:full 已由排除清单保证）。

Run: `bunx tsc --noEmit`
Expected: 0 错误（src/** tests/**）。

- [x] **Step 2: 残存检查**

Run: `rg "P2-S6|P2 评估报告|spec.*hash 待回填|待回填" docs/operations-log.md`
Expected: 仅回填后的真实 hash 在列，无残留占位符；`git status --short` 仅剩与本任务无关的 4 个 stat-噪音 M（.serena/*/plan-amendment/pdf-worker）与未跟踪 traces/__pycache__——不得暂存。

- [x] **Step 3: 若无修正则收口**

若 Step 1/2 全绿且无新改动，则无需新提交；已在 Task 2/3/4 按规则 5 逐提交留痕并推送。将终验结论补记到 Task 4 的 C3 条目验证段（若 C3 未推送则一起推；若已推送则终验属纯验证无需入 log，避免记录维护递归）。

---

## Self-Review（writing-plans 强制自检）

- **Spec 覆盖**：S6 补档/定稿 → T1+T2；验收清单 5 项勾选（S2/S4 已由既有提交覆盖，T4 标注；终验 → T5）→ T4；评估回写 → T3；ops 留痕 → 各任务内置；spec hash 回填 → T4。`plan-amendment` 的 S8 hash 修订（KC sha256）属改造前置，已由既有 7d1df36 系列完成，不在本计划范围。无缺漏。
- **占位符扫描**：唯一占位符为 ops-log 的 `hash 待回填`（有意为之，T4 Step 2 回填，符合 AGENTS 规则 5）；无 TBD/TODO 施工占位。
- **类型一致**：`scaleLabel` 在 T1 定义并被 tierTable/摘要/结论三处消费，签名 `(v:number)=>string` 全计划一致；SCALES 三档常量全计划唯一句法。