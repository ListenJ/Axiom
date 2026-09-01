# 打通真实数据端到端 + 跨模块已验证修复计划（2026-09-01）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 双主线并行（用户确认 2026-09-01，"两者并行推进"；并行任务用子代理完成）：

1. **主线 A（特性）**：修复 `selfInduce → promoteInductionsToSkills` 链路的**特异性缺口**——当前仅按 `support≥2 && successRate≥0.6` 归纳，通用会话词被提升为 `auto-induce-*` skill 污染技能库（34 个历史污染项已实据发现）。落地后以 curated 真实形态样本走 `.tmp` 专用路径端到端验证，并归档清理污染 skill。
2. **主线 B（跨模块已验证修复）**：两个只读验证子代理已对原始 bug 报告逐项复核**降级**——**原始 20 项报告的 CRITICAL 均未存活**（路径遍历当前线路不可达、blackboard 负 TTL 实为默认降级、breaker 半开竞争单进程不可达），确认存活 **4+1 项 router/env + 4+1 项 memory/vault** 活跃缺陷，本计划将其作为独立验证过的最小修复集实施（TDD 红→绿）。

**Spec:** 主线 A 缺陷根因来自 `axiom-memory/03-Resources/skills/` 34 个历史 `auto-induce-*` 污染 skill 审计（trigger 均为通用词：写一个/函数/步骤/json/api/node/pattern 等）；主线 B 以两个验证子代理的 CONFIRMED/PLAUSIBLE 判定为唯一来源（不采纳 DOWNGRADED 项）。

**Tech Stack:** Bun 1.3.14 / TypeScript strict / bun:test。

## Global Constraints

- 分支 `codex/self-evolving-agent`；每任务 `git add <仅本任务文件>` → commit → `git push internal211 codex/self-evolving-agent`（AGENTS 规则 3）。
- 每任务修改前备份 `.tmp/backups/<相对路径>` → 通读全文 → 最小改动 → 验证通过 → 删备份（规则 2）。
- 每提交前 `docs/operations-log.md` 追加条目，规则 5（一次一条，hash 先待填后回填，回填走 bun 脚本唯一锚点，禁止 sed）。
- `data/real-usage-traces.jsonl`（生产真实数据，**不得**写入合成数据）、`.serena/*`、`scripts/pdf-worker/*`、`docs/superpowers/plans/2026-08-28-plan-amendment-most-stable.md`、`CLAUDE.md`、`scripts/pdf-worker/__pycache__/` 与本任务无关，**不得暂存**。
- 归档目录 `archive/real-usage-test-noise/` 已存在（放 272 行历史测试噪声轨迹），本次把污染 skill 归档其中（规则 4 归档非删除）。
- 终验基线：`bun run test:full` 全绿（现 3220 pass/0 fail，本任务后只增不减）+ `bunx tsc --noEmit` 0（src/** tests/**）。

---

## 主线 A：selfInduce 特异性修复

### Task 1: 归纳特异性失败测试（红）

**Files:**
- Add: `tests/self-evolve/induce-specificity.test.ts`

- [ ] **Step 1: 写 selfInduce 特异性过滤测试（红）**

新建 `tests/self-evolve/induce-specificity.test.ts`：
- 喂入含通用词的真实形态样本（如 task 含 `写一个 json 处理函数`、`用 node 写一个 api`、`返回多少步骤` 等，success 全 true，support≥2），断言：
  - `json`、`api`、`node`、`写一`、`函数`、`步骤`、`一个`、`用` 等**通用词不在**结果中（特异性过滤生效）；
  - 有意义术语（如 `mcp`、`redis`、`限流`）**仍在**结果中（不误杀）。
- 喂入纯术语样本（如 `debug mcp timeout`×2、`tune redis cache`×2），断言 `mcp`/`redis` 仍被归纳（回归 guard）。

Run: `bun test tests/self-evolve/induce-specificity.test.ts` → 红（当前 selfInduce 无特异性过滤，通用词仍出现）。

---

### Task 2: selfInduce 特异性过滤实施（TDD 绿）

**Files:**
- Modify: `src/self-evolve/engine.ts`（新增 `INDUCE_STOPWORDS` + selfInduce 过滤逻辑）

**Interfaces:** 不改 `selfInduce` 签名（`traces?, topN?` 不变），纯内部行为收紧——对既有调用方（`evolve.ts`、`real-usage.ts`、`reflection-loop.ts`）透明。

- [ ] **Step 1: 备份并通读** `src/self-evolve/engine.ts`（备份 `.tmp/backups/`，规则 2）。
- [ ] **Step 2: 新增 `INDUCE_STOPWORDS`**：以 34 个污染 skill 的 trigger 反推的通用词集合（英文通用技术词 json/api/node/pattern/task/success/agent + 中文功能 bigram 写一/函数/步骤/一个/用/用户/返回/参数/执行/约束/重试/回滚/先读/不要/一次/多少/给出/现在/什么/一条/一句/一个 等）。
- [ ] **Step 3: selfInduce 内**，在 `if (c.support < 2) continue;` 与 `successRate` 检查之间/之后叠加：若 `pattern` 命中 `INDUCE_STOPWORDS` → `continue`（跳过，不进 result）。保留既有排序与 `topN`。
- [ ] **Step 4: 跑 Task 1 测试** → 绿；跑 `tests/self-evolve/cjk-tokenize.test.ts`、`reflection-induce.test.ts`、`skill-promotion.test.ts`、`evolve` 相关测试确认无回归。

---

### Task 3: 真实形态端到端 evolve 测试（.tmp 专用路径 + fake promotion deps）

**Files:**
- Add: `tests/agent-evals/real-usage-evolve-specificity.test.ts`

**关键注入约束**：`evolveFromRealUsage` 对 `promoteInductionsToSkills` 无 deps 注入（real-usage.ts:261 裸调用），直接调它会写真实 skill 目录——故本测试**不调** `evolveFromRealUsage`，而是组合 `selfInduce`（过滤后）+ `promoteInductionsToSkills(inductions, fakeDeps)`（镜像 skill-promotion.test.ts 的 fake deps：register/has/persist 全内存），全程不落真实磁盘。生产侧 `evolveFromRealUsage` 仍用默认 deps，特异性过滤天然生效——合法性由 Task 1-2 的引擎级测试保证。

- [ ] **Step 1: 构造 curated 真实形态 traces**（写临时文件到 `.tmp/`，**绝不写生产** `data/real-usage-traces.jsonl`）：含自然语言请求 + 有意义任务（如 `调用 mcp 超时处理`、`优化 redis 缓存命中率`）+ 混杂通用词样本。
- [ ] **Step 2: 断言端到端结果**：`engine.selfInduce(tmpTraces)` → `promoteInductionsToSkills(inductions, fakeDeps)` 返回的 `registered` 只含有意义 skill id（`auto-induce-mcp`、`auto-induce-redis` 等），**不含** `auto-induce-json`/`auto-induce-写一` 等通用词 skill。
- [ ] **Step 3: 验证 sentinel 仍生效**（`assessTraceHealth` 畸形率拒卷，既有测试覆盖）与 dedup 路径不受影响（既有 real-usage 测试绿即可，此处不重复）。

---

### Task 4: 历史污染 skill 归档（非删除，规则 4）

**Files:**
- Move: `axiom-memory/03-Resources/skills/auto-induce-*.json`（34 个中的无意义项）→ `archive/real-usage-test-noise/skills/`
- 保留有语义价值项（如 `auto-induce-mcp`、`auto-induce-redis`——若存在且 trigger 为术语）。

- [ ] **Step 1: 逐项评估 34 个 `auto-induce-*`**：trigger 为通用词（写一/函数/步骤/json/api/node/pattern/agent/task/success/用/用户/返回/参数/执行/约束/重试/回滚/先读/不要/一次/多少/给出/现在/什么/一条/一句/一个 等）→ 归档；trigger 为有语义术语 → 保留。
- [ ] **Step 2: 归档**到 `archive/real-usage-test-noise/skills/`（`git mv` 保留历史，规则 4）。
- [ ] **Step 3: 重新加载 SkillRegistry**，断言不再出现已归档 id；`bunx tsc --noEmit` 0。

---

## 主线 B：跨模块已验证修复（最小活跃集）

> 来源：两个只读验证子代理逐项复核后的 **CONFIRMED/PLAUSIBLE** 判定，逐条附 file:line。**DOWNGRADED 项一律不实施**（#3 breaker race、#5 PORT、#6 readInt 负数、#8 双烧 framing、#9 backoff、vault #5/#7/#8/#10）。

### Task 5: router/env 已验证修复（4+1 项）

**Files:**
- Modify: `src/router/model-router.ts`（#1、#2）
- Modify: `src/utils/env.ts`（#10）
- Modify: `src/utils/resilience.ts`（#7，可选加固）
- Add: `tests/router/` 对应回归测试（#1/#2）、`tests/utils/`（#10/#7）

- [ ] **Step 1（#1 HIGH）**：`chatStream` native-stream 失败路径（`model-router.ts:680-918`）——native 尝试失败时先 `routerBreaker.recordFailure(breakerKey)`，再决定是否走 buffered 回退；`fallbackBufferedStream` 成功后 update breaker 状态（报告原文：native 失败从不记入 breaker，同一 attempt 对同模型打两次，breaker 不学习 native 失败）。TDD：注入会抛错的 native stream → 断言 `recordFailure` 被调用、buffered 只回退一次。
- [ ] **Step 2（#2 MEDIUM）**：`executeWithRole` 的 `endpoint` 由 `this.assign()` 结果推导（`model-router.ts:1108-1127`）——fallback 后 `assign()` 仍返回 primary（可能是已死模型），`endpoint` 与 `out.provider` 指向不同 provider。TDD：A 死 B 活 → `out.model=B` 且 `endpoint` == B 的 baseURL。
- [ ] **Step 3（#10 LOW，一行）**：`validateEnv` 应用默认值时跳过 `config.validate()`（`env.ts:265-274`）——默认值落盘 `process.env` 前补一次 validate。TDD：非法默认值被拒绝。
- [ ] **Step 4（#7 PLAUSIBLE，可选）**：`withTimeout` abort listener 未在正常 resolve 时 detach（`resilience.ts:91-119`，`once:true` 防双发但闭包滞留到 GC/abort；17 处调用点）。加固：resolve 后 `signal.removeEventListener`。若改动面影响测试结构则以主模型判断是否纳入本次。

---

### Task 6: memory/vault 已验证修复（4+1 项）

**Files:**
- Modify: `src/memory/archiver.ts`（#4、#6、#1）
- Modify: `src/memory/vault-manager.ts`（#2）
- Modify: `src/memory/blackboard.ts`（#3+#9）
- Add: `tests/memory/` 对应回归测试

- [ ] **Step 1（#4 数据孤立，最高优先）**：`archiver.ts:222-232`——`archiveNotePath` UPDATE 抛错被 catch 后，`fs.unlinkSync(sourcePath)` 仍在 catch 之外执行（file 已删、索引行保留指残）。修复：将 index UPDATE 放入 try 块内，**索引成功后**才 unlink；或改用 rename 式移动。TDD：`archiveNotePath` 抛错 → 源文件不 unlink。
- [ ] **Step 2（#2 非原子写）**：`vault-manager.ts:340-356`——`writeFileSync` 先写文件、`upsertNote` 后写索引，upsert 抛错无回滚 → 文件在索引不在。修复：索引失败时清理已写文件（或先索引后文件 + 失败删文件），防静默文件↔索引分歧。TDD：注入 upsert 抛错 → 断言文件未残留。
- [ ] **Step 3（#6 无事务）**：`moveToArchive` 写-索引-删 无原子性（`archiver.ts:200-232`）——崩溃窗口文件重复或索引指向缺失归档。修复：rename 式移动 + 索引更新先于 unlink（与 #4 合并实现可共享路径）。TDD：与 #4 回归合一或独立断言。
- [ ] **Step 4（#1 防御缺口）**：`archiveNote` 公共 sink 无 vault 边界校验（`archiver.ts:178-186`）——补 `resolveSafePath` 风格 vault 边界检查，当前线路不可达（降级为 PLAUSIBLE），做防御式缓冲。TDD：`fileRel` 含 `..` → 拒绝，不越界写。
- [ ] **Step 5（#3+#9 缓存语义泄漏）**：`blackboard.ts:404, 518`——`expireTime===0`（永不过期）条目被 `syncToCache`/`storeEntry` 以 1h 默认 TTL 存入 cache（`cache.ts:200` 负值回退默认）。修复：`expireTime===0` 映射 `undefined`/`NO_EXPIRY_MS`，逐出行为与语义一致。TDD：never-expire 条目 1h 后仍在 cache。

---

## 终验

### Task 7: 终验 + 提交 + 推送

- [ ] **Step 1: 全量验证**：`bun run test:full` 全绿 + `bunx tsc --noEmit` 0。
- [ ] **Step 2: 提交**（仅本任务文件，规则 3）：主线 A 一项 + 主线 B 按 Task 5/6 各一项（提交粒度与 ops-log 条目一一对应，规则 5）。
- [ ] **Step 3: 推送** `internal211 codex/self-evolving-agent`（规则 3，禁 force push），回填 ops-log hash（规则 5）。
- [ ] **Step 4: 报告**用户：A 特异性修复 + 端到端验证 + 归档清理；B 各修正 file:line + 测试；推送状态。

## Self-Review（writing-plans 强制自检）

- **Spec 覆盖**：主线 A 特异性缺口（engine/skill-promotion 引用链 + 34 污项实证）→ Task 1-4；主线 B 以验证子代理 CONFIRMED/PLAUSIBLE 为唯一输入，DOWNGRADED 全部排除（Task 5 Step 4 #7 与 Task 6 Step 4 #1 标为可选/防御，主模型定夺）。
- **注入隔离红线**：A 端到端测试不调 `evolveFromRealUsage`（避免真实 skill 目录）；B 测试全部注入 fake（镜像 skill-promotion.test.ts 模式）。
- **红线保持**：`selfInduce` 签名不变；`support≥2 && successRate≥0.6` 门槛保留；queryKG 无关（本计划不触碰 W5 落地区）。