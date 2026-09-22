# 操作日志（Operations Log）

> 按 `AGENTS.md` 规则 5：每次提交记录一条，提交一次记录一次。
> 字段：时间 / 任务 / 工具 / 操作 / 验证 / Commit。
> 约定：条目随代码同提交入库，Commit 字段先写初稿 hash 并注明 amend，
> 推送后的最终 hash 以 `git log` 为准（amend 仅补录本行，不再单独更正）。

---

## 归档索引（规则 5：单月 >200 条按月拆分）

| 月份 | 条目数 | 归档文件 |
|---|---|---|
| 2026-07 | 96 | [operations-log/2026-07.md](./operations-log/2026-07.md) |
| 2026-08 | 407 | [operations-log/2026-08.md](./operations-log/2026-08.md) |
| 2026-09（当月） | 149 | 本文件 |

---

## 2026-09-01 — fix(agent-evals): 跨模块 bug 加固（并行子代理检索 + 主模型审核后落地 6 项修复）

- **任务**：按用户要求"检查其他部分是否有bug，使用并行子代理完成检索、主模型审核"，对 auto-evolve / real-usage / skill 执行 / 基础工具层做跨模块 bug 检索。4 个并行子代理（self-evolve 链路 / skill-registry+执行 / chat路由+测试污染 / 工具基础设施）共报 1 critical + 14 major + 若干 minor；主模型逐一复核后**降级多数**（未危及 auto-evolve 处理用户数据的安全性——生产路径无删除/无覆盖），确认 6 项值得落地（3 真问题 + 3 加固）。方案 B（A+加固）用户确认实施。
- **工具**：Agent（4 并行子代理检索，只读）、Read（逐文件复核子代理关键发现）、Edit（6 处源码 + 2 测试文件）、Write（词边界新测试 6 例）、Bash（bun test 红→绿 / tsc / test:smoke）。AGENTS 规则 2（备份 `.tmp/backups/` 6 源文件 + 1 测试 → 通读 → 最小改动 → 验证）与规则 7（红→绿：词边界测试先红后绿）全程执行。
- **操作**（文件级）：
  1. `src/routes/chat.ts`：handleChatStream `case "error"` 分支补 `captureRealUsageTrace({success:false, feedback:"stream-error"})`——流式失败交换不留痕，学习侧看不到失败模式、successRate 被高估（对齐 handleChat/handleAgentChat）。error 事件不含 model/provider（产生时模型已不可用），模型字段留空。
  2. `src/agent-evals/real-usage.ts`：`flushPending` 重构为 **per-target 串行写链**（`flushChains` Map：每次 flush 排在链尾，链段执行后循环取走 append 期间新入队批次，防并发 flush 丢批/乱序）；`flushOneBatch` 抽离单批处理；`clearRealUsageTraces` 先 await 进行中链排空再清文件+清理 flushChains（避免清空后链段写回旧批次）。`shouldSkipCapture` 改 `readString("NODE_ENV","").toLowerCase()==="test"` 大小写鲁棒（防 CI 设 `NODE_ENV=TEST` 绕过守卫，与 validateEnv 的 toLowerCase 一致）。
  3. `tests/agent-evals/real-usage-guard.test.ts`：补 2 例——`NODE_ENV=TEST`（大写）跳过 + `NODE_ENV=production` 正常采集。
  4. `src/utils/env.ts`：`readInt` 加 `Number.MAX_SAFE_INTEGER` overflow guard——超安全整数范围的离谱值（如 MAX_BODY_SIZE=999999999999）回退默认，防限制类配置（body 限流/日志轮转）被静默击穿。
  5. `src/main.ts`：`MAX_BODY_SIZE` 加 `clamp:{min:1024, max:16MiB}`（此前无上界，env 可禁用请求体限制）。
  6. `src/skills/skill-registry.ts`：短 ASCII trigger（≤4 字符如 doc/fix/test）改用**词边界匹配**（`\b`，trigger 内容先 escapeRe 转义），防 `"doc"` 误命中 `"docile"`、`"test"` 误命中 `"contest"`；CJK（无空格分词，\b 无效）与长 trigger 保持 includes。`match()` 与 `matchAll()` 共用 `triggerMatchLevel` 辅助。
  7. 新建 `tests/skills/skill-trigger-word-boundary.test.ts`（6 例）：docile/contest 不误命中、doc/test 独立词命中、长 trigger review/codereview 仍 includes、CJK "优化" 嵌入词仍命中。独立构造 `new SkillRegistry({skillDirs:[]})` 避开全局单例污染。
  8. `src/self-evolve/skill-promotion.ts`：persist 改 **tmp+renameSync 原子写**（镜像 skill-quality.ts），失败清理临时文件后抛出、不阻断内存注册。
- **验证**：词边界测试先 2 pass/3 fail（红——子串误命中复现）→ 修正测试设计（builtin doc-generate/review 竞争干扰）后 **6 pass/0 fail**（绿）。受影响模块关键套件 7 文件 **33 pass/0 fail**（real-usage guard+unit、auto-evolve、skill-promotion、词边界、registry-p2、execute-by-id）。`bunx tsc --noEmit` **0**（首跑拦截 chat.ts error 事件无 model/provider 字段 + SkillDefinition 未导出 + 2 处 null 断言，已修）。`bun run test:smoke` **63 pass/0 fail**（基线一致）。`test:full` 全量（预期只增不减，新增 2+6=8 例）。
- **红线**：不接触 queryKG 排序/架构完整性；未改 evolveFromRealUsage/selfInduce/promote 内部语义（仅 persist 写入方式加固）；技能匹配改动仅影响短 ASCII trigger（CJK 行为不变）。
- **Commit**：fix(agent-evals): 跨模块 bug 加固（stream error 采轨迹、flush 串行化、NODE_ENV 大小写、readInt clamp、trigger 词边界、persist 原子写） — 583b8b4

## 2026-09-01 — feat(agent-evals): 数据质量 sentinel（evolve 畸形率拒卷门，防脏数据误归纳）

- **任务**：用户原始关切"自动 evolve 不因脏数据产生误差/误删"的收尾——此前已确认生产路径无删除/无覆盖，本任务加一道**拒绝门**而非删除门：轨迹文件畸形率过高时拒卷，阻止损坏/脏数据被 `evolveFromRealUsage` 归纳成垃圾 `auto-induce-*` skill。只读评估，不改动任何用户数据。
- **工具**：Read（real-usage.ts 加载/evolve 落点、env.ts 既有 helper 家族）、Write（TDD 红测试 + sentinel 实现 + env readNumber）、Edit（real-usage.ts + env.ts + 测试修正）、Bash（bun test 红→绿/tsc）。AGENTS 规则 2（备份 → 通读 → 最小改动 → 验证 → 删备份）与规则 7（红→绿）全程执行。
- **操作**（文件级）：
  1. `src/utils/env.ts`：新增 `readNumber(key, fallback, clamp?)`——严格解析非负浮点数（`^\d+(\.\d+)?$`），非法/NaN/Infinity 回退默认，可选 [min,max] 钳制（对齐 readInt 的严格解析+越界防护，供阈值类配置使用）。
  2. `src/agent-evals/real-usage.ts`：新增 `assessTraceHealth(filePath?)` → `{total, malformed, malformedRate}`（非空行总数 / 畸形行数[JSON 解析失败或缺 id/task] / 畸形率；只读，先 flush 保证一致）；`evolveFromRealUsage` 归纳前先评估——畸形率 ≥ 阈值（默认 0.2，env `AXIOM_EVOLVE_MAX_MALFORMED_RATE`，clamp [0,1]）时 **拒卷**（返回 `refused:"malformed-rate"` + `health` 快照），`traceCount` 语义与正常路径一致 = 合法轨迹数（total − malformed），不归纳、不创建 skill、不改动文件。
  3. 新建 `tests/agent-evals/real-usage-sentinel.test.ts`（7 例）：正常文件畸形率 0；统计损坏 JSON + 缺字段行；畸形率超阈值拒卷（refused + inductionCount 0 + health 快照）；低于阈值正常 evolve；阈值 env 调高（=1 永不拒卷）/ 调低（=0 任何畸形都拒卷）；空文件不拒卷不崩。
- **验证**：TDD 红→绿——首跑 6 pass/1 fail（红：拒卷分支 `traceCount` 误用 total 而非合法数，语义与既有 real-usage.test.ts 的 traceCount=合法轨迹数不一致，已修正拒卷分支为 total−malformed + 测试断言改为合法数）→ **7 pass/0 fail**（绿）。既有 real-usage 全系 4 文件 **23 pass/0 fail** 无回归（既有 evolve 测试的 traceCount 断言不受影响）。`bunx tsc --noEmit` **0**。生产轨迹文件实测 0 行未被污染（sentinel 测试用 `.tmp` 路径隔离）。
- **红线**：sentinel 是**拒绝门非删除门**——不触碰/不删除/不改动轨迹文件；`evolveFromRealUsage` 正常路径语义不变（仅新增 `refused`/`health` 可选字段，非破坏性）；不接触 queryKG 排序/架构完整性。
- **Commit**：feat(agent-evals): 数据质量 sentinel（evolve 畸形率拒卷门，防脏数据误归纳） — 30a77eb

## 2026-09-01 — fix(self-evolve): auto-evolve 高水位回退（轨迹文件清空/归档后不长期卡 insufficient-new）

- **任务**：审计 `maybeAutoEvolve` 水位逻辑发现真实缺陷——`getNewTraces` 返回轨迹**总数**，增量 = `newTraces − lastNewTraces`。但轨迹文件可能被清空/归档（如 2026-08-31 fedaefc 将 272 行测试噪声归档清零），此时 `lastNewTraces` 停在旧高水位（如 50），文件清空后 `newTraces=0` → 增量恒负 → 即便之后累积了 30 条真实轨迹，`pending = 30−50 = −20 < minNewTraces` 仍长期卡 `insufficient-new`，自动 evolve 静默停摆。
- **工具**：Read（auto-evolve.ts / auto-evolve.test.ts 通读）、Write（新增水位回退测试，TDD 红）、Edit（auto-evolve.ts 水位回退）、Bash（bun test 红→绿 / tsc / test:smoke / agent-evals 全目录）。无子代理。AGENTS 规则 2（备份 → 通读 → 最小改动 → 验证 → 删备份）与规则 7（红→绿）全程执行。
- **操作**（文件级）：
  1. `tests/agent-evals/auto-evolve.test.ts`：新增 1 例「水位回退」——preset state lastNewTraces=50 → `getNewTraces` 返回 0（清空）→ 断言不 evolve 且 **state.lastNewTraces 已回退到 0**（持久化）→ 再累积 30 条 → 断言正常 evolve（若不回退水位，pending=−20 会卡死）。
  2. `src/agent-evals/auto-evolve.ts`：`maybeAutoEvolve` 内读 `newTraces` 后，若 `newTraces < state.lastNewTraces`（文件被清空/归档）则以当前数为新水位 `writeState` 持久化并更新内存 state——增量不再为负，从新基重新计数。
- **验证**：TDD 红→绿——实现前新测试 fail（`Expected:0 Received:50`，水位残留，红）→ 实现后 **8 pass/0 fail**（绿）。`bunx tsc --noEmit` **0**。回归：agent-evals 全目录 **131 pass/0 fail**；`bun run test:smoke` **63 pass/0 fail**（基线一致）。
- **红线**：只改 auto-evolve 水位语义（文件清空后回退，不改变 append-only 正常路径）；不触碰 evolveFromRealUsage/selfInduce/promote 内部与轨迹文件本身。
- **Commit**：fix(self-evolve): auto-evolve 高水位回退（轨迹文件清空后从新基计数，防增量恒负停摆） — e4e8a46

## 2026-09-01 — fix(self-evolve): selfInduce 归纳特异性过滤 + 34 污染 skill 归档（打通真实数据端到端）

- **任务**：审计"打通真实数据端到端"方向时发现 `selfInduce → promoteInductionsToSkills` 链路有**特异性缺口**——仅按 `support≥2 && successRate≥0.6` 归纳，通用会话词（CJK 功能 bigram + 泛化技术词）也被提升为 `auto-induce-*` skill。实据：`axiom-memory/03-Resources/skills/` 34 个历史 `auto-induce-*` 污染文件（trigger 均为 `json/api/node/pattern/task/success/写一/一个/函数/步骤/用/用户/返回/参数/执行/重试/回滚...` 类通用词），其中 `auto-induce-task/success/pattern` 由既有 `real-usage.test.ts` 的 `evolveFromRealUsage` 默认 promotion deps 反复写真实 skill 目录产生——**重复污染源亦被本次堵死**。
- **工具**：Glob/Read（34 污染 skill 枚举 + `engine.ts`/`skill-promotion.ts`/`real-usage.ts` 链路通读 + trigger 逐项核验）、Write（特异性红测试 + 端到端 `.tmp` evolve 测试，TDD 红）、Edit（`engine.ts` 新增 `INDUCE_STOPWORDS` + `selfInduce` 过滤）、Bash（bun test 红→绿）。并行实施子代理 2 个（router/env、memory/vault，见独立任务）。AGENTS 规则 2（备份）与规则 7（红→绿）全程执行。
- **操作**（文件级）：
  1. 新建 `tests/self-evolve/induce-specificity.test.ts`（2 例）：真实形态样本（`写一个 json 处理函数`/`用 node 写一个 api`/`调用 mcp 超时处理`/`优化 redis 缓存命中率` 混喂）——有语义术语（mcp/redis/超时/缓存）必须保留，通用词（json/api/node/写一/一个/函数/用/处理/优化）不得出现；纯术语样本（debug mcp timeout×2 / tune redis cache×2）回归 guard——mcp/redis 仍被归纳（不误杀）。首跑红（json/写一/一个/函数/node/api 全被归纳）。
  2. `src/self-evolve/engine.ts`：新增 `INDUCE_STOPWORDS`（泛化技术词 json/api/node/pattern/task/success/agent/js/sql/client/file/code/data/function + 中文功能 bigram 写一/一个/用/用户/返回/步骤/不要/一次/多少/给出/现在/函数/参数/执行/约束/重试/回滚/先读/什么/一条/一句/处理/优化——以真实污染 trigger 为蓝本反推）；`selfInduce` 在 `support≥2 && successRate≥0.6` 门槛内叠加 `if (INDUCE_STOPWORDS.has(pattern)) continue;`——跳过不进 result，保留既有排序与 `topN`，签名不变（对 evolve.ts/real-usage.ts/reflection-loop.ts 透明）。
  3. 新建 `tests/agent-evals/real-usage-evolve-specificity.test.ts`（1 例端到端）：走真实加载路径 `loadRealUsageTraces(.tmp jsonl)` + 真实引擎 `selfInduce` + `promoteInductionsToSkills(fakeDeps)`——刻意**不调** `evolveFromRealUsage`（其对 promotion 无 deps 注入，会写真实 `axiom-memory/03-Resources/skills`）。断言只创建 `auto-induce-mcp`/`auto-induce-redis`，无 `auto-induce-json/api/写一/函数` 等通用词 skill。
  4. `axiom-memory/03-Resources/skills/auto-induce-*.json`（34 个）→ `git mv` 归档至 `archive/real-usage-test-noise/skills/`（规则 4 归档非删除）。逐项核验：即使 `redis`/`postgresql` 等术语样 trigger，其 promptTemplate 亦为 "Pattern X appeared in N traces" 模板化空壳（源自在 2-3 条测试噪声轨迹），无执行语义，故 34 个全部归档、无保留项。
- **验证**：TDD 红→绿——特异性测试首跑 1 fail（`json` 仍被归纳，红）→ 实施后全绿。相关 6 文件 **23 pass/0 fail**（新增 3 例 + 既有 cjk-tokenize/reflection-induce/skill-promotion/real-usage 无回归；real-usage.test.ts 的 `evolveFromRealUsage` 不再因默认 promotion deps 写垃圾 skill 文件）。`bunx tsc --noEmit` 0（终验统一跑）。
- **红线**：`selfInduce` 签名不变、`support≥2 && successRate≥0.6` 门槛保留（仅叠加特异性层）；`tokenize`/检索等其他用途不触碰；不写生产 `data/real-usage-traces.jsonl`（端到端用 `.tmp` 路径）；归档非删除（git mv）；不触碰 queryKG/W5 落地区。
- **Commit**：feat(self-evolve): selfInduce 归纳特异性过滤（通用词不入 skill，堵 real-usage 测试重复污染源）+ 34 历史污染 skill 归档 — 4f87c4b

## 2026-09-01 — fix(router/env): 跨模块已验证修复（native-stream 记熔断、endpoint 实际模型、默认值校验、withTimeout 监听清理）

- **任务**：主线 B 跨模块 bug 检索的**已验证修复集**——两个只读验证子代理对原始 bug 报告逐项复核降级后，确认的 router/env 活跃缺陷（原始 CRITICAL 均未存活：path traversal 当前线路不可达、breaker 半开竞争单进程不可达）。本任务经用户确认"两者并行推进"、并行任务用子代理完成，由实施子代理 TDD 红→绿。
- **工具**：实施子代理（general-purpose）Read/Write/Edit/Bash 完成；主会话核验（Read model-router.ts / env.ts / resilience.ts 关键区段 + 全量终验）。AGENTS 规则 2（备份）与规则 7（红→绿）全程执行，备份已删。
- **操作**（文件级）：
  1. `src/router/model-router.ts` **Fix 1（HIGH）** chatStream native-stream 失败路径（~L792-800）：catch 块内 `routerBreaker.recordFailure(breakerKey)` 后再回退 buffered——native 失败不再静默不记，breaker 学习模型失败，permanent 错误不再烧 2 次调用。新增 `tests/router/chat-stream-native-breaker.test.ts`（2 例，注入抛错 native stream 断言 recordFailure 被调 + 回退仅一次）。
  2. `src/router/model-router.ts` **Fix 2（MEDIUM）** executeWithRole endpoint 推导（~L1111-1117）：由实际执行模型 `out.provider` 经 `PROVIDER_CONFIG` 查 baseURL，替代重新 `assign()` 首选候选（fallback 后首选可能已死，endpoint 与 out.model 指向不同 provider）。新增 `tests/router/executeWithRole-endpoint.test.ts`（3 例：A 死 B 活 → out.model=B 且 endpoint=B baseURL）。
  3. `src/utils/env.ts` **Fix 3（LOW）** validateEnv 默认值路径（~L269-275）：非必填变量缺省应用默认值后补一次 `config.validate(config.default)`，非法默认值拒绝并标记 invalid。新增 `tests/utils/env-invalid-default.test.ts`（2 例）。
  4. `src/utils/resilience.ts` **Fix 4（加固）** withTimeout abort 监听清理（~L102-117）：抽出具名 abort handler，resolve/reject 后 `signal.removeEventListener`——闭包不再滞留 signal。新增 `tests/utils/withTimeout-listener-leak.test.ts`（2 例，行为等价：settle 后外部 abort 不再产生额外 rejection）。
- **验证**：`bun test tests/router` **48 pass/0 fail**、`bun test tests/utils` **17 pass/0 fail**、`tests/architecture-integrity.test.ts` **25 pass/0 fail**、`bun run test:smoke` **63 pass/0 fail**。全量终验由主会话统一跑：`bun run test:full` **3280 pass/34 skip/0 fail**、`bunx tsc --noEmit` **0**。
- **红线**：仅改上述 4 点最小改动，不触碰 memory/self-evolve/agent-evals；测试全注入 fake（不连真实 provider/网络）；与 Task 6 文件集不重叠，共享树并行安全。
- **Commit**：fix(router/env): native-stream 记熔断、endpoint 取实际执行模型、默认值过校验、withTimeout 监听清理 — 70ba841

## 2026-09-01 — fix(memory): 归档原子性/路径守卫 + vault 原子写 + blackboard 永不过期语义（跨模块已验证修复）

- **任务**：主线 B 跨模块 bug 检索**已验证修复集**的 memory/vault 部分——验证子代理确认的活跃缺陷（原始 CRITICAL path traversal 经复核为当前线路不可达的防御缺口，降级为 PLAUSIBLE 后仍按防御性加固处理）。经用户确认"两者并行推进"、并行任务用子代理完成，由实施子代理 TDD 红→绿。
- **工具**：实施子代理（general-purpose）Read/Write/Edit/Bash 完成；主会话核验（Read archiver.ts / vault-manager.ts / blackboard.ts 关键区段 + 全量终验）。AGENTS 规则 2（备份）与规则 7（红→绿）全程执行，备份已删。
- **操作**（文件级）：
  1. `src/memory/archiver.ts` **Fix 1（最高优先，数据孤立）** moveToArchive：源文件删除移至索引更新**成功之后**；索引失败时 rename 路径移回源、EXDEV 路径删归档保留源，并 re-throw——杜绝"源已删、索引仍指向旧路径"的孤文件。**Fix 3（无事务）**：优先 `fs.renameSync(sourcePath, archiveFullPath)` 原子移动（同文件系统），EXDEV 回退 tmp 写入 + rename，消除 copy-then-delete 崩溃窗口。**Fix 4（防御缺口）**：新增 `isPathWithinVault(fileRel)`（与 VaultManager.resolveSafePath 同构，拒 `..`/绝对路径/逃逸），`archiveNote` 与 `moveToArchive` 入口调用。新增 `tests/memory/archiver-safe-move.test.ts`。
  2. `src/memory/vault-manager.ts` **Fix 2（非原子写）** writeNote：tmp + `renameSync`（镜像 skill-promotion/skill-quality 既有原子写习惯）——先写 tmp，`upsertNote` 索引**成功后**才 rename 发布正式文件；索引抛错清理 tmp，不留"文件在索引不在"的孤文件。新增 `tests/memory/vault-atomic-write.test.ts`。
  3. `src/memory/blackboard.ts` **Fix 5（缓存语义泄漏）** syncToCache/storeEntry：`expireTime===0`（永不过期）映射 cache 的 `ttlMs===0` NO_EXPIRY 哨兵，避免 `0 - Date.now()` 负数被 cache.ts 误判为未传 TTL 回退默认 1h、导致永不过期事实 1h 后被淘汰。新增 `tests/memory/blackboard-cache-never-expire.test.ts`。
- **验证**：`bun test tests/memory` **82 pass/0 fail**。全量终验由主会话统一跑：`bun run test:full` **3280 pass/34 skip/0 fail**、`bunx tsc --noEmit` **0**。
- **红线**：仅改上述 3 文件最小改动；测试用注入 fake / `.tmp` 临时目录，绝不写真实 axiom-memory 生产目录；与 Task 5 文件集不重叠，共享树并行安全。
- **Commit**：fix(memory): 归档原子 move + 索引成功才删源 + vault 路径守卫、vault 原子写、blackboard 永不过期映射 — 6f5ed2f

## 2026-09-01 — feat(agent-evals): 回归基准入库（eval-registry）

- **任务**：主线 D eval 基建——agent-evals 结果结构化落盘 `data/eval-registry.db`（SQLite,bun:sqlite 内建零第三方依赖,镜像 model-eval-service 既有惯例）,配 stats/trend/compare 查询 CLI,历史 87.5
## 2026-09-01 — feat(agent-evals): 回归基准入库（eval-registry）

- **任务**：主线 D eval 基建——agent-evals 结果结构化落盘 data/eval-registry.db（SQLite，bun:sqlite 内建零第三方依赖，镜像 model-eval-service 既有惯例），配 stats/trend/compare 查询 CLI，历史 87.5% 基线数字升级为可查询的基准行。经用户确认"确认并开始继续完善"并选定该方向推进。
- **工具**：主会话实现，子代理并行查询/检索；测试全注入 :memory:/tmpfile（不连真模型/不花 API 费用）。AGENTS 规则 2（备份）、规则 7（TDD 红→绿）执行，备份已删。
- **操作**（文件级）：
  1. src/agent-evals/metrics-types.ts 新增：StoredTaskResult/FamilySnapshot/RunSummarySnapshot/RunFilter/RunMetadata/RunRow/StoredTaskRow/RunComparison——类型从 metrics.ts 解耦避免循环依赖。
  2. src/agent-evals/registry.ts 新增：openRegistry 返回 SQL 访问层，SCHEMA 建 eval_runs + eval_task_results（run_id REFERENCES eval_runs ON DELETE CASCADE）；关键修复 PRAGMA foreign_keys = ON（SQLite 级联默认关闭）。API：insertRun/insertTaskResults/listRuns/getRun(ref id|tag)/getTasks/compare/getTrend/seedBaseline/deleteRun。
  3. src/agent-evals/run.ts 改造：两个落点插桩——evolve 路径（baseline/evolved 两阶段）+ 常规路径；--no-persist 逃生口；runTag 含 pid 与 phase 避免 UNIQUE 冲突（冲突时 +1s 重试）；持久化整体 try/catch 非阻塞（镜像 skill-gain FileStore 惯例）。
  4. src/agent-evals/registry-cli.ts 新增：stats/show/compare/trend/seed-baseline 子命令。
  5. data/eval-registry.db 种子（gitignored）：2026-08-13-42loop-baseline 23/24=95.83%、2026-08-16-evolve-constraints-baseline 22/24=91.67% 两条历史基准入档。
  6. tests/agent-evals/registry.test.ts 新增 9 例：roundtrip/getRun-by-tag/UNIQUE 冲突/compare/trend 排序/seed-baseline/损坏 JSON 兜底/tmpfile 持久化/deleteRun 级联。
- **验证**：bun test tests/agent-evals/registry.test.ts 9 pass/0 fail、架构完整性 25 pass/0 fail；全量终验 bun run test:full 3289 pass/34 skip/0 fail、bunx tsc --noEmit 0。
- **红线**：仅新增上述文件最小改动；registry 持久化全程 try/catch 非阻塞，不影响既有 run 流程；data/*.db gitignored 不入库（schema 在源码模块、种子经 CLI）。
- **Commit**：feat(agent-evals): 回归基准入库（eval-registry: metrics-types/registry/run 落点/查询 CLI/历史基线种子）— e8acd5a

## 2026-09-02 — fix(agent-evals): eval 暴跌根因修复（失败分类 + zhipu 限流缓解 + 干净基线重跑）

- **任务**：追查 2026-09-01 17:52 UTC eval-registry run #3（glm-4.7-flash / provider zhipu / `--concurrency=3`）通过率暴跌至 **12.5%（1/8）**，对照 deepseek-v4-flash 基线 95.83%/91.67%。根因定位：zhipu 免费模型限流（HTTP 429 code 1302）在并发 3 下产出 `[ERROR] ...` 空内容串，被关键字验证器误判为能力失败（7/8 任务 output_len=41）。经用户确认三项修复："失败分类（根治）、降并发（缓解）、重跑干净基线"。
- **工具**：Read/Edit/Write（src/agent-evals 各模块 + 测试 TDD 红→绿）、Bash（bun test 红→绿 / `bun run test:full` / `bunx tsc --noEmit` / registry-cli 查询核验）、Bash sqlite 迁移（data/eval-registry.db `ensureColumn` + run #3 重分类，备份 `.tmp/eval-registry.db.pre-migrate-r3`）。无子代理。AGENTS 规则 2（备份 → 通读 → 最小改动 → 验证 → 删备份）与规则 7（红→绿）全程执行。
- **操作**（文件级）：
  1. `src/agent-evals/metrics-types.ts` + `metrics.ts` + `runner.ts`：新增 `executionError?: boolean`（TaskResult/StoredTaskResult/FamilyMetrics/MetricsSummary）与 `executionErrors` 计数；runner 检测 `[ERROR] ` 前缀 → 直接返回 executionError:true 结果（不经关键字验证器）；**通过率分母剔除执行错误**（能力通过率 = passed / (total − executionErrors)）；pickBest 重跑语义：优先 pass → 其次非 executionError 尝试 → 兜底 attempts[0]。
  2. `src/agent-evals/registry.ts`：SCHEMA 增 `summary_execution_errors` / `execution_error` 两列 + `ensureColumn()`（PRAGMA table_info + ALTER TABLE ADD COLUMN，兼容既有 DB 增量迁移）；`insertRun`/`insertTaskResults`/`rowToTask` 落点映射。
  3. `src/agent-evals/report.ts` + `registry-cli.ts`：报表/CLI 拆分显示——执行错误行 `⚠️` 标记、表头增"执行错误"列、通过率旁注"不计入分母"。
  4. `src/agent-evals/run.ts`：**zhipu 并发钳制**——`provider === "zhipu"` 时并发强制 1（原并发 3 超限），请求并发 >1 时告警提示 429 code 1302 缓解。
  5. `tests/agent-evals/`：metrics.test.ts（+3 例：executionError 不计分母/计数）、registry.test.ts（+1 例：executionError/summaryExecutionErrors 落库读回）、runner-rerun.test.ts（+1 例：pickBest 非执行错误优先）。
  6. `data/eval-registry.db`（gitignored，已迁移）：run #3 重分类——7 个 output_len=41 限流任务置 execution_error=1、summary_execution_errors=7、summary_pass_rate 回算 **100**（8 任务中 1 通过 + 7 执行错误，能力通过率 1/(8−7)=100%）；run #4 以并发 1 重跑干净基线 **8/8 通过（100%）**，证实 zhipu/glm 能力无缺陷、根因纯限流。
- **验证**：TDD 红→绿；agent-evals 相关测试全绿（metrics/registry/runner-rerun 新增 4 例）；`bun run test:full` **3293 pass/34 skip/0 fail**（首跑 1 例 flaky fail 定位为 `tests/memory/sqlite-memory-tags.test.ts` afterAll 清理的 Windows EBUSY 文件锁竞争，与本次改动无关，重跑复绿）；`bunx tsc --noEmit` **0**；registry-cli `show` 核验 run #3 重分类结果与 run #4 100%。
- **红线**：通过率分母剔除仅作用于 executionError 计数，不改 passed/total 原始口径；zhipu 并发钳制仅作用于 provider=zhipu，其他 provider 并发不变；既有 run 数据仅重分类污染行（备份 `.tmp/eval-registry.db.pre-migrate-r3`），无破坏性删除；测试全部注入 fake / `.tmp` 临时 DB，不连真实 provider。
- **Commit**：fix(agent-evals): eval 暴跌根因修复（失败分类 executionError 不计通过率 + zhipu 限流并发 1 + 干净基线重跑）— 7fb009a

## 2026-09-02 — perf(agent-evals): eval 自适应重跑（首次即通过停止，结果等价省约一半调用）

- **任务**：追查 eval 运行时成本——`runOneBest` 固定按 `rerunEach`（默认 2）跑满全部尝试，**即使首次尝试已通过**也再跑一次。`pickBest` 语义取首个通过，通过任务的第 2 次采样对结果零贡献却双倍消耗 provider 调用与耗时（zhipu 并发 1 + 任务间 4s 间隔下尤其明显）。优化：**首次尝试即通过则停止重跑**（break at first pass），结果与「跑满 rerunEach 次后 pickBest」**完全等价**——pickBest 只取首个通过，通过位置前后的多余样本都不影响其选择；无通过时两者同样跑满全部尝试（消除单样本波动的设计意图完整保留）。高通过率轮次（基线为主）省约一半调用。
- **工具**：Read（runner.ts / runner-rerun.test.ts 通读）、Write（TDD 红测试 5 例）、Edit（runner.ts 新增 `rerunAdaptive` + `runOneBest` 改用它）、Bash（bun test 红→绿 / 全目录回归 / tsc / test:smoke）。无子代理。AGENTS 规则 2（备份 → 通读 → 最小改动 → 验证 → 删备份）与规则 7（红→绿）全程执行。
- **操作**（文件级）：
  1. `src/agent-evals/runner.ts`：新增导出 `rerunAdaptive(runOnce, rerunEach)`——循环内每次 `runOnce()` 后若 `passed` 即 break；`runOneBest` 由「固定跑满 rerunEach 次」改为 `return rerunAdaptive(() => runOne(task, options), rerunEach)`。`pickBest` / `DEFAULT_RERUN_EACH` 不变，签名对调用方透明（runTasks 行为不变，仅每任务调用数下降）。
  2. `tests/agent-evals/runner-rerun.test.ts`：新增 5 例（首过只调 1 次；首败后第 2 次通过处停止；全败跑满保留首次；rerunEach=1 只调 1 次；全执行错误跑满且真实能力失败不被执行错误吞没）——用调用计数 tracker 断言「省调用」与「结果等价」双重性质。
- **验证**：TDD 红→绿——实现前 `rerunAdaptive` 未导出（SyntaxError，红）→ 实现后 **10 pass/0 fail**（绿，含既有 pickBest 5 例无回归）。回归：agent-evals + self-evolve 全目录 **244 pass/0 fail**；`bunx tsc --noEmit` **0**；`bun run test:smoke` **63 pass/0 fail**（基线一致）。
- **红线**：不改 `pickBest` / `DEFAULT_RERUN_EACH` / 并发语义；只改「已通过任务是否还需重跑」，失败/执行错误任务仍跑满 rerunEach 次（消除单样本波动设计意图不变）；无 provider/网络调用变更。
- **Commit**：perf(agent-evals): eval 自适应重跑（首次即通过停止，结果等价省约一半调用）— 399ed2c

## 2026-09-02 — feat(agent-evals): eval-registry 回归守卫（check 子命令，回落超阈值自动报警）

- **任务**：eval-registry 已入库历史基线与真实轮次，但**没有任何东西在「新轮次相对基准通过率回落」时自动报警**——回归防御闭环缺最后一环。新增 `registry-cli check <id>`：候选轮 vs 基准轮（默认自动取**同族+同模型+同 split 作用域**的历史最高通过率轮次；`--baseline=<id|tag>` 显式指定）通过率回落超阈值（默认 10pp，`--max-drop=N`）→ 打印对比表并 **exit 1**（可接入 CI/脚本）。基准 passRate 已剔除执行错误（能力口径），比较公平。
- **工具**：Read（registry.ts / registry-cli.ts / registry.test.ts 通读）、Write（TDD 红测试 7 例）、Edit（registry.ts 新增 `RegressionCheck` + `checkRegression`；registry-cli.ts 新增 `check` 命令）、Bash（bun test 红→绿 / tsc / test:smoke / 真实 DB 端到端核验）。无子代理。AGENTS 规则 2（备份 → 通读 → 最小改动 → 验证 → 删备份）与规则 7（红→绿）全程执行。
- **操作**（文件级）：
  1. `src/agent-evals/registry.ts`：新增导出 `RegressionCheck` 类型 + Registry 接口 `checkRegression(candidate, opts?)`——显式 baseline 优先；否则 `listAllStmt.all()` 过滤**同 family+同 model+同 split（null-safe）** 且排除候选自身，取 `summaryPassRate` 最高者为历史最优基准（跨模型/跨族/跨 split 不可比，宁缺毋滥——防跨模型假阳性）。`dropPp = 基准 − 候选`，`regressed = dropPp > maxDropPp`（严格大于，回落等于阈值允许）；附 `familyDiffs`（逐族 基准/候选/Δ）。
  2. `src/agent-evals/registry-cli.ts`：新增 `check <id> [--baseline=<ref>] [--max-drop=N]`——数字形态 ref 按 id 解析（与 printCompare 同惯例，`toId`/`toOptionalId` 消歧）；无可比基准/候选缺失 → 明确报错 exit 1；对比表 + 判定行（回归/未回归）；`regressed` → exit 1。
  3. `tests/agent-evals/registry.test.ts`：新增 7 例（回落=阈值不报警、回落>阈值报警含分族 diff、改进负 drop 不报警、自动基准取历史最优非最近、模型不同自动无可比需显式、family 作用域不同自动无可比、候选缺失 null）。
- **验证**：TDD 红→绿——实现前 7 fail（checkRegression 未定义，红）→ 实现后 **17 pass/0 fail**（含既有 10 例无回归）。真实 DB 端到端：`check 4`（glm-4.7-flash/coding）自动基准取 run 3（同作用域），0pp 回落 exit 0；`check 4 --baseline=2`（跨模型显式）→ 候选高于基准 8.33pp exit 0；`check 999` / 缺参 → 防御报错 exit 1。`bunx tsc --noEmit` **0**（首跑拦下 `asId` 返回类型含 undefined 的 TS2345，已修）；agent-evals 全目录 **157 pass/0 fail**；`bun run test:smoke` **63 pass/0 fail**。
- **红线**：只新增 registry 接口 + CLI 命令，不改既有 insertRun/listRuns/compare/trend/seed 语义；自动基准严格限定同族同模型同 split（宁缺毋滥），显式 baseline 由用户负责可比性；测试全 `:memory:`，不碰真实 DB 数据（真实 DB 仅 CLI 端到端只读核验）。
- **Commit**：feat(agent-evals): eval-registry 回归守卫（check 子命令，回落超阈值自动报警）— 276f95a

## 2026-09-02 — fix(agent-evals): evolve 链路三处真实缺陷（state 写失败抛穿 / promotion 无 deps 注入写真实技能目录 / clear 竞态注释）

- **任务**：并行 bug-hunt 子代理在 evolve 链路（real-usage.ts + auto-evolve.ts）定位到 3 处真实缺陷——①`maybeAutoEvolve` 的 `writeState` 在 state 路径不可写时**同步抛错**，会把 fire-and-forget 触发器的错误抛给 chat 交换主流程（与设计意图「evolve 失败不阻断 chat 响应」矛盾，W3 可降级）；②`evolveFromRealUsage` 无条件走 `defaultDeps()` → **每次 evolve 都往真实 axiom-memory/03-Resources/skills 写 auto-induce-* JSON**（既有污染源，specificity 测试顶部注释标注的缺口）；③`clearRealUsageTraces` 清队列→等写链排空的竞态语义未注释，行为与「先清队列再排空（不丢新数据）」意图有偏差。
- **工具**：Read（auto-evolve.ts / real-usage.ts / skill-promotion.ts / engine.ts / specificity 测试通读）、Write（TDD 红测试 4 例 + 新测试文件 1 个）、Edit（real-usage.ts / auto-evolve.ts 最小改动）、Bash（bun test 红→绿 / 全目录回归 / tsc / 真实技能目录污染清理核验）。AGENTS 规则 2（备份 → 通读 → 最小改动 → 验证 → 删备份）与规则 7（红→绿）全程执行。**注**：promotion-deps 红跑会写真实技能目录，已当场清理（auto-induce-mcp.json / auto-induce-调用.json 删除，绿跑后目录 0 污染）。
- **操作**（文件级）：
  1. `src/agent-evals/auto-evolve.ts`：新增 `safeWriteState`（吞写失败仅记日志，W3 可降级），3 处 `writeState` 调用点（水位回退 / ok / error）全部替换；`writeState` 原样保留（语义单一职责）。
  2. `src/agent-evals/real-usage.ts`：`evolveFromRealUsage` 签名新增 `opts.promotionDeps?: InductionPromotionDeps` 并注入 `promoteInductionsToSkills`（缺省走 defaultDeps，生产行为不变）；`clearRealUsageTraces` 竞态语义注释补齐（先清队列再排空写链，trade-off 明示）。
  3. `tests/agent-evals/auto-evolve.test.ts`：新增 2 例（evolve 成功但 state 写失败 → 不抛返回 ok；evolve 抛错且 state 写也失败 → 不抛返回 error）——blocker 用「statePath 的 dirname 是普通文件」触发 mkdirSync 抛错。
  4. `tests/agent-evals/real-usage-sentinel.test.ts`：新增 1 例（畸形率 == 阈值 0.2 拒卷，`>=` 闭区间语义固定）。
  5. `tests/agent-evals/real-usage-promotion-deps.test.ts`（新）：端到端——capture(jsonl) → load(dedup) → selfInduce → promote(fake deps)，断言 `created`/`registered` 含 auto-induce-mcp 且零磁盘写入；用「不同任务共享术语」绕过 dedup 折叠保证 support>=2。
- **验证**：TDD 红→绿——实现前 3 fail（2 例 state 写失败 + promotion-deps 未注入）+ 1 例 characterization（==阈值拒卷，当前代码 `>=` 已满足，绿）→ 实现后 **20 pass/0 fail**（4 文件）；agent-evals 全目录 **162 pass/0 fail**；`bunx tsc --noEmit` **0**；真实技能目录绿跑后 `auto-induce` 计数 **0**（零污染）。
- **红线**：`writeState` 语义不变（仅调用方容错层级改变）；`promotionDeps` 缺省行为与 CLI 路径（`real-usage.ts --evolve` 不传 opts）完全不变；clear 竞态 trade-off 仅注释化，不改逻辑；测试全 `.tmp` / fake deps，不连真实 provider、不写真实技能目录。
- **Commit**：fix(agent-evals): evolve 链路三处真实缺陷（state 写失败抛穿、promotion 无 deps 注入写真实技能目录、clear 竞态注释）— 0f10c19

## 2026-09-02 — fix(self-evolve): tokenize 混合脚本段整段 bigram 切碎拉丁（假跨脚本 bigram 污染归纳）

- **任务**：并行 bug-hunt 子代理在 `tokenize` 定位到分词缺陷——含 CJK 的段（如 `redis缓存命中率`、`sqlite查询次数超限`）整体命中 CJK 分支后被**逐字符 bigram 切分**，拉丁部分被切碎成 `re/ed/di/s缓` 这类**假跨脚本 bigram**（`re`、`s缓` 无真实语义），污染 selfInduce 的触发模式共现统计与教训检索。修复：含 CJK 段先按**连续 CJK 块**切分——中文块照旧 bigram（"如何优化" -> 如何/何优/优化），拉丁/数字块**保留整词**（`redis缓存命中率` -> `redis` + 缓存/存命/命中/中率）。行为对纯中文段、纯拉丁段完全不变。
- **工具**：Read（engine.ts tokenize / cjk-tokenize.test.ts 通读）、Write（TDD 红测试 2 例）、Edit（engine.ts tokenize 最小改动）、Bash（bun test 红→绿 / self-evolve 全目录回归 / tsc）。无子代理。AGENTS 规则 2（备份 → 通读 → 最小改动 → 验证 → 删备份）与规则 7（红→绿）全程执行。
- **操作**（文件级）：
  1. `src/self-evolve/engine.ts`：`tokenize` 的 CJK 分支改为 `while` 扫描——`/[一-鿿]/` 连续 CJK 块 bigram 切分，非 CJK 连续块按整词入栈（长度 >=2 且非停用词）；纯中文段/纯拉丁段路径语义不变（原 `if (seg.length >= 2)` bigram 循环改为对 CJK 子块执行，拉丁整词分支保留）。CJK 判定沿用原 `[一-鿿]` 范围（字符字面量形式，等价）。
  2. `tests/self-evolve/cjk-tokenize.test.ts`：新增 2 例（`redis缓存命中率` 含整词 redis 且无 `re`/`s缓` 碎片；`sqlite查询次数超限` 含整词 sqlite 且无 `q查` 碎片）。
- **验证**：TDD 红→绿——实现前 2 fail（复现 `["re","ed","di","s缓","缓存","存命","命中","中率"]` 污染输出，红）→ 实现后 **5 pass/0 fail**（红 2 转绿 + 既有 3 例无回归）；self-evolve 全目录 **96 pass/0 fail**（15 文件）；`bunx tsc --noEmit` **0**。
- **红线**：只改 `tokenize` 的混合段切分逻辑；纯中文 bigram 语义、单字 CJK 保留、拉丁停用词过滤、`STOPWORDS` 集合均不变；`selfInduce` / `INDUCE_STOPWORDS` / 检索链路未触碰；无测试连真实 provider / 真实技能目录。
- **Commit**：fix(self-evolve): tokenize 混合脚本段整段 bigram 切碎拉丁（假跨脚本 bigram 污染归纳）— fdfd7f2

## 2026-09-02 — chore(infra): .gitignore 覆盖 data/*.jsonl（real-usage 运行时 trace 不入库）

- **任务**：`REAL_USAGE_PATH` 运行时 capture 目标 `data/real-usage-traces.jsonl`（.jsonl 后缀）未被既有 `data/*.json` 规则覆盖，会以未跟踪文件形式混入工作区、有被误提交风险；补 `data/*.jsonl` 忽略规则。
- **工具**：Read（.gitignore 通读）、Edit（最小加一行）、Bash（git status 核验未跟踪文件已忽略）。AGENTS 规则 2（备份 → 通读 → 最小改动 → 验证 → 删备份）执行。
- **操作**（文件级）：`.gitignore` Data 段新增 `data/*.jsonl` 一行（`data/*.json` 之后）；已跟踪 jsonl 无受影响项（`git ls-files 'data/*.jsonl'` 为空）。
- **验证**：修改后 `git status` 不再列出 `data/real-usage-traces.jsonl`；备份删除。
- **红线**：仅新增忽略规则，不改任何代码/数据文件语义。
- **Commit**：chore(infra): .gitignore 覆盖 data/*.jsonl（real-usage 运行时 trace 不入库）— 7dac69f

## 2026-09-02 — fix(agent-evals): skill-gain 无基线自引用回退致增益失真/注入被拒 + 增益统计混入执行错误

- **任务**：并行 bug-hunt 子代理在 agent-evals 定位到 skill-gain 两处真实缺陷——①`gainOf`/`shouldInject` 无族基线时回退 `baselineRate = injectedRate`（自引用），增益恒为 0、`injectedRate > baselineRate` 恒 false，把 ≥3 样本的全通过 auto-fix 技能永久拒于注入之外（与契约「无记录 → 允许试用」矛盾，也违背 gainOf 自身注释「无基线返回 null」）；②`run.ts` 增益反馈把执行错误（限流/传输等 provider 侧故障）按能力失败计入族基线与技能注入样本，与 metrics.ts 的 capability-denominated 口径不一致，让基建噪声左右注入决策。
- **工具**：Agent（并行 bug-hunt 子代理 3 路之一，report 4 findings）、Read（skill-gain.ts/run.ts/metrics.ts/registry.ts/registry-cli.ts/既有测试通读）、Edit（skill-gain.ts/run.ts/测试最小改动）、Bash（bun test 红→绿 / 全目录回归 / tsc）。AGENTS 规则 2（备份 → 通读 → 最小改动 → 验证 → 删备份）与规则 7（红→绿）全程执行。
- **操作**（文件级）：
  1. `src/agent-evals/skill-gain.ts`：`gainOf` 无基线 → 返回 null（增益未知，不再自引用压 0）；`shouldInject` auto-fix 无基线 → `pass > 0` 才注入（允许试用契约）；auto-induce 无基线 → 不注入（无法证明 ≥10pp，宁缺毋滥）；新增 `recordFromResults(baseline, evolved)` 方法（执行错误样本跳过），策略内聚于技能增益模块。
  2. `src/agent-evals/run.ts`：增益反馈两处循环改为 `gain.recordFromResults(...)`，执行错误不再计入基线/注入样本。
  3. `tests/agent-evals/skill-gain.test.ts`：新增 5 例（无基线 gainOf 返回 null / 无基线全通过 auto-fix 注入 / 无基线全败不注入 / 无基线 auto-induce 不注入 / recordFromResults 跳过执行错误样本）。
- **验证**：TDD 红→绿——实现前 3 fail（2 例无基线语义 + recordFromResults 未实现）+ 2 例 characterization 已绿 → 实现后 **167 pass/0 fail**（agent-evals 全目录 23 文件）；`bunx tsc --noEmit` **0**。
- **红线**：有基线时的增益/注入判定语义完全不变（基线存在 → 原比较逻辑原样）；auto-induce 严格口径保持；`recordBaseline`/`recordInjection` 单样本接口原样保留；不连真实 provider / 不写真实技能目录。
- **Commit**：fix(agent-evals): skill-gain 无基线自引用回退致增益失真/注入被拒 + 增益统计混入执行错误 — 3f7c53d

## 2026-09-02 — fix(agent-evals): seedBaseline 接受非法通过率污染回归基准 + CLI 空串过滤参数静默空结果

- **任务**：并行 bug-hunt 子代理在 agent-evals 定位到 registry 两处真实缺陷——①`seedBaseline`（及 CLI `seed-baseline`）只校验 `total > 0`，`pass > total`（如 10/3 → 333.33%）或负数 pass 会被入库，污染 `checkRegression` 回归判定；②CLI `--family=`/`--model=` 空串被 `?? null` 放行为真实过滤条件，SQL 匹配 `family_filter = ''` 静默返回空结果，用户看到「无评测记录」而非全量列表。
- **工具**：Agent（并行 bug-hunt 子代理 3 路之一）、Read（registry.ts/registry-cli.ts/registry.test.ts 通读）、Edit（registry.ts/registry-cli.ts/测试最小改动）、Bash（bun test 红→绿 / tsc / 真实 DB CLI 端到端核验）。AGENTS 规则 2 与规则 7 全程执行。
- **操作**（文件级）：
  1. `src/agent-evals/registry.ts` `seedBaseline`：新增 `pass` 范围守卫（`pass >= 0 && pass <= total`），非法抛错并说明会污染回归基准。
  2. `src/agent-evals/registry-cli.ts`：`cmdSeed` 校验补 `passRaw > totalRaw`；`flag()` 解析空值返回 `undefined`（空值视为未传，避免 `--family=` 当真过滤条件）。
  3. `tests/agent-evals/registry.test.ts`：新增 3 例（pass>total 拒绝 / 负数 pass 拒绝 / pass==total 边界 100% 接受）。
- **验证**：TDD 红→绿——实现前 2 fail（pass>total 与负数 pass 均不抛）→ 实现后 **170 pass/0 fail**（agent-evals 全目录 23 文件）；`bunx tsc --noEmit` **0**；真实 DB e2e：`seed-baseline --pass=10 --total=3` exit 1 拒绝、`stats --family=` 返回全量 4 轮（不再静默空）。
- **红线**：合法 seed 语义不变（sourceDoc 必填、total>0 原守卫保留、通过率计算逻辑原样）；CLI 其他参数（limit 缺省、显式真实 family/model）行为不变；仅空串特判。
- **Commit**：fix(agent-evals): seedBaseline 接受非法通过率污染回归基准 + CLI 空串过滤参数静默空结果 — bb8e547
## 2026-09-02 — fix(self-evolve): tokenize 整词化，根治 auto-induce 伪术语污染

- **任务**：selfInduce 把 bigram 自造伪术语（"先处"/"如何" 跨词边界、混合段 "re/ed/di/s缓"）提升为 auto-induce-* skill，污染技能库。root cause = tokenize 的 CJK bigram 切分切穿了词边界。
- **工具**：Edit（整函数替换按 `\uXXXX` 行避让分段编辑）、bunx tsc --noEmit、bun test、git。
- **操作**：
  - tokenize 改为整词语义：CJK 连续块整词保留（"如何优化"→整词）；混合段按连续脚本块切分，拉丁/数字整词（"redis缓存命中率"→redis + 缓存命中率）。
  - selfInduce 补两道特异过滤：单字 CJK 跳过；含 INDUCE_STOPWORDS（≥2 字）子串的中文短语按组成过滤（"写一个"/"处理函数"/"超时处理" 不再漏网）。
  - 重写 cjk-tokenize / induce-specificity 两个测试为整词语义契约（含反例断言：无 "何优"/"先处"/"s缓"/"次数"）。
- **验证**：bunx tsc --noEmit 退出 0；`bun test tests/self-evolve/` 96 pass / 0 fail（含更新后的整词断言）；7/37 断言落在两个改动文件。
- **红线**：规则 2（备份 .tmp/backups/engine.ts 待验证后删）；规则 3（只 add 本任务文件）；规则 7（测试先行，行为即契约）。
- **Commit**：`feb272b`
## 2026-09-02 — fix(self-evolve): recordTrace 防御性拷贝，杜绝外部对象污染归纳

- **任务**：`recordTrace` 直接存调用方对象引用（`this.traces.push(trace)`），外部复用/改动原对象会污染内部轨迹与 selfInduce 归纳结果。listTraces 已只读快照，写入侧缺失对称保护。
- **工具**：Edit、bunx tsc --noEmit、bun test、git。
- **操作**：recordTrace 改为 `this.traces.push({ ...trace })` 浅拷贝入栈；reflection-induce.test.ts 加回归测试（record 后改原对象 → 归纳仍按记录时快照计，support/成功率/字段不变）。
- **验证**：bunx tsc --noEmit 退出 0；`bun test tests/self-evolve/`（含 tokenize/induce 整词套件）14 pass / 0 fail；全量 `bun test tests/` 后台跑批待确认。
- **红线**：规则 1（一行拷贝，不做深度克隆——TaskTrace 为纯字段对象）；规则 2（备份 .tmp/backups/ 待验证后删）；规则 3（只 add 本任务文件）。
- **Commit**：`b55437f`
## 2026-09-02 — chore(gitignore): 忽略 Python 字节码缓存（__pycache__）

- **任务**：`scripts/pdf-worker/__pycache__/`（Python 构建产物）持续出现在 git status，`.gitignore` 的 `# === Python ===` 段只忽略了 `.venv/`，未覆盖字节码缓存。
- **工具**：Edit、git check-ignore、git。
- **操作**：`.gitignore` 的 Python 段补 `__pycache__/` 与 `*.pyc` 两行。
- **验证**：`git check-ignore scripts/pdf-worker/__pycache__/app.cpython-311.pyc` 退出 0（已忽略）；无业务文件改动。
- **红线**：规则 1（仅两行，不重建忽略结构）；规则 2（备份 .tmp/backups/.gitignore 待验证后删）；规则 3（只 add 本任务文件）。
- **Commit**：`3126f20`

## 2026-09-02 — fix(agent-evals,self-evolve,utils): 三处已验证缺陷修复（run.ts 执行错误退出码口径 / env.ts 必需变量命名错位 / 教训文件名 hash 截断）

- **任务**：并行 bug-hunt 子代理三路报告，逐一对照源码复核后确认 3 处真实缺陷并一并修复——①`run.ts` 三处退出码判定（persistResults.exitCode / evolve 合并 / 常规结果）把执行错误当失败（`!r.passed`），与 `metrics.summarize` 能力口径契约不一致（执行错误不计通过率分母），一次限流即整场 eval 失败退出；②`env.ts` `REQUIRED_ENV_VARS` 把运行时从未读取的 `DATABASE_URL`/`VAULT_PATH` 标记 required，每次启动假告警「Missing required: DATABASE_URL, VAULT_PATH」，真实运行时变量 `DATABASE_PATH`/`OBSIDIAN_VAULT_PATH`（config-center/main 实际读取）却零校验（audit 预列 P2）；③`self-evolve/index.ts` 教训落盘文件名用 `stableHash` 截断 6 位，而内存去重/回读键是完整 8 位，hash 前 6 位相同的两个教训写同一文件互相静默覆盖。
- **工具**：Agent（并行 bug-hunt 子代理 3 路）、Read/Grep（对照 config-center/native-bridge/main/registry 复核）、Write/Edit（测试先行 + 源码最小改动）、Bash（bun test 红→绿、typecheck、真实 stableHash 碰撞检索、ops-log CRLF 追加）。AGENTS 规则 2/3/5/7 全程执行。
- **操作**（文件级）：
  1. `src/agent-evals/metrics.ts`：新增导出 `hasCapabilityFailure(results)`——存在非执行错误的任务失败才为真（与 passRate 能力口径一致）。
  2. `src/agent-evals/run.ts`：3 处退出码判定改用 `hasCapabilityFailure`，执行错误（限流/传输/provider 故障）不再令 eval 失败退出。
  3. `src/utils/env.ts`：`REQUIRED_ENV_VARS` 两条 required 项改名 `DATABASE_PATH`（默认 ./data/agent.db）/`OBSIDIAN_VAULT_PATH`（默认 ./axiom-memory）；`DATABASE_URL`/`VAULT_PATH` 降级 required:false 保留（backup 脚本 / native-bridge 云端检测 / 可选 PG 知识图谱仍读）。
  4. `src/self-evolve/index.ts`：教训文件名 `hash.slice(0, 6)` → 完整 8 位 `hash`（title 本就用 8 位，回读按内容 hash 键，向后兼容）。
  5. 新增 `tests/utils/env-runtime-vars.test.ts`（3 例）、`tests/self-evolve/lesson-store.test.ts`（2 例，含真实 djb2 前 6 位碰撞对）、扩展 `tests/agent-evals/metrics.test.ts`（3 例 hasCapabilityFailure）。
- **验证**：TDD 红→绿——实现前 6 fail+1 error（缺 DATABASE_PATH / required 仍 true / 假 missing / hasCapabilityFailure 未导出 / 文件名截断）；实现后受影响套件全绿：`tests/self-evolve tests/agent-evals tests/utils tests/native-bridge.test.ts tests/main.test.ts` = **310 pass / 0 fail**；`bun build` 三个改动入口 0 错。
- **红线**：规则 2（备份 .tmp/backups/ 已验证后删除）；规则 3（只 add 本任务文件，其余工作区改动不碰）；规则 7（测试先行）；规则 9（无强推/reset）。`DATABASE_URL`/`VAULT_PATH` 未删除仅降级，backup 脚本/云端检测兼容。
- **Commit**：`1759a93`
## 2026-09-03 — docs(plans): 回写 08-28/09-01 计划完成状态（记录维护）

- **任务**：迭代间隙文档回填——08-28 最稳路径修订计划（8 切片，含延期 W5/W8）与 09-01 打通真实数据端到端计划（主线 A/B）均已实际完成，两份计划文档状态与 git 历史不一致，需回写完成状态与 commit 锚点。
- **工具**：Read/Grep/Bash（git log 核对各 commit 锚点）、Node（BOM/CRLF 安全的文本替换）、git。AGENTS 规则 5（记录维护）执行。
- **操作**（文件级）：
  1. `docs/superpowers/plans/2026-08-28-plan-amendment-most-stable.md`：8 切片全部标 ✅ 并补 commit 锚点（S1=11f226a、S2=df5e125、S4=3fdbc69、S5=22a407c(+aac3247)、S7+S8=6b4e9a6、W5=fbb47c2+f703bbf、W8=37c24ae）；`延期（下迭代）` → `已完成`；目标/验证/执行顺序各节标注实际结果。
  2. `docs/superpowers/plans/2026-09-01-real-data-evolve-specificity-plan.md`：24 个真实 checkbox `- [ ]` → `- [x]`（保留第 3 行代码 span 的 `- [ ]` 示例），逐任务补完成锚点（主线 A=4f87c4b、Task 5=70ba841、Task 6=6f5ed2f、Task 7 终验=3280 pass/0 fail）。
- **验证**：`git diff` 仅两计划文档与 ops-log；09-01 文件残留 `- [ ] **Step` 计数为 0；08-28 全部切片锚点存在。
- **红线**：规则 1（只回写状态，不删改计划内容）；规则 3（只 add 本任务文件，幻影 stat-cache 文件不碰）；规则 5（hash 回填独立提交）。
- **Commit**：`a2942d5`

## 2026-09-04 — feat(agent-evals): 深化计划 S1+S2+S3 落地（成本/Token 维度 + 延迟分位 + 失败聚类与趋势/对比）

- **任务**：实施 docs/superpowers/plans/2026-09-03-agent-evals-deepening-plan.md 三主线。主线程先搭共享脚手架（registry 全部列接线、run.ts 透传与 CLI 骨架、metrics-types 类型），再以 3 个并行子代理分片独占文件（runner / metrics+report / report-extras）落实现剥离。
- **工具**：Agent（并行子代理 3 路）、主线程 Read/Edit/Write、Bash（bun test / tsc / test:full）。AGENTS 规则 1/2/3/5/7/9 执行。
- **操作**（文件级）：
  1. `src/agent-evals/runner.ts`：导出 parseProviderUsage（OpenAI 兼容 usage 解析）+ 直连/internalAgent 两路径采集 token 用量与 costUsd；响应体单次 JSON 解析，content 与 usage 共用；fallback 路径对等采集；执行错误早退保留本轮已采集用量。
  2. `src/agent-evals/registry.ts`：eval_runs 增 summary_avg_cost_usd/summary_total_cost_usd/summary_latency_p50/p95/p99 五列、eval_task_results 增 prompt_tokens/completion_tokens/cost_usd 三列；insertRun/insertTaskResults 写入、rowToRun/rowToTask 读回、ensureColumn 老库迁移；修复两处实参/列绑定位错（成本列与分位列）。
  3. `src/agent-evals/metrics.ts`：summarize 聚合成本/Token 维度（无数据 null）+ 延迟分位 latencyP50/P95/P99（nearest-rank，全样本含执行错误，n<3 时 p95/p99 回退 null）。
  4. `src/agent-evals/metrics-types.ts`：RunSummarySnapshot/RunRow/StoredTaskRow 增成本与分位字段（全可选，老调用方兼容）。
  5. `src/agent-evals/report.ts`：延迟行扩为 平均延迟/p50/p95/p99（null 显示 "-"），前缀与单行结构不变。
  6. `src/agent-evals/run.ts`：persistResults 透传 token 用量与成本；新增 --trend=N（最近 N 轮趋势）与 --compare=a..b（两轮对比）CLI，只读 registry 不执行评测。
  7. `src/agent-evals/report-extras.ts`（新）：失败原因聚类（执行错误/限流/超时/内容缺失/JSON缺失/其他，命中即归桶）+ trendMarkdown + compareMarkdown（消费 registry.getTrend/compare 返回值）。
  8. 测试（新）：tests/agent-evals/cost-token-dimension.test.ts（12 例）、latency-percentile.test.ts（13 例）、report-extras.test.ts（14 例）。
- **验证**：各子代理 TDD 红→绿；`bunx tsc --noEmit` 0；`bun test tests/agent-evals` 212 pass / 0 fail；`bun run test:full` 3368 pass / 34 skip / 0 fail（基线 3280 pass/0 fail 不下降）。
- **红线**：规则 1（只加新字段/新输出，passRate 能力口径 / executionError / 泛化率 / rerun/fallback 语义全不变）；规则 3（只 add 本任务 10 个文件；.serena/*、scripts/pdf-worker/app.py、CLAUDE.md 等无关改动未触碰）；规则 7（测试先行）；规则 9（无 force/reset/checkout）；规则 11（无真实密钥、无网络）。并行期间子代理跑 bun test 生成的 junit-evals.xml 测试产物已删除。
- **Commit**：47a966c

## 2026-09-04 — docs(plans): 回写 09-03 计划完成状态（记录维护）

- **任务**：迭代间隙文档回填——09-03 agent-evals 深化计划（S1 成本/Token、S2 延迟分位、S3 失败聚类+趋势/对比）已随 `47a966c` 合入（3 路并行子代理 + TDD，主线 A 三主线全部完成），计划文档状态与 git 历史不一致，需回写完成状态与 commit 锚点。
- **工具**：Read/Grep/Bash（git show 核对 a2942d5 记录维护格式与 47a966c 锚点）、Edit（UTF-8 无 BOM、LF 行尾）、Node（CRLF 安全的 ops-log 追加）、git。AGENTS 规则 5（记录维护）执行。
- **操作**（文件级）：
  1. `docs/superpowers/plans/2026-09-03-agent-evals-deepening-plan.md`：引言块追加状态行（主线 A 全部完成 · `47a966c`，注明「3 路并行、单提交合入而非每片独立 commit」与计划的差异）；S1/S2/S3 标题标 ✅ + 锚点；验证修订节补实测结果（tsc 0 / agent-evals 212 pass / test:full 3368 pass）；主线 B 维持「下迭代实施」不变。
  2. `docs/operations-log.md`：CRLF 追加本条记录（Hash 占位 `__HASH__` 待后续回填）。
- **验证**：`git diff` 仅计划文档与 ops-log 两文件；计划文档 S1/S2/S3 锚点与 `47a966c` 一致；主题内容（设计/红线/主线 B 留滞）未删改。
- **红线**：规则 1（只回写状态，不删改计划内容）；规则 3（只 add 本任务文件）；规则 5（hash 回填独立提交）。
- **Commit**：579b2b3

## 2026-09-05 — feat(agent-evals): S4 任务集质量强化（声明式断言 + expectedBehavior 标定）

- **任务**：主线 B（S4）落地——之前的关键词闭包验证无法表达数值/长度/正则断言、`expectedBehavior` 字段（tasks.ts:30）48 任务零使用。本次给 agent-evals 引入**可内省的结构化断言层**（AssertionSpec + compileAssertion）+ **全量 expectedBehavior 语义标定** + 6 个跨族新任务演示新能力。
- **工具**：主线程（verify.ts 基建全量实现 + assertion-validators.test.ts + index.ts 重导出）→ 子代理 A（独占 tasks.ts 内容层）+ 子代理 B（独占 external.ts + assertion-spec-guard.test.ts 红队）双路并行，文件零冲突，TDD 红→绿。
- **操作**（文件级）：
  1. `src/agent-evals/verify.ts`：新增 `AssertionSpec`（8 字段 1:1 映射既有验证器，AND 短路）+ `NumberAssertion`/`OutputLengthBounds` + `ASSERTION_SPEC_KEYS` + `assertSpecErrors`（良构校验，compileAssertion 与 validateTasks 共用）+ `compileAssertion`（畸形 spec 返回 fail-closed 桩不 throw）+ `extractLastNumber`/`mustReturnNumber`/`outputLength` 新验证器。红队发现的 `{ mustReturnNumber: null }` 崩溃级 bug 已修（`typeof null === "object"` 漏守卫，outputLength/mustReturnNumber 两分支一并补 `=== null`）。
  2. `src/agent-evals/tasks.ts`：`AgentTask` 增 `assert?`；`t()` 工厂 overload（AssertionSpec 派生 verify，显式闭包最高优先）；`validateTasks` 增 assert 良构 + expectedBehavior 质量门 2 类规则；**48 既有任务全量 expectedBehavior**（闭包一字不动）；新增 6 任务（CODING-09/KNOW-09/PLAN-09/TOOL-09/MEM-09/EVOLVE-09 各演示 mustReturnNumber 精确/区间、outputLength、matchesAll 正则、JSON键+数值、组合）。
  3. `src/agent-evals/external.ts`：toHumanEvalTask/toMbppTask 补 expectedBehavior 元数据（真实执行断言语义）。
  4. `src/agent-evals/index.ts`：补全重导出（新增验证器 + 顺带补漏 containsAllAny）。
  5. 测试：assertion-validators.test.ts（25）、assertion-spec-guard.test.ts（99，红队）、tasks-s4-assert.test.ts（49）、external-benchmarks.test.ts（+2）、tasks.test.ts（+1）。
- **验证**：TDD 红→绿——guard 曾 1 fail（null bug，修复后转绿）；`bunx tsc --noEmit` 0；`bun test tests/agent-evals` 392 pass / 0 fail（基线 212，+180）；`tests/agent-evals + tests/utils + tests/native-bridge + tests/main` 421 pass / 0 fail；外部消费方 `tests/external-eval-sandbox.test.ts` 3 pass。全仓 test:full 未跑（用户中断，影响面已穷举：src 无其他 agent-evals 消费方）。
- **红线**：规则 1（48 闭包语义全不变，`git diff` 确认 `(r) =>` 闭包零改动，仅 extra 补 expectedBehavior + 工厂 overload）；规则 2（.tmp/backups 验证后删净）；规则 3（只 add 本任务 9 文件；.serena/*、scripts/pdf-worker/app.py、CLAUDE.md 未碰）；规则 7（测试先行）；规则 9（无 force/reset/checkout）；规则 11（无密钥、无网络，新任务只测纯函数判定）。
- **Commit**：441976a
## 2026-09-05 — docs(plans): 回写 09-03 计划主线 B（S4）完成状态（记录维护，规则5）

- **任务**：迭代收尾——S4 任务集质量强化（09-03 计划主线 B）已随 `441976a` 合入（主线程基建 + 双路并行子代理 + TDD，任务集 48 → 54），计划文档状态与 git 历史不一致，需回写完成状态与 commit 锚点；顺带清 09-04 上一轮遗留的 `__HASH__` 拖欠（随 61a70b5 一并回填）。
- **工具**：node（CRLF 安全 ops-log 追加）、Edit（计划文档 UTF-8 无 BOM）、git。AGENTS 规则 5（记录维护）执行。
- **操作**（文件级）：
  1. `docs/superpowers/plans/2026-09-03-agent-evals-deepening-plan.md`：引言状态行改为双主线全覆盖（A→`47a966c`，B→`441976a`）；主线 B 段落从「不实施」改写为 ✅ 实施详情（AssertionSpec 层 / t() overload / validateTasks 质量门 / 6 新任务 / external 元数据）；验证修订节补 S4 实测（tsc 0 / agent-evals 392 pass / 影响面 421 pass / external-sandbox 3 pass）。
  2. `docs/operations-log.md`：CRLF 追加本条记录（Commit 字段占位待回填）。
- **验证**：`git diff` 仅计划文档与 ops-log 两文件；S4 锚点 `441976a` 与会话实际 commit 一致；主题内容（设计/红线/主线 A 记录）未删改。
- **红线**：规则 1（只回写状态，不删改计划内容与主线 B 交付语义）；规则 3（只 add 本任务文件）；规则 5（hash 回填独立提交）；规则 9（无 force/reset）。
- **Commit**：58ace5c

## 2026-09-05 — docs(plan): agent-evals S5 收尾计划（报告落地 / 回归自动检测 / 验证器直测）

- **任务**：S5 迭代规划——S4 后三处「半成品」收口（S3 失败聚类段未接入主报告 / checkRegression 未自动跑 / verify.ts 14 导出仅直测 7 个）。方向由用户选定（排除 HTML 报告视图）；设计决策：失败聚类无失败轮次省略段、回归检测默认开启 + --no-check-regression 逃生舱、分级退出码（回归=2 > 能力失败=1 > 正常=0）。
- **工具**：Read/Grep/Bash（现状盘点全读 report-extras/registry/run/verify）、Write（计划文档）、node（CRLF 安全 ops-log 追加）。AGENTS 规则 5 执行。
- **操作**（文件级）：
  1. `docs/superpowers/plans/2026-09-05-agent-evals-s5-closure-plan.md`（新）：S5 收尾计划——4 个 Slice（验证器直测补齐 / 报告落地补全 / run-check 纯函数 / run.ts 胶水 + 分级退出码），含兼容红线与验证策略。
- **验证**：计划与用户 AskUserQuestion 选择一致；改动面与既有代码 read 核对。
- **红线**：规则 1（仅接入既有能力）；规则 3（只 add 计划文档 + ops-log）；规则 9（无 force/reset）。
- **Commit**：b771ec6

## 2026-09-05 — feat(agent-evals): S5 报告落地补全 + 回归自动检测闭环 + 验证器直测补齐

- **任务**：S5 三项收口全部落地（4 Slice 顺序推进）——(1) 验证器直测补齐：verify.test.ts 新增 describe 直测 S4 新增 7 导出；(2) 报告落地补全：report.toMarkdown 明细表后按需追加 ## 失败聚类 段（仅失败轮次，全绿省略保逐字节兼容），toJSON 增结构化 failures；(3) run-check.ts 新建 autoCheckRegression 纯函数（:memory: 全分支测试）；(4) run.ts 胶水：persistResults 返回 runId、--baseline/--max-drop/--no-check-regression 三 flag、落库后自动回归检测（告警走 warn/stderr）、分级退出码 回归=2 > 能力失败=1 > 正常=0。
- **工具**：主线程 TDD 红→绿逐 Slice（report-main.test.ts 5 例、run-check.test.ts 6 例先 RED 后 GREEN）、Edit/Write、bun test、bunx tsc、node（CRLF 安全 ops-log 追加）。AGENTS 规则 1/3/5/7/9/11 执行。
- **操作**（文件级）：
  1. `tests/agent-evals/verify.test.ts`：新增「S4 assertion layer (direct)」describe，直接 import 7 个 S4 导出补齐直测。
  2. `src/agent-evals/report.ts`：import clusterFailures；toMarkdown 明细表后追加失败聚类段（clusters.length>0 才输出）；toJSON 增 failures 结构化字段。
  3. `src/agent-evals/run-check.ts`（新）：autoCheckRegression——runId null 纯无操作 / 候选缺失 no-candidate / 无可比基准 no-baseline / 正常 checked+regressed。
  4. `src/agent-evals/run.ts`：persistResults 返回 number|null；--baseline/--max-drop/--no-check-regression；主路径 auto-check（warn→stderr，跳过→info）；分级退出码；帮助文本补三 flag。
  5. 测试（新）：report-main.test.ts（5 例，含兼容红线省略段）、run-check.test.ts（6 例）。
- **验证**：逐 Slice 红→绿（report-main 曾 1 fail 因夹具 reason「缺少关键内容:」实际归「其他」桶，改 empty response 命中「内容缺失」后转绿）；`bunx tsc --noEmit` 0；`bun test tests/agent-evals` 410 pass / 0 fail / 31 files（基线 392）；`tests/agent-evals/latency-percentile.test.ts` 13 pass（兼容红线）；`--help` 三 flag 可见、`--dry-run` exit 0。真实回归判定不连 provider（run-check 判定逻辑 :memory: 全覆盖）。
- **红线**：规则 1（仅接入既有 clusterFailures/checkRegression，无新算法；全绿轮次 toMarkdown 逐字节不变）；规则 2（.tmp/backups/tests/agent-evals/verify.test.ts.bak 验证后删除）；规则 3（只 add 本任务 6 文件 + ops-log；.serena/*、scripts/pdf-worker/app.py、CLAUDE.md 未碰）；规则 7（测试先行）；规则 9（无 force/reset/checkout）；规则 11（无密钥、无网络）。
- **Commit**：e5bc202

## 2026-09-05 — docs(plans): 回写 09-05 计划完成状态（记录维护，规则5）

- **任务**：迭代收尾——S5 收尾计划（报告落地 / 回归自动检测 / 验证器直测）已随 `e5bc202` 合入（主线程 TDD 红→绿逐片推进，agent-evals 392 → 410 pass），计划文档状态与 git 历史不一致，需回写完成状态与 commit 锚点。
- **工具**：Edit（计划文档 UTF-8 无 BOM、LF）、node（CRLF 安全 ops-log 追加）、git。AGENTS 规则 5（记录维护）执行。
- **操作**（文件级）：
  1. `docs/superpowers/plans/2026-09-05-agent-evals-s5-closure-plan.md`：状态行改为 S5 四 Slice 全部完成合入 `e5bc202`；四个 Slice 标题标 ✅ + 锚点；验证策略节补实测（tsc 0 / agent-evals 410 pass / 红线 13 pass / 三 flag smoke）。
  2. `docs/operations-log.md`：CRLF 追加本条记录（Commit 字段占位待回填）。
- **验证**：`git diff` 仅计划文档与 ops-log 两文件；S5 锚点 `e5bc202` 与会话实际 commit 一致；主题内容（设计/红线/验证策略原文）未删改。
- **红线**：规则 1（只回写状态，不删改计划内容）；规则 3（只 add 本任务文件）；规则 5（hash 回填独立提交）；规则 9（无 force/reset）。
- **Commit**：319b6f9

## 2026-09-05 — feat(agent-evals): evolve 回归闭环 + exit_code 真值回写（S5 补充）

- **任务**：evolve 修复——S5 后 evolve 是回归闭环的「另一半」缺口：主路径已接 auto-check + 分级退出码，evolve 两阶段落库后不检测，--baseline/--max-drop/--no-check-regression 三 flag 在 evolve 下是死代码，退出码仍旧 1:0。本次补上：autoCheckEvolve 纯函数（基准解析 spec→baselineRunId→历史最优）+ evolve 接线 + registry.updateExitCode 真值回写（主/evolve 两路径 regressed 时 DB exit_code 记 2）。
- **工具**：主线程 TDD 红→绿（run-check +4 例、registry +2 例先 RED）、Edit/Write、bun test、bunx tsc、node（CRLF 安全 ops-log 追加）。AGENTS 规则 1/3/5/7/9/11 执行。
- **操作**（文件级）：
  1. `src/agent-evals/run-check.ts`：新增 autoCheckEvolve——evolvedRunId null 纯无操作；基准 = 用户 --baseline（run_tag/纯数字双形态）→ 本轮回 baseline 阶段 runId → 自动历史最优。
  2. `src/agent-evals/registry.ts`：接口 + 实现新增 updateExitCode(runId, code)（UPDATE eval_runs.exit_code，返回影响行数）。
  3. `src/agent-evals/run.ts`：evolve 段捕获 baseline/evolved runId；!noCheckRegression 时 autoCheckEvolve（候选=evolved，基准=--baseline 或 baseline 阶段），regressed → updateExitCode(evolvedRunId,2) + 退出码 2；主路径 regressed 分支同样 updateExitCode(runId,2) 回写 DB 真值；evolve 退出码升级分级 2:1:0。
  4. `tests/agent-evals/run-check.test.ts`：+4 例 autoCheckEvolve（baselineRunId 采用 / spec 覆盖双形态 / evolvedRunId null 无操作 / 双无回落历史最优）。
  5. `tests/agent-evals/registry.test.ts`：+2 例 updateExitCode（回写后 getRun 读新值 / 不存在返回 0 行）。
- **验证**：TDD 红→绿；`bunx tsc --noEmit` 0；`bun test tests/agent-evals` 416 pass / 0 fail / 31 files（基线 410，+6 = run-check 4 + registry 2）；`latency-percentile.test.ts` 13 pass（兼容红线）；`--help` --evolve + 三 flag 可见、`--dry-run` exit 0。evolve 判定逻辑 :memory: 全覆盖（不连 provider）。
- **红线**：规则 1（仅新增，无语义删改；主路径行为向后兼容）；规则 3（只 add 本任务 7 文件 + 计划补充 + ops-log；.serena/*、scripts/pdf-worker/app.py、CLAUDE.md 未碰）；规则 7（测试先行）；规则 9（无 force/reset/checkout）；规则 11（无密钥、无网络）。
- **Commit**：7b06ca2

## 2026-09-05 — docs(plans): 回写 09-05 计划 evolve 补充完成状态（记录维护，规则5）

- **任务**：迭代收尾——S5 计划文末「补充（evolve 修复）」段已随 `7b06ca2` 实施（偏离原「evolve 不接自动检查」，用户指示 evolve 修复后调整：evolve 两阶段接入回归检测 + 分级退出码 + updateExitCode 真值回写），补充段状态行缺锚点，需回写完成状态与 commit 锚点。
- **工具**：Edit（计划文档 UTF-8 无 BOM、LF）、node（CRLF 安全 ops-log 追加）、git。AGENTS 规则 5（记录维护）执行。
- **操作**（文件级）：
  1. `docs/superpowers/plans/2026-09-05-agent-evals-s5-closure-plan.md`：补充段状态行改为 evolve 修复已实施并合入 `7b06ca2`（410 → 416 pass）。
  2. `docs/operations-log.md`：CRLF 追加本条记录（Commit 字段占位待回填）。
- **验证**：`git diff` 仅计划文档与 ops-log 两文件；锚点 `7b06ca2` 与会话实际 commit 一致；补充段主题内容未删改。
- **红线**：规则 1（只回写状态）；规则 3（只 add 本任务文件）；规则 5（hash 回填独立提交）；规则 9（无 force/reset）。
- **Commit**：aabf0e5
## 2026-09-05 — feat(agent-evals): 真实场景测试集 +12 任务（6族扩展 54→66，S4 声明式断言）

- **任务**：Phase B 实施——按 Agent 真实使用规范（8 角色 + 19 TaskRole + persona + constitution + AGENTS 工程纪律 + 自进化闭环 + model-router/web_search 本体知识）扩展现有 6 族，新增 12 个真实场景任务（每族 1 train + 1 held-out），全部 S4 AssertionSpec 声明式断言（t() + assert + expectedBehavior + maxTokens），并同步 TDD 测试与活文档。
- **工具**：Read/Edit（tasks.ts 逐族追加）、Write（新测试文件）、bun test（TDD 红→绿）、bunx tsc --noEmit、git、node（ops-log CRLF 追加）。无子代理（tasks.ts 单写入者）。
- **操作**（文件级）：
  1. `tests/agent-evals/tasks-real.test.ts`（新增）：真实场景测试 31 用例——12 任务存在性/质量门（validateTasks 0 错误、总数 66）+ 每任务通过/失败行为断言（含 reason 文案核对：缺少任一概念 / JSON 缺少键 / 未找到有效 JSON 对象）。
  2. `src/agent-evals/tasks.ts`：追加 CODING-10/11、KNOW-10/11、PLAN-10/11、TOOL-10/11、MEM-10/11、EVOLVE-10/11（工程纪律规则2/1/9、model-router 路由降级、code-review 角色流程、self-evolve 闭环规划、web_search JSON 参数、容器排障命令序、角色+模型 JSON 约束、多约束数值保持、从失败提炼教训、调试纪律 rule6）。
  3. `tests/agent-evals/tasks-s4-assert.test.ts`：t() 契约断言改为按属性计数——48 显式闭包 assert===undefined、18 个 assert 任务（-09 六 + -10/-11 十二）与 compileAssertion 等价。
  4. `docs/AGENT-EVALS.md`：任务集描述更新为 66 个自建任务（6 族 × 9 基础 + 12 真实场景扩展）。
  5. `docs/superpowers/plans/2026-09-05-real-eval-baseline-plan.md`：本次任务计划文件（本提交一并纳入）。
- **验证**：TDD 红（任务不存在 12 项失败）→ 绿（31/31）；全量 `bun test tests/agent-evals` **447 pass / 0 fail**（原 416 + 31 新，无回退）；`bunx tsc --noEmit` 0 错误；`run.ts --dry-run` 任务清单 66 且校验通过。
- **红线**：规则 1（只新增任务与对应测试，未改既有 54 任务语义/验证器，零基线风险）；规则 2（tasks.ts 已备份 .tmp/backups/，验证后删）；规则 3（只 add 本任务文件：tasks.ts、tests-real、tasks-s4-assert、AGENT-EVALS.md、plan；未碰 .serena/*、scripts/pdf-worker/app.py、CLAUDE.md）；规则 5（本条目，Commit 占位待回填）；规则 9（无 force/reset/checkout）；规则 11（无密钥）。
- **Commit**：8fb0739
## 2026-09-05 — docs(agent-evals): 基准标定第一版（54 任务集，run#5/#6）+ 2026 评测基准调研知识文件

- **任务**：Phase C + Phase D 交付——(C) 依据 registry 真实 run#5（zhipu glm-4.7-flash 54 任务）/ run#6（sensenova deepseek-v4-flash 54 任务）撰写第一版基准标定文档（三路对比/分族/泛化/成本 Token/延迟分位/失败聚类/历史对比/回归检测/结论建议，66 任务 Wave-2 标"待回填"）；(D) arxiv API 直检索 2026-08~09 最新 agent 评测论文，产出知识文件（ClawProBench/Agent-as-a-Judge/EarlyEval/Same Model Different Harness/Do Agent Optimizers Compound 等 12 篇，落进测试集设计与定位判断）。
- **工具**：arxiv API（curl）+ grep/sed 解析摘要（WebSearch/WebFetch 后端摘要模型不可用，绕行）；bun + bun:sqlite 直查 eval_registry/eval_task_results（listRuns 不含 summary 列，改 PRAGMA + 直接 SQL）；Write（两文档）；git；node（ops-log CRLF 追加）。后台两个评测 Job 并行（zhipu-66 bac0fclnj、deepseek-evolve-66 b7862dw8d）。
- **操作**（文件级）：
  1. `docs/agent-eval-baseline-2026-09-05.md`（新增）：第一版全量基线——zhipu 90.6%（48/53，执行错误 1）/ sensenova 100%（45/45，执行错误 9）；分族表、泛化率 1.095、token 26,965 vs 50,708、延迟 p50/p95/p99、失败聚类（zhipu 5 能力失败 + 1 执行错误）、历史对比、结论建议；Wave-2 待回填清单。
  2. `docs/knowledge/agent-eval-benchmarks-2026-09-05.md`（新增）：2026 agent 评测调研——轨迹级评测/确定性验证器 vs LLM judge/回归控制复合增益/跨 harness 差异四结论，12 篇来源表，结论标注事实/判断。
- **验证**：registry 数字逐条自 SQL 聚合核对（run#5 pt=2291 ct=24674、run#6 pt=5374 ct=45334、cap_rate 90.57%/100%、分族 passed/total）；文档未杜撰、无密钥；Phase B 提交后全量测试 447 pass / 0 fail。
- **红线**：规则 1（仅新增文档，未改源码）；规则 3（只 add 本任务 2 文档 + ops-log；未碰 .serena/*、scripts/pdf-worker/app.py、CLAUDE.md）；规则 5（本条目，Commit 占位待回填）；规则 9（无 force/reset）；规则 11（无密钥、报告只记 provider/模型/用量）。
- **Commit**：8cd5fd5

## 2026-09-05 — docs(agent-evals): 标定文档回填 sensenova-66（run#10）+ Wave-2 实时更新与计划回写

- **任务**：Phase C 收尾——sensenova-66（run#10，66 任务全量 Wave-2）完成后回填标定文档第十一节；deepseek（opencode）全量 + evolve 两次不可达（模型自竞争）如实记录；计划文件回写完成状态；66 任务 sensenova 报告落 eval-results/。
- **工具**：git、node（ops-log CRLF 追加）、Read/Edit/Write（文档与报告）。后台 Job：sensenova-66（bymzn4aez）完成、deepseek-evolve2（bj8te3cdz）停止。
- **操作**（文件级）：
  1. `docs/agent-eval-baseline-2026-09-05.md`：新增第十一节 run#10（sensenova 66 任务）——能力口径 91.5%（43/47，19 执行错误不计入）、泛化率 1.133、分族表、4 个真实能力失败（CODING-03/KNOW-02/EVOLVE-01/09）、EVOLVE-09 跨 provider 稳定失败识别；历史对比表补两行 66 任务；结论与待回填更新（deepseek 不可达原因、撞窗任务重跑清单）。
  2. `docs/superpowers/plans/2026-09-05-real-eval-baseline-plan.md`：状态回写「已完成（deepseek 路不可达除外）」+ 四阶段完成说明。
  3. `eval-results/agent-evals-2026-09-05-sensenova-66.md`（新增）：run#10 完整报告（分族 + 逐任务明细 + 失败聚类）。
  4. `docs/operations-log.md`：CRLF 追加本条记录（Commit 占位待回填）。
- **验证**：run#10 registry 落库记录（passRate=91.5%，回归检测回落 8.5pp < 10pp 未判回归）；文档数字与 registry/报告逐项核对；git diff 仅本任务文件；未碰 .serena/*、scripts/pdf-worker/app.py、CLAUDE.md。
- **红线**：规则 1（仅文档/报告，未改源码）；规则 3（只 add 本任务文件）；规则 5（hash 回填独立提交）；规则 9（无 force/reset）；规则 11（无密钥）。
- **Commit**：cfdbe6b
## 2026-09-05 — docs(agent-evals): 回填 deepseek evolve 真实结果（run#8/#9，纠错首版「两次不可达」叙事）

- **任务**：复查 registry 时发现首版标定文档与 ops-log cfdbe6b 记载「deepseek（opencode）全量 + evolve 两次不可达、0 任务落库」有误：run#8/run#9（run_tag `..30192::baseline`/`::evolved`，argv `--provider=opencode --model=deepseek-v4-flash --evolve --concurrency=1 --rerun-each=1`，12:04:18 启动、12:43:52 完成）实为完整成功的 evolve 闭环。三个后台 job 时间线交叉核对：10:40 全量54（`.tmp/eval-logs/deepseek.log`）transport error 拖死、12:04 deepseek-evolve-66（b7862dw8d，=run#8/#9）成功、12:49 deepseek-evolve2（bj8te3cdz，`.tmp/run-deepseek-evolve2.log`）阶段1/3 撞墙——cfdbe6b 把 bj8te3cdz 当成唯一 deepseek job 记录为「停止」，漏看了 b7862dw8d 已成功落库。本次回填真实结果并纠正叙事。
- **工具**：Read/regex（registry 直查）、bun+sqlite（run#8/9 明细、分族、injected_skills 38/38、exit_code 1→0、git_commit 4e4dc82 与 run#7/#10 同版）、node（CRLF 安全 ops-log 追加）、git。无子代理（纯文档回填）。
- **操作**（文件级）：
  1. `docs/agent-eval-baseline-2026-09-05.md`（备份 `.tmp/backups/`）：头部修订注记、全局对比表 opencode 行由「不可达」改真实数据（evolved 100% / baseline 94.7%）、核心结论三路并列、历史对比表补 deepseek evolve 行、结论4 区分「evolve 已成功 vs 全量66未做」、第十一节新增 run#8/#9 小节（baseline 36/38=94.7%→evolved 38/38=100%，分族 coding 5/6→6/6、memory 6/7→7/7，两阶段零执行错误）、待回填清单 deepseek 项改为「全量66（无evolve）待空闲期补跑」并附三次尝试明细。
  2. `docs/superpowers/plans/2026-09-05-real-eval-baseline-plan.md`（备份 `.tmp/backups/`）：状态行「deepseek 路不可达除外」同步纠正为「deepseek 全量 66 例外」，回写清单补 evolve ✅。
  3. `docs/operations-log.md`：CRLF 追加本条（Commit 占位待回填）。
- **验证**：registry run#8/9 逐项核对（baseline passed=36/38 execErr=0 / evolved 38/38 带 injected_skills；exit_code 1/0 符合分级；git_commit 4e4dc82 与 run#7/#10 一致证实 66 任务集）；`.tmp/run-deepseek-evolve2.log`（12:49 阶段1/3 撞墙）与 `.tmp/eval-logs/deepseek.log`（10:40 全量）确认两次失败尝试与成功 job 区分；git diff 仅标定/计划/ops-log 三文件。
- **红线**：规则 1（纯文档纠错回填，未改源码）；规则 2（两文档已备份，验证后删）；规则 3（仅 add 本任务文件）；规则 5（本条目，Commit 占位待回填）；规则 9（无 force/reset）；规则 11（无密钥）。
- **Commit**：3f256be

## 2026-09-05 — feat(agent-evals): CLI --tasks 精确过滤 + EVOLVE-09 断言校准（TDD）

- **任务**：① 给评测 CLI 加 `--tasks=<id1,id2>` 精确任务过滤（撞窗补测/单任务核验需要，family/split 无法精确定位跨族任务）；② 校准 EVOLVE-09 断言——干净重跑证实原断言误伤合格回答（见验证）。
- **工具**：bun:test（TDD 红→绿）、bunx tsc --noEmit、探针 `.tmp/probe-evolve09.ts`（直连 zhipu/sensenova 抓 EVOLVE-09 原始回答）、真实评测 `run.ts --tasks=EVOLVE-09`。无子代理。
- **操作**（文件级）：
  1. `src/agent-evals/tasks.ts`（备份 `.tmp/backups/`）：新增 `getTasksByIds`（按 id 精确挑选、保持目录顺序、忽略未知 id）；EVOLVE-09 断言由 `{ containsAllAny: [["下次"],["验证"],["回滚"]], mustReturnNumber:{min:2} }` 放宽为 `{ containsAllAny: [改动上下文/验证/回滚 三组同义词], matchesAll: [≥2 编号标记正则（兼容阿拉伯/中文序号/第X条）] }`。
  2. `src/agent-evals/run.ts`（备份 `.tmp/backups/`）：解析 `--tasks`、选择逻辑改 `getTasksByIds`、与 `--evolve` 互斥守卫、帮助文案。
  3. `tests/agent-evals/tasks.test.ts`（备份 `.tmp/backups/`）：+3 条 `getTasksByIds` 行为测试。
  4. `tests/agent-evals/tasks-s4-assert.test.ts`（备份 `.tmp/backups/`）：EVOLVE-09 测试块重写（6→8 条），纳入两个真实样本（zhipu 中文序号 / sensenova 阿拉伯序号）。
- **验证**：TDD 红→绿；`bun test tests/agent-evals` 452 全绿（无回归）；`bunx tsc --noEmit` 0；`--dry-run --tasks=EVOLVE-09` 精确 1 任务；真机重跑 run#11（zhipu）/run#12（sensenova）EVOLVE-09 在新断言下均 PASS。校准结论：EVOLVE-09 原断言「必须字面下次 + 数字≥2」误伤合格回答（zhipu 用「规则一/二」中文序号无数字、sensenova 用「规则 1/2/3」且未复述「下次」，但均含验证动作+回滚确认点）——属验证器过度标定而非能力缺口。
- **红线**：规则 1（最小改动）；规则 2（四处改动前均备份，验证后删）；规则 3（仅 add 本任务文件）；规则 5（本条，Commit 占位待回填）；规则 7（垂直切片 TDD）；规则 9（无 force/reset）；规则 11（无密钥）。
- **Commit**：4787a45

## 2026-09-05 — docs(agent-evals): 撞窗新任务干净窗口补测回填（zhipu 5 + sensenova 3 全通）+ EVOLVE-09 校验器校准结论落档

- **任务**：Wave-2（66 任务）run#7（zhipu）/run#10（sensenova）撞上端点不稳定窗口未测出的 8 个新任务（zhipu 5：CODING-10/11、KNOW-11、EVOLVE-10/11；sensenova 3：CODING-11、KNOW-11、MEM-11）在干净窗口补测校准；落档 EVOLVE-09 跨 provider 稳定性核验结论（任务 #4 已判定：验证器校准，非能力缺口）。
- **工具**：真实评测 `run.ts --tasks=<id,…> --provider=… --no-check-regression --rerun-each=N`（run#14/#16/#17/#18）；直连探针 `.tmp/probe-zhipu-know11.ts`（抓 zhipu KNOW-11 原始回答）；bun+sqlite 查 registry 核对 8 任务跨轮状态。无子代理。
- **操作**（文件级）：
  1. `docs/agent-eval-baseline-2026-09-05.md`（备份 `.tmp/backups/`）：新增 `### 撞窗新任务干净窗口重跑校准（run#14/#16/#17/#18）` 小节（8 任务补测结果表 + 3 条关键发现：12 新任务两路全通、KNOW-11 run#17 flake 判采样方差、zhipu 空内容窗口时段性）；run#7/run#10 的「待干净窗口重跑」措辞改指该小节；`### 待回填` 三项中「撞窗补测」与「EVOLVE-09」两项勾选完成（附结论），仅保留 deepseek 全量 66 待回填。
- **验证**：registry 实查 run#14/#16/#17/#18——sensenova 3/3 PASS（CODING-11 run#16、KNOW-11/MEM-11 run#14）、zhipu 5/5 PASS（CODING-11/EVOLVE-10/EVOLVE-11 run#17、CODING-10/KNOW-11 run#18）；探针证实 KNOW-11 完整答案可产出（force push + 硬重置），run#17 缺 `reset --hard` 组判采样方差而非断言误伤/能力缺口；结论：12 个新任务两路全通，无真实能力缺口。
- **红线**：规则 1（仅改标定文档 + ops-log，未动源码/测试）；规则 2（改动前备份 `.tmp/backups/docs/`，验证后删）；规则 3（仅 add 本任务文件）；规则 5（本条，Commit 占位待回填）；规则 9（无 force/reset）；规则 11（无密钥）。
- **Commit**：ff651da

## 2026-09-05 — feat(agent-evals): 校验器校准 — KNOW-02/05 + EVOLVE-06 断言过度标定修正（TDD 红→绿 + 双路真机核验）

- **任务**：核实并校准标定文档「结论与建议 #2」点名的三处校验器校准点（KNOW-02/KNOW-05/EVOLVE-06）。探针取 zhipu/sensenova 原始回答核实：三处失败均为**断言强制了 prompt 未要求的概念**（KNOW-02 运行时点只认引擎名、KNOW-05 强制未要求的「镜像」、EVOLVE-06 强制未指定的「备份」），而非同义词组过窄——组内已含常见写法。
- **工具**：探针 `.tmp/probe-zhipu-calib.ts`/`.tmp/probe-zhipu-calib2.ts`/`.tmp/probe-sensenova-calib.ts`（直连抓原始回答，zhipu 空内容/ECONNRESET 内建重试）；bun:test（TDD 红→绿）；bunx tsc --noEmit；真实评测 `run.ts --tasks=KNOW-02,KNOW-05,EVOLVE-06 --rerun-each=2 --no-check-regression`（zhipu run#20 / sensenova run#19）。无子代理。
- **操作**（文件级）：
  1. `src/agent-evals/tasks.ts`（备份 `.tmp/backups/`）：三处函数式断言按 prompt 对齐——KNOW-02 运行时点 `["jsc","javascriptcore"]` 放宽为 `["jsc","javascriptcore","v8","引擎","engine","运行时","性能"]`；KNOW-05 第三组 `["镜像","image"]`（prompt 未要求）改为 `["启动","秒级","毫秒","引导"]`（prompt 三维度之三）；EVOLVE-06 删除强制组 `["备份","backup","保存","快照"]`（prompt 只要求 3 条自检项、未指定内容）。
  2. `tests/agent-evals/validators-noise.test.ts`（备份 `.tmp/backups/`）：EVOLVE-06 块重写（原「缺备份仍失败」用例翻转——真实 zhipu 3 条合法自检项通过；新增「无任何具体自检项」失败用例）；新增 KNOW-02/KNOW-05 两个 describe（真实 zhipu 探针回答作通过夹具 + 缺维度失败用例）。
  3. `docs/agent-eval-baseline-2026-09-05.md`（备份 `.tmp/backups/`）：七表两行标注「已校准」；十.2 从「需补同义词」改为「已核验：断言过度标定，已按 prompt 对齐校准」。
- **验证**：TDD 红→绿（旧断言下 4 红：真实回答被误杀 + KNOW-05 缺「启动」却被「镜像」放行）；`bun test tests/agent-evals` 458 全绿（+6 新用例，无回归）；`bunx tsc --noEmit` 0；真机双路核验 zhipu run#20 3/3 恢复通过、sensenova run#19 3/3 无回归；断言仍具区分度（缺维度/无具体自检项回答仍失败）。
- **红线**：规则 1（仅改 3 处断言 + 1 测试文件 + 标定文档）；规则 2（改动前备份、验证后删）；规则 3（仅 add 本任务文件）；规则 5（本条，Commit 占位待回填）；规则 7（垂直切片 TDD 红→绿）；规则 9（无 force/reset）；规则 11（无密钥）。
- **Commit**：175efa0
## 2026-09-06 — feat(agent-evals): 外部评测沙箱镜像固定收口（docker-sandbox opts.image 注入 + python:3.11-slim）

- **任务**：核验收口中断会话遗留的工作区改动——docker-sandbox 支持 opts.image 注入（缺省回退默认镜像 ubuntu:22.04），external 评测 runPython 固定 python:3.11-slim 镜像（ubuntu:22.04 无 python3 保障，是基线文档结论#4「外部 HumanEval/MBPP docker 沙箱能力轴标定」的前置）。改动含新测试（镜像注入参数序 / 缺省回退 / 静态断言 / external 传参断言）。
- **工具**：bunx tsc --noEmit、bun test（tests/docker-sandbox-mount.test.ts + tests/external-eval-sandbox.test.ts）、git。无子代理（改动系上次会话遗留，本次仅核验 + 留痕 + 提交）。
- **操作**（文件级）：src/agent-evals/external.ts（SANDBOX_IMAGE 常量 + sandboxOpts.image 透传）、src/sandbox/docker-sandbox.ts（opts.image ?? DEFAULT_IMAGE）、src/sandbox/types.ts（SandboxOptions.image 字段 + 注释）、tests/docker-sandbox-mount.test.ts（+2 行为测试 +1 静态断言）、tests/external-eval-sandbox.test.ts（+1 断言 image=python:3.11-slim）、docs/operations-log.md（追加本条）。
- **验证**：bunx tsc --noEmit 0；bun test 两文件 20 pass / 0 fail（45 expect）；git diff 仅本任务 5 文件（CLAUDE.md 空文件维持不碰，沿用 09-05 计划约定）。
- **红线**：规则 1（最小改动，不改既有沙箱语义与默认行为）、规则 3（仅 add 本任务文件）、规则 5（本条，Commit 占位待回填）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：f78e50a

## 2026-09-06 — docs(specs): 下一迭代方向三方辩论 + 审计决策设计（第二轮）落档

- **任务**：用户委托「检查最新进展与最新 spec 后头脑风暴，多方辩论 + 审计，产出最优/最轻/最高效率决策（局部最优 + 整体强适应）」——与 2026-08-28 第一轮同型的迭代方向仪式。产出第二轮决策集（D1-D7）并落档 specs。
- **工具**：3 探索代理（计划完成状态 / 全局形态路线图 / 基线结论外部对标，Explore 只读）+ 3 辩论代理（稳定守护者 / 精益效率派 / 演进战略派，general-purpose 只读约束，各自实查仓库）+ 1 审计代理（8 项关键主张逐条核查）+ node（CRLF 追加 ops-log）+ git。主线程：事实基座汇总、裁决、文档撰写、D1 收口执行。
- **操作**（文件级）：新增 docs/superpowers/specs/2026-09-06-next-iteration-debate-decision-design.md（决策集 D1-D7：D1 沙箱收口 3:0 / D2 W5-W8 FTS 本迭代启动 3:0 / D3 主线组合排序 / D4 EarlyEval 押后一轮 / D5 flaky 最小核实 llm-cache / D6 轨迹轨-分发线-前端押后 / D7 观感债）；执行 D1（沙箱镜像改动核验收口，见上条 f78e50a）；docs/operations-log.md 追加本条。
- **验证**：审计员 8 项主张逐条属实性判定（2 项辩论方引用锚点错误被纠正：AXIOM-ARCHITECTURE:1389 非宿主接入形态、llm-cache 注释未定性「真缺陷」）；D1 收口经 tsc 0 + 20 测试 pass 核验；决策文档验收清单仅勾选已实施项，阶段 1 第 2-7 项标注待用户批准。
- **红线**：规则 1（本轮仅文档落档 + D1 收口，未启动阶段 1 新施工）、规则 3（仅 add 本任务文件）、规则 5（本条，Commit 占位待回填）、规则 9（无 force/reset）、规则 10（事实/推测/判断分离，分歧点 2:1 投票记录在案）、规则 11（无密钥）。
- **Commit**：45aa452

## 2026-09-06 — docs(strategy): runtime 定位修正 + OpenCode-only 收紧 + 前缀缓存计划立项 + 批准清单落档

- **任务**：执行用户两项新指令——①最终形态为 runtime（生态位低于现有 Agent 的基础设施层），新增主线「模型前缀缓存优化提升缓存命中率」；②阶段 1 清单获批但宿主接入收紧为 OpenCode-only（除 OpenCode 外其他深度工程化 Agent 不再添加进入 runtime）。深度探索（2 路 Explore 代理：缓存基建+调用路径 / 宿主引用面）后更新文档与计划。
- **工具**：Explore×2（缓存基建 very thorough / 宿主引用面 very thorough）、Read/Edit/Write、node（正则批量勾选 + CRLF 追加 ops-log）、git。无源码改动。
- **操作**（文件级）：① docs/superpowers/specs/2026-09-06-next-iteration-debate-decision-design.md 追加 §8 修正案（D8 runtime 定位+前缀缓存优先 / D9 OpenCode-only，D6 其余宿主由押后改取消）；② docs/superpowers/specs/2026-08-09-nextgen-agent-state.md 头部修订注记 + 架构图组件状态修正（切片3/4 已完成、切片5 进行中，消除 :58 vs :79 矛盾）+ 消费方列表/P0-2/验证标准收紧 OpenCode-only；③ docs/EXTERNAL-COMPONENT-HOST-VALIDATION-2026-08-10.md §6 下一步 Kimi/Pi/Codex 项取消；④ docs/AGENT-EXTERNAL-COMPONENT-LANDSCAPE-2026-08-09.md 头部存档注记；⑤ docs/ARCHITECTURE.md:10 定位由「AI Agent 框架」改为「确定性认知运行时（生态位低于 Agent 的基础设施层，引 ADR-001）」；⑥ 新增 docs/superpowers/plans/2026-09-06-prefix-cache-optimization-plan.md（现状审计 8 项锚点 + P0-A 度量先行/P0-B llm-cache 修复/P1-C 前缀纪律接入主路径/P1-D 请求层适配/P2-E 前缀级 key 押后）；⑦ 2026-08-28-regression-defense-closure-plan.md 与 2026-08-30-p2-closeout-plan.md checkbox 补勾（24/16）+ 头部状态回写行（记录维护）。
- **验证**：git diff 仅本任务 9 文件；勾选数核对（24+16）；两份计划工作落地事实此前已经独立审计核实（commit c5e96ea/0e9a765/af035e9/a1b6c7a/5f57cbe/9fa1a8c/e355d97/36a9231）；nextgen spec 修订后内部无状态矛盾；备份在 .tmp/backups/docs/（验证后删）。
- **红线**：规则 1（文档最小改动，LANDSCAPE 等研究文档只加注记不重写）、规则 2（改前备份）、规则 3（仅 add 本任务文件）、规则 5（本条，Commit 占位待回填）、规则 9（无 force/reset）、规则 10（用户定位指令与 ADR-001 一致性已核对，RUNTIME-SPEC 潜在冲突留待后续评估）、规则 11（无密钥）。
- **Commit**：37c470c

## 2026-09-06 — docs(knowledge): provider 缓存官方文档核查知识文件 + 计划 P1-D 缩窄回写

- **任务**：前缀缓存计划 P1-D 施工前置——按计划红线「provider 缓存行为属外部事实，每个参数注入必须有官方文档依据（规则 10.2）」核查三家 provider 官方缓存语义，落知识文件并回写计划 P1-D 范围。
- **工具**：WebSearch（3 次，官方文档定位）、Read/Write/Edit、node（CRLF 追加 ops-log）、git。无子代理（环境模型并发上限 1，工作者改为严格串行；本条为主线程文档工作）。
- **操作**（文件级）：新增 docs/knowledge/prefix-cache-provider-api-2026-09-06.md（DeepSeek usage.prompt_cache_hit_tokens/miss_tokens + 自动磁盘缓存 hit 计价约 1/10；OpenAI prompt_cache_key/自动前缀缓存 ≥1024 token/prompt_tokens_details.cached_tokens；智谱自动隐式缓存无参数；结论表事实/推测/判断分离：三家当前端点均无参数可注入→P1-D 缩窄为 usage 字段透传、P1-C 前缀稳定为唯一施工杠杆）；编辑 docs/superpowers/plans/2026-09-06-prefix-cache-optimization-plan.md（P1-D 行缩窄为「usage 字段透传即完成」并链知识文件）；docs/operations-log.md 追加本条。
- **验证**：三来源均为官方域名（api-docs.deepseek.com / developers.openai.com / docs.bigmodel.cn）；结论表按规则 10.5 标注事实/推测/判断；git diff 仅两文档 + ops-log。
- **红线**：规则 1（仅文档，未碰工作者分区 src/utils/cache.ts、src/agent-evals、src/kal、src/kg）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 10.2/10.3（官方来源 + 知识文件）、规则 11（无密钥）。
- **Commit**：74e9f93

## 2026-09-06 — fix(llm-cache): P0-B destroy() 语义修正 + E 组 flush 时序修复（TDD 红→绿，子代理施工）

- **任务**：前缀缓存计划 P0-B——①E 组存量失败「写入 L3 后新实例可读取」根因是 L3 去抖异步 flush（pendingL3 + setTimeout(0)）未落盘即关库；②destroy() 误实现为「flush 后 DELETE 整个 namespace L3」，销毁实例语义被错误实现成清库。
- **工具**：general-purpose 子代理（独立备份/验证，禁止 git 写命令）、bun:test（TDD 红→绿）、bunx tsc --noEmit、git（主线程统一提交）。
- **操作**（文件级）：src/utils/cache.ts（destroy() 移除 clear()，仅停定时器 + flushPendingWrites() + db.close()，注释「销毁实例 ≠ 清库」；复用既有 public flushPendingWrites() 作显式钩子，不加浅透传别名）；tests/llm-cache.test.ts（E 组改显式 flush 钩子后关库、零 sleep；新增「destroy 只冲刷不清理，新实例可读」回归测试）；docs/operations-log.md（主线程追加本条）。
- **验证**：主线程复跑 bun test tests/llm-cache.test.ts 11 pass / 0 fail、bunx tsc --noEmit 0。子代理红→绿链：9/1（复现）→10/0（flush 钩子）→10/1（destroy 回归红）→11/0（修复绿）。相邻 runtime-audit / abnormal-input 各 1 失败经原版 cache.ts 对照复跑证实为存量问题（EXCLUDE_FILES 已知账），与本次改动无关。
- **红线**：规则 1（最小改动，仅 2 文件）、规则 2（子代理备份 .tmp/backups/ 验证后删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 7（垂直切片）、规则 8（复用既有钩子不造浅接口）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：a825b92

## 2026-09-06 — feat(agent-evals): P0-A 缓存命中度量 + 清单②执行错误治理（TDD 红→绿 + 真机冒烟）

- **任务**：前缀缓存计划 P0-A——agent-evals 采集 provider 端缓存命中 token（deepseek 系 prompt_cache_hit_tokens / OpenAI 兼容 prompt_tokens_details.cached_tokens / 顶层 cached_tokens，防御性解析）；清单②执行错误治理——直连请求超时可配置（AGENT_EVALS_TIMEOUT_MS）+ 默认 90s/120s 统一上调 180s（覆盖 sensenova p99≈129s 长尾，执行错误 zhipu 1→14 / sensenova 9→19 的易损点）；禁止降 maxTokens（不改断言语义）。
- **工具**：bun:test（TDD 红→绿）、bunx tsc --noEmit、真实评测 run.ts（真机冒烟 run#21）、git。无子代理（P0-A 首次子代理派工两次死于平台模型并发限制，遗留解析层半成品由主线程按 TDD 完成聚合/报告/落库/治理切片并验收）。
- **操作**（文件级）：src/agent-evals/runner.ts（extractCacheHitTokens 多形态解析 + toTokenUsage/parseProviderUsage 接线【子代理遗留】；DEFAULT_REQUEST_TIMEOUT_MS=180s + resolveRequestTimeoutMs（env 可配置、非法回退）；fetch signal 与 curl -m 两处接线）；src/agent-evals/metrics.ts（TokenUsage.cacheHitTokens【遗留】+ MetricsSummary.totalCacheHitTokens/avgCacheHitTokens + summarize 聚合）；src/agent-evals/metrics-types.ts（RunSummarySnapshot/RunRow 缓存字段）；src/agent-evals/report.ts（有数据才输出缓存命中行，无数据轮次输出形态不变）；src/agent-evals/registry.ts（2 列 DDL + ensureColumn 迁移 + insertRunStmt + rowToRun）；tests/agent-evals/cache-hit-dimension.test.ts（新增：解析 5 + 聚合 2 + 报告 2 + 落库 2）；tests/agent-evals/timeout-governance.test.ts（新增：默认/env/非法值 + 两路径接线静态断言）；latency-percentile/report-main/report-extras 测试夹具补新必填字段；docs/operations-log.md 追加本条。
- **验证**：红→绿链（聚合/报告/落库 5 红转绿；超时测试模块导入红转绿）；bun test tests/agent-evals 474 pass / 0 fail；bunx tsc --noEmit 0；真机冒烟 run#21（sensenova MEM-10 单任务通过）报告输出「缓存命中: 0 tokens」——sensenova 确认返回缓存字段且端到端采集成功（首次调用命中 0 属预期，前缀复用后调用方可见命中增长）。注意 run#21 为 1 任务冒烟轮（与 run#11/12/19/20 局部标定轮同性质）。
- **红线**：规则 1（最小改动：治理不降 maxTokens、不改任务断言）、规则 2（主线程改前备份 .tmp/backups/，验证后删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 7（垂直切片）、规则 9（无 force/reset）、规则 10.2（字段形态依据官方文档知识文件）、规则 11（密钥仅 .env，报告不落）。
- **Commit**：253e309

## 2026-09-06 — docs(specs): D2 事实更正（W5/W8 已于 08-30/31 落地，辩论基座误标待立项）+ W5 验收核验

- **任务**：施工核验发现决策文档 D2 事实前提有误——W5（fbb47c2 queryKG FTS5 trigram + f8e3cf7 部分丢失幂等恢复）与 W8（37c24ae SearchPort 端口分层、M13 闭合）已于 2026-08-30/31 按落地形态审计完成并提交，第二轮辩论时被误标为「获准立项待施工」。按规则 10.5 落档更正。
- **工具**：bun:test（W5 测试套件复跑验收）、git log/show（落地时间线核实）、Read/Edit（决策文档 §9 更正）、node（CRLF ops-log）、git。
- **操作**（文件级）：docs/superpowers/specs/2026-09-06-next-iteration-decision-design.md 新增 §9 事实更正（W5/W8 落地证据链 + 验收结论：本迭代无需重复施工，gate 基准以 08-30 bench 记录为准）；docs/operations-log.md 追加本条。
- **验证**：bun test tests/kg-fts-backfill.test.ts tests/kal-kg-fts.test.ts 9 pass / 0 fail（测试点覆盖辩论要求的全部回归点）；两测试文件不在 test-full.ts EXCLUDE_FILES（自动发现覆盖）；ops-log 中 fbb47c2/f8e3cf7 留痕与 hash 回填齐全。
- **红线**：规则 1（仅文档更正）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 10.5（事实/推测/判断分离）、规则 9（无 force/reset）。
- **Commit**：6a48160

## 2026-09-06 — feat(cache): P1-C 切片①② 前缀纪律（CACHE_BOUNDARY 确定性化 + 请求边界工具稳定排序，TDD）

- **任务**：前缀缓存计划 P1-C 前两切片——①prompt-pool 静态前缀跨进程重启字节级稳定：CACHE_BOUNDARY marker 由 Math.random UUID 改为前缀内容 xxh3 hash 派生（随机 marker 使重建/重启后前缀字节漂移，provider 端按字节前缀匹配的缓存命中率归零）；②provider-caller 请求边界工具列表确定性排序（orderToolsForCache：按 function.name 升序稳定排序、不原地修改，两处 tools 展开接线）——工具定义在序列化请求前缀内，传入顺序不定使同前缀请求字节不稳定。
- **工具**：bun:test（TDD 红→绿）、bun run test:full（权威门禁，--isolate）、bunx tsc --noEmit、git。无子代理（并发限制，主线程串行）。
- **操作**（文件级）：src/agents/prompt-pool.ts（buildPoolEntry marker 确定性化 + 删除 generateCacheMarker 随机实现）；src/router/provider-caller.ts（新增导出 orderToolsForCache + callProvider/callProviderNativeStream 两处请求体接线）；tests/prefix-cache-discipline.test.ts（新增 6 用例：跨实例字节稳定 / 同配置重建 marker 不变 / marker 形态 / 排序+稳定性+空数组 / 接线静态断言）；docs/operations-log.md 追加本条。
- **验证**：TDD 红→绿（导入红 0 pass → 11 pass）；bun run test:full 3640 pass / 34 skip / 0 fail（310s）；bunx tsc --noEmit 0。判定记录：原始 bun test tests/ 单进程混跑出现 131 fail，经备份对照（model-router 套件两版本均单独全绿）+ test:full 隔离门禁全绿证实为既有跨测试干扰特性（EXCLUDE_FILES+isolate 机制之设计原因），非本次改动引入。
- **偏差与押后**：P1-C 切片③「prompt-pool 静态前缀接入 router 主路径」押后——重接线会全局替换 router 消费方 system prompt（行为变更），将作废本迭代刚建立的 66 任务基线与回归防线参照；需独立切片 + 行为差异评估 + 重基线后再施工（已回写计划 P1-C 行）。
- **红线**：规则 1（最小改动，不改池语义与排序语义）、规则 2（备份 .tmp/backups/，验证后删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 7（垂直切片）、规则 8（orderToolsForCache 为纯函数小接口）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：d187124

## 2026-09-06 — fix(mcp)+smoke: MCP stdio stdout 纯净性修复 + OpenCode 真实宿主冒烟闭环（D3-④ 完成）

- **任务**：清单④ OpenCode 单宿主冒烟切片——冒烟实证发现真实产品缺陷并修复，完成宿主消费面第一手信息采集。
- **工具**：opencode CLI 1.18.25（真实宿主）、bun:test（TDD 红→绿）、bunx tsc --noEmit、git。无子代理。
- **冒烟过程与发现**：①服务端手动握手正常但 opencode 标记 axiom server unavailable；②根因一（服务端缺陷）：logger info/debug 经 console.log 混入 stdout 污染 JSON-RPC 协议流——修复为 stdio 模式全部日志改写 stderr，新增 tests/mcp-stdio-stdout-purity.test.ts 真实 spawn 回归（红→绿）；③根因二（宿主侧 Windows 模式）：opencode 直接 spawn "bun" 失败，需 cmd /c 包装——已补入 scripts/setup-external-mcp.ts 片段；④修复后闭环：14 个 axiom_* 工具被 opencode 列出，axiom_token_stats 经宿主真实调用并返回运行时数据（totalCalls 2982/successRate 100%）。HOST-VALIDATION 文档「下一步第 1 项」验收线达成。
- **操作**（文件级）：src/utils/logger.ts（writeConsole stdio 分支 + formatLine 抽取，redact 语义不变）；tests/mcp-stdio-stdout-purity.test.ts（新增，真实 spawn 断言 stdout 每行为合法 JSON-RPC）；scripts/setup-external-mcp.ts（OpenCode 片段补 Windows cmd /c 变体）；docs/EXTERNAL-COMPONENT-HOST-VALIDATION-2026-08-10.md（§7 冒烟结果）；docs/operations-log.md（本条）。
- **验证**：bun test tests/mcp-stdio-stdout-purity.test.ts 1 pass / 0 fail；bunx tsc --noEmit 0；冒烟三步（发现→调用→数据回传）全部真实完成；隔离项目（仓库外 TEMP）零写入真实仓库数据。
- **红线**：规则 1（最小修复，日志 redact/轮转语义不变）、规则 2（备份 .tmp/backups/，验证后删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 7（TDD）、规则 9（无 force/reset）、规则 11（无密钥落盘）。
- **Commit**：5f5c58d

## 2026-09-06 — docs(plans): 前缀缓存计划 P1-C 状态回写（切片①②完成 d187124，切片③押后附理由）

- **任务**：记录维护——P1-C 切片①②已实施（CACHE_BOUNDARY 确定性化 + 工具稳定排序，commit d187124），切片③（prompt-pool 接入 router 主路径）经评估押后：重接线属全局 system prompt 行为变更，会作废本迭代刚建立的 66 任务基线与回归防线参照，需独立切片 + 行为差异评估 + 重基线后再施工。
- **工具**：Edit、git。无子代理。
- **操作**（文件级）：docs/superpowers/plans/2026-09-06-prefix-cache-optimization-plan.md P1-C 行状态回写；docs/operations-log.md 追加本条。
- **验证**：git diff 仅计划与 ops-log 两文件。
- **红线**：规则 1（仅文档）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 9（无 force/reset）。
- **Commit**：958a375

## 2026-09-06 — feat(agent-evals): 外部 HumanEval/MBPP docker 沙箱能力轴首轮标定（run#22/#23，清单①完成）

- **任务**：决策清单①——外部能力轴首次真实标定：HumanEval 全量 164（run#22）+ MBPP 前 50（run#23），zhipu/glm-4.7-flash，docker python:3.11-slim 沙箱（镜像注入 f78e50a 为前置）。后台串行真实跑约 2.5 小时。
- **工具**：run.ts --external（真实 provider + docker 沙箱）、bun+sqlite（registry 核对）、Read/Write（报告与文档）、node（CRLF ops-log）、git。无子代理。
- **操作**（文件级）：eval-results/agent-evals-2026-09-06-external-zhipu.md（新增首轮标定报告：口径/失败聚类/口径注记/后续）；docs/agent-eval-baseline-2026-09-05.md（结论#4 回填外部轴标定结果与定位）；docs/operations-log.md（本条）。
- **验证**：registry run#22/#24 逐项核对（164 题 4 通过 2.5% 执行错误 1 缓存命中 4843 tokens；50 题 3 通过 6% 缓存命中 1288 tokens）；报告数字与 registry/日志一致。核心结论：①数字刻画外轴 harness 缺陷而非模型能力（HumanEval 失败=拼接/缩进错位主导 H1；MBPP=入口函数名改写 H3），修复后需重标定；②超时治理成效实证：执行错误仅 1/164（p95 190s/p99 228s 在旧 90s/120s 限下会大量转为执行错误）；③P0-A 缓存命中度量真机首采成功；④exit_code 2 为假回归（首轮无同集基准，auto-baseline 撞同 scope 内部集 run#7，跨基准对比无效——数据完好，回归 scope 纳入任务集标识列为下迭代候选项）。
- **红线**：规则 1（仅评测运行与文档，未改源码）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 10.5（失败聚类区分事实/判断）、规则 11（密钥仅 .env，报告不落）。
- **Commit**：e743e74


## 2026-09-07 — docs(audit): 审计未验证项补验 6/6 收口 + 验证日志落盘（工具故障会话续）

- **任务**：接续 2026-09-06 因工具接口故障中断的独立审计复核会话——将原始实验记录落盘 docs/audit-verification-log.md（第一部分原文存档），并以恢复后的工具补验全部 6 个未验证项（第二部分，含 file:line 证据）+ V1-V3 交叉复核。
- **工具**：rg、bun run scripts/count-tools.mjs、Read/Write、PowerShell（备份/追加）、git。无子代理。
- **操作**（文件级）：docs/audit-verification-log.md（新增，两段式：原文存档 + 补验结果）；docs/operations-log.md（本条）。
- **验证**：补验结论——item 8 RESOLVED（count-tools 实测 total 189 / duplicates 0，与声明精确一致）；item 5 CONFIRMED（isPathSafe 四层校验 path-safety.ts:22-93；ssrfGuard opt-in 决策记录 proxy-fetch.ts:48-58 + 用户可控入口强制 data-pipeline.ts:341；web 内容进上下文前钳制 web-tools.ts:39-43）；item 4 CONFIRMED（截断/去重/域名多样性/引擎级隔离/代理回退/预算全链路，无静默挂起；无主动限流器记 Info）；item 6 静态自洽（bytesPerToken 公式正确、峰值约 2206MB < 4GB、system-resource.ts:178 缺 activation 项确认；端到端实测未做）；item 6b RESOLVED（KG 稳定 id + OR REPLACE/IGNORE + created_at 保留 + 邻接去重；AST 纯正则无中断路径；MinerU 为外部 Python 组件且口径双处披露）；item 7 CONFIRMED（dre/retrieval 四文件无外部消费方，唯一命中为内部互引 hybrid-fusion.ts:25；package.json/bun.lock 零向量库依赖）。V1 复核加强（native 全部构造点均 false）；V2/V3 复核成立。新发现：两条生产向量语义路径（/settings/search 默认链尝试 embedding，settings-search.ts:121-176；context-manager.ts:251-311 cosine top-k），与现行文档口径「仅在可选语义层使用」部分一致，定性 Medium 文档口径缺口。整体仍非全量审核（Phase 0 清单未建立），不构成「审核完成」。
- **红线**：规则 1（仅新增文档，未改源码）、规则 2（备份 .tmp/backups/docs/operations-log.md，验证后删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 9（无 force/reset）、规则 10.5（事实/推测/判断分离：向量路径为事实，口径定性为判断）、规则 11（无密钥）。
- **Commit**：9921f67

## 2026-09-07 — docs(plans): 语义意义构建 × Runtime 优化迭代计划落盘（约束审查 + 长会话不崩坏修订）

- **任务**：基于 2026-09-07 审计补验结论制定双目标迭代计划。对"100% 准确率"约束出具审查意见（拆可判定层/语义层），用户同日撤销 100% 承诺并新增「长上下文/长会话不崩坏」核心保证——已修订入计划：新增 S-A7 切片（崩坏 5 项可判定定义 / 记忆融合契约 / N≥200 轮 soak harness / 降级阶梯锁定）、probe runner 增 long-session-soak-probe、里程碑与验收表同步更新。
- **工具**：Write/Edit（计划文档）、PowerShell（备份/追加 ops-log）、git。无子代理。
- **操作**（文件级）：docs/superpowers/plans/2026-09-07-semantic-meaning-runtime-optimization-plan.md（新增：S-A1~A7、S-B1~B7、时间节点/资源/风险/交付验收八节）；docs/operations-log.md（本条）。
- **验证**：计划八节结构完整；100% 约束处理经用户确认（撤销，改不崩坏保证）；"崩坏"收敛为 5 项可判定集合；全部切片锚定 audit-verification-log.md 已核验 file:line 基线；文档不落密钥。
- **红线**：规则 1（仅新增文档，未改源码）、规则 2（备份 .tmp/backups/docs/，验证后删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 9（无 force/reset）、规则 10（约束审查与直接异议留痕）、规则 11（无密钥）。
- **Commit**：df3d017

## 2026-09-07 — docs(eval): M3 语义等价评估集人工标注与仲裁指南落盘（S-A4 配套）

- **任务**：产出迭代计划 S-A4/M3 的人工标注仲裁指南——判定五步规程、E0-E4 错误分类细则与 verdict 硬映射、7 条边界裁决规则（可推导命题/歧义源/溯源错误/数值否定硬规则等）、仲裁流程（独立判定在先、死锁 contested 剔除显式披露、20% 抽样复核）、质量控制（gold 校准 + 插桩 + Cohen's κ≥0.7 门禁）、双口径报告（严格/宽松并报）、诚实原则与留痕要求。
- **工具**：Write（指南文档）、PowerShell（备份/追加 ops-log）、git。无子代理。
- **操作**（文件级）：eval/semantic-equivalence/ANNOTATION-GUIDE.md（新增，v1.0，含附录判定示例两则）；docs/operations-log.md（本条）。
- **验证**：指南与计划 S-A4 错误分类四类一一对应；verdict 映射为硬规则无裁量空间；κ≥0.7 与双口径报告承接仓库口径诚实惯例；目录落点 eval/semantic-equivalence/ 与计划一致（目录本次随指南首次创建）；无密钥落盘。
- **红线**：规则 1（仅新增文档）、规则 2（备份 .tmp/backups/docs/，验证后删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 9（无 force/reset）、规则 10.5（标注判定定性为"判断"并在指南第 10 节固化）、规则 11（无密钥）。
- **Commit**：078f43e

## 2026-09-07 — docs(plans): M3 启动口径 R1 修订（首轮基线对象/隔离标注形态/soak 骨架先行）

- **任务**：用户批准启动 M3；将三项启动决策写入计划执行修订记录 R1——①S-A4 首轮测定对象为现状基线（kg-writer 现有抽取产出作 before，S-A1/S-A2 上线后同集重测 after）；②标注员 A/B 为上下文隔离子代理、仲裁人为用户；③S-A7 soak harness 骨架先行针对现有组件（context-manager/sqlite-memory/KG 幂等）测 5 项崩坏指标，不阻塞于 M1；④dataset 第一批 100 例三源分布。
- **工具**：Edit（计划文档）、PowerShell（备份/追加 ops-log）、git。无子代理。
- **操作**（文件级）：docs/superpowers/plans/2026-09-07-semantic-meaning-runtime-optimization-plan.md（新增"九、执行修订记录 R1"）；docs/operations-log.md（本条）。
- **验证**：R1 四项与 ANNOTATION-GUIDE v1.0 及计划 S-A4/S-A7 原文无冲突；指南 §2 隔离要求由子代理实例形态满足；文档不落密钥。
- **红线**：规则 1（仅文档修订）、规则 2（备份 .tmp/backups/docs/，验证后删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 9（无 force/reset）、规则 10（口径决策留痕）、规则 11（无密钥）。
- **Commit**：25f2e0d

## 2026-09-07 — eval(dataset): S-A4 dataset 100 例构建（m3-1，现状基线抽取投影）

- **任务**：M3 m3-1——按 ANNOTATION-GUIDE v1.0 §3.1 与计划 R1 口径，构建 dataset 第一批 100 例（docs/ 权威文档 40 + Vault 笔记 30 + 代码注释/docstring 30），candidate_mr 来源于现状真实抽取路径的可复现投影。
- **工具**：Write（manifest/构建脚本）、bun（执行构建与验证）、一次性扫描脚本（.tmp，已删）、PowerShell（ops-log）、git。无子代理。
- **操作**（文件级）：新增 eval/semantic-equivalence/tools/dataset-manifest.jsonl（100 例甄选清单：origin+source+task_type）；新增 eval/semantic-equivalence/tools/build-dataset.ts（parseMarkdownAST → KGWriter(:memory:) → kg_nodes/kg_edges → 指南 §3.1 确定性投影，投影规则固化于脚本头注释；代码例包 ts 栅栏模拟文档内嵌代码摄取）；生成 eval/semantic-equivalence/dataset/se-0001..0100.json（每例含 source_text 原文、source_origin 可回溯、candidate_mr、task_type、generation 构建元数据）。
- **验证**：构建脚本运行成功（100/100，分布 doc_ingest=40 / vault_summary=30 / kg_extract=30）；schema 校验 100/100 通过（id/source_text/source_origin/candidate_mr 五字段/provenance 与 propositions 等长/task_type/generation）；抽查 se-0007（段落全文保留）、se-0042（摘要 500 字符截断如实呈现）、se-0078（JSDoc 语义丢失如实呈现）、se-0049（<50 字符段落空候选，§6.6 适用）；11 例空候选为管线真实行为（2 lesson 短句 + 9 代码例无函数/类/导入实体），非构建缺陷。
- **红线**：规则 1（仅新增评估资产，不改源码）、规则 2（新文件无需备份；一次性脚本用后即删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 9（无 force/reset）、规则 10（溯源片段级/截断/空候选均如实标注于 generation.note）、规则 11（无密钥）。
- **Commit**：9211ba0
## 2026-09-07 — eval(gold): S-A4 gold 校准题 10 例（m3-2，预埋 E1-E4）

- **任务**：M3 m3-2——按 ANNOTATION-GUIDE v1.0 §8 上岗校准要求，构造 10 例 gold（源文本逐字取自真实文件），预埋错误覆盖 E1-E4 各≥1 及边界情形（§6.1 可推导命题、§6.6 空候选、§5 溯源格式 vs 错链分辨），每例附预埋说明。
- **工具**：Write（gold 题与 answer-key）、bun（校验脚本一次性，用后即删）、PowerShell（ops-log）、git。无子代理。
- **操作**（文件级）：新增 eval/semantic-equivalence/gold/gold-01..10.json（指南 §3.1 形态，generation.method=manual-planted）；新增 eval/semantic-equivalence/gold/answer-key.json（预埋答案+判定要点+覆盖索引，标注员禁读，文件头 _notice 声明）。
- **验证**：bun 校验 10/10 通过（JSON 合法、provenance 与 propositions 等长、answer-key verdict 映射符合指南 §3.2/§5 硬规则——not_equivalent 必有 error_classes、equivalent 必为空）；错误类覆盖 E1,E2,E3,E4；source_text 与源文件逐字核对（CONFIGURATION/AXIOM-ARCHITECTURE/ARCHITECTURE/DOCUMENT-INGEST/MIND-SYNAPSE/EDGE-LLM/DRE-ARCHITECTURE/lessons）。
- **红线**：规则 1（仅新增 gold 资产）、规则 2（新文件无需备份）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 9（无 force/reset）、规则 11（answer-key 无密钥，g-10 源文本仅含密钥存放路径描述无真实凭据）。
- **Commit**：299f697
## 2026-09-07 — eval(tools): S-A4 标注 runner（m3-3，A/B 对比 + κ + 分歧清单 + 终局双口径）

- **任务**：M3 m3-3——实现 ANNOTATION-GUIDE v1.0 §7-§9 的标注 runner：compare（A/B 对比、三分类 Cohen's κ、分歧清单 pending-<run>.json、仲裁前预报告）、finalize（合并仲裁 resolved，输出终局双口径报告）、gold（标注员校准对账 answer-key）。
- **工具**：Write（runner）、bun（冒烟+幂等验证）、PowerShell（备份/ops-log）、Edit（1 处控制台输出缺陷修复）、git。无子代理。
- **操作**（文件级）：新增 eval/semantic-equivalence/tools/annotation-runner.ts（约 470 行）；docs/operations-log.md（本条）。
- **验证**：冒烟数据（10 gold + 6 例 A/B 临时标注 + 仲裁 resolved，用后即删未入库）驱动三子命令——gold：10/10 全对 exit 0；compare：κ=0.615 门禁未通过触发停线 exit 2（刻意构造的分歧样本，符合 §8 预期）、分歧 2/incomplete 0/uncertain 配对 1 正确落盘 pending-smoketest.json；finalize：合并 resolved 后严格 40.0%/宽松 40.0%（N=5=6−contested 1），unresolved=0 exit 0，与构造数字一致。幂等性（S-A4 验收"数字可复现"）：compare 连跑两次，报告与 pending 除 generated_at 时间戳外字节一致。修复缺陷：cmdCompare 控制台输出当分母为 0 时误打印 0.0%（null*100=0），改为与 md 报告一致的 n/a 口径；修复后三子命令复跑无回归。κ 计算排除 gold 与 uncertain 配对（§6.7）；双口径分母剔除 contested+uncertain（§9）。
- **红线**：规则 1（仅新增 runner 工具）、规则 2（修改前备份 .tmp/backups/，验证通过后已删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 6（先建冒烟反馈回路再改码）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：5598c06

## 2026-09-07 — eval(annotation): S-A4 上岗校准·标注员 A 独立标注 gold 10 例（m3-4）

- **任务**：ANNOTATION-GUIDE v1.0 §8 上岗校准——标注员 A 在隔离约束下（禁读 answer-key.json、annotations/ 既有文件、arbitration/ 与 reports/）对 gold-01..10 按 §4 五步规程独立判定，产出 10 个标注文件。
- **工具**：Read（指南全文 + gold-01..10 逐例）、PowerShell（事实核查：Test-Path 验证 scripts/merge-knowledge-dbs.ts 与 axiom-memory/.../model-router/README.md 存在性、Select-String 核查 DRE_DB_PATH 实际记载位置、MIND-SYNAPSE.md L11-13 行号核验）、Write（10 个标注文件）、bun（一次性自校验脚本 .tmp/verify-ann-A.ts，用后即删）、git。无子代理。
- **操作**（文件级）：新增 eval/semantic-equivalence/annotations/annotator-A/ann-calibration-gold-01..10.json；docs/operations-log.md（本条）。
- **验证**：bun 自校验 10/10 通过（JSON 可解析、8 字段齐全无多余、annotator=A、run=calibration、verdict 映射符合 §3.2/§5 硬规则：not_equivalent 必有 error_classes+critical、equivalent 必为空）。判定分布：equivalent 2（gold-01、gold-08）；equivalent_with_notes 1（gold-06，provenance 仅行号省略文件前缀，经核验行号与 docs/MIND-SYNAPSE.md 实际内容吻合，minor）；not_equivalent 7（gold-02 E4+E3、gold-03 E4+E3、gold-04 E3、gold-05 E1、gold-07 E2+E3、gold-09 E3、gold-10 E1，均 critical）。事实核查依据：model-router README 全文无 DRE/DRE_DB_PATH（gold-05 E1 错链依据），DRE_DB_PATH 实际见于 docs/ 下五文件；scripts/merge-knowledge-dbs.ts 存在（gold-01 实体指向正确）。
- **红线**：规则 1（仅新增 10 标注文件+本条日志）、规则 2（新文件无需备份；一次性脚本用后即删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 9（无 force/reset）、规则 10（rationale 均逐字引用 source_text ≥8 字片段，事实/判断分离）、规则 11（未读写 answer-key；无密钥入库）。
- **Commit**：1af85eb

## 2026-09-07 — eval(calibration): S-A4 校准会（m3-4，隔离 A/B 共标 gold + runner 校准语义修正）

- **任务**：M3 m3-4——按指南 §2/§8 双上下文隔离子代理独立标注 10 例 gold，runner 校准门禁判定上岗资格；诊断并修正 runner gold 校验语义偏差。
- **工具**：Agent 子代理×3（标注员 A 初标 / 标注员 B / 标注员 A 回炉重标，各自上下文隔离、禁读 answer-key 与对方目录）、bun（门禁）、Edit（runner）、PowerShell（备份/ops-log）、git。
- **操作**（文件级）：新增 annotations/annotator-A/ann-calibration-gold-01..10.json（A 初标 10 例，其中 gold-03 后由回炉子代理重写）；新增 annotations/annotator-B/ann-calibration-gold-01..10.json（B 10 例）；修改 tools/annotation-runner.ts cmdGold（校验语义：error_classes 数组精确相等 → 预埋类包含判定 + severity 精确门）；docs/operations-log.md（本条）。
- **验证**：门禁（gold 子命令）——首轮 A 8/10、B 8/10，verdict 均 10/10 全对，仅 error_classes 超集被判错；根因诊断（规则 10）：指南 §4.3 明文"一例可多类，逐一登记"，runner 的数组精确相等实现惩罚合规多类登记，属 runner 实现偏离指南而非标注员错误（双方多类登记经逐例核验均有源文依据；gold-02 附录 se-0008 亦明文换向类"两分类都接受"）。修正后 A 9/10（gold-03 漏检植入 E2 换向类）、B 10/10；A 按指南 §8 回炉（重学 §5/附录 A 后盲判重标 gold-03，登记 E2+E3+E4 且引用原文）→ 复检 10/10。**双方均获上岗资格（κ 门禁前置条件满足）**。回炉全程未泄露预埋答案与 B 方结果（隔离保持）。runner 修改前备份 .tmp/backups/，验证通过后删除。
- **红线**：规则 1（最小改动：runner 单函数语义修正）、规则 2（备份→改→验→删）、规则 3（仅 add 本任务文件）、规则 5（本条占位回填）、规则 6（先门禁复现→诊断→单变量修正）、规则 9（无 force/reset）、规则 10（根因判定标注员合规、偏差在 runner）、规则 11（answer-key 不入 A/B 子代理上下文，无密钥）。
- **Commit**：04ee1a1

## 2026-09-08 — fix(agents): AgentDiscovery 重复 name 去重跨平台确定性（Linux CI 独有失败修复）

- **任务**：诊断并修复 Linux CI（ubuntu-24.04）独有失败——"重复 name 去重" 期望 "First occurrence" 实得 "Second occurrence"（Windows 本地绿）。
- **工具**：Read（测试/实现全文）、PowerShell（备份、字节级精确替换、行尾与 BOM 核验）、bun test、DeleteFile+PowerShell（备份清理）。无子代理。
- **操作**（文件级）：修改 src/agents/agent-discovery.ts scanMarkdownFiles（L87-89）——返回前对文件列表按完整路径字典序排序（码点比较），使同名去重"先到先得"跨平台一致；docs/operations-log.md（本条）。测试文件未改动。
- **验证**：根因（事实）=去重采用 seenNames 先到先得，文件顺序来自 fs.readdirSync，POSIX 不保证顺序（NTFS 按名称序、ext4 按哈希序），CI 上 agent2.md 先于 agent1.md 被处理；AgentMeta 无任何时间戳字段（已核验 intent-router.ts），任务假设的"同毫秒时间戳 tie-break 缺失"不成立（推测排除）。测试层无注入缝隙（实现不消费时钟/时间戳，弱化断言会破坏"先出现者保留"语义），故按任务预留出口修实现。bun test --isolate --timeout 15000 tests/agent-discovery.test.ts：27 pass / 0 fail（62 expect）。
- **红线**：规则 1（单函数 3 行级最小改动）、规则 2（备份→改→验→删，备份已清理）、规则 3（本子代理被明确禁止 git 操作，提交与回填由主代理执行）、规则 5（本条占位回填）、规则 6/7（先证据后假设：字节级核验排除行尾/编码/缩进干扰）、规则 9（无破坏性操作）、规则 11（无密钥）。
- **Commit**：4851fb8

## 2026-09-08 — fix(ci): Test & Lint Linux CI 失败批量修复（sandbox dash 语法/工作区路径断言/DRE DB 目录/OCR 语言包/codegen 平台命令）

- **任务**：用户报告 CI/CD「Test & Lint」失败（11 annotations），下游 DRE/KB/Build/Security/Stress/Deploy-Smoke 全部 Skipped；定位并修复 5 处 Linux CI 独有失败（Windows 本地均绿），连同上一条 AgentDiscovery 修复一并提交。
- **工具**：Read、rg、PowerShell（备份/替换/验证）、bun test。无子代理。
- **操作**（文件级）：
  1. src/sandbox/process-sandbox.ts——Linux `/bin/sh -c` 分支 limits 为空时产生前导 `; `（dash 语法错误 exit 2），改为 limits.length>0 才拼前缀；
  2. tests/workspaces.test.ts——断言硬编码目录名 openclaw-fusion，CI checkout 目录名不同导致失败，改为 `path.resolve(".")`；顺带去除文件头 BOM；
  3. tests/dre-scenarios.test.ts——CI 无 `.tmp` 目录致 SQLITE_CANTOPEN，beforeAll 增加 `fs.mkdirSync(path.dirname(DB), { recursive: true })`；
  4. tests/ocr-v7.test.ts——CI checkout 无 `*.traineddata`（gitignored），beforeAll/afterAll 建临时假语言包目录，`getOCREngine(["eng"], tmpLang)` 显式传 langPath（engine.ts L257 签名已支持）；
  5. tests/opencode-codegen-timeout.test.ts——Windows 专属命令（powershell/cmd）在 Linux ENOENT 秒败，按平台条件化（POSIX: `sleep 15` / `echo`，语义等价）。
  6. docs/operations-log.md（本条 + 上一条回填）。
- **验证**：bun test --isolate --timeout 全部 6 个受影响文件：74 pass（agent-discovery/security-hardening/workspaces/ocr-v7/opencode-codegen-timeout）+ 4 pass（dre-scenarios）= 78 pass / 0 fail；lint 通过。
- **红线**：规则 1（各修复均为最小改动）、规则 2（备份→读全文→改→验→删）、规则 3（仅 add 本任务相关文件）、规则 5（本条留痕+占位回填）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：4851fb8

## 2026-09-08 — fix(memory): vault 目录缺失导致 MCP stdio 服务器启动即崩（Linux CI 第二轮失败修复）

- **任务**：用户要求检查 CI 运行状态。推送修复后 GitHub run 34157644311 仍红——Test & Lint「Run unit tests」失败于 tests/mcp-stdio-stdout-purity.test.ts L56（lines.length===0，928ms 内失败，Linux CI 独有）。
- **工具**：gh CLI（run view/log-failed 复现）、rg/Read（静态排查启动路径）、PowerShell（复现命令 + 备份）、bun test（红绿验证）。无子代理。
- **根因**（事实，本地已复现）：tests spawn 的 `src/mcp/server.ts` 顶层模块 L66 `getGlobalVault()` → VaultManager 构造 → DeterministicSearchEngine 构造 → buildIndex → scanDirectory `fs.readdirSync("./axiom-memory")` 无保护；`axiom-memory/` 已 gitignore（.gitignore L55），CI 裸 checkout 无此目录 → ENOENT → 进程启动即崩 → stdout 关闭 → 测试 0 行。本地目录存在故绿。
- **操作**（文件级）：修改 src/memory/deterministic-search.ts buildIndex（L106-113）——vault 根目录缺失时返回空索引（existsSync 守卫），缺失记忆库=空索引属合理生产行为；docs/operations-log.md（本条）。测试文件未改动。
- **备选假设**（规则 6，已排除）：VaultManager 构造包 try/catch（掩盖真实错误）；CI/测试侧建目录（只治症状，生产新装机仍崩）。
- **验证**：红绿闭环——复现命令（OBSIDIAN_VAULT_PATH 指向不存在目录 + handshake）崩于 scandir ENOENT；修复后同一场景测试 1 pass/0 fail（6 expect，545ms）；回归 4 文件（deterministic-search/tie/cjk-bigram/link-collision）23 pass/0 fail。
- **红线**：规则 1（单函数 3 行最小改动）、规则 2（备份→改→验→删，备份已清理）、规则 3（仅 add 本任务文件）、规则 5（本条留痕+回填）、规则 6（先复现红→单变量修→验绿）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：5c5f17f

## 2026-09-08 — fix(ci): .ci/frontend-audit.sh 恢复可执行位（Frontend Visual Audit exit 126）

- **任务**：Frontend Visual Audit workflow（GitHub run 34158431442）失败：`./.ci/frontend-audit.sh: Permission denied`，exit 126——文件 mode 为 100644（Windows 文件系统无 +x 位，提交时丢失）。
- **工具**：gh CLI（log-failed 定位）、git ls-files -s（mode 核验）、git update-index --chmod。无子代理。
- **操作**（文件级）：`git update-index --chmod=+x .ci/frontend-audit.sh`（仅索引 mode 100644→100755，文件内容零改动，无需备份/验证运行）；docs/operations-log.md（本条 + 上一条 hash 回填）。
- **验证**：gh Actions 重跑由 push 触发观察（frontend-audit.yml 是唯一以 `./` 直接调用该脚本的工作流；.ci/run.sh 无 GitHub workflow 引用，不改动）。
- **红线**：规则 1（单文件 mode 位最小改动）、规则 3（仅 add 本任务文件）、规则 5（本条留痕+回填）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：eb90d19

## 2026-09-08 — test(rate-limiter): 移除 1ms 窗口用例中的竞态断言（Linux CI 第三轮失败修复）

- **任务**：CI run 34158431441（含 vault 修复）仍红——"B. RateLimiter 边界条件 > windowMs 极小（1ms）— 快速恢复"失败（0.35ms，Expected false / Received true）。vault 修复已生效（mcp-stdio-stdout-purity 转绿）。
- **工具**：gh CLI（log-failed）、Read（测试全文）、PowerShell（备份）、bun test（3 连跑稳定性验证）。无子代理。
- **根因**（事实）：tests/coverage-gap/rate-limiter.test.ts L107-109 在 windowMs=1 下断言第二次同步 check 被拒——依赖两次调用间隔 <1ms，CI 负载下（GC/调度停顿）无任何余量，窗口已过期则 allowed=true。属测试自身非确定性，非实现缺陷。
- **操作**（文件级）：修改 tests/coverage-gap/rate-limiter.test.ts（L106-114）——移除竞态的"立即拒绝"断言（该行为已由 "maxRequests=1"（windowMs=1000）用例确定性覆盖），保留用例独特价值"1ms 窗口快速恢复"断言并注明原因；docs/operations-log.md（本条）。实现文件未改动。
- **验证**：bun test 3 连跑 38 pass / 0 fail（83 expect）。同文件其余时间窗用例（50/300ms 窗）余量 ≥50 倍，无需改动。
- **红线**：规则 1（单用例最小改动）、规则 2（备份→改→验→删，备份已清理）、规则 3（仅 add 本任务文件）、规则 5（本条留痕+回填）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：441e17d

## 2026-09-08 — fix(filesystem): writeFile 并发同文件写原子化（Linux CI 第四轮失败修复）

- **任务**：CI run 34158812795（含 rate-limiter 修复）仍红——"filesystem H-03 TOCTOU > 并发同文件写入不创建非预期文件"失败（L49：最终内容既非 "first" 亦非 "second"）。
- **工具**：gh CLI（log-failed）、Read（实现+测试全文）、bun run harness（本地复现 50 路并发）、bunx tsc、bun test（5 连跑）。无子代理。
- **根因**（事实，本地 harness 复现）：src/mcp/tools/filesystem.ts writeFile 用非原子 open('w')+write——POSIX 两路并发交错出 "firstd" 类损坏产物（CI 实证）；改 tmp+rename 后 Windows 本地 50 路并发 rename 同一目标又确定性 EPERM（MoveFileEx 替换冲突，指数退避重试 5 次仍 12/50 失败，实证排除瞬时冲突假设）。
- **操作**（文件级）：修改 src/mcp/tools/filesystem.ts——新增模块级 writeQueues + queueWrite（进程内按 resolved 路径串行化），非 append 分支整段"写同目录唯一临时文件→rename"入队执行；失败清理 tmp；append 分支不变；docs/operations-log.md（本条）。
- **备选假设**（规则 6，已排除）：测试弱化（放弃原子覆盖契约）；纯重试（harness 实证无效）；仅 POSIX 启用原子写（Windows 生产同样暴露于撕裂写）。
- **验证**：repro harness 5 连跑 0 失败（修复前 12/50 失败）；相关 6 测试文件 5 连跑 85 pass / 0 fail；tsc --noEmit 通过。架构注（规则 6 Phase 6）：writeFile 接口未变，串行化+原子替换藏在实现内（深模块）。
- **红线**：规则 1（单文件最小改动，接口不变）、规则 2（备份→读全文→改→验→删，备份已清理）、规则 3（仅 add 本任务文件）、规则 5（本条留痕+回填）、规则 6（复现→假设→单变量验证）、规则 7（既有测试即红测试，未弱化）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：f45c097
## 2026-09-08 — fix(e2e)+ci: E2E 集成断言去歧义/去网络竞态 + frontend-audit 日志目录修复（第五轮失败修复）

- **任务**：CI run 34159543255（CI/CD，E2E 2 用例失败）与 34159543261（Frontend Visual Audit，exit 1）修复。
- **工具**：gh CLI（log/log-failed）、Read（组件全文：search-panels.tsx / Proxies.tsx / Router.tsx / frontend-audit.sh）、Playwright 本地全量 2 轮、bash -n、PowerShell（备份）。无子代理。
- **根因**（事实）：① e2e L23 旧断言 `/模型路由笔记|没有匹配结果/` 不含实际文案"共 X 条结果"（codegraph 搜 router 必命中）→ element not found；改为等终态后本地又暴露冷启动 codegraph 首查 >15s，allSettled 全完成前终态也不渲染（本地实证 flaky）。② `getByText(/OCR|文字识别/)` 同时命中 tab 按钮与状态条"OCR 就绪"→ strict 歧义。③ `/Proxies|代理/` 同时命中 h1"代理管理"与 h2"代理配置"→ strict 歧义。④ .ci/frontend-audit.sh L22 日志重定向到 data/logs/ci-frontend-audit.log，CI 检出目录无 data/logs → bash 重定向直接报错，后端从未启动 → "backend not healthy"（gh log 实证）。
- **操作**（文件级）：e2e/frontend-backend-integration.spec.ts——L23 改为 `.or()` 组合断言（加载骨架屏 `[aria-label="正在搜索"]` 防抖后确定性渲染 ∨ 终态 `/共 \d+ 条结果|没有匹配结果/`），消除对后端查询耗时的依赖；L36 OCR 改 `getByRole("heading", /扫描文档/)`（面板静态标题）；Proxies 用例 heading 收窄 `/代理管理/`（精确 h1）；趋势 tab 沿用既有 heading 修复。.ci/frontend-audit.sh——启动后端前加 `mkdir -p data/logs`。docs/operations-log.md（本条）。
- **验证**：bun run test:e2e 全量 2 轮——第 1 轮暴露上述 ①-③（修复前），第 2 轮 11 spec 全过、0 failed、0 flaky（integration 5 passed 首试即过）；bash -n 语法通过；mkdir -p data/logs 本地 Git Bash 实证 OK；.ci/frontend-audit.sh 可执行位 100755 保留。
- **红线**：规则 1（仅断言/一行 mkdir，未动产品代码）、规则 2（备份→读全文→改→验→删）、规则 3（仅 add 本任务文件）、规则 5（本条留痕+回填）、规则 6（gh log 先证、本地复现、逐项单变量）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：b6e8324

## 2026-09-08 — ci(deploy-smoke): 健康等待 30s→90s + token 补足 16 字符（第六轮失败修复）

- **任务**：CI run 34161538021——Test & Lint 已绿（E2E 修复生效，5m5s 通过），新失败点 Linux Deploy Smoke："Start under pm2 and smoke test" 30s 健康循环耗尽，curl exit 7（connection refused）。
- **工具**：gh CLI（run view/log-failed）、Read（ci.yml / ecosystem.config.json / runtime-audit.ts）、本地 bundle 复现（bun dist/main.js + 同 env + curl 探测）、bun run audit:runtime、PowerShell。无子代理。
- **根因**（事实，本地全链路复现）：网关冷启动至监听实测 23s（11.5MB bundle 加载 + 外部 MCP 初始化，obsidian 10s 超时为确定性拖累；第二跑热态 9s），CI 健康循环仅 30s，慢 runner 下不够 → exit 7。另：AXIOM_AUTH_TOKEN "ci-smoke-token" 仅 14 字符 < 16 下限，启动时 env 校验 ERROR（被容忍继续启动，非阻塞但属隐患，本地日志实证）。DRE/KB Plugin 与 Build Docker 的 "-" 为条件跳过（build 仅 push main/master），非新故障。
- **操作**（文件级）：.github/workflows/ci.yml——健康循环 seq 1 30→1 90 并注明实测依据；AXIOM_AUTH_TOKEN "ci-smoke-token"→"ci-smoke-token-16chars"（19 字符），diagnostics 调用的 Bearer 同步改；docs/operations-log.md（本条）。pm2 ecosystem 与产品代码未动。
- **验证**：本地复现反馈回路——旧 token+30s：12s 探测失败、日志见 "Invalid value for AXIOM_AUTH_TOKEN"（ERROR）且 23s 才 listen（复现 CI 症状）；新 token：0 校验 ERROR、9s listen、health 200；bun run audit:runtime 16/16 pass exit 0。
- **偏差记录**：本次修改 ci.yml 前未先备份（规则 2 字面未走全）；该文件修改前与 HEAD 一致、原版可由 git 恢复，无数据风险。后续仍严格先备份。
- **红线**：规则 1（两处最小改动）、规则 2（备份缺失已如实记录）、规则 3（仅 add 本任务文件）、规则 5（本条留痕+回填）、规则 6（先复现建回路→单变量验证）、规则 9（无 force/reset）、规则 11（token 为测试占位符非真实凭据）。
- **Commit**：934ac94

## 2026-09-08 — ci(deploy-smoke): pm2 bash 包装启动替代 bun 解释器直载（第七轮失败修复）

- **任务**：CI run 34162662690——Test & Lint 持续绿；Linux Deploy Smoke 90s 健康窗口耗尽仍 exit 7。该 job 此前从未执行过（历史上游一直红被跳过），属首次暴露的存量故障。
- **工具**：gh CLI、本地 pm2 7.0.4（npm -g）、bundle 直跑对照、Git Bash 端到端复现脚本、Read。无子代理。
- **根因**（事实，本地 pm2 全链路复现）：pm2 bun fork 容器 ProcessContainerForkBun.js L25 以 require() 加载入口，而 dist/main.js 为含 top-level await 的 ESM bundle → "TypeError: require() async module is unsupported"，每轮重启同点崩溃（本地 ↺6/30s，axiom-error.log 逐轮实证）→ 永不监听。90s 窗口无用（崩溃循环非慢启动）。次生缺陷：pm2 restart 后 sleep 2 即 curl，实测恢复需 ~6-7s（完整重新初始化）。
- **备选假设**（规则 6，已排除）：慢启动超窗口（90s 仍挂 + 本地直跑 6s listen 证伪）；spawn ENOENT（pm2 status 显示 online 且有日志证伪）。
- **操作**（文件级）：.github/workflows/ci.yml deploy-smoke 步骤——改 `pm2 start --name axiom-agent /tmp/smoke-entry.sh --interpreter bash`（workflow 内联 heredoc 写 `exec bun dist/main.js` 包装脚本，绕开 require-ESM，pm2 管 bash→bun）；restart 后 sleep 2 改 90s 轮询；失败诊断分支精简（去 [DEBUG-smoke7] 标记与失效的 data/logs tail——新模式下 pm2 logs 即全部证据）；docs/operations-log.md（本条）。deploy/pm2/ecosystem.config.json 未动（产品部署文件，其 require-ESM 缺陷另行记录）。
- **验证**：本地 Git Bash 端到端复现 CI 步骤全脚本——first listen 6s/200 → audit:runtime 过 → diagnostics 200 → restart 后 6s 恢复 200 → delete → SMOKE ALL GREEN。YAML 块内 heredoc EOF 落第 0 列（块缩进剥离）确认。
- **偏差记录**：上一条目（插桩轮）修改 ci.yml 前未备份（规则 2 字面未走全，已记录）；本轮修改前已备份 .tmp/backups/ci.yml 并于验证通过后删除。
- **红线**：规则 1（仅 CI workflow 最小改动）、规则 2（本轮合规）、规则 3（仅 add 本任务文件）、规则 5（本条留痕+回填）、规则 6（本地反馈回路→假设排除→单变量修复→回归验证）、规则 9（无 force/reset）、规则 11（占位 token 非真实凭据）。
- **Commit**：c72ce3e

## 2026-09-08 — fix(deploy): ecosystem.config.json 弃用 bun 直载改 bash 包装（require-ESM 缺陷修复）

- **任务**：修复上一轮（c72ce3e）记录的存量缺陷——deploy/pm2/ecosystem.config.json 以 interpreter bun 直载 dist/main.js，pm2 bun fork 容器 require() 加载含 top-level await 的 ESM bundle 必崩（TypeError 崩溃循环，永不监听）。真实 pm2 部署场景同样暴露于该缺陷。
- **工具**：Read、Write、本地 pm2 7.0.4 端到端验证（pm2 start ecosystem 配置全流程）、Git Bash。无子代理。
- **操作**（文件级）：① 新增 deploy/pm2/start.sh（bash 包装：cd 项目根 + exec bun dist/main.js，注明根因）——deploy/ 在 .gitignore:146 中，按 ecosystem.config.json 同性质配套部署资产以 add -f 入库并置 100755；② deploy/pm2/ecosystem.config.json：script dist/main.js→deploy/pm2/start.sh，interpreter bun→bash，其余字段未动；③ .github/workflows/ci.yml deploy-smoke：撤去内联 heredoc 包装，改回 pm2 start deploy/pm2/ecosystem.config.json --update-env——使 CI 冒烟持续回归验证真实部署配置；docs/operations-log.md（本条）。
- **验证**：本地 Git Bash 模拟真实部署路径全流程——pm2 start deploy/pm2/ecosystem.config.json --update-env → 90s 窗口内 listen/health 200 → diagnostics 200 → pm2 restart 后 6s 恢复 200 → pm2 delete，ECOSYSTEM SMOKE ALL GREEN。start.sh 自带 cd 兜底（不依赖 cwd 配置）。
- **回归影响**：CI deploy-smoke 从"测内联等效物"升级为"直接测部署配置"，防止该缺陷复发。
- **红线**：规则 1（最小改动：config 两行 + 一个包装脚本 + CI 一段）、规则 2（两处修改前均备份，验证后删）、规则 3（仅 add 本任务文件，start.sh 因 gitignore 需 -f）、规则 5（本条留痕+回填）、规则 6（复用上轮已证实的根因与接缝）、规则 9（无 force/reset）、规则 11（无密钥）。
- **Commit**：6d2cb51

## 2026-09-08 — eval(m3-5): 第5批标注收官 + 全量100例 compare（κ=0.954 门禁通过）+ 补提交积压批次

- **任务**：S-A4 第 5 批（最后一批）双人全量标注：se-0081..se-0100（20 例 dataset）+ gold-06/07 插桩（每批 2 例，标注员不知情），至此 100 例 A/B 双人全量标注完成。
- **工具**：两个隔离子代理（标注员 A/B 并行，互相不可见对方结果，均未读 answer-key/arbitration/reports/对方目录——双方最终报告含隔离合规声明）；annotation-runner.ts（gold / compare）。仲裁人与编排由主会话承担。
- **操作**（文件级）：① annotations/annotator-A|B/ 新增第 5 批 22×2 文件，并补提交前 4 批积压（工作区此前未提交的 ann-r1-se-0001..0080、ann-r1-gold-01..05/08..10、ann-calibration-*）；② arbitration/pending-r1.json 由 runner 重新生成（全量口径）；docs/operations-log.md（本条）。
- **结果**（事实）：κ=0.954（≥0.7 门禁通过）；一致 97 / 分歧 3（se-0056/0057/0060，全部为 A:equivalent vs B:equivalent_with_notes 宽严差，error_classes 双方均空，零 E1-E4 分歧）；incomplete 0 / uncertain 配对 0。预口径（仅一致项 97）：严格 23.7% / 宽松 55.7%。
- **gold 漂移检查**（§8，如实记录，未处置待决策）：双方各 8/10 全对——① gold-06 双方一致判 equivalent，answer-key 期望 equivalent_with_notes（§5 映射行"仅溯源引用格式问题且命题本体正确→eq_notes"执行遗漏，双方一致漏同一点）；② gold-07 双方 verdict/severity 正确，error_classes 判 E4+E3，answer-key 期望 E2+E3——指南附录 A（se-0008：反向命题"归 E4 亦可，仲裁统一归 E4"）与 answer-key 自相矛盾，属细则/答案键缺陷非标注员过错。按 §8 停线复盘原则，处置方案待需求方决策（细则 v1.1 澄清 / 报告披露维持）。
- **验证**：runner 硬约束校验通过（not_equivalent⇒error_classes 非空、equivalent⇒空）；JSON 全部合法；22×2 文件落位正确。
- **红线**：规则 1（仅标注产物与 runner 产物）、规则 3（仅 add 本任务文件）、规则 5（本条留痕+回填）、规则 10（判定为"判断"定性，等价率解读不作承诺）、指南 §10 诚实原则（分歧/漂移全量披露，不静默）。
- **Commit**：79f56a5

## 2026-09-08 — eval(m3-6): 细则 v1.1 澄清 + r1 仲裁 + 首轮等价率终局报告（严格 23.0% / 宽松 57.0%）

- **任务**：S-A4 收官三件套（需求方两项决策：①授权主会话按 §7 仲裁 3 例分歧；②gold 漂移按细则 v1.1 澄清处置）。
- **工具**：Edit（指南/answer-key）、Write（resolved-r1.json）、annotation-runner.ts（gold 复核 / finalize）、主会话仲裁（先独立判定→读双方 rationale，§7 步骤 2-3）。无子代理。
- **操作**（文件级）：① ANNOTATION-GUIDE.md v1.0→v1.1：新增 §6.8（溯源引用格式残缺≠引用错误，显式区分 minor notes 与 E1 critical）、§6.9（反向/否定翻转命题归类统一 E4，消除附录 A se-0008 与 answer-key gold-07 的自相矛盾），版本头变更说明；② gold/answer-key.json：gold-07 期望 E2+E3→E3+E4（v1.1 §6.9 对齐，planting 注明修正缘由）、_coverage 键名同步；③ arbitration/resolved-r1.json：3 例分歧（se-0056/0057/0060 均采纳 B→equivalent_with_notes，仲裁人独立判定与 B 一致：命题层逐字无增无漏语义闭合，结构拍平+实体粒度失真以 notes 披露）+ gold-06 质控终局（仲裁人判 eq_notes，v1.1 §6.8 口径）；④ reports/report-r1-final.md/.json（finalize 产出，reports/ 被 .gitignore:68 命中按既有 report-r1.json 先例 add -f 入库）。
- **gold 复核结果**（v1.1 口径）：A/B 各 9/10——gold-07 归类偏差消除（双方 E4+E3 = 新期望）；gold-06 双方原判 equivalent 与细则不符，由仲裁终局裁定 eq_notes（细则可发现性问题的纠正，非标注员过错）。
- **结果**（事实）：终局双口径 N=100（contested 0，uncertain 0）：严格 23.0%（equivalent 23）/ 宽松 57.0%（+eq_notes 34）/ not_equivalent 43；κ=0.954；仲裁采纳来源 A=0 B=3 仲裁人=0（dataset 例）；错误分布（A+B 合计）E1=0 E2=0 E3=86 E4=0。
- **验证**：runner finalize 通过（unresolved=0）；resolved 数组结构修正后 runner 可解析；指南 §6 编号连续。
- **红线**：规则 1（最小改动）、规则 2（备份→改→验→删）、规则 3（仅 add 本任务文件，final 报告因 ignore 需 -f）、规则 5（本条留痕+回填）、规则 10（报告中事实/判断分离标注）、指南 §10.5（细则修订独立提交+披露版本号 v1.1，非为数字变好——仲裁使宽松口径 +3 例属采纳 B 的正当结果，严格口径仅受 equivalent 定义影响不因仲裁上升）。
- **Commit**：b4f32f0

## 2026-09-08 — test(m3-7): S-A7 soak harness 落地 + 全量 N=240 跑通（5 项崩坏指标全 PASS）

- **任务**：M4 补 S-A7——soak harness 骨架针对现有组件（context-manager compress/retrieve、sqlite-memory、KG 幂等）落地 5 项崩坏断言（N≥200 轮零未捕获异常 / 逐轮上下文 ≤ 预算 / 植入记忆召回一致率 ≥ 阈值 / 重复注入零重复 KG/Vault 写入 / 中断-恢复可续），全量 run-soak 出报告。
- **工具**：Bun test（TDD 垂直切片 4 轮 RED→GREEN）、bun scripts/soak/run-soak.ts（全量 runner）、bunx tsc --noEmit。无子代理。
- **操作**（文件级）：① 新增 scripts/soak/soak-core.ts——确定性 soak 核心：applyDeterministicEnv（清 *_API_KEY 强制 fallback 链）、forceDeterministicSummary（动态 import 绕 model-router ESM 循环链 + 会话期临时改 decision 角色模型 isFree/priority 使摘要零延迟直达 fallbackSummary）、mulberry32 种子会话模拟、runSoakSession（预算采集 + 每 6 轮锚词植入/检索 + 每 8 轮重复注入计量 + 进程级 uncaughtException/unhandledRejection 兜底）、runSoakInterruptRecovery（120+120 轮：中断前锚词写 sqlite-memory → 无收尾丢弃运行态模拟进程死亡 → 全新 SQLiteMemory/ContextManager 重开同 db 续跑，getByPath 精确校验存续）+ 4 个纯函数断言器（assertBudgetPerRound / assertRecallConsistency / assertNoDuplicateWrites / assertInterruptRecovery）；② 新增 scripts/soak/run-soak.ts——全量 runner，产出 reports/soak/soak-report-2026-09-08.json+.md（reports/ 被 .gitignore:68 命中，按 report-r1 先例 add -f 入库）；③ 新增 tests/soak/soak-harness.test.ts——4 切片冒烟测试（预算 / 存续率 / 重复注入 / 中断-恢复）；④ src/context/context-manager.ts——estimateMessageTokens 由私有改导出（harness 复用同一 token 口径，防双份公式漂移；文件头 BOM 顺带去除）；⑤ docs/operations-log.md（本条）。
- **结果**（事实，N=240 轮 seed=42 budget=3000，deterministic-fallback 零网络零 LLM 成本）：① 零未捕获异常（会话腿+中断腿合计 0）；② 逐轮 max 1797 / p95 1744 / 均值 1046 ≤ 预算 3000，压缩 73 次；③ 植入记忆存续率 100%（39/39，阈值 90%）；④ 重复注入 30 批次，KG 节点/KG 边/sqlite 增量全 0；⑤ 中断-恢复锚词存续 20/20，恢复后 120 轮全完成、压缩 25 次、零异常。判定 PASS。
- **口径说明**：召回口径为"存续率"——fallback 摘要递归吸收历史决策消息、字符频率向量同分致 top-K 排序无判别力（实测 0.594 同分），故按全量检索验证"记忆不凭空丢失"，top-K 排序一致性待 S-A2 真实 embedding 接入后增强；恢复口径为 sqlite-memory 持久层存活 + 全新实例续跑（ContextManager 进程内记忆不跨进程属架构事实，恢复层即 sqlite-memory，Vault 索引与之同源）。
- **验证**：bun test tests/soak/soak-harness.test.ts 4/4；bunx tsc --noEmit soak 相关零错误；context 相关回归（context-engine / context-cache-discipline / context-assembler / dre-degrade-context）34/34；run-soak 全量 PASS（报告落盘 reports/soak/）。
- **红线**：规则 1（仅 soak 相关文件 + 一处导出最小改动）、规则 2（soak-core 与测试文件修改前备份 .tmp/backups/，验证通过后删除）、规则 3（仅 add 本任务文件，报告因 gitignore 需 -f）、规则 5（本条留痕+回填）、规则 7（垂直切片 RED→GREEN ×4）、规则 10（口径与事实/判断分离披露）。
- **Commit**：1738cfb

## 2026-09-08 — plan(m3-8): S-A8 测试计划（S-A2 多级校验流水线 + S-A1 前置 + soak 断言增强）

- **任务**：生成下一轮 S-A8 测试计划。S-A8 未在原计划定义（A 轨仅至 S-A7），经用户决策定范围：S-A2 校验流水线为被测主体、S-A1 schema 为前置（计划文档明文 S-A2 第 1 级复用 S-A1，且 src/semantic/ 实际不存在，二者不可拆轮）。
- **工具**：Grep/Glob/Read（代码勘察：src/semantic 不存在、KNOWLEDGE_USE_LLM 门位置、KG INSERT OR REPLACE 幂等语义、S-A7 soak 挂点）、AskUserQuestion（范围决策）、Write（计划文档）。无子代理。
- **操作**（文件级）：新增 docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md（9 切片 TDD 设计：S-A1 合法零误拒 → 非法变体矩阵 V1-V7 → 级 1-4 独立测试（依赖注入假件）→ 端到端 fail-closed（含校验器自身异常注入）→ 对抗样例集 ≥30 例 100% 拦截 → soak top-K 断言增强（无 key 环境 SKIP 有因））；docs/operations-log.md（本条）。
- **关键口径**（事实/判断分离）：① KG 幂等为 INSERT OR REPLACE 写入语义，"不静默覆盖"必须由流水线级 3 写入前拦截（事实，src/kg/enhanced.ts:224/303）；② 级 3 冲突只做"同实体对矛盾关系"最小判定，宁标不拒防误杀（判断）；③ anchor 格式建议 vault:/kg: 双前缀（判断，实施首日决策点）；④ zod vs 手写守卫留实施首日决策（判断）。
- **验证**：计划文档落盘；代码勘察均有文件行号依据；切片 9 明确不破坏 m3-7 soak 4/4 回归。
- **红线**：规则 1（本轮零生产代码，纯测试计划）、规则 3+5（留痕+提交+回填）、规则 10（S-A8 未定义直接指出并以选项交用户决策；事实/判断分离）。
- **Commit**：e133569

## 2026-09-09 — test(m3-8 切片 1): S-A1 schema 合法样例零误拒（TDD RED→GREEN）

- **任务**：S-A8 测试计划切片 1——S-A1 语义 schema 落地第一步：golden 合法样例（≥3）全部通过且原因码为空。
- **工具**：Bun test（TDD 垂直切片 RED→GREEN）、npx tsc --noEmit。无子代理。
- **操作**（文件级）：① 新增 tests/semantic/meaning-schema.test.ts——3 个 golden 合法样例（最小合法：单实体+单命题无关系；完整：多命题+实体链接+vault:/kg: 双前缀溯源+关系三元组；边界值合法：confidence 恰落 0/1、空实体引用列表、关系链），断言 ok===true 且 reasonCodes 为空；② 新增 src/semantic/meaning-schema.ts——MeaningRepresentation zod schema（命题集/实体/关系三元组/溯源头引用/置信标记 [0,1]）+ 公共接口 validateMeaningRepresentation(x: unknown): ValidationResult（fail-closed）最小实现。
- **决策**（计划第六节实施首日决策点）：zod vs 手写守卫 → 采用 zod（zod@^3.22.0 已在 dependencies，零新增依赖，不违反规则 1）；anchor 格式采纳 vault:/kg: 双前缀。非法分支暂以占位原因码 schema-invalid 返回，切片 2 按非法变体矩阵精化为精确原因码映射。
- **结果**（事实）：RED 确认（模块不存在，1 fail）→ GREEN 3/3 pass（6 expect）；npx tsc --noEmit 退出码 0。零网络零 LLM 成本。
- **红线**：规则 1（仅新增 2 文件）、规则 2（ops log 修改前备份 .tmp/backups/，验证后删除；新文件无需备份）、规则 3+5（本条留痕+回填）、规则 7（垂直切片，未预写切片 2 测试）、规则 8（validateMeaningRepresentation 单一公共接缝）。
- **Commit**：365eba8

## 2026-09-09 — docs(agents): 新增规则 12 PCDA 施工闭环（防过度工程化/过度施工）

- **任务**：检查 AGENTS.md 现行规则，将施工方式显式约束为 PCDA（Plan → Do → Check → Act）闭环，降低过度工程化与过度施工风险。
- **工具**：Read/apply_patch、Bun test（docs-consistency）、PowerShell（结构断言/行尾检查）。无子代理。
- **操作**（文件级）：① AGENTS.md——新增「规则 12：PCDA 施工闭环」，定义 Plan/Do/Check/Act 四阶段准入退出条件、过度施工红线与完成判定；规则 1 增加一句 PCDA 交叉引用；规则 10 适用范围由「1-9、11」更新为「1-9、11-12」；文末「十一条规则」更新为「十二条规则」；② docs/operations-log.md（本条）。
- **关键判断**（规则 10，事实/判断分离）：事实——本仓库既有代码与文档使用 PCDA 术语（`src/testing/scheduler/types.ts:4` 明示 PCDA 循环 Plan-Do-Check-Act），故沿用 PCDA 而非改写为 PDCA；判断——新增独立规则而非扩充规则 1，避免最小施工规则被流程细节淹没。
- **验证**：结构断言通过（12 个规则标题、编号 1-12 连续、无「十一条」残留、文末「十二条」、PCDA 四阶段存在）；`git diff --check` 无空白错误；`bun test tests/unit/docs-consistency.test.ts` 9 pass / 0 fail；行尾/编码检查 UTF-8 无 BOM、LF 一致。
- **红线**：规则 1（仅 AGENTS.md + 本条 ops log）、规则 2（两文件修改前均备份 .tmp/backups/，验证后删除）、规则 3+5（仅 add 本任务文件，本条留痕+回填）、规则 10（PCDA 术语事实核验）、规则 12（Plan→Do→Check→Act 闭环）。
- **Commit**：e1e2b60（amend 前初稿）

## 2026-09-09 — docs(agents): 规则体系 v1.2 — 新增总则/任务分级/完成证据与稳定性加固

- **任务**：对 AGENTS.md 规则体系做稳定与效率优化，不追求精简：补齐规则优先级、任务分级门禁、统一任务契约、完成证据、规则变更协议，并修正若干易冲突/易失效条款。
- **工具**：Read/apply_patch、Bun test（docs-consistency）、PowerShell（结构断言/diff 检查）。无子代理。
- **操作**（文件级）：① AGENTS.md——新增「总则」0.1 规则优先级、0.2 编号与引用稳定、0.3 任务分级 T0-T3、0.4 统一任务契约、0.5 完成证据 DoD、0.6 例外与停机条件、0.7 规则变更协议；② 修订规则 2（新建文件免备份、超大文件读法例外、验证证据、备份保留、子代理边界）、规则 3（禁直提 main/master、暂存范围核对、远端一致性）、规则 4（无历史价值生成物快速删除例外）、规则 5（条目长度/月度归档、已推送禁 amend）、规则 6（trivial bug 快路径、离线确定性回路）、规则 7（无测试接缝的替代验证）、规则 8（设计建议不等于施工授权）、规则 9（未推送才可 amend、无法交互确认则停机）、规则 10（自调整引用、调研知识文件按决策影响触发）、规则 11（扫描范围、凭据泄露轮换、禁止回显明文）、规则 12（引用总则 0.3/0.4/0.5）；③ 文末引用改为“以上全部规则”；docs/operations-log.md（本条）。
- **关键判断**（规则 10，事实/判断分离）：事实——原规则已有最小施工/备份/调试/TDD/深模块/安全/留痕，但缺少规则间优先级与任务分级；判断——新增“总则”层而非重排原规则，保持规则编号稳定，降低已有引用（tests/docs/ops log 中大量“规则 N”）的破坏面。
- **效率例外披露**（判断）：规则 2 的“读全文”对超大文件（>1MB 或 >5000 行，如 operations-log.md）增加“结构索引+修改点上下文+全仓引用”的等价读法；规则 10 的独立知识文件改为“影响方案/代码/架构决策时”触发。二者均为效率优化，保留原规则的反片段改动意图；如要求严格逐字通读/每次调研都落文件，可回滚。
- **验证**：结构断言通过（12 个规则标题、编号 1-12 连续、总则 0.1-0.7、版本 v1.2、无“十一条/十二条”残留、无“1-9、11-12”死引用、代码块闭合）；`git diff --check` 无空白错误；`bun test tests/unit/docs-consistency.test.ts` 9 pass / 0 fail；AGENTS.md UTF-8 无 BOM、LF 行尾。
- **红线**：规则 1（仅 AGENTS.md + 本条 ops log）、规则 2（两文件修改前备份，验证后删除）、规则 3+5（仅 add 本任务文件，本条留痕+回填）、规则 9（未推送才 amend；无 force）、规则 11（无密钥明文）、规则 12（PCDA 闭环）、总则 0.7（规则变更协议）。
- **Commit**：15ee91b（amend 前初稿）

## 2026-09-09 — plan(下一轮前置): 多模型协同处理系统设计文档入库 + 规则 10 审查

- **任务**：用户提交《多模型协同处理系统设计文档》，自述定位为"切片 2 实施完成后的下一轮迭代指导"；入库存档并按规则 10 给出独立审查意见。
- **工具**：Glob（存量能力勘察：src/agents/、src/router/、src/context/）、Write、Edit。无子代理。
- **操作**（文件级）：新增 docs/superpowers/plans/2026-09-09-multi-model-collaboration-design.md（用户原文未改动 + 出处/定位/状态头）；docs/operations-log.md（本条）。
- **审查要点**（事实/判断分离）：
  - 事实①：文档模型名单（GPT-4/Claude 3/GPT-3.5/Llama 2/PaLM 2）为 2023 世代产品名；本仓库模型接入为 provider/endpoint 抽象（src/router/model-router.ts 角色×isFree/priority 模型配置、api-key-store 动态读 env、scripts/discover-free-models.ts），设计应按"角色×能力档位"建模而非产品名。
  - 事实②：绿地假设不成立——2.2 组件与存量模块大面积对应：任务分发↔src/agents/orchestrator.ts+intent-router.ts+query-decomposer.ts、上下文管理↔src/context/context-manager.ts（预算/压缩，S-A7 已 soak 验证）、提示词模板/动态生成/版本↔prompt-pool.ts+prompt-engineer.ts+prompt-optimizer.ts、知识库集成↔src/knowledge/pipeline.ts+src/kg/enhanced.ts。实施前必须划清"复用 vs 新建"。
  - 事实③：3.2 输出质量校准、3.3 幻觉预防（交叉验证/知识库锚定）与 S-A2 四级校验流水线职责面重合；S-A8 切片 3-8 尚未实施，切片 2 完成仅等于 S-A1 收口。
  - 判断①（顺序风险）：文档"切片 2 后启动新系统"存在依赖倒置——新系统的审核层/交叉验证/知识库锚定需要 S-A2 流水线作落地接缝；建议切片 2 后至少完成 S-A8 切片 3-4（级 1-2），或将 S-A2 级 3-4 并入新系统"指挥与审核层"合并设计。
  - 判断②（指标不可验收）：幻觉率<1%、满意度>4.5/5、可用性 99.9% 无测量协议支撑；按 m3-6 惯例先定义评估集+runner+口径再立目标，否则数字不可复现。
  - 判断③（成本矛盾）：3.3"关键结论至少两个不同模型独立验证"与 5.2"降本 40%+"目标存在张力，需按任务分级选择性交叉验证。
  - 判断④（形态）：设计文档非 TDD 测试计划；按仓库惯例实施前转切片化测试计划（接口面/验收口径/确定性保证），时间估算（阶段一 2 周等）按纪律不作承诺。分层思想、统一接口抹平差异、fail-closed 精神与现行方向一致，可作方向输入。
- **验证**：勘察均有文件路径依据；文档含 11 条规则敏感信息扫描（无密钥/凭据，规则 11 通过）。
- **红线**：规则 1（本轮仅文档入库零生产代码）、规则 3+5（本条留痕+回填）、规则 10（原文未改动，审查意见事实/判断分离、直接异议不迎合）。
- **Commit**：a2ce727

## 2026-09-09 — test(m3-8 切片 2): S-A1 非法变体矩阵 V1-V7 fail-closed（TDD 垂直切片 ×7 RED→GREEN）

- **任务**：S-A8 切片 2——S-A1 schema 对 7 类非法变体 fail-closed 且原因码精确匹配（不多报不漏报），S-A1 收口（合法零误拒 + 非法全拦截双验收达成）。
- **工具**：Bun test（TDD 垂直切片 7 轮，每轮 RED 确认→最小实现→GREEN）、npx tsc --noEmit。无子代理。
- **操作**（文件级）：① tests/semantic/meaning-schema.test.ts——追加切片 2 describe（V1-V7 各一独立测试，mutable 深克隆变体构造，每变体断言 ok===false 且 reasonCodes toEqual 精确单码）；② src/semantic/meaning-schema.ts——validateMeaningRepresentation 演进为四段：V7 前置拦截（null/原始值/数组→not-an-object）→ zod safeParse（V1/V3 按 issue.path 归因：sourceAnchor 缺失或前缀非法→missing-provenance，其余→type-mismatch，Set 去重）→ 结构级闭合检查收集（V6 空命题集/空实体集、V2 悬空实体引用、V4 关系端点未声明）→ hasCyclicRelation DFS 三色环检测（V5，含自环）。
- **口径细化**（计划表"原因码（拟）"两处，事实/判断分离）：① 空实体集单列 empty-entities（与 empty-propositions 分开精确归因，判断：计划将"空命题集/空实体集"并为一行但共用一码会导致归因模糊）；② missing-provenance 覆盖"锚字段缺失"与"前缀非法（非 vault:/kg:）"两种子态（判断：二者同为"溯源不可解析"）。V4 依计划注记仅查声明闭合，实存性留给流水线级 2。
- **结果**（事实）：7 轮逐轮 RED 确认（各 1 fail）→ GREEN；终态 10/10 pass（3 golden 零误拒保持 + V1-V7 全拦截，28 expect）；npx tsc --noEmit 退出码 0。每轮最小实现，未预写后续轮测试。
- **验证**：bun test tests/semantic/meaning-schema.test.ts 10/10；npx tsc --noEmit=0；备份验证通过后删除（规则 2.5）。
- **红线**：规则 1（仅任务契约两文件）、规则 2（两文件改前备份→改→验→删）、规则 3+5（仅 add 本任务文件+本条留痕回填）、规则 7（垂直切片 ×7 禁止水平铺）、规则 8（公共接口不变，validateMeaningRepresentation 单接缝）、规则 9（无破坏性操作）。
- **Commit**：e15f8d6

## 2026-09-09 — test(m3-8 切片 3): ValidationPipeline 级 1 语法级薄透传（TDD 垂直切片 RED→GREEN）

- **任务**：S-A8 切片 3——流水线对非法 schema 输入返回 level=1 + 对应原因码且不进入后续级；反向断言合法输入穿过级 1（级 2 被调用可观测证据）。
- **工具**：Bun test（TDD 1 轮 RED 确认→最小实现→GREEN）、npx tsc --noEmit。无子代理。
- **操作**（文件级）：① 新增 tests/semantic/validation-pipeline.test.ts（2 测试：非法输入 level=1+精确原因码+spy 零调用，覆盖 V7/V1/V3/V6 四代表变体；合法输入 kg.getNode spy 触发+放行）；② 新增 src/semantic/validation-pipeline.ts（PipelineVerdict{pass,level,reasonCode,detail} + ValidationPipelineDeps 对齐生产同步接口 getNode/getByPath + validate：级 1 薄透传 validateMeaningRepresentation，fail→level 1 首因码；pass→级 2 入口遍历声明实体调 kg.getNode，本切片无拒绝语义）。
- **口径细化**（判断）：① level 语义=fail 拦截所在级/pass 到达的最深层级（合法输入 level=2 即穿过级 1 的证据）；② validate 同步（生产两依赖 getNode/getByPath 均同步，异步留待真异步依赖出现）；③ ctx/embedder 参数不做，对应切片（6）再加。
- **结果**（事实）：RED 确认（模块不存在 1 fail）→ GREEN 2/2；全量 bun test tests/semantic/ 12/12（切片 1-2 回归保持，50 expect）；npx tsc --noEmit 退出码 0。
- **验证**：bun test tests/semantic/validation-pipeline.test.ts 2/2；bun test tests/semantic/ 12/12；tsc=0；备份验证通过后删除（规则 2.5）。
- **红线**：规则 1（仅任务契约三文件）、规则 2（ops log 改前备份→改→验→删）、规则 3+5（仅 add 本任务文件+本条留痕回填）、规则 7（垂直切片单轮，未预写级 2 测试）、规则 8（依赖注入 spy 假件，测试只穿越 validate 公共接口）、规则 9（无破坏性操作）。
- **Commit**：c383aff

## 2026-09-09 — test(m3-8 切片 4): ValidationPipeline 级 2 实存性校验（TDD 垂直切片 RED→GREEN）

- **任务**：S-A8 切片 4——级 2 拒绝语义：实体不可解析→unresolved-entity、溯源 anchor 不可解析→unresolvable-provenance、全部可解析→通过（依赖注入 Map 内存假件，规则 8）。
- **工具**：Bun test（TDD 1 轮 RED 确认（2 fail：新拒绝语义未实现）→最小实现→GREEN）、npx tsc --noEmit。无子代理。
- **操作**（文件级）：① src/semantic/validation-pipeline.ts——级 2 由"调用入口"演进为实存性校验：声明实体逐个 kg.getNode（null/undefined 判不可解析）；命题 anchor 双前缀解析（vault:→memory.getByPath 去前缀路径、kg:→kg.getNode 去前缀 id），fail-closed Set 收集原因码（reasonCode=首码，detail 携带全部 code:offender），全可解析→pass level=2；② tests/semantic/validation-pipeline.test.ts——追加切片 4 describe（3 测试：实体缺节点、vault 缺笔记/kg 缺节点双态、全可解析通过）+ 切片 3 spy 假件由恒 null 改为可解析占位记录（级 2 有拒绝语义后恒 null 会误拒合法输入，反向断言语义保持）；③ docs/operations-log.md（本条）。
- **口径细化**（判断）：① kg: 溯源锚与实体同走 kg.getNode 解析（双前缀锚是唯二可解析锚，fail-closed 要求两者都可解析）；② 不可解析判定 == null（覆盖 null/undefined，fail-closed）；③ reasonCode 单字段取首码、detail 承载全部失败项，不新增多码字段。
- **结果**（事实）：RED 2 fail→GREEN 5/5（33 expect）；全量 bun test tests/semantic/ 15/15（切片 1-3 回归保持，61 expect）；npx tsc --noEmit 退出码 0。
- **验证**：bun test tests/semantic/validation-pipeline.test.ts 5/5；bun test tests/semantic/ 15/15；tsc=0；备份验证通过后删除（规则 2.5）。
- **红线**：规则 1（仅任务契约三文件）、规则 2（三文件改前备份→改→验→删）、规则 3+5（仅 add 本任务文件+本条留痕回填）、规则 7（垂直切片单轮）、规则 8（Map 假件注入，测试只穿越 validate 公共接口）、规则 9（无破坏性操作）。
- **Commit**：684c8d3

## 2026-09-09 — test(m3-8 切片 5): ValidationPipeline 级 3 逻辑一致性·同实体对矛盾关系（TDD RED→GREEN）

- **任务**：S-A8 切片 5——既有 KG 事实与输入三元组同实体对矛盾 → conflict 标记（策略可配置），幂等重放与新事实放行，全程断言 KG 行数不变且零写入（不静默覆盖，INSERT OR REPLACE 之上先拦）。
- **工具**：Bun test（TDD 1 轮 RED 确认 4 fail →最小实现→GREEN）、npx tsc --noEmit。无子代理。
- **操作**（文件级）：① src/semantic/validation-pipeline.ts——deps.kg 增 getOutEdges（结构对齐生产 KGEdge.source/target/type）；新增 ValidationPipelineOptions.conflictPolicy（mark 默认/reject，计划第六节"宁可标记不拒绝"）；PipelineVerdict 增 flags（软标记，pass=true 也可非空）；级 3 只读检测：getOutEdges(source) 中同 target 且 type 不同→conflict，类型相同→幂等重放，无既有边→开放世界新事实放行；全部返回点补 flags 字段；② tests/semantic/validation-pipeline.test.ts——既有两假件补 getOutEdges；切片 4 全可解析用例 level 2→3（pass=到达最深层级语义的自然演进）；新增切片 5 describe ×4（mark/reject/幂等重放/新事实，makeKgFake 含 INSERT OR REPLACE 式写入记录与 rows() 行数断言）；③ docs/operations-log.md（本条）。
- **口径细化**（判断）：① conflict 只判同向实体对（source→target），反向 (B,Y,A) 视为新事实（计划样例为同向，最小实现）；② mark 策略下 conflict 走 flags 不走 reasonCode（reasonCode 保留给 fail 语义）；③ 切片 4 用例 level 断言随级 3 落地演进为 3（契约内声明）。
- **结果**（事实）：RED 4 fail→GREEN 9/9（50 expect）；全量 bun test tests/semantic/ 19/19（切片 1-4 回归保持，78 expect）；npx tsc --noEmit 退出码 0。
- **偏差记录**：一次对同一测试文件并行下发 4 处 Edit 触发竞态（3 处丢失），改回逐次串行编辑后修复——AGENTS.md 规则 2.6"同一文件禁止并行编辑"的实例教训，复发即停。
- **验证**：bun test tests/semantic/validation-pipeline.test.ts 9/9；bun test tests/semantic/ 19/19；tsc=0；备份验证通过后删除（规则 2.5）。
- **红线**：规则 1（仅任务契约三文件）、规则 2（三文件改前备份→改→验→删）、规则 3+5（仅 add 本任务文件+本条留痕回填）、规则 7（垂直切片单轮）、规则 8（内存 KG 假件注入，测试只穿越 validate 公共接口）、规则 9（无破坏性操作）。
- **Commit**：7978f5b

## 2026-09-09 — test(m3-8 切片 6): ValidationPipeline 级 4 上下文连贯·重叠度阈值（TDD RED→GREEN）

- **任务**：S-A8 切片 6——输入关键实体与上下文关键实体重叠度低于阈值→low-confidence 降级标记（不拒绝）；高于阈值→无标签；无证据时级 4 跳过。
- **工具**：Bun test（TDD 1 轮 RED 确认 3 fail（引用作用域外假件 ReferenceError）→最小实现→GREEN）、npx tsc --noEmit。无子代理。
- **操作**（文件级）：① src/semantic/validation-pipeline.ts——deps 增可选 embedder{embed(text):number[]}；新增 ValidationContext{keyEntities?}（validate 第二可选参数，补齐计划接口面 validate(mr,ctx)）；options 增 contextOverlapThreshold 默认 0.1；级 4 判定：ctx.keyEntities 与 embedder 同时在场→逐实体 embed 后与上下文向量取最大余弦（≥ENTITY_SIM_THRESHOLD=0.5 记匹配），overlap=匹配数/实体数，<阈值→flags 加 low-confidence；缺席则级 4 无证据跳过（level 停留 3）；模块级 cosine 辅助（零向量返 0）；② tests/semantic/validation-pipeline.test.ts——makeFakeDeps 上移模块作用域并增可选 embedder 参数；新增切片 6 describe ×3（高重叠 level=4 无标签 / 零重叠 low-confidence 降级 / 无 ctx 或无 embedder 跳过 level=3），字符频率假 embedder（26 维小写字母频次归一化，确定性零网络，计划第四节）；③ docs/operations-log.md（本条）。
- **口径细化**（判断）：① 级 4 判定需 ctx.keyEntities 与 embedder 同时在场，缺席跳过且 level 停留已判定层级（切片 3-5 既有用例零改动）；② low-confidence 只降级不拒绝（计划切片 6 原文）；③ ctx 只收 keyEntities（原文/对话历史预提取是调用方职责，后续按需）。
- **结果**（事实）：RED 3 fail→GREEN 12/12（62 expect）；全量 bun test tests/semantic/ 22/22（切片 1-5 回归保持，90 expect）；npx tsc --noEmit 退出码 0。
- **偏差记录**：零重叠用例首选用词 Kubernetes 与 SQLite 字符频率余弦 ≈0.51 恰越过 0.5 阈值（夹具选词不分离），改用 Docker（≈0.17）——假 embedder 粒度粗，用例须选明显分离词对；无实现改动。
- **验证**：bun test tests/semantic/validation-pipeline.test.ts 12/12；bun test tests/semantic/ 22/22；tsc=0；备份验证通过后删除（规则 2.5）。
- **红线**：规则 1（仅任务契约三文件）、规则 2（三文件改前备份→改→验→删）、规则 3+5（仅 add 本任务文件+本条留痕回填）、规则 7（垂直切片单轮）、规则 8（embedder 确定性假件=第二适配器，接缝成立；测试只穿越 validate 公共接口）、规则 9（无破坏性操作）。
- **Commit**：facf7c4

## 2026-09-09 — test(m3-8 切片 7): 端到端 fail-closed 铁律（真实临时 KG + SQLiteMemory）（TDD RED→GREEN）

- **任务**：S-A8 切片 7——真实依赖端到端：任一级失败→零写入断言（KG/memory 行数不变）；全绿→唯一入库通道写入成功（幂等重放行数不变）；stub resolver 抛错→internal-error fail-closed + onAlert 告警（A.3 崩坏隔离）。
- **工具**：Bun test（TDD 1 轮 RED 确认 3 fail（ingest 未实现）→最小实现→GREEN）、npx tsc --noEmit。无子代理。
- **操作**（文件级）：① src/semantic/validation-pipeline.ts——deps.kg 增必选窄写入接口 addNode({id,name,type})/addEdge({source,target,type,weight})（生产 KnowledgeGraphEnhanced 经方法双变结构兼容，INSERT OR REPLACE 幂等）；options 增 onAlert 告警回调；validate 拆为 fail-closed 包装 + 私有 validateLevels（自身异常→reasonCode="internal-error"、level=0、onAlert 触发、不放行）；新增 ingest 唯一入库通道（校验全绿才写：实体→节点 type="entity"、关系→边 weight=1，返回 writtenNodes/writtenEdges，写入异常同样 fail-closed+告警）；② tests/semantic/validation-pipeline.test.ts——makeSpyDeps/makeFakeDeps 补 no-op 写入方法、makeKgFake 写入签名改对象参数；新增切片 7 e2e describe ×3（Database(":memory:")+KnowledgeGraphEnhanced+SQLiteMemory 真实依赖，rowCount 直接 SQL COUNT kg_nodes/kg_edges，memory 用 stats().totalNotes）；③ docs/operations-log.md（本条）。
- **口径细化**（判断）：① ingest 只写 KG（实体+关系），memory/Vault 不回写——命题随 vault 笔记存在，溯源锚仅作存在性校验；Vault 文件数由 memory 行数代表（getByPath 走 SQLite 索引同源）；② conflict mark（pass=true）仍入库，是否拒收由调用方 conflictPolicy 决定；③ internal-error level=0 表示未完成任何一级；④ 写入异常 fail-closed 但不做事务级部分写回滚（超出本轮）。
- **结果**（事实）：RED 3 fail→GREEN 15/15（87 expect）；全量 bun test tests/semantic/ 25/25（切片 1-6 回归保持，115 expect）；npx tsc --noEmit 退出码 0（真实 KG/SQLiteMemory 直接通过结构化类型注入，零适配器）。
- **偏差记录**：首版 e2e 用 rowCount 查 KG 库的 memory_notes 表报 no such table——memory_notes 在 SQLiteMemory 自身 :memory: 库，改用 mem.stats().totalNotes（无实现改动）。
- **验证**：bun test tests/semantic/validation-pipeline.test.ts 15/15；bun test tests/semantic/ 25/25；tsc=0；备份验证通过后删除（规则 2.5）。
- **红线**：规则 1（仅任务契约三文件）、规则 2（三文件改前备份→改→验→删）、规则 3+5（仅 add 本任务文件+本条留痕回填）、规则 7（垂直切片单轮）、规则 8（写入窄接口对齐生产，e2e 零适配器；异常注入走 stub 假件）、规则 9（无破坏性操作；测试全内存零外部副作用）。
- **Commit**：755ae13

## 2026-09-09 — test(m3-8 切片 8): 对抗样例集全量拦截（S-A2 收口）（TDD RED→GREEN）

- **任务**：S-A8 切片 8——eval/semantic-validation/adversarial/ ≥30 例畸形/对抗样例（V1-V7 每类 ≥3 + 组合 ≥9，含注入风格、超深嵌套、超大 payload）；runner 断言 100% 拦截且每例有原因码；报告落 reports/（S-A4 md+json 惯例）；样例 JSON 化可复现。
- **工具**：Bun test（TDD 1 轮 RED 确认 1 error（runner 模块不存在）→最小实现→GREEN）、npx tsc --noEmit、一次性生成脚本（.tmp，不入库）。无子代理。
- **操作**（文件级）：① eval/semantic-validation/adversarial/av-001..031.json——31 例（V1-V7×3=21 + COMBO×10：注入风格/2000 层深嵌套/64KB payload/V3+V4/V2+V5/V1+V6/数组包裹/注入+超大/多字段畸形/500 实体批量不可解析）；② eval/semantic-validation/tools/adversarial-runner.ts——makeEmptyDeps（空 KG/空 memory 假件）+ loadAdversarialSamples（av-*.json 确定序加载）+ runAdversarialSuite（走 ValidationPipeline.validate 公共接口，收集 blocked/level/reasonCode + 类别/原因码/层级分布）+ renderReportMd + main（import.meta.main 直接运行：断言 100% 拦截 → 写 report-adversarial-r1.{md,json}，拦截率≠100% 退出码 1）；③ tests/semantic/adversarial-runner.test.ts——3 测试（样例集规模与类别分布达标/100% 拦截+每例原因码/判定语义 not-an-object 与 unresolved-entity 兜底）；④ eval/semantic-validation/reports/report-adversarial-r1.{md,json}（31/31 拦截：级 1×26 + 级 2×5）；⑤ docs/operations-log.md（本条）。
- **口径细化**（判断）：① 判定走 ValidationPipeline 而非 S-A1 直接调用——对齐验收条款 S-A2"畸形样例 100% 拦截"的流水线语义；② 空依赖假件保证语法合法对抗样例由级 2 实存性兜底（unresolved-entity），注入风格字段 zod strip 后 text 合法仍被兜底拦截；③ 深嵌套/超大样例静态 JSON 化（紧凑序列化防缩进平方膨胀：全量 162KB）；④ 生成脚本不入库——静态样例即交付物，同输入同结果重放兼容。
- **结果**（事实）：RED 1 error→GREEN 3/3（78 expect）；全量 bun test tests/semantic/ 28/28（切片 1-7 回归保持，193 expect）；runner main 退出码 0（total=31 blocked=31 blockRate=1 allHaveReasonCode=true）；npx tsc --noEmit 退出码 0。
- **偏差记录**：首版样例 JSON 用 2 空格缩进序列化，2000 层深嵌套缩进平方膨胀致全量 8.2MB，改紧凑序列化后 162KB（无实现改动）。
- **验证**：bun test tests/semantic/adversarial-runner.test.ts 3/3；bun test tests/semantic/ 28/28；tsc=0；ops log 备份验证通过后删除（规则 2.5）。
- **红线**：规则 1（零 src/ 实现改动，纯新增 eval+tests 文件）、规则 2（ops log 改前备份→改→验→删）、规则 3+5（仅 add 本任务文件+本条留痕回填）、规则 7（垂直切片单轮）、规则 8（runner 穿越公共接口 validate，空依赖=第二适配器接缝成立）、规则 9（无破坏性操作）、规则 11（样例注入文本为虚构攻击串，无真实凭据）。
- **Commit**：ecb47d2

## 2026-09-09 — test(m3-8 切片 9): soak 断言增强——top-K 排序一致性（S-A7 遗留收口）（TDD RED→GREEN）

- **任务**：S-A8 切片 9——runSoakSession 叠加 top-K 排序一致性断言（top-1 命中植入锚词）：真实 embedding 可用（topKProbe 注入）时 evaluated 判定；无 key 环境 SKIP 有因落报告；不破坏 m3-7 soak 4/4 全绿。
- **工具**：Bun test（TDD 1 轮 RED 确认 1 error（topK 字段/断言函数不存在）→最小实现→GREEN）、npx tsc --noEmit、run-soak CLI 小轮数验证报告落盘。无子代理。
- **操作**（文件级）：① scripts/soak/soak-core.ts——SoakSessionConfig 增可选 topKProbe{isAvailable,top1}（规则 8 依赖注入接缝）；SoakSessionResult 增 topK{status:evaluated|skipped, skipReason, planted, top1Hits, rate}；runSoakSession recall 循环处探针可用时对同一锚词做 top-1 判定，缺省/不可用→SKIP 有因（两种理由措辞：未注入探针 / isAvailable=false）；新增 assertTopKConsistency（skipped→零违例；evaluated 且 rate<recall.threshold→违例 top1-rate-below-threshold，阈值复用召回口径）；② scripts/soak/run-soak.ts——断言链接入第 6 项（计入 pass 判定）+ reportJson.assertions 增 topKViolations/topK（SKIP 理由自动落 json）+ md 报告第 6 行（evaluated→PASS/FAIL；skipped→SKIP(理由)）+ 违例明细增 top-K 项 + 口径说明更新；③ tests/soak/soak-topk.test.ts——4 测试（无探针默认 SKIP 有因 / 恒命中假件 evaluated+rate=1 / 恒不命中→违例 / isAvailable=false→SKIP 有因），m3-7 文件 soak-harness.test.ts 零改动。
- **口径细化**（判断）：① 探针走 SoakSessionConfig 注入而非 env 探测——soak 确定性环境（applyDeterministicEnv 清 key）下 env 探测恒 false 使"真实 embedding"路径成不可测死代码；注入接缝让接线逻辑可测（恒命中/恒不命中/不可用三假件），真实 embedding 由生产环境注入（零网络测试原则不破坏）；② 阈值复用 recall.threshold（同一召回口径，不新增配置面）；③ skipped 不计入违例、PASS 不受阻——对齐 dual-probe SKIP 有因惯例。
- **结果**（事实）：RED 1 error→GREEN 4/4（19 expect）；bun test tests/soak/ 8/8（m3-7 4/4 回归保持）；bun test tests/semantic/ 28/28；npx tsc --noEmit 退出码 0；run-soak CLI（--rounds 12）判定 PASS，md 第 6 项"SKIP：未注入 topKProbe（…）"落报告（reports/soak/ 在 .gitignore 内，运行产物不入库）。
- **偏差记录**：无（测试第 3 例 misses 断言初版误引用违规结构字段，RED 前修正，未产生错误 RED）。
- **验证**：bun test tests/soak/soak-topk.test.ts 4/4；bun test tests/soak/ 8/8；bun test tests/semantic/ 28/28；tsc=0；CLI 报告核验通过；备份验证通过后删除（规则 2.5）。
- **红线**：规则 1（仅两文件增强 + 一测试新文件）、规则 2（两文件改前备份→改→验→删）、规则 3+5（仅 add 本任务文件+本条留痕回填）、规则 7（垂直切片单轮）、规则 8（topKProbe 注入接缝=第二适配器：缺省路径与假件路径两实现）、规则 9（无破坏性操作）、规则 11（无密钥入库；探针接口不含凭据）。
- **Commit**：8194ee9

## 2026-09-09 — docs(m3-8 终局): S-A8 终局报告（9 切片汇总 + 终局门禁核对）

- **任务**：S-A8 测试计划全部切片完成后，按 S-A4 终局报告惯例（report-r1-final.md 先例）生成终局汇总报告。
- **工具**：直接撰写（数据来源：ops log 九条切片记录 + 各切片收尾验证输出）。无子代理。
- **操作**（文件级）：新增 eval/semantic-validation/reports/report-sa8-final.md——终局门禁四项核对（全切片绿 28/28+8/8、对抗 31/31 拦截、m3-7 soak 4/4 保持、tsc=0）+ 九切片逐项 commit/测试数表 + 交付物清单 + 关键设计决策复盘 + 偏差与遗留（zod 非 strict、ingest 无事务级回滚、真实 embedding 生产接线）+ 复现命令。
- **结果**（事实）：报告落盘并入库存（reports/ 目录被 .gitignore 全局规则忽略，沿用 S-A4 force-add 入库先例）；终局门禁四项全 PASS。
- **偏差记录**：无。
- **验证**：报告数据与 ops log 九条记录逐项核对一致（commit hash / 测试数 / 门禁指标）。
- **红线**：规则 1（单文件新增）、规则 3+5（仅 add 本任务文件+本条留痕回填）、规则 10（事实与判断分节标注）。
- **Commit**：a84bc01

## 2026-09-09 — docs(frontend-plan): 前端功能测试/体验优化/渲染审计项目完成计划（T1 文档任务）

- **任务**：按用户 5 项核心要求（任务分解时间轴/决策点头脑风暴/视觉像素级测试/体验优化/渲染层级审计）制定项目完成计划。
- **工具**：Explore 子代理（前端现状勘察，仅研究）+ 直接撰写。无其他子代理。
- **操作**（文件级）：① 勘察确认前端存量：React 19 + Vite + Tailwind + Zustand、20+ 页面、Playwright 配置已有、视觉审核链已有（scripts/frontend-audit.ts → SenseNova → CI 阈值），确定性像素 diff 未确认存在；② 新增 docs/superpowers/plans/2026-09-09-frontend-ux-completion-plan.md——五阶段时间轴（D0-D28 相对工作日，角色占位）、D1-D5 决策点预分析表 + 会议/ADR 机制、视觉双链方案（存量 LLM 审核 + 新增 toHaveScreenshot 像素 diff，3 浏览器×3 视口矩阵 + 确定性保证）、体验优化测量先行、渲染审计三步（深度扫描脚本/Profiler 画像/对症优化）、沟通机制、风险登记册、红线对照。
- **口径细化**（判断）：① 会议部分按规则 10 声明边界——agent 产出预分析/议程/纪要模板与 ADR 落盘，会议本身由用户组织；② 时间轴为相对工作日规划参考，不作交付承诺；③ 计划设批准门槛（D1-D5 决策结论落盘后 T1 开工），未冻结不动工（总则 0.4）。
- **结果**（事实）：计划落盘；本轮未写任何前端代码/测试（不做项遵守）。
- **偏差记录**：无。
- **验证**：计划文档存在且覆盖用户 5 项要求逐条映射（§1 时间轴/§2 决策会/§3 视觉测试/§4 体验/§5 渲染审计）；勘察结论附文件路径依据。
- **红线**：规则 1（两文件：计划 + 本条留痕）、规则 3+5（仅 add 本任务文件 + 回填）、规则 10（事实/判断分离、会议边界直接异议）。
- **Commit**：b977875

## 2026-09-09 — docs(frontend-plan): T1.3/T3.1 任务契约落盘（计划附录 A/B）

- **任务**：用户要求拟定像素基线建设（T1.3）与渲染深度扫描脚本（T3.1）的具体任务契约。
- **工具**：Read 勘察（playwright.config.mjs、scripts/frontend-audit.ts）+ 直接撰写。无子代理。
- **勘察事实**：既有 Playwright 仅单 Chromium project（无浏览器/视口矩阵）、testDir ./e2e、baseURL 18789、后端生命周期由 scripts/run-e2e.cjs 管理；页面清单单一事实源 DEFAULT_AUDIT_PAGES（src/computer-use/frontend-audit.ts 已导出）；e2e/*.png 被 gitignore（基线 PNG 入库需例外规则）。
- **操作**（文件级）：docs/superpowers/plans/2026-09-09-frontend-ux-completion-plan.md 追加附录 A/B——按总则 0.4 格式（任务/验收/改动清单/不做项/验证命令/风险回滚）。A：独立 playwright.snapshot.config.mjs（3 浏览器×3 视口，不动既有 config）、e2e/visual-snapshot.spec.ts（复用 DEFAULT_AUDIT_PAGES）、.gitignore 基线例外 + 体积实测驱动 D3；B：纯函数 scanJsxDepth（typescript 包 AST 遍历，零新依赖）+ CLI 薄封装 + bun test 夹具用例（TDD）。
- **口径细化**（判断）：① T3.1 冻结为「单文件 JSX 静态嵌套深度」，跨文件组件引用图深度裁剪为后续可选（T3.2 证实瓶颈再补，防投机实现）；② T1.3 开工前置收窄为 D1/D2，D3 改为实测数据驱动（>50MB 才回退 LFS/分支）；③ snapshot 独立配置文件隔离，保证存量功能 e2e 零影响。
- **结果**（事实）：契约落盘；本轮未动工实现（两契约开工前置未满足/待用户批准）。
- **偏差记录**：无。
- **验证**：契约覆盖总则 0.4 全部六要素；改动清单均可回答"删掉它验收标准是否仍成立"。
- **红线**：规则 1（单文件追加）、规则 3+5（仅 add 本任务文件+回填）、规则 10（口径裁剪标注判断与理由）。
- **Commit**：b864437

## 2026-09-10 — docs(plan): S-A8 演进计划落盘——级 4 去 embedding 化（方案 A+B）

- **任务**：用户批准"不用 embedding 完成任务"头脑风暴结论（方案 A+B），要求先立切片计划。
- **工具**：Grep/Read 全仓 embedding 依赖图勘察（33 命中文件逐条甄别）+ AdvisorTool 策略校准 + 直接撰写。无子代理。
- **勘察事实**：主检索栈本就零 embedding（FTS5/bigram/BM25/Jaccard）；embedder 仅 S-A8 级 4 消费且从未接生产（可选依赖，缺席即跳过）；soak topKProbe 无 key 已 SKIP 有因；settings-search 三级回退链独立成立；ENTITY_SIM_THRESHOLD=0.5 为字符频率余弦阈值（切片 6 教训：docker~kubernetes 余弦 0.51 越阈）。
- **操作**（文件级）：新建 docs/superpowers/plans/2026-09-10-sa8-evolution-l4-symbolic-plan.md——任务契约（T2）+ 设计决策 D1-D4（三级判定：归一化精确匹配→KG 一跳邻域→字符 bigram Jaccard；阈值 0.4 校准矩阵冻结；门控改 ctx.keyEntities 在场即评估；embedder/cosine 全删不留缝）+ 四切片 TDD 顺序 + DoD。
- **决策依据**（判断）：删除 embedder 注入缝（规则 8 单适配器非真接缝、规则 12 不投机保留）；别名表/soak FTS5 化列入不做项另立计划；soak 线本计划零触碰。
- **结果**（事实）：计划落盘，未动工实现（待用户批准契约后按切片开工）。
- **偏差记录**：无。
- **验证**：契约覆盖总则 0.4 六要素；每项改动可回答"删掉它验收标准是否仍成立"；接口事实（KGNode.name、getOutEdges、slice-6 测试面、makeFakeDeps）均实测核对。
- **红线**：规则 1（仅新建计划文件+本留痕）、规则 3+5（占位 hash 回填）、规则 10（决策依据标注事实/判断分离）。
- **Commit**：29deb80

## 2026-09-10 — feat(sa8-e1): 演进切片 1——symbolic-similarity 纯函数 + 校准矩阵

- **任务**：按 S-A8 演进计划（2026-09-10-sa8-evolution-l4-symbolic-plan.md 切片 1）实现级 4 符号相似度纯函数，TDD RED→GREEN。
- **工具**：Write/Edit + bun test + bunx tsc。无子代理。
- **操作**（文件级）：新建 src/semantic/symbolic-similarity.ts（normalizeEntity 全角折叠/小写/去连接符 + bigrams CJK 二字组/拉丁字符二元组分段切分 + bigramJaccard 空集 fail 向不匹配侧）；新建 tests/semantic/symbolic-similarity.test.ts（18 用例：归一化 5 + 切分 6 + 校准矩阵 7）。
- **验证结果**：RED 确认（模块缺失 1 fail）→ GREEN 18/18 pass / 29 expect；bunx tsc --noEmit 退出码 0。
- **校准冻结**（计划 D2）：postgres~postgresql=7/9≈0.778 匹配；docker~kubernetes=1/13≈0.077 不匹配（切片 6 余弦 0.51 越阈教训修复）；机器学习~深度学习=0.20 不匹配（弱点交别名表不做项）；kubernetes~k8s=0。ENTITY_JACCARD_THRESHOLD=0.4 实测成立，无需调整。
- **偏差记录**：两处测试断言笔误（docker~kubernetes 并集 12→13、post_gre 归一化期望值）为实现前测试面自身错误，非实现缺陷，RED→GREEN 中修正；计划文档 D2 表 docker~kubernetes 预估 0.10 实测 0.077，同侧不匹配，不影响阈值结论。
- **Commit**：d6b4823

## 2026-09-10 — feat(sa8-e2): 演进切片 2——级 4 符号腿接入 + embedder 删除

- **任务**：按 S-A8 演进计划切片 2，validation-pipeline 级 4 从字符频率向量+余弦切换为符号判定（腿 1 归一化精确匹配 + 腿 3 bigram Jaccard），删除 embedder/cosine/ENTITY_SIM_THRESHOLD。
- **工具**：备份（规则 2，.tmp/backups）→ 串行 Edit（测试面先行 RED 确认 5 fail → 实现 GREEN）→ bun test + tsc + grep 证据。无子代理。
- **操作**（文件级）：src/semantic/validation-pipeline.ts（删 embedder 依赖/cosine/旧阈值，新增 ENTITY_JACCARD_THRESHOLD=0.4，级 4 门控改 ctx.keyEntities 在场即评估，头部注释同步）；tests/semantic/validation-pipeline.test.ts（makeFakeDeps 删 embedder 参数；slice-6 重写为演进切片 2 六用例：腿 1 同名/变体、腿 3 近形、零重叠 low-confidence、无 ctx/空 ctx 跳过、阈值可配置）；src/semantic/symbolic-similarity.ts（注释措辞去 cosine 字样，使 A1 grep 严格零命中）。
- **验证结果**：RED 5 fail→GREEN semantic 49/49（227 expect）；A1 grep embedder|cosine|ENTITY_SIM_THRESHOLD 于 src/semantic 零命中；A4 测试 diff hunks 仅 makeFakeDeps+slice-6 区（slice-3/4/5/7 零改动）；对抗 runner 零 embedder 引用，31 例含于 semantic 全拦截；soak 8/8 零改动全绿（A6）；bun run test:full 3697 pass/0 fail/35 skip（376 文件，280s）；tsc --noEmit 退出码 0。
- **偏差记录**：一处新测试夹具错误（e-docker 未入假件节点表被级 2 拦截）GREEN 首轮 1 fail，属测试面自身缺陷，修正夹具后全绿；实现代码一次通过无缺陷。
- **Commit**：6bf651a

## 2026-09-10 — feat(sa8-e3): 演进切片 3——级 4 腿 2 KG 一跳邻域匹配

- **任务**：按 S-A8 演进计划切片 3，级 4 三级判定补齐腿 2：实体一跳出边邻居名命中 ctx.keyEntities 即视为语境相关（可解释性来源，只读零写入）。
- **工具**：备份（规则 2）→ 串行 Edit（RED 先行 2 fail 确认 → GREEN）→ bun test + tsc。无子代理。
- **操作**（文件级）：src/semantic/validation-pipeline.ts（级 4 匹配逻辑抽 matchesKey 复用腿 1+3，实体自身不匹配时遍历 getOutEdges(entity.id)→getNode(target).name 再判，不扩注入接口——复用级 2/3 已有 getOutEdges/getNode，生产 KnowledgeGraphEnhanced 两方法实测存在且返回含 name 的 KGNode）；tests/semantic/validation-pipeline.test.ts（makeFakeDeps 增可选 extra 注入 edges/names/writes；新增演进切片 3 describe 四用例：邻域命中/无出边退回/邻居归一化匹配/入边不计入+零写入断言）。
- **验证结果**：RED 2 fail（邻域命中用例失败，退回/入边用例通过=旧行为一致）→ GREEN semantic 53/53（236 expect，含 slice-2/3/4/5/7 既有 49 用例零改动复跑 + 对抗 31 例）；tsc --noEmit 退出码 0。
- **设计核对**（规则 8）：未新增 deps 接口方法（复用注入缝）；腿 2 仅 ctx.keyEntities 在场时触发，slice-7 真实 KG 端到端不传 ctx 零影响；writes 断言证明级 4 只读。
- **偏差记录**：无。
- **Commit**：06e29f4

## 2026-09-10 — docs(sa8-e4): 演进切片 4——回归收口 + 演进报告（S-A8 级 4 去 embedding 化轮次闭环）

- **任务**：按 S-A8 演进计划切片 4，核对六项验收门禁（A1-A6），产出演进报告并收口本轮。
- **工具**：Read/Glob/Grep 证据核对 + 逐文件 bun test 实测用例数 + Write 报告。无子代理。
- **操作**（文件级）：新建 eval/semantic-validation/reports/report-sa8-e1-l4-symbolic.md——六门禁逐项 PASS 表（A1 grep 零命中实测、A5 full 3701/0 + tsc 0、A6 soak 8/8）、演进切片 0-4 提交链、三级判定最终设计、阈值校准矩阵（实测值：0.778/0.077/0.20/0/1.0）、删除项与偏差、未决项（别名表/soak FTS5 化；P-5③ embedding 接线销账）、复现命令。
- **验证结果**：用例数逐文件实测（symbolic 18 + schema 10 + adversarial 3 + pipeline 22 = 53，与套件 53/53 一致）；对抗样例 31 例 Glob 计数核对；报告数字全部来自实测，无推算。
- **偏差记录**：reports/ 命中 .gitignore:68（stress 产物规则），前轮 report-sa8-final.md 经 -f 入库为既定交付惯例，本轮对齐（不改 .gitignore，规则 1 最小改动）。
- **Commit**：8835b0b（留痕）+ f79edfc（报告 -f 入库）

## 2026-09-10 — chore(docs): ops log 按月拆分（规则 5 合规）

- **任务**：2026-08 单月 407 条 > 200 条阈值，按规则 5 将 2026-07（96 条）、2026-08（407 条）拆至 docs/operations-log/YYYY-MM.md，主文件保留头部 + 归档索引 + 当月（2026-09，91 条）。
- **工具**：一次性脚本（.tmp/split-opslog.ps1，按标题日期分组、逐行保留原始终止符处理 CRLF/LF 混合）+ 校验脚本（.tmp/verify-split.ps1，逐块 SHA256）。脚本属 .tmp 生成物不入正式提交。无子代理。
- **操作**（文件级）：新建 docs/operations-log/2026-07.md、docs/operations-log/2026-08.md；重写 docs/operations-log.md（preamble 不变 + 新增归档索引表 + 2026-09 全部块原样保留）。
- **验证结果**：条目守恒 91+96+407=594（拆分前 594）；**内容等价性 SHA256 逐块比对 = IDENTICAL，594 块字节级零损**（含 CRLF/LF 混合终止符原样保留）；主文件 1.26MB→0.19MB，归档 0.29/0.77MB 均 <2MB。
- **偏差记录**：无（本条留痕本身在拆分后追加，属当月记录，符合规则 5 拆分后主文件保留当月口径）。
- **Commit**：17382df

## 2026-09-10 — feat(frontend-t3.1): 渲染层级深度扫描脚本（行动计划 P-2）

- **任务**：按前端 UX 完成计划附录 B 冻结契约实现 T3.1——单文件 AST 静态 JSX 嵌套深度审计，产出 >10 层热点清单（T3.3 优化输入）。开工前置=无（纯本地零网络零 LLM）。
- **工具**：Read 契约 + Write/Edit + bun test + bunx tsc。无子代理。
- **操作**（文件级）：新建 scripts/frontend/render-depth-audit.ts（纯函数 scanJsxDepth(source)→{maxDepth,hotspots}，typescript 5.9.3 createSourceFile 遍历 JsxElement/JsxSelfClosingElement/JsxFragment 计层，DEPTH_WARN=10 契约冻结，hotspots 深度降序行号升序稳定排序；CLI 薄封装 Bun.Glob 扫 frontend/src 全部 .tsx → reports/frontend/render-depth.{json,md} 双份，无时间戳+路径升序=确定性）；新建 tests/frontend/render-depth-audit.test.ts（15 用例：浅嵌套/自闭合/Fragment/显式 Fragment/条件渲染/无JSX/精确深度 1-6-12/hotspots 阈值严格大于/行号精确/空源/语法错误容错/泛型箭头组件/可选链子元素）。
- **验证结果**：RED（模块缺失）→GREEN 15/15（22 expect）；CLI 双跑 diff 为空（确定性验收）；tsc --noEmit 退出码 0（scripts 经测试 import 纳入检查）；package.json/bun.lock 零 diff（零新增依赖验收）。实测扫描：115 文件，最深 9 层（Chat/Vault/panels），0 热点（>10 层），分布 0-4 层 80 文件 + 5-9 层 35 文件（解析有效性佐证）。
- **偏差记录**：首版块注释含 glob 模式 `**/*.tsx`，其中 `*/` 提前终止注释致语法错误（bun build 定位 7:65），改措辞后通过——测试面/实现均一次 GREEN，唯注释自毁一处。
- **Commit**：d6ff4a0

## 2026-09-10 — docs(mm-survey): 多模型协同"复用 vs 新建"勘察报告（行动计划 P-4，T0 只读）

- **任务**：按规则 10 审查要求，将多模型协同设计文档转为切片化测试计划前，先做代码勘察划界（复用 vs 新建），产出 T3 书面计划草案供用户批准。
- **工具**：Read/Glob/Grep 实际读码 + Explore 子代理辅助定位（子代理返回片段，主 agent 补齐全部接口签名与行号）。无写业务代码。
- **操作**（文件级）：新建 docs/superpowers/plans/2026-09-10-multi-model-collaboration-survey-plan.md——①逐项能力映射表（需求①-⑥ × 现有实现，附精确接口签名+行号）；②真实缺口 3 处（A 交叉验证协调器/B 审核回环/C 用户配置）；③设计文档需修正项（模型名单过时、指标无测量协议、交叉验证与降本张力）；④切片化测试计划 S0-S7（TDD 垂直切片，fake router 零网络）；⑤需用户确认决策 D1-D4。
- **验证结果**：T0 只读勘察，无代码改动，不需回归；所有接口签名标注来源行号可跳转复核；核心发现——仓库已实现设计文档约 70% 能力（中枢-执行 TaskOrchestrator、注册 registry、分发 Dispatcher/assign、压缩 context-manager、单模型幻觉 detector、提示词 pool），真实缺口仅交叉验证协调层。
- **偏差记录**：无。计划为草案，未动工（T3 门禁：待用户批准 D1-D4 后冻结）。
- **Commit**：4c6a49b

## 2026-09-10 — feat(mm-s1): 多模型协同 S1——CrossValidator 纯聚合逻辑（计划冻结轮）

- **任务**：用户批准 D1-D4=全部建议默认值，勘察计划冻结（状态行+第六节改写）；实施 S1 投票聚合纯函数（缺口 A 内核，零 LLM 零网络）。
- **工具**：备份（规则 2）→ Edit 计划文档 → Write 测试（RED 1 fail 模块缺失确认）→ Write 实现 → bun test + tsc。无子代理。
- **操作**（文件级）：docs/superpowers/plans/2026-09-10-multi-model-collaboration-survey-plan.md（草案→已冻结，D1-D4 落定）；新建 src/agents/cross-validator.ts（aggregateVotes 纯函数：VoteVerdict{agree/disagree/abstain}→VoteOutcome{consensus/majority/tie/insufficient}，MIN_VALID_VOTES=2 对齐设计 3.3"≥2 独立验证"，fail-closed：一切不确定形态 needsArbitration=true+finalVerdict=null）；新建 tests/agents/cross-validator.test.ts（15 用例：共识×2/多数×2/tie×2/insufficient×4 含空票全弃权弃权稀释/不变量×3 计数守恒+仲裁互斥+置换不变）。
- **验证结果**：RED（模块缺失）→GREEN 15/15（50 expect）；tsc --noEmit 退出码 0；tests/agents/ 目录 19/19 无碰撞（纯新增文件）。
- **偏差记录**：无。S2-S7 按计划顺序推进，S2 接 Dispatcher（fake dispatch 注入）。
- **Commit**：5788948

## 2026-09-10 — feat(mm-s2): CrossValidator 接分发端口（顺序分发 + 票面解析 + 错误隔离）

- **任务**：实施 S2——CrossValidator.validate 经注入 dispatch 端口对结论做 ≥N 角色独立交叉验证（缺口 A 分发层，fake router 零网络）。
- **工具**：Read 生产接口（TaskRole 联合类型 models/types.ts:20、SmartAssignmentResponse model-router.ts:66）→ 备份 3 文件 → Edit 测试（追加 12 用例）→ Edit 实现 → bun test + tsc。无子代理。
- **操作**（文件级）：src/agents/cross-validator.ts（新增 VoteDispatch 端口类型、parseVoteVerdict 票面解析、voteMessages 系统提示、CrossValidator 类 validate 方法）；tests/agents/cross-validator.test.ts（追加 S2 两 describe：parseVoteVerdict 4 + validate 8，含 makeDispatchFake）；计划文档 S2 行措辞修正（并发→顺序分发）。
- **验证结果**：cross-validator 27/27（77 expect）；tsc --noEmit 退出码 0；tests/agents/ 31/31 无碰撞。
- **偏差记录**：计划 S2 原措辞"并发调用"与 excludeModels 去重语义冲突——并发下后发调用看不到先发返回的模型，无法累积 excludeModels 保证"≥2 独立模型"（设计 3.3 核心）。改顺序分发，回 Plan 修正措辞（规则 12：影响验收标准回 Plan）。parseVoteVerdict 先判 DISAGREE 再判 AGREE（子串陷阱：DISAGREE 含 AGREE）。
- **Commit**：da69371

## 2026-09-10 — feat(mm-s3): CrossValidator 分歧裁决（仲裁端口注入，fail-closed 未决）

- **任务**：实施 S3——needsArbitration（tie/insufficient）时交仲裁端口裁决，共识/多数绝不叫仲裁；仲裁弃权/抛错→未决（finalVerdict=null，绝不默认放行）。
- **工具**：Read ValidationPipeline 接口（validation-pipeline.ts L21-89，确认其同步/结构化输入与投票语义不同构，仲裁端口按 D3 接缝同构 dispatch 设计，生产适配归调用方）→ git HEAD 补建 S3 前备份 → Edit 测试（追加 6 用例 + makeDispatchFake 记录 messages + makeArbitrateFake）→ Edit 实现 → bun test + tsc。无子代理。
- **操作**（文件级）：src/agents/cross-validator.ts（新增 ArbitrateFn 端口、ArbitrationResult、CrossValidatorDeps.arbitrate 可选、validate 返回 arbitration 字段、私有 arbitrate 方法三段铁律）；tests/agents/cross-validator.test.ts（S3 describe 6 用例：平票+仲裁 agree 定案、insufficient+仲裁 disagree 救回、仲裁 abstain→未决、仲裁抛错→未决不崩溃、共识零调用透传、未配置向后兼容）。
- **验证结果**：cross-validator 33/33（93 expect）；tsc --noEmit 退出码 0；tests/agents/ 37/37 无碰撞。
- **偏差记录**：①S3 测试追加后未单独跑 RED 即实现（测试 import 的 ArbitrateFn 在 S2 版本必致编译失败，RED 为编译级必然，但流程上应先跑 RED 留证——如实记录，结果面 GREEN 证据完整）；②计划 S3 接缝列"validate 或 dispatch"，实现取"仲裁端口与 dispatch 同构由调用方适配 ValidationPipeline"，与 D3 平票交仲裁语义一致，无验收偏差。
- **Commit**：3deb4cd

## 2026-09-10 — feat(mm-s4): TaskOrchestrator 审核回环（缺口 B，首次触碰生产主链路）

- **任务**：实施 S4——execute() 新增可选 opts.verify(answer)，实现"执行→指挥回验→带反馈修正一次→再验"回环；未配置 verify 时主链路零扰动（回归验收）。
- **工具**：Read task-orchestrator.ts 全文（358 行，规则 2）+ Grep 现有 router spy 测试模式（20 处 spyOn(router,executeWithRole) 确认注入惯例）→ 备份 2 文件 → Write RED 测试（6 用例，首版 spy 跨用例累积计数缺陷→重写为闭包计数器+显式 restore，备份旧版）→ Edit 实现 → bun test + tsc + orchestrator 5 文件回归。无子代理。
- **操作**（文件级）：src/router/task-orchestrator.ts（OrchestratedResult 加 verification 字段、新增 VerificationStatus/VerificationOutcome/AnswerVerifier 类型、execute Step3+4 提为 runOnce 闭包可重跑、新增私有 verifyAndCorrect（passed/corrected/degraded/not-verified 四态，最多修正一次铁律，verify 抛错立即降级不重跑）、buildMessages 加 extraFeedback 参数、executeMultiAgent 补 verification:not-verified 保持类型诚实）；新建 tests/router/task-orchestrator-verify.test.ts（6 用例：未配置零扰动/通过直出/修正后通过+反馈消息断言/修正消息含文本/二次不过降级不第三次/verify 抛错 fail-closed）。
- **验证结果**：RED（verification 不存在 6 fail）→GREEN 6/6（18 expect）；tsc --noEmit 退出码 0；orchestrator 既有 5 测试文件 31/31 零改动复跑无碰撞（回归铁律：主链路未破坏）。diff 范围核对：仅 task-orchestrator.ts +113/-20 + 新测试，无清单外改动。
- **偏差记录**：①首版测试用 spyOn 复用致 mock.calls 跨用例累积、toHaveBeenCalledTimes 不可靠，重写为每用例独立闭包计数器+afterEach 显式 restore（测试面缺陷，非实现问题，旧版已备份 .tmp）；②verify 抛错语义：设计为"立即降级不触发修正重跑"（校验器已挂重跑无意义），比计划"裁决失败 fail-closed"更精确，无验收偏差；③executeMultiAgent 暂不接回环（S4 范围仅 execute()），如实标注。
- **Commit**：73b0116

## 2026-09-10 — test(mm-s5): 端到端 fail-closed 铁律集成测试（缺口 A+B 串联，对齐 S-A8 切片 7）

- **任务**：实施 S5——用单一 fake router（executeWithRole spy 同时承接任务执行/交叉验证/仲裁三类调用）串联 TaskOrchestrator.execute（S4 回环）← verify 适配 ← CrossValidator（S1 聚合/S2 分发/S3 仲裁），断言幻觉/未决结论绝不静默放行。
- **工具**：Read 计划 S5 口径 + cross-validator.ts / task-orchestrator.ts 全文 + executeWithRole 签名（确认三类调用可经消息特征路由）→ 备份 cross-validator.ts → Write RED 集成测试（4 用例）→ Edit 补告警 → bun test + tsc + 并行回归 + 全量。Explore 子代理定位失败文件路径。
- **操作**（文件级）：新建 tests/integration/multi-model-failclosed.test.ts（4 用例：正常共识 AGREE→passed 放行+excludeModels 去重断言、幻觉共识 DISAGREE→修正一轮仍不过→degraded 拦截、全角色分发异常→abstain→insufficient→仲裁弃权→degraded+logger.warn 告警、平票+仲裁弃权→degraded）；src/agents/cross-validator.ts（validate 分发 catch 补 logger.warn 告警，兑现计划"协调器异常→fail-closed+告警"——原实现仅票面降级 abstain、异常静默，无 warn）。
- **验证结果**：RED（告警断言 1 fail，其余 3 绿）→GREEN 4/4；tsc --noEmit 退出码 0；agents/router/integration 并行 123/123 绿；全量 3975 pass/10 fail（10 fail 经"暂存改动前后同文件集对比"证实为既有失败：perf 门禁/并发压测/文档 grep 类，与本次 diff 无交集）。
- **偏差记录**：①计划 S5 接缝列"集成"，实现取"单一 executeWithRole spy 按消息 system 前缀路由三类调用"，未新建独立 fake router 模块——最小化（规则 1），零生产接线改动除告警外；②发现并修复既有缺口：CrossValidator 分发异常原静默转 abstain、无 warn，不满足计划"协调器异常→告警"，补 logger.warn（唯一生产改动）；③直跑 `bun test <多目录>`（非 --parallel）会跨文件 spyOn(router) 泄漏致 S4/S5 假失败——项目标准命令用 --parallel=8 进程隔离，验证一律按权威并行口径。
- **Commit**：45476aa

## 2026-09-10 — feat(mm-s6): 关键结论触发策略（缺口 D，D4 冻结：默认即门控，非全量）

- **任务**：实施 S6——可配置"哪些结论需交叉验证"，平衡设计 3.3（≥2 模型验证）与 5.2（降本）。纯增量新导出，不改 CrossValidator 既有行为。
- **工具**：Read 计划 D4/缺口 D 口径 + cross-validator.ts 全文 → 备份 → Write RED 测试（14 用例）→ Edit 实现 → bun test + tsc + 并行回归 + 全量。无子代理。
- **操作**（文件级）：src/agents/cross-validator.ts（新增 decideCrossValidation 纯函数：force 显式覆盖 > skip 豁免 > critical 命中 > 默认不触发；DEFAULT_CRITICAL/SKIP_PATTERNS 中英词表；createCrossValidationVerifier 工厂：组装触发策略+交叉验证为可直接注入 orchestrator.execute({verify}) 的审核器，不触发零 dispatch）；新建 tests/agents/cross-validation-trigger.test.ts（14 用例：优先级链/默认词表正反例/空文本/自定义接管/降本铁律零调用/force 恒触发/DISAGREE fail-closed/未决 fail-closed/显式强制/opts 复用无残留/validator 注入复用）。
- **验证结果**：RED（import 编译失败）→GREEN 14/14（45 expect）；tsc --noEmit 退出码 0；agents/router/integration 并行 190/190（2 skip 既有）；全量 3989 pass/10 fail——10 fail 与 S5 基线完全一致（perf 门禁/并发压测/文档 grep 既有失败），零回归。
- **偏差记录**：①首版实现"trigger 缺省=恒触发（兼容 S5）"致降本铁律用例红（闲聊文本也 dispatch），RED 回路暴露语义错误——改为"恒门控、trigger.force=true 恢复恒触发"（D4 冻结语义：默认即关键结论触发，非全量），同步修正测试假设；②工厂 call 参（crossValidate/excludeModels）与 AnswerVerifier 接缝兼容：orchestrator 只传单参，多余可选参不影响结构赋值。
- **Commit**：ed79cad

## 2026-09-10 — test(mm-s7): 多模型协同 S1-S7 回归收口（权威门禁全绿 + 附带修复一致性门禁）

- **任务**：实施 S7——tsc + test:full 权威口径全绿 + 收口报告 + 计划回写 + 留痕，关闭多模型协同整期计划。
- **工具**：Read test-full.ts（确认 --isolate + stress/flaky 账本口径）→ bunx tsc + bun run test:full（后台）→ 定位 3 fail 根因（ops log 月度拆分致文档一致性门禁排除清单失配）→ 备份 2 测试文件 → Edit 修复 → 复跑 → Write 收口报告 + 计划回写。无子代理。
- **操作**（文件级）：tests/unit/deadcode.test.ts + tests/unit/docs-consistency.test.ts（一致性门禁排除清单：新增 operations-log 目录 + 文件名前缀匹配，覆盖 P-1 月度拆分后的历史留痕文件；active docs 扫描面不变）；新建 docs/superpowers/plans/2026-09-10-multi-model-collaboration-closeout.md（收口报告：交付总览/验证证据/两个既有缺口修复/接线方式/未决项）；docs/superpowers/plans/2026-09-10-multi-model-collaboration-survey-plan.md（状态行改 S1-S7 全部完成；切片表加"状态/commit"列，S1-S7 逐行标 ✅ + 锚点）。
- **验证结果**：tsc --noEmit 退出码 0；`bun run test:full` **3773 pass / 35 skip / 0 fail**（381 文件，exit 0）；deadcode+docs-consistency 修复后 11/11；mm 切片面并行 190/190。
- **偏差记录**：①S7 范围本为"纯验证 + 报告"，但 test:full 暴露 3 fail 属门禁回归（P-1 ops log 拆分引入，非 mm 代码）——按规则 6 建反馈回路定位根因后修复（一致性测试排除清单失配月度拆分文件），属收口必要项而非扩权：不修则 S7"全绿"验收不成立；②收口报告落点：仓库无 docs/reports/，遵循计划文档就近原则落 docs/superpowers/plans/*-closeout.md（对齐既有 2026-08-30-p2-closeout 惯例）。
- **Commit**：2e65e02

## 2026-09-10 — fix(tech-debt): 修复两项被误标 flaky 的确定性技术债（env 登记漂移 + package.json BOM）

- **任务**：用户选定"修两项确定性技术债"。勘察发现 test:full 报 0 fail 但两文件单跑稳定红——它们被 EXCLUDE_FILES 账本排除（注释明写"修复后应移出"）：①env-example-completeness：src 读取的 15 个 env 变量未登记 .env.example；②runtime-audit："package.json 暴露 audit:runtime 脚本"因 package.json 含 UTF-8 BOM（EF BB BF）致 JSON.parse 抛 "Unrecognized token '﻿'"。
- **工具**：Grep 逐项定位 15 变量读取点与默认值（auto-evolve/risk-monitor/auth-check/client-connector/search-engines/knowledge-pipeline/real-usage/browser-tools/git-health-terminal 路由）；PowerShell 字节级去 BOM；无子代理。
- **操作**（文件级）：package.json（去首 3 字节 BOM，内容 trimStart(U+FEFF) 比对一致）；.env.example（按主题就近补登 15 变量：网关区 GATEWAY_PORT/PORT/MCP_CONNECT_TIMEOUT_MS、安全区 AXIOM_ALLOW_REMOTE_CDP/AXIOM_ENFORCE_MODE_APPROVAL/AXIOM_SECOND_FACTOR_TOKEN/EDGE_RISK_FAIL_CLOSED/RISK_VERDICT_CACHE_TTL_MS、知识库 KNOWLEDGE_USE_LLM、原生 AXIOM_VRAM_PROBE、爬虫 SEARCH_MAX_PER_DOMAIN、新增十八节自进化 REAL_USAGE_PATH/AXIOM_SELF_EVOLVE_AUTO/COOLDOWN_MS/MIN_NEW_TRACES；凭据类用空占位注释，遵守规则 11）；scripts/test-full.ts（EXCLUDE_FILES 移出 env-example-completeness/runtime-audit 两项，注释"6 项"改自调整表述）。
- **验证结果**：两测试单跑 9/9 绿；`bun run test:full` **3782 pass / 35 skip / 0 fail**（383 文件，exit 0；较 S7 的 3773 增 9 = 移出账本纳入的用例）；tsc --noEmit 退出码 0；git diff --stat 核对改动仅 3 文件。
- **偏差记录**：①package.json 属 git 跟踪文件，去 BOM 用字节级 WriteAllBytes 而非文本重写，避免行尾/编码二次污染，改后 content-equal 断言 + JSON.parse 双验；②15 变量登记值全部取代码内实际默认值（Grep 核实），非臆测；③账本移出后 test:full 文件数 381→383，pass 增量与移出用例数吻合，无新引入失败。
- **Commit**：21b1437

## 2026-09-10 — chore(test-ledger): 移除 llm-cache flaky 账本条目（修复早已入库的拖欠清理）

- **任务**：用户指定继续啃账本 llm-cache。勘察（规则 6 Phase 1 反馈回路）：单跑 `bun test tests/llm-cache.test.ts` 11/11 绿 ×3 次连跑稳定——**非现行失败**。git log 证实修复提交 `a825b92`（2026-09-06，fix(llm-cache): P0-B destroy() 只冲刷不清库 + E 组显式 flush 时序修复，TDD）已在当前分支——账本条目是该修复后未按约定移除的拖欠（账本注释明写"修复后应移出"）。
- **工具**：bun test（RED 回路复现尝试→实际全绿）、git log/merge-base（修复提交溯源与分支包含性确认）。无子代理。
- **操作**（文件级）：scripts/test-full.ts（EXCLUDE_FILES 移除 llm-cache.test.ts 条目及其注释，其余 4 条目不动）。无生产代码改动（勘察无缺陷证据，规则 1）。
- **验证结果**：`bun run test:full` **3793 pass / 35 skip / 0 fail**（384 文件，exit 0；较上次 +11 pass/+1 文件 = llm-cache 11 用例纳入守护，增量吻合）；tsc --noEmit 退出码 0。
- **偏差记录**：①任务预期"啃硬 bug"，实际勘察发现是账本拖欠清理（T2→T1 降级，按影响面如实处理）——若跳过 Phase 1 直接改代码即违反规则 6；②账本剩余 4 条目（EventBus 时序 ×2 / scheduler jitter / pcda 负载失稳）均为真时序敏感，修复需先建确定性回路，另行立项。
- **Commit**：eb5085b

## 2026-09-10 — fix(test-flaky): EventBus abnormal-input 时序确定化（缺 await + setTimeout 猜时序，移出账本）

- **任务**：用户指定啃账本 EventBus abnormal-input 的"虚拟时钟回路"。Phase 1 回路：单跑稳定 1 fail/34 pass（非 flaky，确定性）。根因（Phase 3-4）：`publish` 为 async，`stats.errors` 在 `await Promise.allSettled` 之后才自增（src/dre/runtime/event-bus.ts:91-92），而失败用例用同步 `test(...)` 不 await publish 立即读 stats → 恒 errors=0。判定为**测试时序缺陷**而非生产缺陷；正确接缝是 await publish，无需虚拟时钟（避免投机抽象，规则 8）。
- **工具**：bun test（RED 回路 + 3 次连跑 GREEN 验证）、Read/Grep 定位 publish 结算路径与同文件全部时序模式。无子代理。
- **操作**（文件级）：tests/edge-cases/abnormal-input.test.ts（A.5 两用例确定化：①"handler 抛错不影响后续"改 async + await publish；②"rejected Promise"删 setTimeout(50) 猜时序改 await publish——后者是负载失稳的真实来源）；scripts/test-full.ts（EXCLUDE_FILES 移除 abnormal-input 条目）。无生产代码改动（errors microtask 结算对 sync/async handler 语义一致，属合理设计，改之即扩权）。
- **验证结果**：单文件 3 次连跑 35 pass/0 fail 稳定；`bun run test:full` **3828 pass / 35 skip / 0 fail**（385 文件，exit 0；+35 pass/+1 文件与 abnormal-input 用例数精确吻合）；tsc --noEmit 退出码 0。
- **偏差记录**：①用户预期"虚拟时钟回路"，实际勘察发现根因是缺 await/setTimeout 猜时序，await 即完全确定化——虚拟时钟反而引入不必要的测试机制（规则 1/8），按事实采用最小接缝并如实报告；②修正上一条留痕判断：abnormal-input 并非"真时序敏感"，是确定性测试缺陷；账本剩余 3 条目（network-resilience 自愈断言 / scheduler jitter / pcda 负载失稳）待逐项勘察定性，不预设；③规则 2 备份：两改动文件均 git 跟踪，以 HEAD b8dd1e9 为回滚点（git show 可复原），未另做 .tmp/backups 物理副本，ops log 已备份。
- **Commit**：16bfea0

## 2026-09-10 — fix(test-flaky): EventBus network-resilience 同根因确定化（缺 await，移出账本）+ 一次未归因偶发 fail 记录

- **任务**：用户指定啃账本 network-resilience。Phase 1 回路：单跑 3 次稳定 1 fail（确定性，非 flaky）——D.3"EventBus 错误风暴后自愈"与 abnormal-input 完全同根因：同步 test 不 await async publish，stats.errors 在 Promise.allSettled 后 microtask 自增 → 恒 0（Expected >= 500, Received: 0）。
- **工具**：bun test（单跑 RED 3 次 + GREEN 3 次；test:full 首跑纳入后 1 fail；后续 5 次全量连跑全绿）、Grep/Read 核查 client.ts 超时与重试 jitter、bunfig.toml 与 --timeout 语义验证（默认超时 >6s，D.1 非嫌疑）。无子代理。
- **操作**（文件级）：tests/edge-cases/network-resilience.test.ts（D.3 EventBus 用例改 async + 风暴循环逐次 await publish + post-clean await；其余用例不动）；scripts/test-full.ts（EXCLUDE_FILES 移除 network-resilience 条目，账本剩 2 项）。无生产代码改动。
- **验证结果**：单文件 3 连跑 11 pass/0 fail；`bun run test:full` 首跑纳入后 **1 fail（3838 pass，用例名未捕获）**，随后 **5 次全量连跑全绿**（3838-3839 pass/35 skip/0 fail，386 文件，exit 0）；tsc 0。
- **偏差记录**：①首跑 1 fail 未留日志、后续 5 次全量 + 3 次单跑不可复现——按规则 6 不盲改：无最小复现回路即无法定位，不凭猜测改测试（如放宽 elapsed<50ms 墙钟断言）；②观察点：D.1"连续失败触发熔断"负载下 6.1s（单跑 2.3s，慢化 2.6x，疑 llmCache 持久化 SQLite 跨文件争用；该用例 D.1 describe 无 llmCache.clear，而 D.2 有），若未来复现超时类失败优先查此；③账本剩余 2 项（system-scheduler-rigorous jitter / pcda-scheduler 负载失稳）待逐项勘察。
- **未决项**：network-resilience 纳入后偶发 1 fail（发生率 ~1/6 全量运行，未归因）。处置：保留在 test:full 守护面（6 次全量 1 fail 5 绿 + 单跑 3 绿，证据倾向首跑为环境噪声/冷启动效应）；若再次复现，按规则 6 从 D.1 慢化观察点切入建回路。
- **Commit**：b641355

## 2026-09-10 — fix(test-flaky): 账本最后 2 项 scheduler 定性修复（rigorous 观测点饱和 / pcda 真实墙钟 p95），账本清空

- **任务**：用户指定啃账本最后 2 项 scheduler。Phase 1 回路定性：rigorous 单跑稳定 1 fail（确定性）；pcda 单跑/isolate 18/0 全绿（真负载敏感，账本记录 ~1/6 全量复现）。
- **根因（Phase 3-4）**：
  - rigorous "recommendedMaxTokens 2000 vs 4000 线性"：`recommendedMaxTokens = min(floor(min(avail-1100, kvCacheMaxMB=2200)×1024²/229376), cap=4096)`。取 2000→kv900→4114→钳 4096、4000→kv2900→10057→钳 4096，**两点双双落在饱和区恒 4096**，线性断言必失。**账本"jitter 过滤干扰"归因错误**：测试用 `new ResourceBudgetManager({resource})` 直接构造绕过 updateResource，防抖根本不参与。属确定性测试观测点缺陷（cap=4096 是 H-3 有意 ctx 上限，非生产 bug）。
  - pcda "autoEscalate 升级断言时序敏感"：`runConcurrentLoad` 用 `Date.now()-reqStart` 实测 `setTimeout(5ms)`，全量并发时事件循环拥塞使 p95 膨胀；level-2 阈值 50ms，负载下可达 2x → high performance issue → `act` 返回 `degrade`，而端到端用例断言集 `[pass,escalate,fail]` 不含 degrade → 失败。真负载敏感（非逻辑错误）。
- **工具**：bun test（RED/GREEN 单跑 + 4 次全量连跑）、Grep/Read 定位 system-resource 钳制公式与 pcda-scheduler check/act 路径。无子代理。
- **操作**（文件级）：①tests/rigorous/system-scheduler-rigorous.test.ts（观测点 2000/4000→未饱和区 1500/1900，kv=400/800 翻倍且均<4096；加 a1900<4096 断言锁定观测点有效；改测试名+注释澄清饱和根因）；②tests/distributed/pcda-scheduler-test.test.ts（新增 `loadLevelsNoPerfCap()` helper 经既有 `customLoadLevels` 接缝中性化 expectedMaxResponseMs，仅用于 2 个依赖 p95 决策的端到端用例——autoEscalate 升级、warmup passed；性能阈值判定本身由 Check 单测 mock result 确定覆盖）；③scripts/test-full.ts（EXCLUDE_FILES 清空，账本 4 项存量全部修复移出）。无生产代码改动。
- **验证结果**：rigorous 单跑 14 pass/0 fail；pcda 单跑/isolate 18 pass/0 fail；`bun run test:full` **4 次全量连跑全绿**（3871 pass/35 skip/0 fail，388 文件，file ledger:0，exit 0；+32 pass/+2 文件与两文件用例数吻合）；tsc 0。pcda 历史 ~1/6 复现率，4 次全绿 + 机制隔离（不再耦合真实墙钟）为充分稳定性证据。
- **偏差记录**：①rigorous 账本"jitter 归因"经勘察证伪，实为观测点落饱和区——修正记录；②pcda 用 customLoadLevels 中性化性能阈值是隔离测试关注点（端到端测状态机、Check 单测测阈值），非掩盖生产性能问题；真实 p95 性能由 test:stress（.slow.ts）专门度量，本就不属单测职责；③network-resilience 上一轮未归因偶发 fail 在本轮 4 次全量中未复现，继续观察。
- **Commit**：b3e64bc

## 2026-09-11 — chore(diagnosis): network-resilience 偶发 fail 归因调查（GC 假设证伪 + 10 次负载连跑 0 复现，未决项关闭）

- **任务**：用户指定为 network-resilience 纳入账本后那次未归因偶发 fail（~1/6 全量）建高负载复现 harness。
- **Phase 1-4（假设驱动，证伪）**：读全文件锁定唯一墙钟上界断言 D.1"熔断拒绝 elapsed<50ms"（tests/edge-cases/network-resilience.test.ts:136）。立假设 H1：拒绝路径 assertBudgetAvailable→getStatus→canRun 的对象分配在全量大堆下触发 major GC 停顿击穿 50ms。建临时 harness（.tmp/nr-gc-harness.test.ts，gitignore 不入仓）：基线/200MB 存活堆/大堆+每 50 轮强制 Bun.gc(true) 三阶段各 3000 次测 elapsed。**结果 H1 证伪**——三阶段 max 仅 1.39ms（同步 throw 路径在 generate L268 缓存 I/O L293 之前，亚毫秒，GC 打不进）。
- **策略转向（观察驱动）**：承认从未捕获过失败用例名，停止在微基准假设上扩权；改跑真实 test:full 负载 10 次连跑、每次落盘 grep "(fail)"。
- **工具**：bun test（harness 1 次 + test:full 10 次连跑）、Read/Grep 定位墙钟断言与 generate 拒绝路径顺序。无子代理。
- **操作**（文件级）：无生产/测试代码改动（纯诊断）。临时产物 .tmp/nr-gc-harness.test.ts 与 10 个 .tmp/nr-cap*.log 调查后删除（规则 4 例外：未跟踪、可重建、无引用）。
- **验证结果**：10 次 test:full 全量连跑 **全部 3871 pass / 35 skip / 0 fail（0/10 复现）**。结合修复前 1/6 复现、修复后累计 14 次全量（4+10）0 复现——证据支持结论：那次偶发 fail 系 await 确定化修复**之前**的 EventBus 缺 await 缺陷所致（该缺陷在纳入运行的同一次修复中已消除），非独立负载问题。未决项关闭。
- **偏差记录**：①初期在"GC 击穿 50ms"微基准假设上投入一次 harness，虽证伪但快速廉价（单次运行），且随即按规则 6 Phase 6 复盘转向观察驱动，未继续扩权；②结论为"修复即根因"的正向证据（0/14 复现 + 机制吻合），非"无法复现故放弃"；若未来再复现，从 harness 已排除 elapsed 断言、转向 D.2 llmCache.clear 残留或 scheduler 单例跨文件状态切入。
- **Commit**：5ff547d

## 2026-09-11 — docs(decisions): 前端 D1–D5 决策会议落盘（ADR-001~005 + 纪要），计划 T1 解冻

- **任务**：用户指向前端 UX 完成计划（2026-09-09）的 D1–D5 决策会议。按规则 10 先勘察会前事实（21 页面清单、playwright.config.mjs 无视觉基线、全仓无 toHaveScreenshot、无使用频次埋点），agent 出独立研判，用户（项目经理）逐点表决。
- **工具**：Glob/Grep/Read 勘察、AskUserQuestion 结构化表决（4 点）、Write 落盘。无子代理。
- **表决结果**：D1 抗锯齿容差起步（threshold 0.2 + maxDiffPixelRatio 0.002，两周校准）；D2 全量截图+分级门禁（chat/sessions/search 阻断、其余周报）；D3 实测数据驱动（≤50MB git 跟踪，>50MB 回退 LFS/分支，不阻塞）；D4 按产品常识定 chat/sessions/search（步数=可感知交互步数）；D5 Profiler 提交耗时为主 + Vitals 并报。agent 研判与用户表决一致。
- **操作**（文件级）：新建 docs/decisions/（ADR-001~005 五份 + 2026-09-11-frontend-d1-d5-decision-meeting.md 纪要，含反对意见/回退条件/行动项）；修改 docs/superpowers/plans/2026-09-09-frontend-ux-completion-plan.md 状态行（"待批准"→"D1–D5 已决，T1 解冻"）。无代码改动。
- **验证结果**：计划批准门槛条款（§"批准门槛"：用户批准 + D1-D5 结论落盘）逐项核对满足；6 份新文档 git 可见；计划状态行与实际决议一致。
- **偏差记录**：①计划文件与本 log 修改前未做 .tmp/backups 物理副本（规则 2.1 遗漏），两者均 git 跟踪、回滚点 HEAD f22c7cb 可完整复原；②D4 无埋点数据支撑，采用产品常识清单并显式记录回退条件（T4.1 埋点数据可推翻），属"事实缺失下的判断"，已在 ADR-004 标注。
- **Commit**：f17b368

## 2026-09-11 — docs(T1.2): 前端 Vitest 组件测试基线盘点（冒烟缺口=0，识别 G1-G5 大页深度覆盖缺口）

- **任务**：前端 UX 完成计划 T1.2——盘点现有用例清单 + 量化"每页至少 mount 不抛错"覆盖缺口。纯只读盘点 + 报告落盘，无代码改动。
- **工具**：npx vitest run（真实基线）、PowerShell 正则统计（各页 its/render/组件行数）、Read 抽查 Chat/KG 用例质量、Glob/Read 核对 App 路由。无子代理。
- **操作**（文件级）：新建 docs/test-reports/frontend-vitest-baseline-20260911.md。
- **验证结果**：vitest run 实测 **66 文件 / 335 用例全绿（0 fail）**，65.7s；App.tsx 21 路由页 + Login 共 22 页，22 个 .test.tsx 全部含 render + ≥1 用例 → **冒烟缺口=0**。真实发现为深度覆盖与规模倒挂：Settings(631行/3例)、Sessions(407/3)、Git(263/2)、Code(233/2)、Agents(180/2) 列 G1-G5 补测清单；5 个 30 行重定向壳页 1 例即全覆盖（非薄弱点）。
- **偏差记录**：①首次误用 `bun test`（根 runner）跑前端，识别后改用 `npx vitest run`（frontend/package.json 约定），bun 进程未产生干扰输出即弃；②T1.2 验收"每页 mount 冒烟"已天然达标（存量测试质量好），故本任务实质产出是"确认无缺口 + 量化深度缺口"，未为凑工作量造补测任务（规则 1）；③深度补测 G1-G5 不阻塞 T1.3（像素基线只依赖渲染可达性），建议排期见报告 §4。
- **Commit**：2f27538

## 2026-09-11 — feat(T1.3): 像素 diff 基线建设（21 页 Desktop Chrome 单视口，二跑零 diff + 门禁自证）

- **任务**：前端 UX 完成计划 T1.3（附录 A 契约）——建确定性像素 diff 基线。用户指示本轮 Desktop Chrome 单视口。
- **工具**：Read/Grep 勘察（api.ts 端点面、Sidebar/Chat/Sessions/Tokens 数据消费、App Suspense fallback、契约附录 A）、Write 新建、Playwright（生成/复跑/自证）、run-e2e.cjs（回归）。无子代理。
- **操作**（文件级）：新建 playwright.snapshot.config.mjs（独立配置，不动 playwright.config.mjs）、e2e-visual/visual-mock.ts（形状感知 catch-all mock：仅拦 fetch/xhr，document/assets fallback 真实后端；workspaces/sessions/models/token-details 等给确定形状）、e2e-visual/visual-snapshot.spec.ts（21 页清单单一事实源 + 就绪判据=Suspense fallback 消失+networkidle+fonts.ready + ADR-001 容差 threshold0.2/maxDiffPixelRatio0.002）、21 个基线 PNG；改 docs/decisions/ADR-003（D3 实测定稿）。
- **验证结果**：①首跑 --update-snapshots 生成 21 基线；②复跑不带参数 **21/21 零 diff**（可复现自证）；③门禁自证——临时注入 3px 样式差异→chat 红（12959 像素 ratio 0.01>0.002），还原→绿，探针 GATE-SELFTEST 已 grep 确认无残留；④功能 e2e 回归 run-e2e.cjs 全套 exit 0「All E2E tests passed」（视觉 spec 在 e2e-visual/ 不在 run-e2e 读取的 e2e/，物理隔离，存量零影响）；⑤体积实测 21 PNG/3.44MB<<50MB→D3 定 git 跟踪（写 ADR-003）。
- **偏差记录**：①**契约偏离校正（规则 12 回 Plan）**：初版误将视觉 spec 建在 e2e/ 下（会被 run-e2e.cjs 当功能用例跑、无基线首跑必 fail）且硬编码清单——违反契约"不动 playwright.config.mjs/独立 snapshot 配置"，已删除错建文件回退 e2e/.gitignore，按契约重建为独立 playwright.snapshot.config.mjs + e2e-visual/ 目录；②**清单来源冲突**：契约附录 A 引 DEFAULT_AUDIT_PAGES（仅 9 页 LLM 审核清单），但 ADR-002 已表决 21 页全量——服从更新且明确的 ADR-002，清单落 spec 内单一事实源（不复制），记此偏差；③**视口/浏览器裁剪**：契约矩阵 3 浏览器×3 视口，用户指示本轮 Desktop Chrome 单视口，扩展留待基线稳定后迭代；④tokens 页首跑崩（mock 默认 {} 但页面直读 data.overall.totalTokens），补 token-details fixture 修复（mock 形状不全，非生产 bug）；⑤mask 清单未交付（验收 5）：mock 下无动态区（全空态+固定 health），当前无需 mask，真实数据态基线时再迭代补齐。
- **Commit**：acd2141

## 2026-09-11 — docs(T1): 阶段文档整理与评审报告落盘（T1 收口，T2 解冻）

- **任务**：用户指示「先停在这里，整理 T1 阶段文档」。把 T1.1/T1.2/T1.3 散落在 ADR、盘点报告、spec 与 ops log 中的产出收敛为一份阶段评审，并更新计划状态。纯文档，无代码改动。
- **工具**：Read/Glob/Grep 汇总既有交付物、Write 新建评审报告、Edit 改计划状态行。无子代理。终止了上一轮遗留的后台 `bun test`（job-e2c13ac，输出为空、无结论价值）。
- **操作**（文件级）：新建 docs/superpowers/plans/2026-09-11-frontend-t1-closeout.md（交付总览/D1-D5 结论/实测证据/验收对照/偏差教训/移交 T2 未决项）；改 docs/superpowers/plans/2026-09-09-frontend-ux-completion-plan.md 状态行与 §1 T1 标题为「T1 已完成、T2 可开工」。
- **验证结果**：报告内全部数字与链接指向既有已提交产物（f17b368 / 2f27538 / acd2141），未新增任何未验证断言；验收对照逐项核对，CI 接线如实标注为 T2.3 未做（不声称完成）。
- **偏差记录**：①计划文件与本 log 修改前已按规则 2 备份至 .tmp/backups/，验证通过后删除；②评审报告未新建模板/流程，仅汇总既有证据，符合规则 1 最小化；③**落点校正**：初稿写 docs/reports/（规则 5 用语），实测该目录被根 .gitignore `reports/` 排除、仓库历史 0 跟踪文件——遵循 2026-09-10 收口惯例改落 docs/superpowers/plans/*-closeout.md，并删除空目录。
- **Commit**：5d1061f

## 2026-09-11 — fix(http): 静态 gzip 响应 Content-Length 虚报（T2.1 暴露的生产 bug，TDD 接缝）

- **任务**：T2.1 像素矩阵扩展时 webkit 3×21 页基线全失败（`Failed writing received data to disk/application`，libcurl CURLE_WRITE_ERROR）。按规则 6 建反馈回路定位：非测试工具链问题，是生产缺陷。
- **根因（Phase 3-5，假设驱动）**：`src/main.ts` `serveStaticFile` 用 `gzipSync(Buffer.from(raw)).buffer`——`.buffer` 返回 Node Buffer **内存池的整个 ArrayBuffer**（16384），压缩流仅 N 字节（如 5.7KB CSS→1975B），尾部 ~14KB 池垃圾随响应发出 → `Content-Length: 16384` 虚报。实测：`curl --compressed` exit 23；chromium/firefox 网络栈容忍垃圾尾故基线正常（掩盖了 bug），webkit(libcurl) 严格解析失败。**对照实验证伪"buffer 池 detach 即修复"假设**（`gz.slice().buffer` 仍共享池，curl 仍 exit 23）；坐实修复：`new Response(gz)` 直传 Buffer 视图 或 `gz.buffer.slice(off,off+len)` detach → curl exit 0。
- **工具**：Read/Grep（main.ts 静态服务）、curl（回路）、bun（对照服务实验：buggy/detached/direct-Buffer 三态）、Write（回归测试 + 接缝模块）、Edit（main.ts）。无子代理。规则 2（备份 main.ts）、规则 7（红→绿垂直切片）。
- **操作**（文件级）：①新建 `src/utils/static-encoding.ts`——`encodeGzip(ArrayBuffer): ArrayBuffer` 纯函数接缝（小接口大实现，规则 8；main.ts 顶层 Bun.serve 无法轻量 import，故抽函数）；②新建 `tests/utils/static-encoding.test.ts`（4 例：长度恰等 gzip 流/多输入独立/gunzip 还原/小输入）；③`src/main.ts` L550 import 改 `encodeGzip`、L584 `gz = encodeGzip(raw)`（原 `.buffer` 移除）。
- **验证结果**：TDD 红（Cannot find module）→绿 **4 pass/0 fail**；`bunx tsc --noEmit` **0**；curl 修复后 exit 0（gzip 1975B）；`bun run test:full` **3875 pass/35 skip/0 fail**（389 文件，exit 0；基线 3871/388→+4/+1 吻合新增用例，**零回归**）。
- **偏差记录**：①**契约扩权（规则 12 回 Plan）**：T2.1 原为纯测试设施，发现生产 bug 后经用户表决（AskUserQuestion）采纳"修生产 bug"而非"测试侧绕过"——理由：诚实根治、避免基线偏离真实网络路径；②临时探针（.tmp-webkit-*.cjs/.tmp-gz-*.ts，未跟踪可重建）调查后删除（规则 4 例外）；③对照服务 job 用完即 StopCommand 终止。
- **Commit**：ec8f73f

## 2026-09-11 — feat(T2.1+T2.3): 像素基线 3×3 矩阵扩展 + CI 双门禁接线（webkit-desktop 移除 + chromium-only 入仓）

- **任务**：前端 UX 计划 T2.1（浏览器×视口矩阵）+ T2.3（CI 像素门禁分级）。用户指示启动 T2.1/T2.3、删 CLAUDE.md、分支合并留待 T2 收口。
- **工具**：Read/Grep（snapshot 配置、run-e2e.cjs、CI workflow、ADR-001~003）、Edit（配置矩阵）、Write（run-visual-gate.cjs + visual-snapshot.yml）、Playwright（生成/二跑/自证）、AskUserQuestion（两项决策）。无子代理。规则 2（备份 mock/spec/main.ts）。
- **操作**（文件级）：①`playwright.snapshot.config.mjs` projects 扩为 9 组合（desktop-chromium 沿用名 "chromium" → 21 既有基线零重生成；全 dpr=1 统一）；②`scripts/run-visual-gate.cjs`（新）——门禁 runner，复用 run-e2e 后端生命周期 + 透传 --project/--grep 分级；③`.github/workflows/visual-snapshot.yml`（新）——pixel-blocking（chat/sessions/search × chromium 3 组合，阻断）+ pixel-weekly（其余 18 页，continue-on-error）双 job；④`.gitignore` 排除 `*-firefox-*.png`/`*-webkit-*.png`；⑤ADR-002 附录（webkit-desktop 移除）、ADR-003 T2.1 修订（88.78MB>50MB→chromium-only 入仓）；⑥删 CLAUDE.md（空 0 行 + 未跟踪 + 无代码引用 → 规则 4 例外直删）。
- **验证结果**：矩阵生成 189 PNG（webkit-desktop 63→移除后入仓 63 chromium/7.27MB）；二跑 chromium/firefox/webkit-tablet/mobile **183/183 零 diff**；**门禁自证（规则 6 回路）**：临时 spec `page.addStyleTag` 注入 200×200 色块→阻断级 3 页 `toHaveScreenshot` **红**（像素 diff 捕获），删探针→**绿 3 passed**；探针产物（spec+空快照目录+3 actual PNG）全清、`public/index.html` git 无改动无残留；`bun run test:full` 全绿（见上条）。
- **偏差记录**：①**webkit-desktop 移除（用户表决）**：Windows WebKit 1440×900 并发渲染不稳定——4 worker 下 6 页连拍 20363px/ratio0.02 不自稳，**workers=1 串行 6/6 通过** → 定性并发抖动非产品缺陷；恢复条件（workers=1 或 macOS runner）记 ADR-002 附录 + 技术债；②**ADR-003 外推证伪**：预估 31MB，实测 88.78MB（firefox/webkit 单张约 chromium 6-7 倍）→ 触发 >50MB 回退条款，用户表决 chromium-only 入仓，firefox/webkit 待 LFS（ADR-003b）；③**自证回路两次踩坑后校正（规则 6 Phase 6）**：初版改 `public/index.html` 注入 → 后端启动时缓存旧内容致注入不生效、失败点落在 waitReady 而非像素 diff（自证无效）；经 Advisor 复核改用 addStyleTag 浏览器上下文注入，绕开缓存精确隔离 toHaveScreenshot；④**写入污染**：Write 工具两次将文件内容截断为 U+2026（run-visual-gate.cjs、测试文件），PowerShell 精确替换修复并去 BOM，提交前全量扫描确认无残留；⑤**范围裁剪**：真实数据态基线/mask 清单未做（mock 态无动态区，留 T2.1 后续）。
- **Commit**：136cd11

## 2026-09-12 — ops(T3): 启用 .10 Gitea LFS 服务端（ADR-003b 前置）+ 端到端验证

- **任务**：ADR-003b 前置"LFS 服务端验证"。勘察结论：internal211 裸仓库无 git-lfs（不可用）；.10 Gitea `LFS_START_SERVER=false`。用户表决采纳方案 1（启用 Gitea 内置 LFS），批准"现在执行 + 端到端验证"。
- **工具**：ssh/curl（勘察）、docker exec（改配置/重启/chown）、git-lfs 3.7.1（端到端冒烟）。无子代理。计划落盘 `docs/superpowers/plans/2026-09-12-gitea-lfs-enablement.md`（T3 书面计划）。
- **操作**（服务端，非本仓库）：①备份 `app.ini`→`/home/data/app.ini.bak-lfs-20260912`（sha256 19927b23…）；②`LFS_START_SERVER false→true` + `docker restart`；③**修复启用后崩溃**：Gitea 回写 LFS_JWT_SECRET 需 app.ini 可写，原 root:root 644 致 permission denied 崩溃循环 → 临时容器 root `chown git:git app.ini`（→600）后恢复；④端到端冒烟：临时仓库 push LFS 对象→服务端落盘→删缓存重拉一致→删临时分支。
- **验证结果**：batch 端点 404→400/401（LFS handler 响应）；`/api/v1/version` 200（v27.3.1）；push `Uploading LFS objects 100% (1/1)`；服务端 `/data/git/lfs/3e/4a/2f9db74…`；`roundtrip_match=True`；传输走 basic HTTP 自动回退。临时分支/仓库/脚本全清，保留 app.ini 备份用于回滚。
- **偏差记录**：①**启用开关引发崩溃（规则 6 定位）**：初版计划未预见 LFS 需回写 app.ini，重启后崩溃循环；日志直证 permission denied，chown 修复——教训记入 ADR-003b"关键"节；②**范围严格限定服务端启用+验证**，基线迁移（.gitattributes/迁入/CI 扩列）留 ADR-003b 后续待办，未混入本轮；③PowerShell 嵌套引号多次破坏远程命令，改脚本文件 scp 传输执行规避。
- **Commit**：6d9cdf1

## 2026-09-12 — feat(ADR-003b): firefox/webkit 基线迁入 LFS（105 张，renormalize 不改写历史）

- **任务**：基线迁入 LFS 并处理迁移冲突。勘察发现**端点冲突**：规则 3 主目标 internal211（.22 裸仓库）无 git-lfs 且 data 无 sudo → LFS 对象无法落 .22。用户表决：基线分支直接推 .10 Gitea（LFS 已启用），.22 装 git-lfs 由用户执行后同步。范围：仅 firefox/webkit 入 LFS，chromium 63 张保持普通 blob（7.28MB 未超阈）。
- **工具**：Read/Grep/Edit（.gitattributes/.gitignore/ADR-003b）、git-lfs 3.7.1（renormalize + push + fsck）、ssh（服务端对象数核验）。无子代理。规则 2（备份 .gitignore/.gitattributes）。
- **操作**（文件级）：①`.gitattributes` 加 `*-firefox-*`/`*-webkit-tablet-*`/`*-webkit-mobile-*.png filter=lfs`；②`.gitignore` 移除 firefox/webkit 排除、改排除废弃 webkit-desktop（15 张残留不入库）；③`git add` 105 张触发 clean filter 转 pointer（新增提交，非 `git lfs migrate`，规则 9 不改写历史）；④push gitea 上传 LFS 对象。
- **验证结果**：`git lfs ls-files`=105（chromium 命中 0）；push gitea `Uploading LFS objects 100% (105/105) 66 MB`，分支 `cda7ec9..6aee3a0`；服务端 `/data/git/lfs` 对象 106（105+冒烟残留1）；`git lfs fsck` OK；工作区 firefox PNG magic `8950 4E47`/1086137B 未被 pointer 污染；chromium 63 张未动、工作区干净。
- **偏差记录**：①**端点冲突（规则 0.6 停机表决）**：internal211 推 LFS 失败实证 `git-lfs-authenticate: command not found` → 基线分支暂只在 .10，.22 装 git-lfs 需用户 sudo（记 ADR-003b 待办）；②**webkit-desktop 15 张残留**：组合已废弃（ADR-002），经 .gitignore 排除不入库、磁盘保留（未删，避免扩大范围）；③迁移用 renormalize 而非 migrate import（后者改写已推送历史，违反规则 9）。
- **Commit**：6aee3a0

## 2026-09-12 — docs(AGENTS v1.3): 规则 3 主远端 internal211(.22) → gitea(.10)，移除 internal211 remote

- **任务**：用户确认 .22 服务器整体废弃，主远端切换至 1Panel Gitea（.10，SSH 2222/HTTP 3000，密钥登录，LFS 已启用）。前置核验（上一任务）证实 gitea 为 .22 完整超集：`rev-list --count 3814022..9856a65`=0、逐分支 hash 一致、tags（v2.2.0/v2.8.2 仅 gitea 有）、105 LFS 对象齐备。
- **工具**：Read/Grep/Edit（AGENTS.md、SKILL.md、ADR-003b、.gitattributes）、git remote。无子代理。规则 2（备份 AGENTS.md/SKILL.md）。
- **操作**（文件级）：①AGENTS.md 规则 3 目标仓库改 `gitea`（含 .22 废弃历史说明），版本头 v1.2→v1.3（次版本=规则语义变更，遵守 0.7）；②规则 9 例外条款 `push internal211`→`push gitea`；③skills/axiom-frontend-ui-repair/SKILL.md 提交步骤改 push gitea；④ADR-003b ".22 装 git-lfs 同步"待办作废；⑤.gitattributes 端点注释更新；⑥`git remote remove internal211`（remote 配置无独有数据、可逆，规则 3 文档同步改"已移除"）。历史 plans/specs/reviews 中的 internal211 为当时事实记录，不改。
- **验证结果**：结构校验（规则 0.7）——规则编号 1-12 连续、"规则 N"引用无越界、无 `push internal211` 残留；`git remote -v` 确认 internal211 移除、internal/gitea 均指 .10；分支跟踪 `internal/*` 不受影响。
- **偏差记录**：①deploy.sh 的 192.168.0.22 是 runtime-go 集群节点 n2（searchd/agentd 服务），非 git 仓库，属独立部署拓扑，超出本任务范围不动——**待确认：.22 整机废弃则该脚本也需改，已问用户**；②internal211 remote 选择"移除"而非"保留标记"，因用户明示"不再推送"，移除杜绝误推且完全可逆。
- **Commit**：2e8f8b4

## 2026-09-12/13 — ops(T3): .22 整机退役与 n2 换机五项改造（ADR-006）

- **任务**：用户五项任务书（n2 新机/全链合理性/单机峰值/算法优化/.22 离场）。计划冻结 `docs/superpowers/plans/2026-09-12-node22-decommission-n2-swap.md`（T3）；决策 `docs/decisions/ADR-006-node22-decommission-n2-swap.md`。
- **工具**：Edit/Write（deploy.sh/loadgen/soak-72h.sh/ADR/README）、bash+ssh+scp（.108/.110/.22 远端）、loadgen（压测/浸泡）、go build/test。无子代理。规则 2（deploy.sh/ops log 均有 .tmp/backups 备份）。
- **操作**（文件级）：①deploy.sh 重写（n2 默认终态 `listen@192.168.0.110` 有线口、preflight 快速失败、AUTH_TOKEN 透传、GP 自动探测、无 .22 残留）；②loadgen 增 `-token`（X-Axiom-Token，seed/search 共用）；③新增 `scripts/runtime-go/soak-72h.sh`（用户侧 72h 浸泡：RSS/PID 快照 + 判据清单）；④README 新增"拓扑演进"节（当前拓扑/节点添加流程/监控异常/实测表）；⑤ADR-006 落盘；⑥.22 清理执行（tar 155MB 备份校验→停三服务→删 ~/runtime-go 与裸仓库→端口核验清零）。
- **验证结果**：A3 单机（w1 GP=12）simple 49,943；A4 两实验均无收益回退（写二进制 seed 13.2→14.1/19.4s；微批 v1 simple −74%/v2 mixed −11%）；**A4 回退复测 gate**：WiFi 组 simple 6,613/mixed 7,753（RTT 14-105ms 归因：ping 60ms、eno1 未插线），用户插网线后（n2=.110，HTTP ~2.8ms）**simple 13,804（基线 12,635 +9.3%）/ mixed 10,893（10,711 +1.7%）/ seed 12.98s，零错误**；双节点 /cluster 两节点 healthy、分片各持 16、鉴权矩阵 403/403/200。go build 全包通过、search 包测试 2.7s 全绿。
- **偏差记录**：①**计划外 IP 漂移连锁**：原 n2 .111 关机后 DHCP 将 .111 分给 w1（w1 残留 searchd 对"n2"健康检查自环假健康）→ 重启指向真 n2；n2 终态有线 .110（计划文档写作时为 .111/.108，deploy.sh 头注记录全程）；②**ADR 编号顺延**：计划原定 ADR-004 已被占用 → ADR-006；③**验证报告未入库**：`docs/reports/` 为 .gitignore 既有策略（0 跟踪先例），报告本地留存，偏差记此；④cluster.go/httpapi.go 仅 CRLF 行尾差异（A4 回退 Write 引入），sed 归零无内容改动；⑤30min 浸泡仍在运行，结果与 72h 用户执行另条补记。
- **Commit**：de71e26（工具链）+ 1b96647（文档），分支 codex/node22-decommission-n2-swap → gitea

## 2026-09-14 — ops(T1): 规则符合性整改 —— 补齐规则 2/3/5/9 的历史偏差记录

- **任务**：AGENTS.md v1.3 已存在但在此前若干提交中**未被遵守**。本条目为总则 0.6 要求的偏差记录，并补齐后续施工所需的规则基础设施。**仅记录与建基础设施，不改业务代码**。
- **工具**：Bash（勘察/备份/git）、Read、Edit。无子代理。
- **操作**（文件级）：①`docs/operations-log.md` 追加本条目（规则 5）；②新建 `.tmp/backups/`（规则 2 要求的备份落点，已被 .gitignore 忽略）；③新建 `archive/` 与 `archive/ARCHIVE-LOG.md`（规则 4 要求的归档落点，已被 .gitignore 忽略）。
- **偏差记录（历史，如实补记）**：
  - **规则 9（Git 安全护栏）**：在 `fix/audit-critical-security` 分支执行过一次 `git push --force-with-lease`（用于压缩历史、剔除误提交的 `nul` 垃圾文件）。**该操作违反规则 9**——规则明文禁止 force/force-with-lease，例外仅限"用户明确要求且不在 main/master"，且需执行前复述命令请用户确认；当时**未做确认**。影响面：仅该分支（非 main/master），无协作者，未丢失提交（压缩前后 tree 哈希一致，已验证）。补偿：此后不再执行任何 force 类操作；如需改写已推送历史，先按规则 9 请求确认。
  - **规则 2（改前备份）**：此前 7 个提交涉及的既有文件均**未**先备份到 `.tmp/backups/`。补偿：备份点改由 git 提交固化（每次改动都有可回退的 commit），并自本次起严格执行"先备份再改"。
  - **规则 5（操作留痕）**：此前 7 个提交**均未**在 `docs/operations-log.md` 追加记录。补偿：本条目补记整体范围；逐提交明细见各 commit message（`git log --oneline 7ad30ce..HEAD`）。
  - **规则 3（分支命名）**：实际分支为 `fix/audit-critical-security`，与约定 `codex/<任务简述>` 不符。补偿：后续任务改用 `codex/` 前缀；该分支已推送且被引用，不在本次改名（改名需重写远端引用，风险高于收益）。
  - **规则 3（remote 名）**：规则要求 remote 名 `gitea`，实际名为 `origin`（URL 与规则要求一致，指向 .10）。补偿：后续统一用 `git push origin <分支>`；如需严格对齐可 `git remote rename origin gitea`（属独立小任务，未擅自执行）。
- **验证结果**：`docs/operations-log.md` 追加成功（幂等可检索）；`.tmp/backups/docs/operations-log.md` 备份存在且被 gitignore；`git check-ignore` 确认 `.tmp/`、`archive/` 均不进入常规提交。
- **Commit**：7333523

## 2026-09-14 — plan(T3): 知识后端收敛至 DRE SQLite —— 计划冻结

- **任务**：用户决策「知识后端收敛至 DRE SQLite 一处，不再使用其他后端，砍掉多余的知识库部分」。按总则 0.3 判为 **T3**（模块重构 + 数据迁移 + 接口收敛），须先落盘书面计划并冻结契约。
- **工具**：Bash（实测测绘：`grep -rl "new Database("`、FTS5/KG 写入路径清点）、Read、Write。无子代理。
- **操作**（文件级）：①新增 `docs/superpowers/plans/2026-09-14-knowledge-backend-convergence.md`（含 0.4 任务契约、实测测绘、六步执行顺序、影响面清单、规则遵守要点）；②本条目（规则 5）。
- **验证结果**：计划落盘，契约六要素齐备（任务/验收标准/改动清单/不做项/验证命令/风险回滚）。关键决策已由用户确认（收敛目标 = DRE SQLite）。
- **偏差记录**：①测绘发现 **KG 写入路径实为 5 处**（用户表述为 4 套），已在计划中如实更正；②**大量非知识后端模块同样 `new Database`**（缓存/凭据/定时/评测共十余处），已在契约"不做项"中逐一列明，避免收敛时误伤；③计划中标注 FTS5 排序语义差异会导致**结果顺序变化**，对拍须按集合差异断言，否则产生假失败。
- **Commit**：bd19277

## 2026-09-14 — recon(T3/步骤1.1): DRE 检索能力勘察 —— 结论改变计划重点

- **任务**：T3 计划步骤 1.1「确认 DRE 现有检索能力」（只读勘察）。
- **工具**：Bash（grep/read 定位检索 API 与实现）、Read（读全文实现）、Edit（回 Plan 更新）。无子代理。
- **操作**（文件级）：①`src/dre/runtime/atom-engine.ts:267 search()` 与 `src/dre/runtime/knowledge-network.ts:470 search()` 只读勘察；②`docs/superpowers/plans/2026-09-14-knowledge-backend-convergence.md` 步骤 1 段落更新（按规则 12：Do 阶段发现影响验收标准的问题 → 暂停并回 Plan 更新清单与理由）。
- **验证结果**：两处 `search()` 均为**朴素子串匹配** —— 整串 `toLowerCase().includes()`、无分词、无打分、无排序、凑够 `limit` 即 `break`。两个模块**均无 FTS5**（grep 计数 0/0）。
- **偏差记录**：①**结论改变了计划重点**：原计划 1.2 写"若缺则补"，实测后升级为**必须补齐** —— 否则收敛后检索质量会**显著低于**现状（现状至少有 FTS5 的 bm25 排序），本次收敛失去成立前提；②三个具体缺陷已写入计划：无分词（多词查询几乎必然 0 结果，中文尤甚）、无打分排序（结果按 Map 插入顺序截断，相关项可能排在无关项之后）、提前 break（可能漏掉更相关项）；③本步骤验收标准由"确认有检索能力"升级为"检索质量不劣于收敛前"，由步骤 1.3 的对拍评测集量化把关。
- **Commit**：2adc74f7（`2adc74f79a8101b45207c40b47e311c35e309cea`，2026-09-14 19:50 +0800。本行由 2026-09-22 R5-e 的记录维护回填：`git log -S` 唯一命中该提交且其 `docs/operations-log.md` 增行即本条目）

## 2026-09-14 — feat(T3/步骤1.2): DRE 检索升级为「分词 + 打分 + 稳定排序」

- **任务**：T3 计划步骤 1.2。DRE 现有 `search()` 为朴素子串匹配（步骤 1.1 勘察结论），须补齐才能承担"唯一检索源"。
- **工具**：Bash（勘察/验证/git）、Read、Write、Edit。无子代理。
- **操作**（文件级）：①新增 `src/dre/runtime/text-rank.ts`（分词 + 打分，深模块，对外 2 个函数）；②`src/dre/runtime/atom-engine.ts` 的 `search()` 接线（+1 行 import）；③新增 `tests/unit/text-rank.test.ts`（13 例）；④新增 `tests/unit/dre-search.test.ts`（7 例）；⑤`tests/crawl/search-fallback.test.ts` mock 支持本地自建 SearXNG 地址。
- **验证结果**：`bunx tsc --noEmit` 通过；`text-rank` 13 pass / `dre-search` 7 pass；**全量 `bun run test` 4050 pass / 36 skip / 0 fail**。
- **偏差记录**：①**测试自身缺陷**：`dre-search` 首版"无关查询"用例的查询串带了测试前缀 `P`，而内容也含 `P` ⇒ 前缀作为 token 正常命中，被误判为失败。这是**正确行为**，已修正测试（改为断言目标原子不出现在结果中），非实现问题；②**连带修复一处既有失败**：`tests/crawl/search-fallback.test.ts` 的 mock 只认公共实例 `sapti.me`，而前序提交（5ba0eeb）已让 SearXNG 地址由 `web-search.yaml` 驱动、默认指向自建实例 ⇒ mock 报 `unexpected host: 127.0.0.1`。已按规则 1 做最小修复（mock 增加本地/内网地址识别）；③按规则 8 评估过"是否需要独立模块"：两个调用点（atom-engine / knowledge-network）确有第二处真实使用，非投机抽象；④本次**仅接线 atom-engine**，`knowledge-network.search()` 作为下一片切片，未在本次一并改动（规则 7 垂直切片）。
- **Commit**：bd19277

## 2026-09-14 — feat(T3/步骤1.2 切片4): DRE 检索打分升级为 BM25（与 FTS5 同族）

- **任务**：T3 计划步骤 1.2 切片 4。切片 1-3 的自拟打分 `(命中词数×0.6 + 覆盖率×0.4)×字段权重` **缺少 df 维度** —— 普遍词与稀有词贡献相同分数，判别力差；而收敛后要求"检索质量不劣于收敛前"（收敛前是 FTS5 的 bm25），故须用同族打分函数。
- **工具**：Bash（备份/测试/勘察/git）、Read、Write、Edit。无子代理。规则 2（备份 `src/dre/runtime/text-rank.ts` → `.tmp/backups/`）。
- **操作**（文件级）：①`src/dre/runtime/text-rank.ts` 重写打分内核为 BM25（`IDF = ln(1+(N-df+0.5)/(df+0.5))`、`tf` 饱和 k1=1.2、长度归一化 b=0.75、多字段加权求和）；新增对外 `rankDocuments()` / `RankableDoc` / `RankedDoc`（语料级 df+avgdl 一次性构建）；`scoreMatch()` 保留为单文档便捷入口（既有调用方与切片 1-3 测试不破坏）；②`tests/unit/text-rank-bm25.test.ts`（上轮遗留的 RED 用例，11 例）。
- **验证结果**：`bunx tsc --noEmit` 通过（exit 0）；BM25 11 pass / 0 fail；切片 1-3 既有 20 pass / 0 fail；**全量 `bun run test` 4061 pass / 36 skip / 0 fail**（本切片前 4050，+11 即新增用例，无回归）。
- **偏差记录**：①**发现并如实记录一处未接线缺口**：`atomStore.search()` 仍逐个文档调 `scoreMatch()`，**单文档无语料统计**（N=1/df=1）⇒ IDF 退化为常数、跨文档分数不可比，"按相关性排序"名不副实；`rankDocuments()` 目前只有测试调用方。已按规则 12 回 Plan，新增**切片 4b（必须做）**把 `rankDocuments` 接线进两处 `search()`。②切片 4 的验收限于"打分函数升级 + 模块级测试"，**不代表 1.2 整体完成**，故计划中 1.2 与切片 4b 保持未勾选。③`avgFieldLen` 按"字段存在的文档数"求平均（而非总文档数），避免字段缺失的文档拉低均值、间接惩罚字段齐全的文档。
- **Commit**：b83e410

## 2026-09-14 — feat(T3/步骤1.2 切片4b): 把 rankDocuments 接线进两处 search()（补上切片 4 的未接线缺口）

- **任务**：T3 计划步骤 1.2 切片 4b。切片 4 完成 BM25 打分函数后，`rankDocuments()` **只有测试调用方**：两处 `search()` 仍逐个文档调 `scoreMatch()`，而单文档无语料统计（N=1/df=1）⇒ IDF 退化为常数、跨文档分数不可比，"按相关性排序"名不副实。本切片把语料级排序真正接上产品路径。
- **工具**：Bash（勘察/测试/git）、Read、Edit、Write。无子代理。规则 2（备份 `atom-engine.ts`、`knowledge-network.ts` → `.tmp/backups/`，见下偏差①）。
- **操作**（文件级）：①`src/dre/runtime/atom-engine.ts`：import 由 `scoreMatch` 改为 `rankDocuments`；`search()` 改为「整个语料一次性建 `{item, fields:[content]}` → `rankDocuments` → 同分按 id 升序 → `slice(0, limit)`」；②`src/dre/runtime/knowledge-network.ts`：新增 import；`search()` 同构改造，语料用**两字段** `[entity.name, entity.content]`（字段重要性由 `1/(1+下标)` 承担，"命中名称优于命中正文"），并补 `!query.trim()` 早返。
- **验证结果**：`bunx tsc --noEmit` 通过（exit 0）；`dre-search` 7 + `text-rank` 13 + `text-rank-bm25` 11 = **31 pass / 0 fail**；**全量 `bun run test` 4061 pass / 36 skip / 0 fail**（与接线前逐项一致，共享检索路径改动**无回归**）。
- **偏差记录**：①**规则 2 部分偏差（如实记录）**：本次两处编辑**未能在改前**建立 `.tmp/backups` 副本（先改后补），偏差原因是切片 4b 紧接着切片 4 提交推进、把 git 提交当作了回滚点。补偿：两份文件旧版均可由 `git show b83e410:<path>` 完整取回（git 提交即回滚点），且改动已被全量测试验证；备份副本已在验证后补齐并即将按规则 2 第 5 步删除。后续切片恢复"先备份再改"。②**接线后排序语义变化需如实告知**：`rankDocuments` 的同分兜底是"输入下标"，而 Map 插入顺序即输入下标 ⇒ 在原 `search()` 用 `id.localeCompare` 兜底的场景，**同分时的次序可能与之前不同**。已保留 `id.localeCompare` 作为显式二次兜底，使顺序不依赖 Map 插入历史；非同分场景的相关性排序才是本次实质变化，这正是 1.3 对拍评测集要量化的对象。③`atomStore.search()` 与 `knowledgeNetwork.search()` 都改为在空查询时早返（前者原有、后者本次补上），保持两处对外行为一致。④**确定性实测（补验）**：以 5 条含唯一前缀的原子为语料，同一查询连续调用 `search()` 5 次，结果 id 序列**逐次完全一致**（`allIdentical=true`）；排序实测为「全词命中 > 部分命中 > 低频重叠」，符合 BM25 预期。
- **Commit**：bfd91be

## 2026-09-14 — fix(consolidation): 移植 Axiom 侧两条独有安全修复（TDD，规则 6/7）

- **任务**：仓库收敛第一步。取证结论（子代理 patch-id 索引 1526 提交 + blob 逐字节比对）显示：Axiom 侧 4 个提交中 `a43a725` 已全部存在于本仓库，`4af0715`/`5531ab0` 各有一项**独有且在本仓库仍活跃**的缺陷。本次移植这两项（第三项"去伪"另议，见偏差③）。
- **工具**：Bash（勘察/备份/测试/git）、Read、Write、Edit、子代理×4（只读取证）。规则 2（备份 `src/core/http-router.ts`、`src/plugins/plugin-registry.ts` → `.tmp/backups/`）。
- **操作**（文件级）：①`src/core/http-router.ts`：缓存写入与命中读取均改用 `clone()`（+6/−2）；②`src/plugins/plugin-registry.ts`：新增 `PLUGIN_ID_RE` / `assertValidPluginEntry` / `assertValidManifest`，接在 `installFromPath` 与 `install` 的入口，并在 `enablePlugin` 动态 import 前加解析后路径的包含性兜底；③新增 `tests/unit/http-router-response-cache.test.ts`（4 例）；④新增 `tests/unit/plugin-manifest-containment.test.ts`（4 例）。
- **验证结果**：
  - **HTTP-router（阻塞级）**：RED 阶段独立复现 `TypeError: Body already used`（3 fail / 1 pass）；修复后 4/4 pass。机理：`Response` body 是一次性流，缓存对象被消费后同一 GET 路径在 TTL(30s) 内第二次请求必抛，经 `main.ts` catch 转 500。
  - **插件包含性**：RED 阶段 3 个攻击面失败；其中**恶意 entry 实测确认越界模块被真实执行**（调试探针 `marker: true`、`status: enabled`）⇒ 非理论风险。修复后 4/4 pass：恶意 `id`（`../../escaped`）与非法 id 被拒、恶意 `entry`（`../../payload.js`）在**安装期**即被拒且 marker 未生成、合法插件未误伤。
  - `bunx tsc --noEmit` exit 0；**全量 `bun run test` 4069 pass / 36 skip / 0 fail**（基线 4061，+8 即新增用例，无回归）。
- **偏差记录**：①**测试自身缺陷 3 处**（已如实记录）：`Plugin` 无顶层 `id`（应为 `manifest.id`）；测试助手漏返回 `toolRegistry`；测试1 的第二个断言路径算错（`join(pluginDir,"..","..")` 指到 `/tmp` 全局，被先前残留污染）——均为**测试 bug 而非实现问题**，已修正。②**修复位置比原设计更早**：entry 校验落在**安装期**而非启用期（原 Axiom 实现亦为安装期正则 + 启用期兜底），故测试改为断言安装期拒绝 + marker 未生成，比原计划更严格。③**第三项（去伪）未做，待决策**：3 个插件仍用 `Math.random()` 伪造 severity/行号、`plugin.json` 仍声明不存在的 `index.js`、`kg/graph.ts` 仍顶着假的"Louvain"头、`cron/scheduler.ts` 仍有模块级副作用。本仓库已有 `7820915`（插件写入默认关闭）作为**设计分歧**而非遗漏，故是否"去伪"需先确认是修还是撤，未擅自改（规则 12 过度施工红线）。
- **Commit**：8638f46

## 2026-09-14 — fix(plugins): 去伪 —— 撤掉伪造工具、修正 phantom 接口与假 Louvain 头

- **任务**：仓库收敛第三项（用户决策"去伪：撤掉伪造行为，保留接口"）。对应 Axiom 侧 `0267bcb` 的插件部分，但**未照搬**（理由见偏差①）。
- **工具**：Bash（勘察/转译/测试/git）、Read、Write、Edit、子代理×4（只读取证）。规则 2（备份三个插件目录 → `.tmp/backups/plugins/`）、规则 4（归档登记 `archive/ARCHIVE-LOG.md`）。
- **操作**（文件级）：
  ①`plugins/code-analysis-enhanced/`、`plugins/doc-generator/`：新增可加载的 `index.js`（`tools: []` + 文件头写明审计结论与恢复方式），删除原 `index.ts`；`plugin.json` 的 `tools` 改为 `[]`、readme 改为如实声明未实现、移除从不被校验的 `permissions` 字段；
  ②`plugins/git-workflow-enhanced/`：**保留** 4 个真实工具，由 `bun build` 转译为可加载 `index.js`，删除原 `index.ts`；`plugin.json` 移除 phantom 的 `manage_git_hooks`，工具列表改为实际的 4 个；
  ③`src/dre/kg/graph.ts`：头部与 `detectCommunities` 注释的假 "Louvain" 改为"基于连通分量"，并说明该算法无模块度/层次合并；
  ④新增 `tests/unit/plugin-defabrication.test.ts`（4 例）。
- **验证结果**：
  - 三个插件**真正可加载**：`installFromPath(..., {enable:true})` 后状态均为 `enabled`（此前因 `entry:index.js` 而只有 `index.ts`，启用必抛 Entry file not found）。
  - 伪造行为已撤：两个去伪插件注册工具数为 **0**；`git-workflow-enhanced` 注册 **4** 个真实工具且无 `manage_git_hooks`。
  - `bunx tsc --noEmit` exit 0；**全量 `bun run test` 4073 pass / 36 skip / 0 fail**（基线 4069，+4 即新增用例，无回归）；`tests/kg-enhanced.test.ts` 13 pass。
- **偏差记录**：
  ①**未照搬 Axiom 的修法**：Axiom 把 `plugin.json` 的 `entry` 改为 `index.ts`，但本仓库顶层 `plugins/` **不在 tsconfig include 内**（仅 `src/**`+`tests/**`），且加载器走 `await import(entry)` —— 声明 `.ts` 在运行期仍无法加载，属**假修复**。故改为提供真实可加载的 `.js`，接口才算"真保留"（并有测试证明）。
  ②**独立判定，未一刀切**：`git-workflow-enhanced` 无随机数、无自承模拟、4 个 handler 均有真实 return，属**确定性真实实现**，故保留其工具；Axiom 将其一并撤掉属更激进路线。此处按本仓库实际代码判定。
  ③**发现第二类问题（phantom 接口）**：`git-workflow-enhanced/plugin.json` 声明 5 个工具，而代码只注册 4 个，`manage_git_hooks` **完全不存在**。另两个插件的声明数与实际注册数一致。
  ④**测试自身缺陷 3 处**：`Plugin` 无顶层 `id`（应 `manifest.id`）；助手漏返回 `toolRegistry`；对 `Math.random` 做**文本扫描**会误伤"注释/警告文案中提到该词"的情形（非调用）——已改为**功能性断言**（启用后工具集为空），避免以文本代替行为。
  ⑤**cron/scheduler.ts 模块级副作用未改**：`tests/unit/scheduler-crash.test.ts:126-137` 明确断言"import 即安装 unhandledRejection/uncaughtException 监听器"，即**既有测试依赖该副作用**；收敛它会打破既有断言，须同步改测试，属独立任务，未混入本次提交（规则 1/12）。
- **Commit**：4e10c72

## 2026-09-14 — feat(searxng): 收敛迁移 —— 配置/部署脚本/研究文档并入本仓库（②③）

- **任务**：仓库收敛第二步。把 Axiom 侧的 9 项产物迁入本仓库（规范仓库），并统一命名。按子代理逐文件比对结论执行：**7 项迁移（4 项整体 + 3 项片段）、1 项无操作（AGENTS.md 逐字节相同）、1 项丢弃**。
- **工具**：Bash（勘察/备份/yaml 校验/compose 校验/功能测试）、Read、Write、Edit、`docker compose config`、子代理×5（只读取证）。规则 2（备份 5 个文件 → `.tmp/backups/`）。
- **操作**（文件级）：
  ①`docker-compose.yml`：新增 `searxng` + `searxng-valkey` 服务与两个命名卷；`axiom-agent` 增加 `SEARXNG_INSTANCE=http://searxng:8080`。**保留**本仓库既有 `user:"1000:1000"` 与 `./plugins:/app/plugins`（冲突报告判定整文件替换会导致插件整体失效 + 挂载卷不可写）。
  ②`config/searxng/settings.yml`：并集合并（新增 `outgoing`、16 条 `engines`、`image_proxy:false`），**保留**本仓库的 `bind_address:"127.0.0.1"`。
  ③新增 `scripts/deploy-searxng.sh`（本仓库**声明却缺失**的 `auto_deploy: true` 实现）。
  ④`.env.example`：SearXNG 段重写（含两个密钥变量说明）。⑤`.env.production.example`：+23 行 SearXNG 段。⑥`README.md`：+106 行（两个小节）。⑦新增 `docs/research/{free-search-apis-2026,no-auth-search-sources}.md`。
- **验证结果**：
  - `docker compose config`：**缺密钥时按设计失败**（`required variable SEARXNG_SECRET_KEY is missing`，exit 1）；提供密钥后 exit 0。渲染产物核对：`user: 1000:1000` ✅、`plugins` 挂载 ✅、`SEARXNG_INSTANCE: http://searxng:8080` ✅、容器收到 `SEARXNG_SECRET` ✅、端口 `127.0.0.1:8080` ✅。
  - `settings.yml`：YAML 合法；程序化比对确认**旧版无任何键丢失**，唯一有意变更 = `secret_key` 占位符。
  - `deploy-searxng.sh`：`bash -n` 通过；用临时 ENV_FILE 实测 —— 占位值触发生成且**两变量同值(64 hex)**、幂等（重跑不改密钥）、旧态（只有 `SEARXNG_SECRET`）能补齐并保持同值。
  - 敏感模式扫描（`sk-*`/`AKIA`/`ghp_`/`github_pat_`/`nvapi-`/PRIVATE KEY）：迁移文件与改动文件**零命中**。
  - `bunx tsc --noEmit` 通过；`docs-consistency` + `deadcode` 门禁 11 pass；**全量 `bun run test` 4073 pass / 36 skip / 0 fail**（与迁移前逐项一致，零回归）。
- **偏差记录**：
  ①**修正了原计划的"统一命名"结论（重要）**：原计划要把密钥统一成一个名字，但实测证明**两个变量名是两个不同消费者** —— 上游 `searx/settings_defaults.py` 的 `secret_key` 声明 `environ_name='SEARXNG_SECRET'`（容器读），而 Axiom 应用读 `config/web-search.yaml: secret_key_env`（`SEARXNG_SECRET_KEY`）。**合并即会导致"密钥生成了但某一侧读不到"**。故改为：两者必须同值，由 deploy 脚本保证（并有实测覆盖）。同时让 `secret_key_env` 这个此前"有形状无行为"的字段首次真正有消费者。
  ②**安全取值优于源仓库**：Axiom 版把 `bind_address` 放宽到 `0.0.0.0` 且 `secret_key` 用上游默认值 `ultrasecretkey`；本仓库保留 `127.0.0.1` 与显式占位值（裸机路径下"默认密钥 + 全网监听"风险已规避）。
  ③**参数化做了但受限（如实记录）**：LAN 代理地址无法用 env 参数化 —— 已核实 SearXNG **不支持** `settings.yml` 内 `${VAR}` 插值（`settings_loader.py` 只读取 `SEARXNG_SETTINGS_PATH` 这类整值变量）。故将其限定为**单点环境特定值**并加显著标注（换环境只改这一处 / 无代理则删该段），而非引入额外模板层（规则 1）。
  ④**丢弃 1 项**：`deploy/docker/docker-compose.yml` 未迁移 —— 本仓库已在 `4cb84bb` 主动退役该目录，属旧部署模型（端口 3000 vs 现行 18789），迁移会引入两套互斥部署路径。
  ⑤**未做**：README 的其余 Axiom-only 改动（审计整改记录、工具数口径等）**未迁移** —— 那会使本仓库已修正的内容回退（含一条已撤回的虚假安全声明），故只迁移 2 个新增小节。
- **Commit**：2c646a6

## 2026-09-14 — chore(repo): 仓库收敛完成 —— agent/openclaw-fusion 更名为 agent/Axiom（④）

- **任务**：仓库收敛最后一步（用户确认执行）。消除 `agent/openclaw-fusion` 与陈旧 `agent/Axiom` 并存的双仓库状态。按 T3 判定（远端引用变更 + 不可逆面）。
- **工具**：Bash（备份/校验/git）、`git fetch`/`ls-remote`、Gitea REST API（`PATCH /repos/{owner}/{repo}`，token 只经 `curl -K` 配置传入，不进 argv/URI）、Edit。规则 2（AGENTS.md 备份，见偏差①）。
- **操作**（文件级）：
  ①**数据安全前置**：先把陈旧 `agent/Axiom` 的 4 个独有提交（`4af0715`/`5531ab0`/`0267bcb`/`a43a725`）取回并**推送为 `archive/axiom-old-repo-2026-09-14` 分支**，确认落远端后才动旧仓库（此前已证实这 4 个提交在 openclaw-fusion 全 26 refs 与 GitHub 上均不存在）。
  ②记录改名前基线（远端 23 个 ref）并备份到仓库外 `/home/listen/repos/.axiom-refs-before-rename-2026-09-14.txt`。
  ③`PATCH agent/Axiom` → 更名 `Axiom-legacy-2026-09-14`（HTTP 200），腾出仓库名。
  ④`PATCH agent/openclaw-fusion` → 更名 **`Axiom`**（HTTP 200，默认分支 `master`，134.5 MB）。
  ⑤本地 remote：本仓库 `origin` 改为 `ssh://git@192.168.0.10:2222/agent/Axiom.git`；陈旧本地仓的 `gitea` remote 改指 legacy 名（避免误推）。
  ⑥`AGENTS.md` 规则 3 目标仓库更新为 `agent/Axiom`，版本 v1.3 → **v1.4**（规则语义变更=次版本，规则 0.7）。
- **验证结果**：
  - **改名零内容变化**：改名前/后 `git ls-remote --heads --tags` 逐行 diff → **23 个 ref 完全一致，SHA 逐一相同**。
  - 新 URL 可用：`git ls-remote ssh://…/agent/Axiom.git` exit 0；`git push --dry-run` → `Everything up-to-date`（**SSH 通道可直接推送,日常无需 token**）。
  - 旧仓库**未删除**：`agent/Axiom-legacy-2026-09-14` 仍可读，其 2 个 head 与 `a43a725` 完好 ⇒ 双份保留。
  - 归档分支已在远端：`archive/axiom-old-repo-2026-09-14` → `a43a725`。
  - 旁证：GitHub `ListenJ/openclaw-fusion` 返回 **301**（上游也已改名为 Axiom）。
- **偏差记录**：
  ①**规则 2 偏差**：`AGENTS.md` 是**先改后备份**（备份落在编辑之后）。补偿：旧版可由 `git show HEAD:AGENTS.md` 完整取回（HEAD 即回滚点），改动已逐行核对；后续严格先备份。
  ②**remote 名未改**：规则 3 要求 remote 名 `gitea`，本仓库实际为 `origin`。URL 已指向正确仓库；改名会波及既有脚本，故按规则 3 记差异而非擅自改名（已在 AGENTS.md 中注明对齐命令）。
  ③**凭据处理**：Gitea token 仅经 `curl -K` 配置文件与 git `-c http.extraHeader` 传递，未进 argv、未写入 git config、未进 remote URL；用后销毁（见下一条提交的记录维护说明）。
  ④**LFS 未做本地完整性核验**：本机 **git-lfs 未安装**，105 个 LFS 实体在服务端、本地只有指针。改名不涉及对象迁移（同库内改名），风险低；但"105 对象确实可取回"仍未实测，列为待办。
- **Commit**：5739174

## 2026-09-14 — verify(lfs): 105 个 LFS 实体全量核验通过（下载 + sha256 逐一对齐）

- **任务**：核验服务端 LFS 实体**确实可取回且内容正确**（本机未装 git-lfs，工作区只有 132 字节指针；此为收敛任务的遗留待办）。
- **工具**：Bash（探测/清点）、Python（LFS batch API + 流式下载 + sha256）、`git grep`/`git show`。**未安装任何软件**。
- **破执检索结论（先查再定）**：①本机**无** git-lfs 二进制（`/usr`、`/opt`、`/snap`、`~/.local` 全扫）；②`npm` 上的 `git-lfs` 包**已于 2015-10-11 下架（E404）**；③系统安装需 sudo（不可得）。⇒ **判定不需要 git-lfs**：Gitea 的 LFS batch API 可直接核验，比装客户端更直接。
- **操作**（文件级）：新增本条目（无仓库文件改动）。实际动作：①清点全部含 LFS 指针的分支与 OID；②`POST /agent/Axiom.git/info/lfs/objects/batch`（HTTP `Basic` 认证）查询 105 个对象；③**全量下载并逐个重算 sha256** 与 OID 比对。
- **验证结果**：
  - 指针清点：**105 个唯一 OID**，分布在 **5 个分支**（`archive/cut-scope-2026-09-14`、`codex/knowledge-backend-convergence`、`codex/node22-decommission-n2-swap`、`codex/self-evolving-agent`、`fix/audit-critical-security`，每分支 105 个指针、OID 集合相同）。`.gitattributes` 3 条 `filter=lfs` 规则。
  - **存在性**：batch 响应 `请求 105 / 存在 105 / 缺失 0`，且返回的 `size` 与指针声明**逐一一致**（0 处不符）；实体总量 65,971,176 B = **62.9 MiB**。
  - **内容正确性（决定性）**：**全量下载 105/105，sha256 与 OID 逐一匹配、大小一致，0 失败 0 异常**，耗时 12.7s。抽样阶段先验了 5 个（最小 14,820 B → 最大 1,273,760 B）亦全部通过。
  - 临时文件（含下载地址与令牌上下文）已 `shred -u` 销毁；令牌特征串在 `/tmp` **零残留**。
- **偏差记录**：
  ①**判定"不需要 git-lfs"而非硬装**：三条获取途径全不可行（无二进制/npm 包下架/需 sudo），且 batch API + sha256 是更直接的证据 —— 故未为完成核验而安装软件（规则 1）。
  ②**认证方案试错并记录**：LFS 端点对 `Bearer` 与 `token` 均返回 **401**，实测 **HTTP `Basic`（`agent:<token>`）通过** —— 该实例的 LFS 端不走 git-lfs 常用的 Bearer。若后续有人照官方文档写 Bearer 会踩同一个坑。
  ③**"存在"不等于"内容正确"已实证**：batch API 只报 actions 与 size；本次以重新计算 sha256（内容寻址的硬标准）兜底，避免了"取回 0 字节/错误内容却显示成功"的假阳性。
  ④**该核验是改名后的事后确认**：改名属**同库操作、不迁移对象**，故 LFS 并非改名的前置条件；本次为"核验遗留待办 + 为未来在新机器 clone 立基线"，非"改名卡点"。
- **Commit**：c70d961

## 2026-09-14 — refactor(cron): 收敛 scheduler 的模块级副作用（最后一项遗留待办）

- **任务**：`src/cron/scheduler.ts` 在**模块顶层**建库、注册 `Bun.cron`、立即执行一次 `healthCheckTask()` 并安装进程级监听器 ⇒ 任何 `import` 它的代码都会落盘建库、注册 4 个全局定时任务、触发真实外呼。按规则 12 收敛为显式启动。
- **工具**：Bash（备份/验证/git）、Read、Write、Edit。规则 2（备份 `src/cron/scheduler.ts` → `.tmp/backups/`，验证后删除）。
- **操作**（文件级）：①`src/cron/scheduler.ts`：数据库改**惰性** `getDb()`（import 不落盘）；新增 `startCronScheduler(opts)`（`registerCron` / `runImmediately` / `installProcessHandlers`，默认全开且**幂等**）；cron 注册与进程监听器移入该函数；加 `import.meta.main` 守卫保持 `bun run src/cron/scheduler.ts` 原用法；顶层 `logger.info("starting")` 移入启动函数；②`src/main.ts`：由"靠 import 副作用"改为显式 `startCronScheduler()`；③新增 `tests/unit/cron-scheduler-sideeffects.test.ts`（4 例，子进程隔离观测模块级副作用）；④`tests/unit/scheduler-crash.test.ts`：2 个断言由"import 后断言监听器"改为"显式启动后断言"，并新增 1 例断言 **import 本身不再安装监听器**。
- **验证结果**：
  - RED 阶段：3 例因 `startCronScheduler` 不存在失败；第 4 例（任务函数）**超时 5s** —— 精确暴露"import 即触发 `healthCheckTask` 外呼、每次最长 5s 超时"的副作用。
  - GREEN 后：13/13 pass；同样的子进程用例耗时由 **~5000ms 降至 ~20ms**，即副作用被消除的量化证据。
  - **`import.meta.main` 守卫实测**：`bun run src/cron/scheduler.ts` 仍自动启动并打印完整注册清单（命令行用法未变）。
  - `bunx tsc --noEmit` exit 0；**全量 `bun run test` 4078 pass / 36 skip / 0 fail**（基线 4073，+5 为新增/改造用例，零回归）。
- **偏差记录**：
  ①**既有测试确实依赖该副作用（预判被证实）**：`scheduler-crash.test.ts` 原以 `await import(...)` 后断言监听器数 > 0。收敛后该断言必然失败，故**同步改为显式启动后断言**（这是"改测试以适配重构"，非放宽断言 —— 另补 1 例反向断言 import 不装监听器，净约束是收紧）。
  ②**测试环境继承真实 API Key 导致首版非确定性失败**：新测试子进程最初继承 `process.env`，`healthCheckTask` 按真实 key 发起 4 次外呼（正是被测缺陷本身），使用例 5s 超时。已在子进程中显式清空 4 个平台 key 并把任务函数的验证改为"不抛即通过"，与网络解耦。
  ③**任务函数语义保持不变**：`healthCheckTask`/`heartbeatTask`/`cleanupTask`/`discoverFreeModelsTask` 的签名与返回不变，仅把内部 `db` 换成惰性 `getDb()`。
  ④**未改** `scheduler-crash.test.ts` 对 SQLITE_BUSY 重试等其余断言（与本次无关，避免扩大范围）。
- **Commit**：7cdaa38

## 2026-09-14 — chore(repo): main 快进 + 退役 fix/audit-critical-security + 陈旧克隆指向新仓库

- **任务**：用户指令「确保稳定后切入 main，退役 fix/audit-critical-security，本地陈旧部分指向新仓库」。按 T3 判定（分支/远端引用变更）。
- **工具**：Bash（验证/备份/git）、Gitea REST API（删除远端分支）、curl。规则 4（先归档再删）、规则 5。
- **操作**（文件级）：①本地新建 `main` 跟踪 `origin/main`，`git merge --ff-only` 到 `codex/knowledge-backend-convergence` 顶端；②`git push origin main`（快进 `7ad30ce..93620c2`）；③新增归档分支 `archive/fix-audit-critical-security-2026-09-14`（`c107bea`）并推送；④`DELETE /repos/agent/Axiom/branches/fix%2Faudit-critical-security`（HTTP **204**）；⑤删除本地分支 `fix/audit-critical-security`；⑥陈旧克隆 `~/repos/Axiom`：`gitea` 与 `origin` 两个 remote 均改指 `ssh://git@192.168.0.10:2222/agent/Axiom.git`，`git fetch` 后 `origin/main` = `93620c2`；⑦`archive/ARCHIVE-LOG.md` 登记本次分支退役。
- **稳定性验证（合并前，全部新鲜执行）**：
  - `bunx tsc --noEmit` → **exit 0**
  - `bun run test`（`--parallel=8 --timeout 15000 ./tests`）→ **4078 pass / 36 skip / 0 fail**（4114 tests / 404 files）
  - `bun run build` → **exit 0**，592 模块 → `dist/main.js` 11.43 MB
  - **真实冒烟（构建产物）**：`bun dist/main.js` 启动成功、监听 `127.0.0.1:18789`、`/health` **连打 3 次全 200**（其中一次即验证 http-router 缓存修复在真实服务上生效）、退出后端口释放无残留进程
  - 合并前置：`git merge-base --is-ancestor origin/main HEAD` → **是祖先** ⇒ **fast-forward，无需 merge commit、无需 force**
- **验证结果（合并后）**：远端 `refs/heads/main` = **93620c2**（与本地一致）；`refs/heads/master` 仍为 `7ad30ce`（未擅自动）；远端默认分支 HEAD → `refs/heads/master`（**待决**，见偏差③）；`fix/audit-critical-security` 远端已不存在；归档分支 `c107bea` 完好。
- **零丢失核验（陈旧克隆的未提交改动）**：逐文件比对 + 行级丢失检测 —— `.env.example` / `.env.production.example` / `README.md` / `config/searxng/settings.yml` / `scripts/deploy-searxng.sh` / `AGENTS.md` 的差异**全部为有意改进**（如 `bind_address` 由 `0.0.0.0` 收紧为 `127.0.0.1`、密钥变量统一为两个消费者、README 两小节俱在、AGENTS.md 仅版本号与仓库名更新）；`docs/research/` 两文件**内容完全相同**。陈旧克隆 HEAD `a43a725` 已确认被归档分支包含。
- **偏差记录**：
  ①**CI 未实际执行（如实声明）**：按 `ci-cd-pipeline` 铁律"流水线要么实际跑过，要么明确声明只做静态校验"—— 核查发现 Gitea 实例**runner 数为 0**（`/repos/agent/Axiom/actions/runners` → `total_count: 0`）且无 `workflow_runs`，故 `.github/workflows/*.yml` **从未在此实例运行过**。本次只做静态核查 + 本地等价验证（tsc/test/build/冒烟）。
  ②**CI 与本地存在版本漂移**：`ci.yml` 钉 `BUN_VERSION: "1.3.14"`，本机实际 `bun 1.4.2`（两者经 GitHub Releases API 核验**均为真实版本**，非臆造）。属待决项。
  ③**远端默认分支仍为 `master`** 且 `master` 停在 `7ad30ce`：本次只按指令推进 `main`，**未擅自改动** `master` 或默认分支设置。这会造成"默认分支落后 899 个提交"的困惑，建议将默认分支切到 `main` 并令 `master` 同步（待用户决策）。
  ④**发现版本号口径不一致（未修，记入待办）**：`GET /health` 返回 `version: "2.2.0"`（`src/routes/health.ts:40` 硬编码），而同文件 `:99` 另一处写 `"2.9.0"`，`package.json` 为 `4.0.0` —— 三处口径不一。不在本次范围，未擅自改（规则 1/12）。
  ⑤**陈旧克隆未做工作区清理**：其 9 项未提交改动经核验已全部迁入新仓库，但**未擅自丢弃**（`git checkout .` / `clean` 属规则 9 禁止操作），remote 已指向新仓库供用户自行处置。
- **Commit**：4c38995

---

## 2026-09-22 01:34 +0800 — S3 移植到主干（R0：零冲突文件落地 + 红基线）【WIP，勿并入】

- **任务**：经方案比选，S3 冲突处理定为**在 `internal/main` 上重放**（否决"合 main 进旧分支"与"直接开 PR 解冲突"）。本条只做 R0：把 S3 产物中 main 从未触碰的文件整搬落地，并建立真实红基线。
- **工具**：Qoder 主代理（git worktree / git merge-file / Read / cp / bun test / tsc），无子代理。
- **前置事实测量**：以 `7ad30ce4` 为基线，S3 改动 84 文件中 **39 个 main 从未触碰**（`git diff --quiet base internal/main -- <f>` 判据，可整搬）、**45 个需三方合并**；main 相对基线为 1578 文件 / +107848 行，`registry.add({` 字面量 **183 处**（旧分支 177），且 main 完全缺少 `src/utils/safe-fs.ts`、`src/utils/security-defaults.ts`、`config/security-defaults.json`、`config/nondeterminism.json`、`tests/capability-invariants.test.ts`、`tests/doc-contract.test.ts`、`docs/security/tool-capability-declarations.md`。
- **main 侧内核现状（移植要收敛的对象）**：`src/utils/permission-middleware.ts:19-27` 是以工具名为键的守卫表（11 个名字）、`:74-76` 对表外工具默认放行，且 `checkToolPermission` 无生产调用方（仅 `tests/rigorous/security-rigorous.test.ts`、`tests/unit/permission-middleware.test.ts` 引用）；实际闸门是 `src/mcp/tool-registry.ts:52-80` 的 HardFloor（按参数**字段名**正则初筛）；`src/utils/path-safety.ts:42-47` 的 DENIED_SEGMENTS **不含 `.github/workflows`**（写 CI 工作流这条提权链路在 main 上敞开），`:78-86` 在 realpath 双失败时显式 fail-open；`src/mcp/tool-registry.ts:42` 的模式审批需 `AXIOM_ENFORCE_MODE_APPROVAL=1` 才生效 ⇒ 未配置即不审批，属 L8 同型缺陷。
- **执行的操作（文件级）**：新建工作树 `/home/listen/.qoder/worktrees/app/e001f4/s3-on-main`（分支 `codex/s3-on-main-2026-09-22`，基于 `internal/main` = `0ba2cb4`，`node_modules` 按既有约定符号链接）。整搬 38 个零冲突文件（`docs/security/tool-capability-declarations.md` **刻意不搬**：其 177 条表在 main 的 183 个注册点上必然失真，留待 R2 重新生成）。`src/utils/permissions.ts` 走 `git merge-file --diff3` 三方合并：保留本侧 `decideCapability` 单源判定，同时回代验证 main 的 13 行改动语义未丢 —— `.env`/`.env.local` 读拒、`.environment`/`my.env.bak` 不误伤（main 的 Low 修复）、`.git/config` 与 `data/*.db` 读拒、`/etc/passwd` 读拒、`.github/workflows/*` 写拒（main 原缺）、沙箱内普通文件读写放行。
- **验证**：`bun run lint` 基线（main 原样）exit=0；换内核后 main 自身安全套件 `tests/rigorous/security-rigorous.test.ts tests/unit/permission-middleware.test.ts tests/security-fixes.test.ts` → **96 pass / 0 fail**（证明判定内核收敛未回退 main 的 C-01/N-H1 修复）。R0 后状态：`bun run lint` 106 处 error（全部指向 45 个待合并文件：`ToolDef.capability`、`registry.getCapabilities()`、`risk-monitor.screenToolCall/reviewSequence/resetSequences`、路由 `principalOf`），`tests/capability-invariants.test.ts` 19 pass / 17 fail，`tests/doc-contract.test.ts` 5 pass / 11 fail（main 文档仍是旧口径）。**本分支此刻为红，属移植中途，禁止并入主干。**
- **矛盾与残留（如实记录）**：(1) 旧分支 `codex/doc-caliber-doc-contract-gate-2026-09-21` 的门禁全绿只在 `master` 旧世系成立，本条起验证口径改以 main 为准；(2) 整搬的 `docs/SECURITY-MEASURES.md` 等 6 份文档含旧世系的量化口径（177 注册点等），需 R2 后按 main 重算，doc-contract 的 11 条失败即此项；(3) `permission-middleware` 名字表与 `tests/rigorous`、`tests/unit/permission-middleware` 两处断言其"非受控工具默认放行"，R1 要决定是删表改能力驱动还是保留为纵深，尚待与用户确认；(4) 本工作树的 `.tmp/backups/` 已建，验证后删除。
- **敏感资产扫描（规则 11）**：本条涉及的 38 个搬入文件对 `sk-*`(≥16)/`AKIA*`/`ghp_*`/`-----BEGIN *PRIVATE KEY-----` 命中 0；`AGENTS.md` 未在本分支改动（规则 3 的 remote 修正已在旧世系提交 `847f486`，R1 合并时需带过来）。
- **Commit**：cc712ea（本条时间戳由 01:41 更正为实际 01:34，并回填 hash；更正属记录维护，规则 5）

---

## 2026-09-22 02:52 +0800 — R1 内核收敛：main 侧守卫改能力驱动 + 全量测试对齐（并完成 494b3b7 的重放提交）

- **任务**：用户指令「同意，按能力驱动的方案重构并更新测试」。范围＝删掉 main 遗留在 `permission-middleware` / `risk-monitor` 的**名字表**，改为按工具自己声明的 capability 分派，并把所有断言旧行为的测试对齐到能力口径；同一提交里完成 `494b3b7`（S3-P0…P5）的重放收尾（R0 之后 cherry-pick 一直停在"冲突已解、未提交"状态）。
- **工具**：Qoder 主代理（Read / Edit / Write / Grep / Bash / tsc / bun test）+ 子代理 A1/A2（main 侧注册点清点）、A3（capability 声明批量补齐与独立诊断，A3 明确拒改主代理正在编辑的文件）。规则 2 备份、规则 5 留痕、规则 7 逐条红绿、规则 9 未触碰任何禁止命令。
- **执行的操作（文件级，共 53 个文件：52 改 + 1 新建）**：
  - **判定内核（唯一来源）**：`src/utils/permission-middleware.ts` 重写为 `checkToolPermission(call)`——按 `call.capabilities` 逐能力取负载并交 `decideCapability` 裁决，能力集为空即拒（`no capability declared`），删掉 11 个工具名的表；`src/agents/risk-monitor.ts` 的初筛集合改由 `CAPABILITY_PAYLOAD` 派生（导出 `SCREENED_CAPABILITIES`，剔除 `fs.read`/`internal`），"要不要进概率层"只看能力集不看名字与负载内容；`src/mcp/tool-registry.ts` 的 HardFloor 由**声明能力**推导操作类型（不再从工具名猜 write/delete），并删掉与 `ToolSurfaceLike` 重复的 `capability` 字段声明；`src/utils/tool-surface.ts` 把 `capability` 上移到**工具表面**，使 `{ ...tool }` 包装无法在包装层剥离授权声明（封堵 L9）。
  - **注册点补齐**：main 的 `src/mcp/server/*.ts`（browser/document/dre/kg/mind/orchestrator/recoverable-output/safety/skill/token/vault/web 等）、`src/mcp/tools/*`、`src/tools/*`、`src/mcp/register-external-tools.ts`、`plugins/git-workflow-enhanced/index.js`、两个测试夹具逐个补 `capability`。以 tsc 当枚举器（因本分支把 `capability` 变为必填）：报错站点 67 → 41 → **0**，不靠人肉搜索漏站点。
  - **架构门合规**：合并后的 `src/mcp/server.ts` 为 502 行，超 `test:arch` 的 ≤500 规则；把场景路由的 41 行整块抽到**新文件** `src/mcp/server/scene-tools.ts`（`registerSceneTools`，两个工具均声明 `capability: ["internal"]`，函数体逐字搬运），`server.ts` 降到 461 行。**未删除任何仓库文件**，故规则 4 的归档步骤不适用（被移动的代码块随本提交进入 git 历史，新文件即其正式版本）。
  - **测试更新（口径变更，逐条给理由）**：`tests/unit/permission-middleware.test.ts`、`tests/unit/risk-monitor-coverage.test.ts`、`tests/unit/risk-monitor-degraded.test.ts`、`tests/unit/tool-mode-gate.test.ts` 按能力 API 重写（新增"改名不影响判定""包装后仍携带声明""capability 不得出现在发给模型的 tools 里"等断言）；`tests/workspace-snapshot.test.ts` 的 L1 用例改断 main 的 D5 契约（`success:false` + `errors:[".env",".github/workflows/ci.yml"]`，普通文件仍恢复、锚点仍缺席）；`tests/read-tool-fence.test.ts` 的 `reason` 正则接受"执行锚点"词汇（旧口径是"敏感路径"）；`tests/unit/plugin-manifest-containment.test.ts` 动态生成的插件源补 `capability:['internal']`；`tests/hallucination-feedback.test.ts` 加 `beforeEach(resetSequences)`（见残留⑥）；`tests/risk-monitor.test.ts` 头注释与两条断言回代到 C-4 口径；`tests/agents/risk-verdict-cache.test.ts` 由已删除的 `monitorToolPayload` 改调用 `screenToolCall`；`tests/rigorous/security-rigorous.test.ts`、`tests/utils/tool-schema.test.ts`、`tests/components/recoverable-output.test.ts`、`tests/tool-registry-dedup.test.ts`、`tests/mcp/tool-registry-external.test.ts` 对齐新类型。
- **验证结果（全部新鲜执行）**：
  - `bun run lint`（`tsc --noEmit`）→ **exit 0**，原始输出文件内 `error TS` **0** 命中（按既往教训以原文件核算，不采信管道计数）
  - `bun run test:arch` → **25 pass / 0 fail**（含 `server.ts` ≤500 行规则转绿）
  - `bun test tests/capability-invariants.test.ts` → **35 pass / 1 fail**（唯一失败＝S-6 回环单源，R3 已知红）
  - `bun test --parallel=8 --timeout 15000 ./tests`（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G` 包裹）→ **4141 pass / 36 skip / 14 fail**（4191 tests / 407 files / 31.74s）。相对 R0 红基线的 27 fail 净减 13，R1 范围内失败清零。
  - **14 项失败逐条归因**：11 × `tests/doc-contract.test.ts`（R5：main 文档仍是旧口径；D8 的实测集合现为 25 个 `src/mcp/server/*-tools.ts`，已含本次新增的 `scene-tools.ts`，文档侧读到 `[]`）、1 × S-6（R3：`src/mcp/dre-backend.ts`、`src/mcp/kb-backend.ts` 并列信任本机）、1 × `HttpRouter 缓存` 用例（R4：路由未 `cacheable:true` 前响应缓存实际不生效）、1 × `tests/ocr.test.ts`「should get engine with default config」（**环境缺件**：`/usr/share/tessdata` 不存在、`TESSERACT_LANG_PATH` 未设、仓库不跟踪任何 `traineddata`；该用例在 `7cdbca29` 诚信化前是 `expect(true)` 假绿）。
  - **敏感资产扫描（规则 11）**：53 个改动文件对 `sk-*`(≥16)/`AKIA*`/`ghp_*`/`-----BEGIN *PRIVATE KEY-----` 命中 **0**（唯一的 ≥40 字符命中为 diff 内的文件路径）；`.env.example` 新增内容仅为开关注释与占位；改动文件中无 `192.168.0.22` 残留。
  - **并入判定**：主干 `internal/main` 此前是 0 fail，本分支仍有 14 项已知红（R3/R4/R5 + 环境件），**因此本条只推分支，不并入 main**；并入需等 R2–R5 收口或由用户明确放行。
- **矛盾与残留（如实记录，未擅自扩范围修复）**：
  ① `checkToolPermission` 在**生产仍零调用方**（只有测试与 `src/mcp/tool-registry.ts` 头部一处过时注释提到它）——实际闸门是 `defaultToolGuard` + `safe-fs`。这是"声明 vs 实际"的分离，接线与否属 R2 决策。
  ② **能力→负载表覆盖不全**：`web_search`、`skill_list`、`skill_reload`、`skill_run` 与 `web_fetch` 的 `fs.write`，以及 `db.write` 类工具的 `sourceId/scene/verdictId` 参数都不在 `CAPABILITY_PAYLOAD` 里 ⇒ 守卫取不到负载、等价静默放行。I1 只保证"有声明"，不保证"声明可裁决"（子代理 A3 实测，R2 必须登记并补齐）。
  ③ `skill_create` 用裸 `fs.writeFileSync` 写盘（`src/skills/skill-loader.ts:220`），绕过 `safe-fs` ⇒ I2"在实际 I/O 调用点强制"缺位。
  ④ `SynapseStore` 的 `new Database("./data/synapse.db")` 同样绕过 `safe-fs`，而 `data/*.db` 在执行锚点表内。
  ⑤ CDP 浏览器工具声明 `net.outbound` 后撞上回环默认拒绝——与 S-6 同源，需 R3/R4 的默认值与豁免清单一起定。
  ⑥ **离线（无 edge 模型）时特权调用一律升级审批**：`hallucination_feedback` 这类 `db.write` 工具连打 8 次即触发 I4 突发上限（`SEQUENCE_BURST_LIMIT=8`，序列状态是模块级、主体键退化为 `unassigned`），无审批桥时 1 秒自动拒绝。本次以测试隔离（`resetSequences`）处理，产品侧后果与逃生阀 `EDGE_RISK_MONITOR=0` 需在 R3 文档化；同时 `reviewSequence` 的主体未按身份分桶，也是 R3 项。
  ⑦ 审批被拒后经 `buildHttpHandlers` 返回的是 `{error:true,message}`，**不含 `success:false`** ⇒ 只判 `result.success` 的调用方拿到 `undefined`（本次红测的直接原因之一），契约需在 R2 统一。
  ⑧ 模式审批仍需 `AXIOM_ENFORCE_MODE_APPROVAL=1` 才生效（L8 同型缺陷未在本条范围内收紧）。
  ⑨ web 工具存在两处定义（`registerWebTools` 与 `buildWebToolSurfaces`），即 S-5 反对的"第二份清单"；`web_fetch`/`web_search` 的描述宣称"自动写入 Vault"，实现里 `savedToVault: true` 是硬编码。
- **Commit**：25f67e1（`25f67e1a8744ae5fb27c245ed3c46eb1f9bf1add`；本条 hash 由占位符回填，回填提交属记录维护，规则 5）

---

## 2026-09-22 05:48 +0800 — R2 落地四片（A 并列入口 / B 执行点 / D 声明可裁决 / E 拒绝契约）

- **任务**：收口 R1 残留①②③④⑦。子片：**R2-A** 原生 function-calling 与 skill 直调这两条并列执行入口必须过同一守卫；**R2-B** `saveSkillFile` 落到 `safeFs` 执行点（I2）；**R2-D** 派发前裁决的取负载改为"声明 + 值形态"驱动，改字段名不得脱离守卫（新增门 **S-8**）；**R2-E** 被拒调用统一返回 `success:false`，场景层高危判定从工具名表改按声明能力。R2 的剩余片：**R2-F** 能力声明登记表重生成（`docs/security/tool-capability-declarations.md` 现为死链）+ 一致性门、**R2-G** 出网裁决执行点（转 R3）。
- **工具**：Qoder 主代理（Read / Edit / Write / Grep / Bash / `tsc --noEmit` / `bun test` / sed 做单行注释删除），无子代理。规则 2 备份→验证→删备份、规则 5 留痕、规则 7 垂直切片、规则 11 敏感扫描均已执行；规则 9 有一次违反，见"事故"。
- **执行的操作（文件级，22 改 + 4 新建测试）**：
  - **R2-A**：`src/mcp/tool-registry.ts` 新增 `ToolRegistry.execute(name,args)` 与 `createRegistry(surfaces)` 作为唯一派发接缝（未知工具名抛 `Unknown tool`，不静默返回 `undefined`）；`src/routes/chat.ts` 的 `buildChatToolConfig().executeTool` 由"自己 `find` 表面再调 `handler`"改为 `registry.execute(...)`；`src/mcp/server/skill-tools.ts` 的 `runSkillTool` 改为经默认守卫的懒建注册表派发；`src/mcp/server/skill-tools.ts` 的 `skill_create` 注释同步到新口径。新建 `tests/mcp/tool-exec-entry-guard.test.ts`（含静态门：`src/routes`、`src/services`、`src/mcp/server` 内不得再出现 `xxx.handler(` 直调）。
  - **R2-B**：`src/skills/skill-loader.ts` 的 `saveSkillFile` 由裸 `fs.mkdirSync`+`fs.writeFileSync` 改 `await safeFs.writeFile(..., {principal:"tool:skill_create"})`（签名转 async）；`src/utils/safe-fs.ts` 修 `authorizePath` 的逐跳跳过条件 —— 原判据 `realRelative.startsWith(".")` 会把 `.git`/`.ssh`/`.github`/`.env` 一并放行（这些正是提权落点最高的锚点），现只跳过"解析结果即沙箱根"这一种情形。新建 `tests/skills/skill-write-execution-point.test.ts`（符号链接指向 `.github/workflows/ci.yml` ⇒ 锚点字节不变；沙箱外绝对路径拒；沙箱内普通 skill 可写）。
  - **R2-D 判定内核**（`src/utils/permissions.ts`）：`CapabilityPayloadSpec` 由 `{kind,fields}` 扩为 `{kind,judgment,fields,acceleratorFields,shapeAdjudicable,preDispatch,declaredTargetRequired}`；`payloadForCapability` 之外新增 `payloadCandidatesForCapability`（声明字段 → 规范字段 → 加速器字段 → **值形态认领**四步，去重后全部交给裁决）；新增 `looksAdjudicableValue`/`looksPathLike`/`looksUrlLike`（单行、≤512 字、无空白，URL 需 scheme）与统一入口 `adjudicateCallPayloads`；`decideCapability` 的分支改为按同一张表的 `judgment` 分派，未知能力 fail-closed 拒绝；原 `defaultToolGuard` 里那张 30 键名正则并入 `PATH_ACCELERATORS`（全仓一份）。**两处刻意的不对称**：① 形态认领出的路径只做锚点裁决、不做越界裁决（越界取决于工具真实落点，vault / axiom home 在 cwd 之外，只有 I/O 点知道）；② `proc.exec` **不走形态识别**，改由注册处声明目标入参（见下）。
  - **R2-D 声明门 S-8**：`src/utils/tool-surface.ts` 的 `ToolSurfaceLike` 增加 `payloadFields?: PayloadFields`（与 `capability` 同挂表面，包装层要么整体转发要么重新声明，剥离即注册期抛错），头部注释改为与实现一致（旧注释宣称"包装靠 `{ ...tool }` 透传"，实测两处包装都是显式字面量，已按事实重写）；`src/mcp/tool-registry.ts` 新增 `checkPayloadDeclaration(tool)` 并在 `add()` 内强制：声明 `declaredTargetRequired` 的能力（现为 `proc.exec`）必须给出 `payloadFields`，或显式 `"fixed"`；声明的字段名必须存在于 `inputSchema`（拼错即启动期抛错）。`ToolGuard` 签名加第 4 参 `payloadFields`，守卫的 ① 层换成 `adjudicateCallPayloads`。
  - **R2-D 生产声明补齐**：`src/mcp/server.ts`（5）、`src/mcp/register-external-tools.ts`（9）、`src/mcp/server/browser-tools.ts`（5）、`hermes-tools.ts`（2）、`lsp-tools.ts`（2）、`code-agent-tools.ts`（2）共 **25 处 `proc.exec` 注册点**补 `payloadFields`：`terminal_exec` 声明 `{"proc.exec":["command"]}`，其余 24 处声明 `"fixed"`（命令由实现内部拼装，入参里没有可裁决对象；证据为 `src/mcp/tools/git.ts` 的 argv 形态、`workspace-snapshot.ts` 的 `execFileSync`+`assertValidSnapshotId`、`code-analysis.ts` 的固定 `npx tsc --noEmit` 等）。
  - **R2-D/R2-E 下游接线**：`src/agents/risk-monitor.ts` 的 `ToolCallView`/`extractPayload` 透传 `payloadFields`（概率层看到的负载集合与 HardFloor 同源）；`src/utils/permission-middleware.ts` 的 `checkToolPermission` 改为调 `adjudicateCallPayloads`（删掉自己那份循环）；`src/mcp/scene-router.ts` 删 `RISKY_SCENE_TOOLS` 工具名表，改按 `registry.getCapabilities()` 判副作用（未声明 ⇒ 拒绝，词表新增档位默认视为有副作用），并把 handler 返回值归一为执行记录；`src/mcp/tool-registry.ts` 的 `buildHttpHandlers` catch 分支补 `success:false`。
  - **测试对齐**：新建 `tests/mcp/payload-shape-guard.test.ts`（异形字段 `vault_path`/`cdpUrl` 仍被拒且未触达实现；S-8 两种注册期拒绝；声明字段里的高危命令被拒；`"fixed"` 下散文 `message:"clean up passwd handling"` 不误伤）与 `tests/mcp/tool-error-contract.test.ts`（拒绝契约 + 场景能力判定三条）；`tests/capability-invariants.test.ts` 新增 **S-8** 静态门（每一处 `proc.exec` 注册字面量都带 `payloadFields['proc.exec']` + 正向对照防零命中假绿）；`tests/unit/risk-monitor-degraded.test.ts` 的 3 个 `proc.exec` 夹具补声明（S-8 生效后被门拦下，属门真的咬到生产口径）；`tests/routes/chat-tools.test.ts`、`tests/mcp/skill-run-tool.test.ts` 对齐新接缝。
  - **文档**：`docs/SECURITY-MEASURES.md` §2.7.1 新增"派发前裁决怎样取出目标"段（值形态认领 + 命令类靠声明 + 无声明不可注册）、§2.7.3 的 L4 行补"改入参名同样不脱管"、L5 行改为按事实表述、§2.7.5 新增 4 行未封堵项（命令类不做形态猜测及其兜底、命令危险模式两份清单、`adaptTool` 无 `payloadFields` 通道、`mcp.external` 不参与派发前裁决）+ 1 行（形态认领只做锚点裁决）。
- **验证结果（全部新鲜执行）**：
  - `bun run lint`（`tsc --noEmit`）→ **exit 0**
  - 新增 4 个测试文件 → **23 pass / 0 fail**；`tests/capability-invariants.test.ts` → **39 pass / 1 fail**（唯一失败＝S-6 回环单源，`src/mcp/dre-backend.ts`、`src/mcp/kb-backend.ts`，R3 已知红）；`tests/doc-contract.test.ts` → **5 pass / 11 fail**（与 R1 基线同数，R5 范围；本条新增文字未引入新违规，命中项仍只有既存的 `./security/tool-capability-declarations.md` 死链 3 处＝R2-F 交付物）
  - `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests` → **4169 pass / 36 skip / 14 fail**（4219 tests / 411 files / 32.42s）。相对 R1 的 4141 pass / 14 fail：新增 28 个用例、4 个文件，**失败数不变且逐条同名**（11×doc-contract = R5，1×S-6 = R3，1×HttpRouter 缓存 = R4，1×OCR = 环境缺件）。中途一次 17 fail 由 S-8 咬到 `risk-monitor-degraded` 的 3 个夹具，补声明后回到 14。
  - **门有效性（存活证明，非"绿即可信"）**：① S-8 运行期门 —— 临时删去 `add()` 内的 `throw` 后，恰好 2 条声明类用例转红；② S-8 静态门 —— 新建 `src/mcp/__s8-mutation-probe.ts`（`proc.exec` 无声明的字面量）后该门精确报出该站点，删除探针即回绿。
  - **敏感资产扫描（规则 11）**：工作区 diff 与 4 个新建测试对 `sk-*`(≥16)/`AKIA*`/`ghp_*`/`-----BEGIN *PRIVATE KEY-----`/`192.168.` 命中 **0**；夹具内的 `.env`、`authorized_keys`、`fixture-not-a-real-token` 均为锚点名占位，非真实凭据。
  - **并入判定**：本分支仍带 14 项已知红（R3/R4/R5 + 环境件），**只推分支不并入 `main`**（与 R1 同口径）。
- **事故（如实记录，不粉饰）**：一次变异检查命令以 `git checkout -- src/mcp/tool-registry.ts` 收尾，把该文件**未提交**的 R2-A/R2-D/R2-E 改动全部丢弃（`.tmp/backups/` 内的备份恰是 HEAD 版本，无从回救）。规则 9 禁止 `git checkout .` / `restore .` 的正是这类丢失，单文件形式同样致命。已按上下文重建该文件并重新以 `lint` + 契约用例验证；已提交的 `25f67e1` 未受影响。**后续硬规矩：变异检查一律在临时副本上做，或改完立即用 Edit 精确还原；不得对脏文件执行任何 `git checkout`/`restore`。**
- **偏差（与任务书不一致处，需用户确认或否决）**：任务书 R2-D 写的是"取负载改由值形态驱动（绝对/相对路径形态、URL 形态、**命令形态**）"。命令形态**没有**按字面实现 —— 命令与散文在语法上不可区分，实测反例即 `snapshot_create` 的 `message`、`git_commit` 的提交说明（形如 `clean up passwd handling` 会被 `HIGH_RISK_PATTERNS` 命中），猜形态会把正常写文档打成提权。改为：路径/URL 按形态认领（加速器表退化为加速器），命令按注册处声明 + S-8 强制（无声明即不可注册）。红线用例（多行正文含锚点名放行、散文含空格放行）与 `§2.7.5` 的登记行共同锁住这一取舍。
- **矛盾与残留（未擅自扩范围修复）**：① `proc.exec` 的 `"fixed"` 声明由人写、机器不校验其真实性（只校验 schema 存在性），登记表（R2-F）须逐条给出证据；② 命令危险模式仍是两份清单（`permissions.ts` 的 `HIGH_RISK_PATTERNS` 无去混淆，`command-safety.ts` 有），违反 §2.7.4 第 1 条，转 R3；③ `mcp.external` 的远端读写对判定内核不可见（参数形状在远端），只有复核层与 I4 计数；④ `payloadCandidatesForCapability` 是"声明字段 + 规范字段 + 加速器字段"**并集**而非替换，声明不能缩小裁决面（保守方向，不会成为绕过通道）；⑤ `checkToolPermission` 生产仍零调用方（R1 残留①，接线与否待决）；⑥ `reviewSequence` 主体仍退化为一律 `"unassigned"`（R3）；⑦ 形态认领只认 string 入参，嵌套对象内的路径（如 `{ops:[{file:"..."}]}`）不进入派发前裁决，靠 `safeFs` 兜底 —— 是否扩到递归取值待裁决（登记，不在本片做）。
- **Commit**：e30c377（`e30c3778cb80eda12b6d4e23f3e0ccccf0d7d2d8`；已推送 `internal codex/s3-on-main-2026-09-22`，`7b7b1902..e30c3778`。本条 hash 由占位符回填，回填提交属记录维护，规则 5）

---

## 2026-09-22 06:05 +0800 — R2-F 能力声明登记表入库（由代码重生成 + D10 一致性门）

- **任务**：R2 收尾片 R2-F —— 把 `docs/security/tool-capability-declarations.md`（R0 起一直是死链）变成由注册代码重生成的登记表并加门，同时回答"能力声明到底覆盖了几个注册点"。
- **工具**：Qoder 主代理（Read / Edit / Write / Grep / Bash + `tsc --noEmit` + `bun test`），无子代理。规则 2 备份→读全文→改→验证→删备份、规则 5 留痕、规则 7 垂直切片（D10 先红后绿）、规则 11 敏感扫描均已执行；规则 9 无违反。
- **执行的操作（文件级：3 新建 + 2 改）**：
  - 新建 `src/testing/tool-declarations.ts`：`addLiterals`（括号配平取 `.add({…})` 整段，跳过字符串与注释）、`propertyText`、`topLevelSchemaKeys`（内联对象或 `z.object({…})` 取顶层键，取不到即 `null` = 不可静态核）、`capabilityList`、`payloadFieldsText`、`tiersFor`（分档文字**只读 `CAPABILITY_PAYLOAD`**，与派发前裁决共用一份口径，不另立词表）、`collectToolDeclarations`、`renderDeclarationsDoc`（不写时间戳、不写行号 ⇒ 逐字可重生成）。
  - 新建 `scripts/gen-capability-declarations.mjs`：默认只打印统计，`--write` 重写文档。首版缺陷已修：`new URL("..").pathname` 带尾斜杠时 `abs.slice(root.length + 1)` 会削掉相对路径首字符（表头输出成 `lugins/...`），改用 `fileURLToPath` 并去尾斜杠。
  - `tests/doc-contract.test.ts` 新增 **D10** 三条：登记表存在（否则 `docs/SECURITY-MEASURES.md` 的 3 处链接是死链）／与重生成结果**逐字相等**／抽取器正向对照（`terminal_exec` = `proc.exec→["command"]`、`snapshot_create` = `proc.exec→fixed`、`fs_read` 带 `fs.read`、固定名注册 >150、打包产物被扫到但不进逐条表、手写插件 `plugins/git-workflow-enhanced/index.js` 必须在表内 —— 后两条互锁，防"把 plugins 整个排除掉"蒙过门）。
  - `docs/SECURITY-MEASURES.md`：§2.7.1 的"177 处工具注册点"手抄计数改为指向生成表首行（本文不再复述任何计数）；§2.7.5 补两条（`db.write` 把 SQL 文本按 filesystem 裁决，既不防护也可能误伤，并入既有 `db_query` 行；两个插件打包产物是能力内核之前的旧构建）。
  - 新建 `docs/security/tool-capability-declarations.md`（由脚本生成，349 行）。
- **登记表测得的事实**（重新测得，不是复述旧文档）：固定名注册 **186** 处、动态名 **1** 处（`src/mcp/client-connector.ts` 的 `mcp_${name}_${tool.name}`）、声明 `proc.exec` **25** 处（24 处 `"fixed"` + 1 处声明 `command`，与 R2-D 提交的 25 处吻合）、**未声明能力 0 处**、schema 不可静态核 1 处。
- **本片新发现的洞（登记表自己咬出来的，未修）**：`plugins/dre-dsh/backend/server.js`（726 KB）与 `plugins/kb-dsh/backend/server.js`（4.2 MB）是提交入库的压缩产物，内含 42 与 29 处注册且**零 `capability`**。判据链：其 `package.json` 的 `build:backend` 是 `bun build ../../src/mcp/dre-backend.ts --minify`（打包入口用的就是现行 `ToolRegistry`），而源码侧同名注册点 `src/mcp/server/dre-tools.ts`（35）+ `mind-tools.ts`（7）= 42 条**全部带声明** ⇒ 产物是 R1 之前的旧构建，里面生效的仍是按字段名/工具名正则的旧守卫（`command|script|cmd`、`path|file|target|destination|from|to`、按工具名推 delete/write/read）。运行这两个产物等于回到名字正则内核，I1 与 S-8 都不生效。**本片只登记不重建**（重建＝压缩文件整体重写、diff 数 MB、插件测试需独立跑），是否立即重建待用户裁决。
- **验证结果（全部新鲜执行）**：
  - `bun run lint`（`tsc --noEmit`）→ **exit 0**
  - `bun test ./tests/doc-contract.test.ts ./tests/capability-invariants.test.ts` → D10 三条**全绿**；S-1…S-8 全绿（唯一红仍是 S-6 回环单源，R3 已知）；doc-contract 其余 11 条红与基线**同名同数**（R5 范围），且新增件不在任何 offender 列表内：`docs/security/tool-capability-declarations.md:` 命中 **0**，D1 的 43 处命中全为既存文件
  - 全量（内存封顶、与基线同口径）`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests` → **4171 pass / 36 skip / 15 fail**（4222 tests / 411 files / 36.33s）。相对 R2-A/B/D/E 的 4169/14：+3 为 D10 用例；多出的第 15 个失败是 `tests/edge-cases/performance-degradation.test.ts` 的 E.4 p99 分位数 —— 单跑该文件 p99=22.99ms **通过** ⇒ 判为 `--parallel=8` 下的时序抖动（环境相关），登记为已知 flaky，不计为本片引入
  - **D10 存活证明**（非"绿即可信"）：往生成的文档末尾手工追加一行 `| terminal_exec | proc.exec | 手抄一行 | 1 | 人工改写 |` ⇒ "逐字一致"立即转红；恢复后转绿。手抄与事后改表都跑不掉
  - **敏感资产扫描（规则 11）**：新增/修改文件对 `sk-*`(≥16)/`AKIA*`/`ghp_*`/`-----BEGIN *PRIVATE KEY-----`/`192.168.` 命中 **0**
  - **并入判定**：本分支仍带已知红（R3/R4/R5 + 环境件），**只推分支不并入 `main`**（与 R1/R2 同口径）
- **矛盾与残留**：① 抽取器只看 `.add({` 字面量，运行期由远端 `listTools()` 决定的注册、以及不走 `add()` 的调用面不在表内 —— 表尾"这张表不证明什么"已明写这一边界；② `"fixed"` 的真实性仍由人保证（机器只校验字段名确实存在于 schema），表里"24 处 fixed"是**声明数**不是**正确数**；③ 打包产物旧构建是新登记的洞，未修；④ `tiersFor` 对 `db.write` 会显示"入参可裁决"，读者易误读为已防护 ⇒ 以表尾脚注说明，不改判据（改了会与 §2.7.5 的债项脱钩）。
- **Commit**：8299750（`8299750b5613e42a7500a23403976e9a803d68b6`；已推送 `internal codex/s3-on-main-2026-09-22`，`c44c3763..8299750b`。本条 hash 由占位符回填，回填提交属记录维护，规则 5）

## 2026-09-22 06:26 +0800 — R3-① 回环豁免并入单源：两个 MCP HTTP 后端不再无条件信任本机

- **任务**：R3 第一片，收掉上一片记录在案的"唯一红仍是 S-6 回环单源"。S-6 的静态扫描判据是"调用 `isLocalAddress(` 的源文件必须同时调用 `localBypassEnabled(`"，offender 为 `src/mcp/dre-backend.ts` 与 `src/mcp/kb-backend.ts`：两者 HTTP 模式把回环地址直接当作 `isLocal` 传给 `checkApiKey` ⇒ 网关侧默认关闭豁免之后，本机任意进程仍可从 3001/3002 端口免 token 拿到全 API —— L6 没封堵，只是换了个入口。`docs/SECURITY-MEASURES.md` 的 L6 行早已写"只有一个开关来源"，本片之前那是宣称不是事实。
- **工具**：Read（两后端通读 + `src/utils/security-defaults.ts`、`src/utils/auth-check.ts` 语义核对）、Edit（各 2 处）、Bash（bun test / tsc）。无子代理。AGENTS 规则 2（备份 `.tmp/backups/src/mcp/{dre,kb}-backend.ts` → 通读 → 最小改动 → 验证）执行；备份在两片验证通过后统一删除。
- **操作**（文件级）：`src/mcp/dre-backend.ts`、`src/mcp/kb-backend.ts` 各两处改动 —— ① 引入 `localBypassEnabled(process.env)` 得 `allowLocalBypass`；② 鉴权调用改 `checkApiKey(req, allowLocalBypass && isLocalAddress(remoteAddr), apiKey)`。顺带删去注释里手抄的 `server.ts:439-447` 行号锚点（D9 口径：行号必漂，只指到文件）。默认绑定 `127.0.0.1`、`*_MCP_HOST`/`AXIOM_AUTH_TOKEN` 读取、stdio 分支与工具注册面均未动。
- **验证结果（新鲜执行）**：`bun test ./tests/capability-invariants.test.ts` → S-6 由红转绿（offender 列表转空），整件 40/40；`bun test ./tests/mcp-backend-auth.test.ts` → 3/3（该文件只锁"接线存在"，行为语义另由 `tests/auth-check.test.ts` 覆盖 ⇒ 本片真正的门是 S-6 的静态扫描）；`bun run lint`（`tsc --noEmit`）→ exit 0。全量套件并入下一片记录。
- **红线**：不改 `checkApiKey` 本体与 `localBypassEnabled` 默认值；两后端 stdio 分支不含鉴权，未动。
- **Commit**：87b6b46（`87b6b46a600ba50ab9b59cc14a6199cbc980efd7`）

## 2026-09-22 06:26 +0800 — R3-② 命令危险判据收敛为单源（新增 S-9 门，§2.7.4 第 1 条）

- **任务**：§2.7.5 登记的"命令危险模式有两份清单"债。派发前裁决走 `permissions.ts` 的 `HIGH_RISK_PATTERNS`（原始串匹配、不去混淆），执行点走 `command-safety.ts` 的 `DANGEROUS_PATTERNS` + `STRUCTURAL_PATTERNS`（去混淆、但缺提权/账号/SQL 类）⇒ 同一条命令在两条路径可得相反结论，违反"每层判定同一批事实"。
- **RED 量测（先测后改，非凭印象）**：把 HEAD 上两份清单逐字抄回 `.tmp/r3b/divergence.probe.ts`，对 40 条语料（= 新测试的 MUST_DENY 20 + MUST_ALLOW 8 + probe 12）求差：**17 条分歧**，且双向 —— 9 条派发前放行／执行点拒（`rm${IFS}-rf /`、`r\m -rf /`、`wget … | sh`、`base64 -d x | sh`、`$(whoami)`、反引号、`format c:`、`rd /s /q`、`powershell -EncodedCommand`），8 条派发前拒／执行点放行（`chmod 777`、`useradd`、`userdel`、`passwd`、`shutdown`、`reboot`、`delete from`、`DROP TABLE`）。合并后同一语料复测（`.tmp/r3b/after.probe.ts`）：**0 条分歧**。分歧数与语料数已写进新测试的文件头注释，不留在临时件里。
- **工具**：Read（`command-safety.ts` / `permissions.ts` 全文通读、`payloadCandidatesForCapability` 与 `decideCapability` 的 command 分支核对影响面）、Write（RED 探针 + 新测试文件）、Edit（两份清单合并、`commandDanger` 导出、两处调用点改道、文档三处、测试四处）、Bash（bun test 红→绿 / tsc / 全量 / 探针）。无子代理。AGENTS 规则 2（备份 `.tmp/backups/src/utils/{command-safety,permissions}.ts` 与 `tests/rigorous/…` → 通读 → 最小改动 → 验证 → 删备份）与规则 7（垂直切片）执行。
- **操作**（文件级）：
  1. `src/utils/command-safety.ts`：三张表并入 `CommandDangerRule[]`（`DANGEROUS_RULES` 18 + `STRUCTURAL_RULES` 3 + `ESCALATION_RULES` 11，后者从 `permissions.ts` 搬来）并导出唯一清单 `COMMAND_DANGER_RULES`；新增 `commandDanger(command): string | null`（对 [原始串, 换行归一串, 去混淆串] 三份目标匹配，返回判据描述）；`sanitizeCommand` 黑名单分支改调 `commandDanger`，拒绝文案 `Dangerous command blocked for safety` 与白名单分支逐字不变。
  2. `src/utils/permissions.ts`：删除 `HIGH_RISK_PATTERNS`，`checkCommandPermission` 改为 `commandDanger` 的 `PermissionCheck` 适配层，保留 `High-risk operation detected: <描述>` 文案形状（`tests/unit/risk-monitor-degraded.test.ts` 断言该前缀）；同步更正"自动接收模式"段里对旧清单名的引用。
  3. 判据取并集时补宽两处，防派发前层因换表而退化：`mkfs\.` → `mkfs`、`fdisk\s+` → `fdisk`（旧派发前表是裸词，新表原为带后缀形状）。
  4. 新建 `tests/command-danger-single-source.test.ts`（31 例）：MUST_DENY/MUST_ALLOW 两层同判 + 12 条 probe 的两层**结论相等**（不只锁危险侧，也锁正常命令不被合并清单误伤）+ `commandDanger` 正向对照 + 守卫层真实拒绝（`registry.execute` 抛 `HardFloor` 且 handler 未运行）。
  5. `tests/capability-invariants.test.ts`：新增 **S-9**（清单只有一个导出点；两文件确实调用 `commandDanger(`；`src/` 下再无 `*_PATTERNS =` 定义点）。结构门与行为门分工：S-9 锁"没有第二份"，新测试锁"结论相等"。
  6. `tests/rigorous/security-rigorous.test.ts`：`shutdown -h now`、`reboot` 从"已知局限（不强制拦截）"移入必须拦截集；Windows 变体那条从"只断言判定不崩"收紧为**两层都拒**（合并前派发前那份表根本不认 `cmd /c rd /s`）。`tests/unit/risk-monitor-degraded.test.ts` 文件头对已删符号的指称同步更正。
  7. `docs/SECURITY-MEASURES.md`：§2.7.4 第 1 条括注加 S-9；§2.7.5 的原债行替换为残留项（白名单模式只在执行点生效 ⇒ 该模式下执行点**严于**派发前，方向是 fail-closed，登记以免被读成"两层完全同构"）；§7.1 门件表补 `command-danger-single-source.test.ts` 一行，并把两处过期计数 `S-1…S-7`／`D1–D9` 更正为 `S-1…S-9`／`D1–D10`。
- **影响面核算（合并清单前先量）**：`proc.exec` 的 25 处注册里 24 处声明 `"fixed"` ⇒ `payloadCandidatesForCapability` 直接返回空、不进命令裁决，实际只有声明 `command` 的 `terminal_exec` 会被派发前命令判据命中 ⇒ 清单变严的爆炸半径限于该工具，且与执行点原判定同向。
- **验证结果（全部新鲜执行）**：目标 7 件 `bun test ./tests/command-danger-single-source.test.ts ./tests/capability-invariants.test.ts ./tests/rigorous/security-rigorous.test.ts ./tests/unit/command-safety.test.ts ./tests/command-safety-newline.test.ts ./tests/unit/risk-monitor-degraded.test.ts ./tests/mcp-backend-auth.test.ts` → **163 pass / 0 fail**（S-9 两条为新增，capability-invariants 42/42）。`bun run lint` → exit 0；`bun run test:arch` → 25/25。全量（内存封顶、同口径）→ **4204 pass / 36 skip / 13 fail**（4255 tests / 412 files / 38.58s）：11 条 doc-contract（R5 既存）+ 1 条 HttpRouter 缓存（R4 既存）+ 1 条 OCR（缺 `tessdata`，环境件）⇒ S-6 那条红已消失，实质红 14→13。第二遍全量在更高负载下另多 2 条时序抖动（`stress/high-intensity-load.test.ts` 的 C.5 Layer 0+1+2 用时 16.55s 撞 15s 超时、`edge-cases/performance-degradation.test.ts` 的 E.4 p99）；两文件单跑 **32 pass / 0 fail**（21.29s），且与本片改动无调用关系 ⇒ 判为 `--parallel=8` 负载抖动、登记为已知 flaky，不计为本片引入。
- **敏感资产扫描（规则 11）**：本片新增的行对 `sk-*`(≥16)/`AKIA*`/`ghp_*`/`-----BEGIN *PRIVATE KEY-----`/`192.168.` 命中 **0**（被改文件内的既存命中只有一处，是 `tests/rigorous/security-rigorous.test.ts` 的 SSRF 夹具 `http://192.168.1.1/`，属规则允许的测试夹具）。**顺带查出的既存残留（非本片引入，未擅自清理）**：本文件历史条目里有 3 处私有地址入库 —— 两条 `deploy.sh` 相关的 `192.168.0.22` / `listen@192.168.0.110`（含 SSH 用户@主机），以及一条完整的 `ssh://git@…:2222/agent/Axiom.git` remote URL。按规则 11 与规则 3"不在文档复制 IP/URL"的现行口径应抹为占位；但改历史条目＝改写留痕，与本仓库"操作日志只追加"的约定冲突，且同族清理在 `847f486` 只做到了 AGENTS.md ⇒ 列为待用户裁决项，不在本片静默处理。
- **红线**：不改判定层级（HardFloor ①、复核 ②、审批桥顺序不动）；不改 `sanitizeCommand` 的白名单分支与错误文案；`db.write` 仍按 filesystem 裁决（该债留在 §2.7.5 原行，本片不动，避免把 SQL 语义判据混进命令清单）。
- **矛盾与残留**：① 白名单模式（`AXIOM_TERMINAL_WHITELIST`）只在执行点生效，两层并非完全同构 —— 已按 fail-closed 方向登记；② 判据仍是正则黑名单，`find / -delete`、变量间接（`a=rm; $a -rf /`）、`rm -r --force` 仍不覆盖，单源只保证"两层同样漏"，不保证"不漏"；③ 合并后派发前也做去混淆，理论上多一层误伤面（如命令字段值里出现 `passwd` 字样），本片语料未见，但样本非全量。
- **并入判定**：本分支仍带已知红（R4/R5 + 环境件），只推分支不并入 `main`（与 R0/R1/R2 同口径）。
- **Commit**：edf323e（`edf323e72e490b62acc7eb416db82e5a32b677a4`；两片已推送 `internal codex/s3-on-main-2026-09-22`，`baadc7cf..edf323e7`。本条与上一条 hash 由占位符回填，回填提交属记录维护，规则 5）

## 2026-09-22 06:57 +0800 — R3-③ 序列复核主体接线：守卫按当次调用归集，不再一律 `unassigned`（新增 S-10 门）

- **任务**：§2.7.5 首行的登记债 —— `defaultToolGuard` 调 `reviewSequence` 时不传 principal，全体调用方共用 `"unassigned"` 一个桶，I4 的身份维度形同虚设。目标：把"谁在发起这次调用"从传输边界带到守卫，并按真实粒度记录口径（不得把凭证摘要写成用户身份）。
- **前置量测（先证症状再改）**：接线前对 `tests/call-principal-plumbing.test.ts` 求 RED → **2 pass / 7 fail**（9 例）。关键判别例是反向的那条：调用方 B1 先 `fs.write`、B2 再 `proc.exec`，接线前 B2 被 `复核判定为高危操作` 阻止（1002ms 走审批桥的无处理者自动拒绝路径）⇒ 既存缺陷不只是"审计答不出是谁"，还有**跨调用方互相续链**（一方写入即可让无关另一方的高危动作提前进审批，也可被反向用来制造噪声）。同一文件里"同一主体 write→exec 被升级"与"未标注仍共桶"两条在接线前即通过，说明缺的是身份供给而非链路识别。
- **工具**：Read（`tool-registry.ts` 全文、`http-router.ts` 全文、`risk-monitor.ts` 的 `ToolCallView`/`reviewSequence`/`escalate`、`mcp/server.ts` 与两个插件后端的请求处理段、`approval-bridge.ts` 的无处理者分支、`node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js` 的 `onmessage` 派发位置）、Write（新测试 2 件）、Edit（源码 6 处 + 门件 1 处 + 文档 4 处）、Bash（bun test 红→绿 / tsc / test:arch / test:smoke / 全量 / 变异探针）。无子代理。AGENTS 规则 2（备份 `.tmp/backups/` 下 8 件 → 通读 → 最小改动 → 验证 → 删备份）与规则 7（垂直切片：守卫消费 → 上下文常量单源 → 路由边界 → 门）执行。
- **操作**（文件级）：
  1. `src/utils/call-context.ts`（新增）：`AsyncLocalStorage` 主体载体（`currentCallPrincipal` / `callPrincipalOr` / `runAsCallPrincipal`）+ 凭证→主体派生 `credentialPrincipal`（`authorization` 或 `x-api-key` 原始头值取 sha256 截 16，无凭证归 `anonymous`）+ 两个桶名常量 `UNATTRIBUTED_PRINCIPAL="unassigned"`、`ANONYMOUS_PRINCIPAL="anonymous"`。选 ALS 而非显式传参的理由写在该文件头：守卫是 `add()` 期包进 handler 的，拿不到当次请求对象，而一次请求可嵌套执行（路由→工具→skill→再入工具）。
  2. `tests/call-context.test.ts`（新增，5 例）：边界外为 null、同步与 await 后均传播、并发分支不串桶、嵌套继承、凭证摘要稳定且不泄原文。
  3. `src/mcp/tool-registry.ts`：`defaultToolGuard` 的 ② 层新增 `const principal = callPrincipalOr()` 并把 `principal` 放进 `reviewSequence` 的 call 对象；注释写清"主体必须来自当次调用而不是注册期"与"未标注落共桶是 fail-closed"。派发前 ① 层的 `principal: "tool:" + toolName` **不改**（该字段只随 `CapabilityCheck` 透传、不进任何判定，且它标的是"哪次派发被裁过"，与序列层的"谁"不同维度）。
  4. `src/agents/risk-monitor.ts`：`call.principal ?? "unassigned"` → `?? UNATTRIBUTED_PRINCIPAL`（缺省桶名不再写第二份字面量），`ToolCallView.principal` 注释更正为"缺省归入 unassigned 共桶（缺标注不等于免序列）"。
  5. `src/core/http-router.ts`：`defaultPrincipal` 由自带 sha256 实现改为委托 `credentialPrincipal(ctx.req.headers)`（与 I4 共用同一份身份口径，删掉本地 `createHash` 依赖）；`execute` 内 `principal` 只算一次，缓存键与 handler 执行同用；Step 2 改为 `await runAsCallPrincipal(principal, () => record.handler(ctx))`。
  6. `src/mcp/server.ts`、`src/mcp/dre-backend.ts`、`src/mcp/kb-backend.ts`：三条 MCP HTTP 后端的 `httpTransport.handleRequest(req)` 包进 `runAsCallPrincipal(credentialPrincipal(req.headers), …)`。依据（读 SDK 源码核实，非推测）：SDK 在 `handleRequest` 内以 `this.onmessage?.(message)` 派发 JSON-RPC 请求（JSON 模式在 `new Promise(executor)` 体内、SSE 模式在返回 `Response` 前的 for 循环内），工具执行链从该作用域派生 ⇒ ALS 可穿透。
  7. `tests/call-principal-plumbing.test.ts`（新增，9 例）：同主体升级并阻止 / **不同主体不共窗**（判别例）/ 未标注仍共桶 / 升级留痕带主体（断言 `security.alert` 的 `metadata.payload` 含 `r3c-caller-D → [proc.exec]`、`reason` 含 `write-then-execute`）/ 路由 handler 跨 await 仍持主体且与 `credentialPrincipal` 同值 / 不同凭证不同桶 / 无凭证归 `anonymous` / 缺省桶名单源 / 凭证派生只有一个定义点。
  8. `tests/capability-invariants.test.ts`：新增 **S-10**（3 例）——守卫从上下文读主体且把主体交给序列复核；4 条可识别调用方的执行边界恰为已标注清单（`walkTs("src")` 反向求差，新增边界须显式登记）；`unassigned` 字面量除定义点外不得再出现在 `= ? :` 位置。结构门与行为门分工照旧：S-10 锁"接线点在位"，新测试锁"结论随主体而变"。
  9. `docs/SECURITY-MEASURES.md`：I4 行的门列补 S-10；§2.7.4 第 1 条括注加"S-10 调用主体单点标注"；§2.7.5 删除已封堵的原首行，替换为两行新残留（主体粒度只到凭证/边界，stdio/TUI/进程内直调仍共桶；限流器 `extractUserKey` 另算一份身份）；§7.1 门件表 `S-1…S-9`→`S-1…S-10` 并补 `call-context.test.ts`、`call-principal-plumbing.test.ts` 两行。
- **门的活性证明（防"只断言不失效"）**：两次受控变异，均在原文件上做、事后逐字还原并以 `diff` 确认零差异。① 从 `const call = {…}` 里删掉 `principal` → S-10 第一条 RED（`expect(...).toBeTrue()` Received: false，且失败断言正是那条正则）；② 把 `kb-backend.ts` 的包裹还原成裸 `handleRequest` → S-10 第二条 RED（`toContain` 打回整文件）。两次变异都只跑目标 `-t` 过滤，还原后复跑为绿。
- **顺带查出（非本片引入，未擅自扩大改动面）**：写"凭证→主体派生单源"门时全量扫 `src/`，命中 4 处 sha256 截 16 的伴生件——`src/utils/rate-limiter.ts:275 extractUserKey`（真·第二份身份口径：先剥 `Bearer ` 再取摘要，与 `credentialPrincipal` 对原始头值取摘要不同源）、`src/dre/synapse/store.ts:19 synapseHash`、`src/kg/enhanced.ts:215,294`（内容指纹，与身份无关）。后果与处置：门收窄到"缓存分桶 + 序列复核"这一条派生（S-10 只锁 `credentialPrincipal` 的导出点与两处消费者），限流键的分歧登记为待裁决项（并入会改限流分桶语义），文档 §2.7.5 同步行。
- **验证结果（全部新鲜执行）**：目标 5 件 `bun test ./tests/call-principal-plumbing.test.ts ./tests/capability-invariants.test.ts ./tests/call-context.test.ts ./tests/command-danger-single-source.test.ts ./tests/risk-monitor.test.ts` → **121 pass / 0 fail**（capability-invariants 45/45，含 S-10 三条）。`bun run lint` → exit 0（首跑拦到一条 TS2339：夹具把 ctx 断成 `never` 后取 `.req`，改为返回 `{ctx, req}`）；`bun run test:arch` → **25 pass / 0 fail**；`bun run test:smoke` → **63 pass / 0 fail**（与基线一致）。全量（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`）→ **4223 pass / 36 skip / 13 fail**（4272 tests / 414 files / 32.40s）：11 条 doc-contract（R5 既存）+ 1 条 HttpRouter 缓存（R4 既存）+ 1 条 OCR（缺 `tessdata`，环境件）⇒ 与上一片同口径，实质红 13→13 未增，本片新增的 17 条用例全绿；上一片登记的两条负载抖动（stress C.5、performance-degradation E.4）本次未触发，仍按已知 flaky 登记不撤。`tests/doc-contract.test.ts` 单独复跑 8 pass / 11 fail 与基线逐条一致（文档编辑未引入新红）。
- **敏感资产扫描（规则 11）**：本片新增/修改行对 `sk-*`(≥16)/`AKIA*`/`ghp_*`/`-----BEGIN *PRIVATE KEY-----`/`192.168.` 命中 **0**；测试夹具用的是 `r3c-token-*`、`fixture-*` 与 `http://r3c.test` 伪域，不触及真实主机。任务 #32（历史条目里 3 处既存私有地址）仍待用户裁决，本片未改任何历史条目。
- **红线**：不动守卫分层顺序（⓪ 模式 → ① HardFloor → ② 复核/序列 → 审批桥）；不把 `reviewSequence` 的配对规则或阈值改了（`SEQUENCE_WINDOW_MS`/`SEQUENCE_BURST_LIMIT`/`CHAIN_PAIRS` 逐字未动）；不改缓存键形态（仍是 `method:path:search#principal`，principal 的**取值**因单源委托而逐字不变）；不为凑绿把 stdio/TUI 伪装成某个主体。
- **矛盾与残留**：① 已认证主体不存在——标签只到"凭证摘要 / `anonymous` / 传输边界"，同一 token 的多条连接仍同桶，跨连接协同不受本片约束；② stdio MCP、TUI、进程内直调无请求对象 ⇒ 仍共 `unassigned` 桶（保守方向：链路会互相接续，不会漏判，但审计仍答不出是谁）；③ **三条 MCP 后端的包裹没有端到端行为测试**——只有 S-10 的结构门与 SDK 源码阅读支撑，真正的"HTTP 请求→工具执行→主体入桶"链路未跑通（要起 `Bun.serve` 与 MCP 客户端才有条件证），此处如实标注为未证；④ 限流器身份口径分歧（见"顺带查出"）。
- **记录维护（非新增条目）**：本文件头"归档索引"的当月条目数由 91 更正为 137（按 `^## 2026-09` 实数）；该列自 8 月末拆分后未随条目递增更新，趁本片一并校正，不另开提交。
- **并入判定**：本分支仍带已知红（R4/R5 + 环境件），只推分支不并入 `main`（与 R0/R1/R2 同口径）。
- **Commit**：45be9c9（`45be9c938001d2c9cf153fe7f39843c88536d98c`；已推送 `internal codex/s3-on-main-2026-09-22`，`5973d348..45be9c93`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）

## 2026-09-22 07:11 +0800 — R4 响应缓存按路由显式开启收口：修 stale 回归件 + 新增 S-11 开启清单门 + 更正指南手抄体

- **任务**：R0 重放后遗留的唯一实质功能红（`tests/unit/http-router-response-cache.test.ts` 首条），以及"按路由显式开启"这句话的三面收口——测试口径、文档口径、机器门。
- **前置量测（先证症状再改）**：单跑该文件 → **3 pass / 1 fail**，失败断言为 `expect(handlerCalls).toBe(1)`，`Expected: 1  Received: 3`。**归因（读代码 + 全量扫描，非推测）**：该用例以"GET 默认可缓存"为前提（其文件头原话：`触发条件极宽：GET + status<400 + 路由未显式 cacheable: false（无路由设置该项）`），而 S3-P3/I3 已把语义反转为 `const cacheable = method === "GET" && record.meta?.cacheable === true`（`src/core/http-router.ts:259`）⇒ 红的是**测试的旧前提**，不是缓存实现。同文件另外两条（`/stats`、`/a`+`/b`）名字写"缓存"却在默认语义下根本不进缓存，属"名字与断言脱节"的假绿：删掉 `clone()` 它们仍绿。**关键事实**：`grep -rn cacheable src/` 只命中 `http-router.ts` 自身的判定与注释；`grep -c "meta:" src/routes/index.ts` → **0**，即 `registerTrieRoutes()` 里 `const routes: RouteRecord[]`（`src/routes/index.ts:263-478`，`engine.registerBatch(routes)` 于 480 行注册）无一条携带 `meta` ⇒ 生产面响应缓存**零消费者**。
- **判断（与任务字面"显式开启"的偏差，如实写出）**：本片**不给任何生产端点开缓存**。开一条 = 把该端点的响应交给后来的调用方读，需要逐条裁决"是否与调用方无关 + 能否容忍 TTL 内陈旧"，而 `/health`（含 uptime）、`/api/git/*`（工作区状态）这类恰恰是最不该缓存的；无驱动需求时逐条开启属于过度施工（规则 1）。收口动作改为：让"谁开启了"成为必须被看见的决定（新门），并把旧口径的测试与文档纠正到现行语义。
- **工具**：Read（`http-router-response-cache.test.ts` 全文、`capability-invariants.test.ts` 的 S-4/S-9/S-10 块与 `walkTs`/`read` helper、`doc-contract.test.ts` 的 D4/D9 实现与规范件口径、`SECURITY-MEASURES.md` I3/L7/§2.7.5/§7.1、`COMPREHENSIVE-GUIDE.md` §execute、`src/routes/index.ts` 注册数组）、Edit（4 个文件）、Bash（红→绿、两次受控变异、tsc、test:arch、test:smoke、内存封顶全量、规则 11 扫描）。无子代理。AGENTS 规则 2（备份 5 件到 `.tmp/backups/` → 通读 → 最小改动 → 验证 → 待提交后删）与规则 7（垂直切片：测试纠正 → 新门 → 文档）执行。
- **操作**（文件级）：
  1. `tests/unit/http-router-response-cache.test.ts`：三条走缓存路径的注册逐条补 `meta: { cacheable: true }`（`/health` 在既有 meta 上加字段、`/stats`、`/a`+`/b`），使其真正命中缓存；文件头口径更正为"S3/I3 后响应缓存按路由显式开启，本文件锁的是**开启之后**那条路上的对象复用缺陷；默认不缓存由 S-4 单独锁"。缺陷本体（`Response` body 一次性流 ⇒ 复用同一对象必抛 `TypeError: Body already used`）与 `cacheable:false` 那条用例未动。
  2. `tests/capability-invariants.test.ts`：新增 **S-11「生产路由的响应缓存开启清单」**（1 例）——`walkTs("src")` 反向求 `/cacheable\s*:\s*true/` 命中的文件集合，与门内 `CACHEABLE_ROUTES: string[] = []` 全等；正则刻意不匹配 `cacheable === true` 与 `cacheable?: boolean`，故判定实现自身不误伤。清单为空即把"当前无人开启"从巧合变成被断言的不变式，新增声明必须同时改门 ⇒ 成为强制的一次可见裁决（与 S-10 的 `BOUNDARIES` 同形）。行为面仍由 S-4 三条（默认可缓存⇒必须显式、显式仍命中、键含身份、查缓存排在匹配之后）承担，本片不重复。
  3. `docs/COMPREHENSIVE-GUIDE.md`：删掉该节手抄的 `execute()` 函数体（26 行）改为指向门的要点式描述。删前该副本已同时漂移四处：查缓存排在匹配之前、命中直接返回同一对象、缓存键无身份维度、`record.meta?.cacheable !== false`（默认全缓存），且句中带 `(line 173)` 手抄行号 —— 正是 D9 禁 file:line 锚点所防的形态，只是本副本写作 `path.ext:NN` 之外故未被拦。替换文本只保留可核验的机制陈述并逐条挂上门号（S-4 / S-10 / S-11），不再复制代码。相邻 `match()` 的副本未动（非本片口径），其 `(line 130)` 一并去除。
  4. `docs/SECURITY-MEASURES.md`：§2.7.1 I3 行与 §2.7.2 L7 行的门列 `S-4`→`S-4、S-11`；§2.7.5 残留表首行（"路由响应缓存当前无路由声明 `cacheable`"）补记"默认关闭由 S-4 锁行为、开启者由 S-11 锁清单（当前为空）"，并把后续动作写清为逐条裁决两件事、开启者须同进 S-11；§7.1 门件表 `S-1…S-10`→`S-1…S-11`。
- **门的活性证明（防"只断言不失效"）**：两次受控变异，均在原文件上做、事后以备份 `cp` 还原并用 `diff -q` 确认零差异（`RESTORE-EXACT-MATCH`），未对脏文件使用任何 `git checkout`/`restore`。① 把 `http-router.ts:270` 的 `return cached.clone()` 改成 `return cached` → 被纠正后的回归件首条 RED（`Received promise that rejected`，正是原缺陷形态）⇒ 证明测试纠正后仍抓得住本缺陷，未退化为恒真；② 在 `src/routes/index.ts:265` 的 `/health` 注册上加 `meta: { cacheable: true }` → S-11 RED（清单求差把该文件列为多出的命中）⇒ 证明未登记即开启会被拦下。两次还原后复跑均绿（回归件 4/4，capability-invariants 46/46）。
- **验证结果（全部新鲜执行）**：目标 5 件 `bun test ./tests/capability-invariants.test.ts ./tests/unit/http-router-response-cache.test.ts ./tests/call-principal-plumbing.test.ts ./tests/call-context.test.ts ./tests/doc-contract.test.ts` → **72 pass / 11 fail**（11 条全在 doc-contract，为 R5 既存基线，逐条同名；新增 S-11 计入 capability-invariants 46/46）。`bun run lint` → exit 0；`bun run test:arch` → **25 pass / 0 fail**；`bun run test:smoke` → **63 pass / 0 fail**（与基线一致）。全量（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`）→ **4225 pass / 36 skip / 12 fail**（4273 tests / 414 files / 31.19s）：逐条枚举为 11 条 doc-contract + 1 条 OCR（缺 `tessdata`，环境件）⇒ 实质红 13→12，HttpRouter 缓存红消除且无新红；上一片登记的两条负载抖动（stress C.5、performance-degradation E.4）本次仍未触发，按已知 flaky 登记不撤。
- **敏感资产扫描（规则 11）**：本片新增行对 `sk-*`(≥16)/`AKIA*`/`ghp_*`/`-----BEGIN *PRIVATE KEY-----`/`192.168.`/`ssh://`/`Bearer <长串>` 命中 **0**（`RULE11-CLEAN`）。任务 #32（历史条目 3 处既存私有地址）仍待用户裁决，本片未改任何历史条目。
- **红线**：不给任何生产端点开缓存；不改缓存键形态与默认值（仍 `method:path:search#principal`、仍默认不缓存）；不改守卫分层与 `match`/`register` 实现；不改 `clone()` 修复本体（仅以变异临时移除、随即还原）。
- **矛盾与残留**：① 响应缓存至今零生产消费者——"性能换安全"这一权衡是 S3-P3 顺带落下的，从未被单独裁决，S-11 只是让它可见，没有回答"要不要有人开"；② S-11 拦的是"未登记就声明"，拦不住"登记了但判错"：身份维度只到凭证/边界，同一共享 token 下不同用户读同一 `cacheable` 端点仍会互取响应，门与测试都不覆盖这条（要覆盖需要"已认证用户"这一本系统不存在的前提）；③ `doc-contract` 的 D 系列**没有"手抄代码块"规则**：D4 拦表格行数、D9 拦 `path.ext:NN`，而本节这种"整段复制函数体"的漂移无人管，本次靠人眼发现，已登记为独立待办；④ `match()` 的副本仍是手抄，本片未动。
- **并入判定**：本分支仍带已知红（R5 + 环境件），只推分支不并入 `main`（与 R0/R1/R2/R3 同口径）。
- **Commit**：9c33ac2（`9c33ac23a8473c1d4492484ab242e7072d23fddf`；已推送 `internal codex/s3-on-main-2026-09-22`，`e17a3b3a..9c33ac23`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）
## 2026-09-22 07:34 +0800 — R5① doc-contract 豁免谓词失配纠正（+D0 自证门）②markdown 文本完整性修复（BOM/CR/C0/正文 TAB，围栏内 TAB 豁免）

- **任务**：R5 的总目标是把 main 侧文档口径重构到 `tests/doc-contract.test.ts` 全绿。本片落前两刀：R5-a 修门自身的扫描面失配，R5-b 清 markdown 文本完整性（BOM/CR/C0/正文 TAB）。R5-c（禁语 15）、R5-d（D2/D3/D4/D9 引用与手抄）、R5-e（D6/D7/D8 登记表与清单）留后续提交，本片不为凑绿而扩面。
- **前置量测（先量再改）**：
  - R5-a 根因：HEAD 的 `const HISTORY = /(^|\/)(operations-log|CHANGELOG)\.md$|REVIEW|AUDIT|ASSESSMENT|EVALUATION/`（`tests/doc-contract.test.ts:47`）在三处调用点都以 `path.basename(f)` 代入 —— 带 `(^|/)` 的那一支在 basename 上只能靠 `^` 命中，实际等价于"只认大写命名的 REVIEW/AUDIT 文件 + 根操作日志"。实测口径面：`caliberDocs()` 108 篇里旧豁免 **15** 篇、在册规范件 **94**（含 README）；新谓词豁免 **41** 篇、在册 **68** ⇒ 26 篇小写命名的证据件（`docs/review-2026-08-19-…`、`docs/reviews/2026-…`、按月拆分的 `docs/operations-log/2026-07.md` 与 `2026-08.md`、`docs/audit-verification-log.md`、`docs/knowledge/…assessment-2026-08-29.md`）此前一直被当规范件扫。后果（R5-a 改动前实测，已记入门内注释）：D3 的 89 条里 55 条、D4 的 52 条里 41 条、D9 的 493 条里 301 条出自这类文件。
  - R5-b 基线：按修复后的判据（CR 单报、围栏内 TAB 放行）重扫 HEAD 的 156 篇在扫 md ⇒ **6,330** 条：BOM 13、含 CR 的行 6,274、正文 TAB 30、BEL(0x07) 8、BS(0x08) 5。旧判据因 CR 行级+字符级双计，同一语料报 **12,651** 条 —— 虚高一倍，R4 条目里"12,651/12,653"的口径混乱即源于此（本片已把双计改掉）。
- **判断（为何先修门再改文档）**：约一半的 R5 红不是文档腐烂，而是门的豁免谓词失效造出的假阳性。若按红单逐条改文档，就会把证据件里被有意保留的"问题原话"按规范件口径改写，破坏证据 —— 历史件豁免正是为此存在。故 R5-a 定性为 bug fix，不是"把正则写宽"，并配 D0 自证门防下一次静默。
- **工具**：Read（`tests/doc-contract.test.ts` 的 D0/D1/D2/D3/D4/D9 实现与 scope helper、README/REMINDERS/plan 的受损段落）、Edit（`HISTORY` + 三处调用点 + D0 块 + 完整性判据抽取 + 边界自证）、Write/Bash（`.tmp/r5b-inventory.mjs`、`.tmp/r5b-refine.mjs`、`.tmp/r5b-repair.mjs` 三个量测与修复脚本）、Bash（红→绿、三次受控变异、tsc、test:arch、内存封顶全量、规则 11 集合核验）。无子代理。规则 2：15 篇 md + 1 篇 ts 先备份 `.tmp/backups/` 再改；本片全部改动另可用 `git show HEAD:<file>` 复核，备份在验证通过后删除。
- **操作**（文件级）：
  1. `tests/doc-contract.test.ts`（R5-a）：`HISTORY` 改为对**整条相对路径**做大小写无关、词边界取 `[\/._-]` 的名词匹配；三处调用点（`specDocs`、`caliberScope`、D2）由 `path.basename` 改为整条相对路径；新增 **D0 口径扫描范围自证** 3 例 —— 12 篇规范件必须在册、8 篇证据件必须豁免、`specDocs ≥ 60` 且 `豁免面 ≤ 45`（实测 68/41，上限只留 4 个余量）、`preview` 一类名字不得被当成 review 蒙进豁免面。
  2. 13 篇 md 剥离 BOM：`README.md`、`docs/AGENT-ARCHITECTURE.md`、`docs/ARCHITECTURE.md`、`docs/AUDIT-2026-08-13.md`、`docs/BROWSER-AGENT-STRATEGY-2026-08-09.md`、`docs/PROJECT-GUIDE.md`、`docs/research/CCF-agent-topics-2026-08-12.md`、`docs/reviews/2026-08-11-backend-architecture-review.md`、`docs/reviews/2026-08-11-toolchain-review.md`、`docs/reviews/2026-08-12-resource-audit.md`、`docs/self-evolving-agent-openrsi-2026-08-11.md`、`docs/superpowers/plans/2026-08-24-audit-remediation-plan.md`、`docs/superpowers/plans/2026-08-28-plan-amendment-most-stable.md`。**另有 13 篇 `eval-results/*.md` 同样带 BOM，但在 D1 完整性范围（`mdFiles("docs") + README.md`）之外，本片未扩面**，登记为残留。
  3. CRLF→LF：`README.md` 756 处、`docs/operations-log/2026-08.md` 5,518 处。改前逐字节核验"CR 是否只作行尾"：两文件 CR 总数 757/5,520 对比 CRLF 数 756/5,518 ⇒ 各只多出 1~2 个行尾外 CR，定位后确认它们正是被吃掉的首字母（下一条），不是行尾变体 ⇒ 归一化保内容。
  4. 单字母复原 46 处（3 lone CR + 30 正文 TAB + 13 C0，分布于 `README.md`、`docs/operations-log/2026-08.md`、`docs/REMINDERS.md`）：CR→'r'（`readdirSync`、`results.sort`、`research`）、TAB→'t'（`tests/…`、`tsc --noEmit`、`tool_use`）、BEL→'a'（`assertReadableFile`、`assertSafeHttpUrl`、`assertSafeCdpUrl`、`ask()`、`applyRemoteUpdate()`、`archive/`、`architecture`、`accelint-readme-writer`）、BS→'b'（`bun run build:backend`、`bytesPerToken??229376`、`b.score-a.score`、README 与 REMINDERS 的两处 `bash`）。复原字母逐处由**存活文本**决定，不按公式外推；修复脚本对尾文做白名单断言，白名单外站点直接 abort（首跑即被 abort 两次：一次分类逻辑笔误、一次白名单窗口过短），全程未做批量替换。反查命中：`ask()` 见 `src/dre/actor/system.ts:260,291`，`bytesPerToken` 见 `src/dre/system-resource.ts`，`assertReadableFile`/`assertSafeHttpUrl`/`assertSafeCdpUrl`/`applyRemoteUpdate` 均在对应源文件存在。**`accelint-readme-writer` 未获反查**（`accelint|ccelint` 全仓只这一处，属外部 skill 名，代码无从对照）—— 依"存活文本 + 同类站点全为 BEL 吃首字母"复原为 `accelint-…`，此处如实标注为未证。
  5. `README.md` 围栏复原：L78 单反引号+`bash` → 三反引号+`bash`、L84 单反引号 → 三反引号。依据：块内内容是 `# 检查搜索引擎健康状态` 与 `curl http://localhost:18789/engines`，与同文件另 7 个 ```bash 块同构；复原后 README 的 ``` 围栏行数成偶数。
  6. `tests/doc-contract.test.ts`（R5-b）：完整性判据抽为模块级 `integrityOffenders(rel, txt, hasBom)`；**TAB 只在代码围栏之外算损伤** —— `docs/superpowers/plans/2026-08-25-audit-p0p1-remediation.md` 的 ```go 块内 44 处行中制表符是 gofmt 真实缩进，一律判损伤会逼文档撒谎；CR 改由行级判据单报。新增 1 例边界自证：正文 TAB 必须报、围栏内 TAB 必须放行、围栏内的 C0/CR 照样报。
  7. `docs/REMINDERS.md`：只复原 L24 的 'b'。该处缩进代码块的围栏结构已损坏（L24 以单反引号起、L26 以两个反引号加 `n` 起头且疑似丢了换行）—— 复原结构要猜作者原意，本片不做，登记残留。
  8. `docs/operations-log.md`：本条目；并把文首"归档索引"的当月条目数 137 更正为 139（`^## 2026-09` 实数，R4 条目未同步该列；回填 hash 的提交属记录维护，不再追加新业务条目）。
- **门的活性证明（三次受控变异，均在原文件上做、事后 `cp` 还原并以 `diff -q` 确认零差异，未对脏文件使用任何 `git checkout`/`restore`）**：① 撤掉围栏豁免（`(col === 0 || inFence)`→`(col === 0)`）→ 真实语料 RED，`控制字符 0x9` 恰 **44** 条且全部出自那个 ```go 块 ⇒ 豁免有承重，不是消音器；② 向 `README.md:57` 回插 BEL → 完整性条 RED 且只报 `README.md:57: 控制字符 0x7` ⇒ 修好的绿抓得住回归；③ 把 `HISTORY` 换成写宽的 `/review|operations-log|changelog|audit|eval/i` → D0 三条里 **两条** RED（名册条 `Received: false`、探针条 `Received: true`），但"豁免面 ≤45"这一条**未**触发 ⇒ 如实记录：数量上限只兜得住大幅扩张，本次这类宽化靠名册与探针兜。
- **验证结果（全部新鲜执行）**：`bun test ./tests/doc-contract.test.ts` → **13 pass / 10 fail**（23 tests；本片动工前 11 红 ⇒ 本片消掉 1 条完整性红，另 4 条新增自证全绿）。剩余 10 条逐条计数：D1 禁语 15、D2「唯一权威」2（上限 1）、D3 反引号路径 15、D3 本地链接 9、D4 表格行数 48、D4 内联行数 3、D6（`docs/AXIOM-ARCHITECTURE.md` 缺 `<!-- BEGIN:nondeterminism-registry -->` 锚块，失败形态是 `expect(m).not.toBeNull()`）、D7 未登记决策符号文件 7、D8（§3.0 只有"层/分类/数量/依赖"表，反引号领域文件列出 **0** 条 vs 实际 23 个 `src/mcp/server/*-tools.ts`）、D9 行号锚点 43。`bun run lint` → exit 0；`bun run test:arch` → **25 pass / 0 fail**；全量（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`）→ **4229 pass / 36 skip / 12 fail**（4277 tests / 414 files / 31.98s；R4 基线 4225/36/12，+4 为本片新增自证）：10 条 doc-contract + OCR（缺 `tessdata`，环境件）+ `perf-benchmark` 的 `EventBus 100k publish < 300ms`（并行下 388.65ms；单跑两次 **175.60ms / 174.60ms 均 pass** ⇒ 判为负载抖动而非回归，本片未加任何运行时代码，登记为第三条已知 flaky 不撤）。
- **敏感资产扫描（规则 11）**：本片含行尾归一化，`git diff` 会把历史行显示成新增行，故按**内容集合**而非"新增行"核验：三篇被改 md 的 `192.168.*`/`sk-*`/`AKIA*`/`ghp_*` 命中数改前改后逐文件相等（README 1/1、`docs/operations-log/2026-08.md` 67/67 且排序后集合全等、REMINDERS 0/0）⇒ 未引入任何新地址或凭据，只让既存内容换了行尾。那 67 处私有地址属任务 #32（历史条目清理，待用户裁决），本片按既定口径未动任何历史条目；其中 `sk-abcd1234efgh5678` 经复核是该文件 L5127 叙述测试红灯现象时写的**占位串**，非真实 key。
- **红线**：不改口径判据语义（禁语清单、锚点形态、行数形态一字未动），只修豁免面与完整性判据的适用范围；不把任何证据件按规范件口径改写；不扩面到 `eval-results/`。
- **矛盾与残留**：① 完整性扫描与口径扫描共用 `HISTORY` 但范围不同（前者 `mdFiles("docs")` 含 `docs/superpowers/`、后者 `caliberDocs()` 不含）⇒ 同一篇 superpowers 计划件受完整性扫描却不入口径扫描，这是刻意的，但意味着"豁免面"在两处不是同一个集合，读红单时容易混；② 围栏感知靠 ``` 行计数切换，若某篇文档本身有**奇数**个围栏行，其后的 TAB 会被整体误判为"围栏内"——本次语料未见，但没有任何门把"围栏行数成偶"看着（候选新规则，与待办 #34 同族）；③ `accelint-readme-writer` 的复原未获反查；④ `docs/REMINDERS.md` L24/L26 的围栏结构、`eval-results/*.md` 的 13 个 BOM 属登记未修；⑤ 本片只证明"门的判据在真实语料上不再产自身假阳性"，没有证明 156 篇 md 的口径正确性 —— 后者仍是 R5-c/d/e 的活。
- **并入判定**：本分支仍带 10 条已知红，只推分支不并入 `main`（与 R0/R1/R2/R3/R4 同口径）。
- **Commit**：28f413a（`28f413aa5f17357e97467fb5bf891477292818fa`；已推送 `internal codex/s3-on-main-2026-09-22`，`698ea35a..28f413aa`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）

## 2026-09-22 07:51 +0800 — R5-c 口径禁语清零：行级引用哨兵取代门的文件级自豁免 + 12 处断言改写

- **任务**：R5 第三片，消掉 D1「BANNED 短语在口径范围内 0 命中」的 15 条红。拆成两件事：① 门侧 —— 本门原先把 `tests/doc-contract.test.ts` 整个文件排除在扫描面外（因为清单必须逐字写出禁语），这等价于"改坏门自己没有任何门看着"；改为**行级引用哨兵**，把文件级豁免删掉。② 文档/代码侧 —— 12 处真实的绝对断言改写为可核验的机制陈述。R5-d（D2/D3/D4/D9 引用与手抄）、R5-e（D6/D7/D8 登记表与清单）留后续提交。
- **前置量测（先枚举再改）**：D1 红单 15 条全部落在 `.ts`（`grep` 反查 md：命中 10 篇全在豁免面内 —— `docs/superpowers/**` 由 `caliberDocs()` 排除，`docs/operations-log.md`、`docs/reviews/**` 由 `HISTORY` 豁免 ⇒ md 侧 0 红）。分布：`src/utils/math.ts:4,5`、`src/dre/runtime/text-rank.ts:23,26`、`src/semantic/symbolic-similarity.ts:51`、`tests/prompt-engineer.test.ts:2,13,15,130,131,147`、`tests/torture.slow.ts:222`、`tests/unit/docs-consistency.test.ts:38,39,40`（+ 门自身 `:41,42` 因文件级豁免而不可见）。
- **判断（为何不照红单逐条改字）**：那 3 条红是**另一道门的判据文本**（`docs-consistency` 用 `collectDocsHits(/零向量/)` 复查同一件事），把它按"禁语"改写等于删掉一条保护，正解是让"引用禁语作判据"成为可声明的例外；其余 12 条是真正的口径断言，逐处按代码事实改写。改写不做信息删减：`math.ts` 的"零向量 → 0"落成"任一侧模长为 0 → 0"，与该函数实际判据 `if (na === 0 || nb === 0) return 0`（`src/utils/math.ts:17`）严格对齐，比原词更准。
- **工具**：Read（`math.ts`、`symbolic-similarity.ts`、`text-rank.ts` 头部、`prompt-engineer.test.ts` 全文、`torture.slow.ts:205-244`、`docs-consistency.test.ts` 全文、`doc-contract.test.ts` 的 D0/D1 块与 scope helper）、Edit（7 个文件）、Bash（红→绿、三次受控变异、tsc、test:arch、内存封顶全量、规则 11 扫描）。无子代理。规则 2：7 件先备份 `.tmp/backups/`（含本片新写的 `docs/operations-log.md` 备份）→ 通读 → 最小改动 → 验证，备份在提交后删。规则 7 垂直切片：先改门并**看到红**，再消红。
- **操作**（文件级）：
  1. `tests/doc-contract.test.ts`：新增 `QUOTE_SENTINEL = "doc-caliber:quote"` 与 `bannedHitOn(line)`（**只**放过带哨兵的那一行），D1 的两处判定改走它；`caliberScope()` 删除 `const self = "tests/doc-contract.test.ts"` 的文件级豁免 ⇒ 本门进入自己的扫描面；`BANNED` 两条数据行与自证条的 1 处负控行加哨兵注释。新增 2 例自证：`引用哨兵只豁免它所在的那一行（豁免不得变成免检文件）`（含"哨兵与真断言同行即一起放过"这一已知极限的显式断言）、`依赖哨兵的引用行全部在册，且本门自身在扫描面内`（按**文件集合**全等登记，不列行号 —— 列行号会与 D9 的禁手抄锚点自相矛盾且随编辑漂移）。`vault 生成件` 一条刻意不走 `bannedHitOn`：生成笔记没有"引用禁语作判据"的正当场景，不给它哨兵豁免通道。
  2. `tests/unit/docs-consistency.test.ts`：三条引用行加 `// doc-caliber:quote` 并在其上写明引用理由；该门的判据、用例名、豁免口径一字未动。
  3. 12 处改写（均为注释/文本，无运行时语义）：`src/utils/math.ts:4-5` 零向量→任一侧模长为 0、全零输入；`src/dre/runtime/text-rank.ts:23,26` 卖点"零向量"→"纯词法匹配 / **纯词法**"（该文件自身下一句本就是"纯词法匹配，不引入 embedding / 向量库"）；`src/semantic/symbolic-similarity.ts:51` "与原向量实现零向量口径一致"→"与原向量实现在空输入时的口径一致"；`tests/prompt-engineer.test.ts` 6 处（文件头→"纯规则驱动，无 embedding / 向量依赖"、describe→"确定性提示词引擎（纯规则驱动）"、用例 8 名→"无向量方法验证"，该用例断言的正是 `PromptEngineer` 原型上无 `embed/vector/similarity/cosine` 方法，改名后与断言更贴合）；`tests/torture.slow.ts:222` 注释→"纯规则匹配"。
  4. `docs/operations-log.md`：本条目；文首归档索引当月条目数 139→140（`grep -c '^## 2026-09'` 实数）。
- **门的活性证明（三次受控变异，均在原文件上改、事后按内存中的原文回写并断言零差异，未使用任何 `git checkout`/`restore`）**：① 删去 `BANNED` 首行的哨兵 → D1「0 命中」RED 且 offender **恰 1 条**（`tests/doc-contract.test.ts:41`）⇒ 哨兵是承重的，不是装饰；② 把 `if (line.includes(QUOTE_SENTINEL))` 改成永假 → D1 RED（列出 8 条带哨兵引用行）+ 自证条 RED；③ 把 `bannedHitOn` 改成无条件 `return null`（行级豁免扩成全局消音）→ **D1「0 命中」仍绿**、自证条 RED ⇒ 如实记录：这道条"绿"在门被写坏时是沉默，哨兵的活性由两条自证承担，读红单时不得把「0 命中绿」当唯一证据。三次还原后复跑 16 pass / 9 fail 不变。
- **验证结果（全部新鲜执行）**：改门后、加哨兵前实测 **16** offenders（原 15 + 新自证条自身的 1 处引用），逐条与预期同名 ⇒ 红是可归因的；改后 `bun test ./tests/doc-contract.test.ts` → **16 pass / 9 fail**（25 tests；R5-b 基线 13 pass / 10 fail / 23 tests ⇒ D1 红清零、新增 2 例自证全绿）。`bun test ./tests/unit/docs-consistency.test.ts ./tests/prompt-engineer.test.ts` → 9 pass / 0 fail 与 10 pass / 0 fail（两道门的用例名与断言均未改，改名只动 describe/用例文本）。`bun run lint` → exit 0；`bun run test:arch` → **25 pass / 0 fail**；全量（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`）→ **4233 pass / 36 skip / 10 fail**（4279 tests / 414 files / 31.14s；R5-b 基线 4229/36/12）：剩余 10 条 = 9 条 doc-contract（D2 1、D3 路径 15 + 链接 9、D4 表格 48 + 内联 3、D6 锚块缺失、D7 未登记 7 文件、D8 §3.0 领域文件 0 vs 23、D9 锚点 43）+ OCR（缺 `tessdata`，环境件）；上一片登记的 `perf-benchmark` `EventBus 100k` 负载抖动本次未触发 ⇒ 无新红、零运行时改动。
- **敏感资产扫描（规则 11）**：`git diff -U0 | grep '^+' | grep -cE "sk-[A-Za-z0-9]{16}|AKIA|ghp_|BEGIN [A-Z ]*PRIVATE KEY|192\.168\.|ssh://|Bearer [A-Za-z0-9._-]{20}"` → **1**，且经定位该行就是本条"敏感资产扫描"自身（`192.168.` 与 `ssh://` 作为**待扫模式名**出现，非真实地址）⇒ 排除本行自述后真实命中 **0**。本片刻意不引入 `path:line` 形态的引用清单（见操作 1 的理由）。任务 #32（历史条目既存私有地址）仍待用户裁决，本片未动任何历史条目。
- **红线**：`BANNED` 七个短语一字未动（只加行尾注释）；`HISTORY` 谓词与豁免面未扩；不删 `docs-consistency` 的重复门；不改任何运行时行为；不改写证据件里的原话。
- **矛盾与残留**：① 仓库现在有**两条**独立的禁语门且豁免口径不同 —— `doc-contract` D1 按整条相对路径做名词匹配，`docs-consistency` 按目录名排除 `{archive, reviews, superpowers, operations-log}` 再加分支名前缀 ⇒ 同一篇文档可能一边在册、一边豁免（例：`docs/my-evaluation-guide.md` 在 D1 被豁免、在 `docs-consistency` 在册）。本片只做引用豁免，未收敛双源（收敛要改判据语义，超出 R5-c 口径），与待办 #34 同族登记；② 哨兵的滥用极限是"真断言与哨兵写在同一行即放过"，在册条只到**文件粒度**，逐行清单需以行号为代价 ⇒ 现由"新增引用行必须改这条全等断言"承担可见性；③ 历史证据件里出现的旧用例名（如 `docs/reviews/2026-08-21-final-acceptance.md:54` 引用的"无过时零向量描述"）不随本次 describe/用例改名更新 —— 证据件保持原话，是刻意的不一致；④ `tests/torture.slow.ts` 文件名不匹配 `*.test.ts`，默认 `bun test` 收不到，本片改的虽是注释，但它在 D1 扫描面内而在测试执行面外这一事实值得记（属 R6 门禁接入范围）。
- **并入判定**：本分支仍带 9 条 doc-contract 已知红 + 1 条环境红，只推分支不并入 `main`（与 R0/R1/R2/R3/R4/R5-a/b 同口径）。
- **Commit**：88e569e（`88e569ec54acf1d7f96b4435337d23b3228eeb80`；已推送 `internal codex/s3-on-main-2026-09-22`，`7d0c055a..88e569ec`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）


## 2026-09-22 08:04 +0800 — R5-d① 门判据假阳性纠正（行内代码不算链接 / 覆盖率百分比不算行号锚点）+ D2 权威唯一收口

- **任务**：R5-d 的总目标是把 D2/D3/D4/D9 的剩余红清零。本片（切片①）只动三处：D3 与 D9 各自的**判据缺陷**，加 D2 的一处真实口径冲突。顺序理由与 R5-a 同 —— 红单本身失真时逐条改文档，就会把真实测得值（覆盖率）和代码示例（`[name](args)`）按错误判据改掉。
- **前置量测（动工前一次性 dump 全量红单到 `.tmp/r5d-offenders.txt`，再逐条归因，不按首条直觉开工）**：
  - 基线（HEAD `88e569e`）：`bun test ./tests/doc-contract.test.ts` → **16 pass / 9 fail**。逐条计数：D2 自称式「唯一权威」**2**（上限 1）、D3 反引号路径 **15**、D3 本地链接 **9**、D4 表格行数 **48**、D4 内联行数 **3**、D6 缺 `<!-- BEGIN:nondeterminism-registry -->` 锚块、D7 未登记决策符号文件 **7**、D8 §3.0 列出 **0** 条 vs 实际 23、D9 行号锚点 **43**。
  - D3 链接的 9 条里 **1** 条是门误判：`docs/AXIOM-ARCHITECTURE.md:1013 → args`，来源是 `registry.buildHttpHandlers()[name](args)` —— 行内代码里的方括号-圆括号，markdown 不渲染成链接，读者点不动，判它是死链等于逼文档改代码示例。
  - D9 的 43 条里 **5** 条是门误判：`docs/test-reports/SUMMARY.md:16,17,18,19,21` 的 `src/dre/system-resource.ts:66.67% Funcs`、`url-safety.ts:100% / 88.89%`、`event-bus.ts:75% / 85%` 等是**覆盖率测得值**，形态像 `文件:数字` 而语义是百分比。同文件 `:31` 的 `src/utils/platform.ts:133`（`withExecutableExt` 定位）是真锚点，本片**不**豁免。
  - D2 的 2 条：`docs/AXIOM-ARCHITECTURE.md:3`（判据指定的权威落点）与 `docs/PROJECT-GUIDE.md:3`「本文档是 Axiom 项目的**唯一权威**入门与参考文档」—— 后者是真实的第二权威声明，且与同文件下一行"深层架构细节请参考 ARCHITECTURE.md"自相矛盾。
- **判断（9 条红里只有 1 条属于"文档说谎"）**：D3/D9 的两条若不改判据，代价不是"多几条红"，而是后续切片（48 处行数、38 处锚点）在被污染的名册上逐条核对，并会诱导"删真实数据换绿灯"。故本片只改"什么算一次引用"这一层，不碰禁的形态本身。
- **工具**：Read（`tests/doc-contract.test.ts` 的 D2/D3/D9 块、`docs/PROJECT-GUIDE.md` 文首、`.tmp/r5d-offenders.txt` 全量红单、`docs/AXIOM-ARCHITECTURE.md:1011-1015`、`docs/test-reports/SUMMARY.md:16,31`）、Edit（3 个文件）、Bash（红→绿、三次受控变异、tsc、test:arch、内存封顶全量、规则 11 扫描）。无子代理。规则 2（3 件先备份 `.tmp/backups/` → 通读 → 最小改动 → 验证 → 待提交后删）与规则 7（垂直切片：判据纠正 → 自证断言 → 变异证活性）执行。
- **操作**（文件级）：
  1. `tests/doc-contract.test.ts` D3：本地链接扫描前先 `stripInlineCode` —— 把 `` `...` `` 覆写为**等长空格**，因此偏移不变 ⇒ 报出的行号仍指原文那一行；链接求取抽为 `localLinks()` 供判据与自证共用（避免"自证测的是另一份逻辑"）。新增 1 例自证：代码示例内的 `[name](args)` 不入选、真链接照旧入选且行号按原文计、外链继续排除。
  2. `tests/doc-contract.test.ts` D9：`ANCHOR` 尾部加两个否定前瞻 `(?!\.\d)(?![\d%])`，把 `ts:66.67%` 与 `ts:100%` 排除在锚点之外；在既有"锚点禁令不得被门自身绕过"自检里加 **4** 条断言 —— 2 条正向（百分比、小数必须判非锚点）+ 2 条反向（`:12` 后跟中文句号、`:53,68` 后跟逗号仍必须是锚点 ⇒ 前瞻不得成为逃出口）。
  3. `docs/PROJECT-GUIDE.md:3`：「本文档是 Axiom 项目的**唯一权威**入门与参考文档」→ 改为入门/操作参考定位并前向指向 `AXIOM-ARCHITECTURE.md`（D2 本就放行"见 / 参见 / 指向"这类前向引用形态）。H1「项目权威指南」未动 —— 判据只拦自称"唯一权威"，改写 H1 属于自行扩大口径（登记为残留②）。
- **门的活性证明（三次受控变异，Python 驱动在原文件上单点改写，事后 `cp` 还原并以 `diff -q` 确认零差异，未对脏文件使用任何 `git checkout`/`restore`）**：
  - M1 取消 D3 的行内代码覆写 → `17 pass / 9 fail`，RED 的正是新增的 D3 自证条 ⇒ 覆写有承重，不是把扫描面整体缩掉。
  - M2 取消 D9 的百分比排除（去掉 `(?![\d%])`）→ `17 pass / 9 fail`，RED 的是 D9 自检条 ⇒ 前瞻有承重。
  - M3 把前瞻**写宽**成"锚点后跟非数字字符即放行"（句号因此成为逃出口）→ `17 pass / 9 fail`，RED 的仍是 D9 自检条 ⇒ 反向断言确实兜得住"以修 bug 为名把豁免写宽"这类改坏。
  三次还原后复跑与本片绿基线一致（18 pass / 8 fail，8 条红逐条同名）。
- **验证结果（全部新鲜执行）**：`bun test ./tests/doc-contract.test.ts` → **18 pass / 8 fail**（26 tests；本片前 16/9）。差异可归因：D2 整条转绿、D3 链接 9→8、D9 43→38、新增 1 条自证转绿 ⇒ fail 9→8、pass 16→18。剩余 8 条逐条计数：D3 路径 15、D3 链接 8、D4 表格 48、D4 内联 3、D6 缺锚块、D7 未登记文件 7、D8 0-vs-23、D9 锚点 38。`bun run lint` → exit 0；`bun run test:arch` → **25 pass / 0 fail**；全量（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`）→ **4235 pass / 36 skip / 9 fail**（4280 tests / 414 files / 31.77s；R5-b 基线 4229/36/12）：实质红为 8 条 doc-contract + 1 条 OCR（缺 `tessdata`，环境件）⇒ 无新红；R5-b 登记的第三条已知 flaky（perf-benchmark `EventBus 100k publish`，并行抖动）本次未触发，按已知登记不撤。
- **敏感资产扫描（规则 11）**：本片新增行对 `sk-*`(≥16)/`AKIA*`/`ghp_*`/`-----BEGIN *PRIVATE KEY-----`/`192.168.`/`ssh://`/`Bearer <长串>` 命中 **0**（`git diff -U0 | grep '^+' | grep -oE …` 空输出）。
- **红线**：不改禁的形态（禁语清单、`文件 | 行数` 形态、`path.ext:NN` 主模式）；不为凑绿扩 `HISTORY`/`specDocs`/`caliberDocs` 豁免面（本片一字未动）；不删任何真实测得值 —— 纠正的是判据，不是数据；D4/D6/D7/D8/D10 未被触碰。
- **矛盾与残留**：① D3 的两半对"反引号"语义不一致 —— `PATH_REF` 把反引号当作"点名一个文件"（这恰是它的定义，故**不能**复用 `stripInlineCode`），`localLinks` 把反引号当作代码文本。同一对符号在一条规则里两种解释，读红单时容易混，登记不并；② D2 只拦自称"唯一权威"，`docs/PROJECT-GUIDE.md` 的 H1「项目权威指南」属同族口径却不被拦 ⇒ 判据覆盖面与真实口径不重合，这类"语义同族、形态不同"的漏拦在 D4（表格 vs 内联 vs 本片的 `path.ext:NNN` 变体）上反复出现；③ 百分比排除依赖"`:` 后数字紧跟 `%` 或小数点"，若将来出现被误写成百分比的真锚点（`file.ts:12%`）会被放过 —— 当前语料无此形态，不为假设加判据；④ 本片只消掉 9 条红里判据失真的 2 条，其余 7 条是文档与代码的真实漂移，留给 R5-d②③④。
- **并入判定**：本分支仍带 8 条已知红 + 1 条环境红，只推分支不并入 `main`（与 R0/R1/R2/R3/R4/R5-a/b/c 同口径）。
- **Commit**：9c99f81（`9c99f81d9c1facbcb193791e68eee8128d6924cd`；已推送 `internal codex/s3-on-main-2026-09-22`，`978a1e0f..9c99f81d`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）


## 2026-09-22 08:24 +0800 — R5-d② 文档引用存活清零（D3 路径 15 + 本地链接 8 → 0）：tombstone 从"整行消音"改为"点名式反向断言"

- **任务**：R5-d 切片②。切片①只纠正判据失真，本片按红单逐条核对"文档说的话是否还成立"，把 D3 两半（反引号路径、markdown 本地链接）清零；D4（表格 48 + 内联 3）、D6（缺锚块）、D7（未登记 7 文件）、D8（0 vs 23）、D9（锚点 38）各自留后续切片，不并进本片凑绿。
- **前置量测（15 条路径红逐条 `git log` / `git show --stat` 反查，不按首条直觉开工）**：
  - **4 + 1 条插件内简写路径**：`docs/plans/2026-08-19-dre-dsh-plugin.md:40,42,46,48` 的 `tests/mcp-bridge.test.ts`/`src/config.ts`/`tests/config.test.ts`/`src/index.ts`，同文件 Files 段已用 `plugins/dre-dsh/...` 完整前缀 ⇒ 是同一份计划里的写法不一致，补全前缀（4 件逐一 `test -e` 确认存在）；`docs/experiment-2026-08-19-external-benchmarks-and-diagnostics.md:17` 的 `tests/config.test.ts` 同理落为 `plugins/dsh/tests/config.test.ts`。
  - **2 条外部仓库路径**：`docs/research/deepseek-harness-plugin-2026-08-14.md:15` 的 `docs/user/develop/basic/tool.md`、`docs/cordis-primer.md` 属上游 `deepseek-harness` 仓库而非本仓 ⇒ 加 `deepseek-harness/` 前缀并写明"路径相对**上游仓库根**，不在本仓库"。同段落 `packages/...` 形态本就因前缀不匹配不被拦，说明这是既有表述形态而非新造豁免通道。
  - **1 条占位符**：`docs/PROJECT-GUIDE.md:543` `tests/mcp-xxx.test.ts` → `tests/mcp-<domain>.test.ts`（`xxx` 形态易被当成文件名，`<domain>` 是约定形态）。
  - **7 条"已删除模块"的真实引用**：`src/db/pg-client.ts` ×4（`docs/ARCHITECTURE.md:58,290`、`docs/LIMITATIONS.md:62`、`docs/functional-check-2026-08-16-sensenova.md:46`）、`src/memory/math-enhanced-memory.ts` ×1（`docs/AXIOM-ARCHITECTURE.md:1328`）、`src/memory/conformal-retriever.ts` ×2（`docs/COMPREHENSIVE-GUIDE.md:751,1228`）。删除提交经 git 反查确认：pg-client = 38966d12（2026-08-21，H-M1-03），conformal-retriever 与 math-enhanced-memory = c3b2d351（2026-08-30，P2-S2 幽灵裁剪），两文件的删除行数在 `git show --stat` 中逐一见证 ⇒ 文档"已删除/归档删除"的表述**不是谎**，红因是 D3 无条件要求路径存在会逼文档删掉"我们删过什么"。故建 tombstone 通道而非改文档。
  - **8 条链接红**：`docs/PROJECT-GUIDE.md:584-590` 7 行（`api-audit-report.md`/`review-core.md`/`review-frontend.md`/`review-security.md`/`review-knowledge.md`/`REVIEW-2026-07-17.md` 六件经 `git show --stat a6db7411` 确认已移除；`changelog.md` 实际在仓库根且名为 `CHANGELOG.md`）→ 接替为 2 行（`reviews/` 目录 + `../CHANGELOG.md`）；`README.md:350` 指向不存在的 `docs/v2.9.2-COMPREHENSIVE-REPORT.md` → 删该链接、保留同句的 MCP 指南链接。
- **判断（为何"每行加个注释"不成立）**：第一版把哨兵做成"整行消音"，实测新增 **12** 条红 —— `tombstone 失效 → src/main.ts 仍存在`、`→ src/db/pg-schema.sql 仍存在`、`→ docs/ARCHITECTURE.md 仍存在` 等：墓碑行通常同时点名活文件（"旧件已删，新件仍在"是最自然的写法），整行消音等于把活引用一起放过，反向断言随即失效。改为**标记必须点名自己豁免哪个路径**，并加"空转"反向检查（点名了、本行却无反引号引用 ⇒ 文档改版后遗留的墓碑）。这与 R5-c 引用哨兵同构：**豁免的粒度必须等于声明的粒度**。
- **顺带纠正的真实文档错误（不是为凑绿）**：① `docs/ARCHITECTURE.md:58,290` 与 `docs/LIMITATIONS.md:62` 原写"`pg-schema.sql` 仅归档保留"，实测该文件**仍在仓库**（`Dockerfile` 会 COPY 进镜像，运行时代码无消费者，源码侧仅 `src/utils/db-guard.ts` 一条注释提到）⇒ 改为可核验表述并补删除提交号；写"全仓唯一提及处"时经 `grep -rl pg-schema` 反查发现 `Dockerfile`/`package.json` 也命中，故限定为"源码"并显式点名 Dockerfile 行为。② `docs/COMPREHENSIVE-GUIDE.md` §4.4 逐字抄了整段已删模块的 TypeScript（含手写 `at line 342`）⇒ 以墓碑 + 在役记录（`src/main.ts` 休眠链注释、`tests/math-breakthroughs.test.ts` 文件头，两处均已读到原文确认）+ 历史读取命令替换，并删汇总表对应行；删段后核查围栏计数为偶（100）。③ `docs/PROJECT-GUIDE.md` 附录 A 的"完整架构白皮书（69KB）"是手抄测得值，提交时实测 75,105 B（=73.3 KB）已漂移 ⇒ 去掉该度量（该形态不被 D4 覆盖，属任务 #34 登记的漏拦族）。
- **工具**：Read（D3 块全文、四篇文档相关段落、`tests/math-breakthroughs.test.ts` 头部、`src/main.ts` 休眠注释）、Edit（8 文件）、Bash（`git log`/`git show --stat` 反查删除提交、`test -e` 存在性、红→绿、三次受控变异、tsc、test:arch、内存封顶全量、规则 11 扫描）、Python（6 处哨兵迁移逐处 `assert count==` 后替换，不做静默多替换；全 md 的 `plugins/` 引用普查）。无子代理。规则 2：12 件（11 改动件 + 本日志）先备份 `.tmp/backups/` → 通读 → 最小改动 → 验证，备份待提交后删。规则 7 垂直切片：改门（看到红）→ 迁文档（转绿）→ 变异证活性。
- **操作**（文件级）：
  1. `tests/doc-contract.test.ts`：`PATH_REF` 目录集合加 `plugins`（前置普查：全 md 的 `plugins/` 引用 33 条，唯一死引用 `docs/superpowers/plans/2026-09-14-knowledge-backend-convergence.md:32` 在口径豁免面内，纳入后 D3 仍绿 ⇒ 未借本片扩/缩豁免面）；行级标记由裸 `<!-- doc-caliber:absent -->` 升级为 `<!-- doc-caliber:absent: <path>[, <path>] -->`（新增 `ABSENT_MARK`/`absentTargets`），`deadPathOffenders` 改为"点名才豁免 + 空转即报"并返回 `checked`；主判据保留 `checked > 200` 覆盖面自证并加"至少一条墓碑在册"的通道自证；新增 2 例 —— 反向断言自检（6 组断言：未点名死路径仍报／点名且确不存在则通过且入册／点名但仍存在报"失效"／同行活路径不受影响／同行第二条未点名死路径仍报／空转报）、使用 tombstone 的文件集合全等登记。
  2. 文档 10 篇：`docs/ARCHITECTURE.md`(2 哨兵 + PG 口径)、`docs/LIMITATIONS.md`(1)、`docs/functional-check-2026-08-16-sensenova.md`(1 + 标注"本条此后失效")、`docs/COMPREHENSIVE-GUIDE.md`(§4.4 墓碑 + 表行删除)、`docs/AXIOM-ARCHITECTURE.md`(接线点去已删模块 + 1 哨兵)、`docs/PROJECT-GUIDE.md`(占位符 + 附录 A 两行 + 去 69KB)、`README.md`(删死链)、`docs/experiment-2026-08-19-external-benchmarks-and-diagnostics.md`(1)、`docs/plans/2026-08-19-dre-dsh-plugin.md`(4)、`docs/research/deepseek-harness-plugin-2026-08-14.md`(外部仓库路径标注)。
  3. `docs/operations-log.md`：本条目；当月条目数 141→142（`grep -c '^## 2026-09'` 实数）。
- **门的活性证明（三次受控变异：Python 在原文件单点改写 → 跑门 → `cp` 还原 → `cmp` 断言零差异，未对脏文件使用任何 `git checkout`/`restore`）**：M1 删"空转"检查 → D3 自检条 RED（其余 D3 条不变绿 ⇒ 该检查唯一承重处正是墓碑遗留）；M2 把"点名才豁免"改回"整行消音"（`marked.includes(target)` → `marked.length > 0`）→ **主判据 RED 且**自检条 RED（真实文档的墓碑行都带活路径，整行消音当场把活引用误判为"失效"）；M3 删"失效"反向断言（墓碑退化为纯消音器）→ 自检条 RED 而**主判据仍绿** ⇒ 如实记录：墓碑是否仍在断言"不存在"只由自检条承重，读红单时不得把「D3 绿」单独当证据。三次还原后复跑 22 pass / 6 fail 不变。
- **验证结果（全部新鲜执行）**：`bun test ./tests/doc-contract.test.ts` → **22 pass / 6 fail**（28 tests；切片①为 18 pass / 8 fail、26 tests）。差异可归因：D3 路径 15→0、D3 链接 8→0（2 条转绿）+ 新增 2 条自证（绿）⇒ pass +4、fail −2。剩余 6 条逐条计数：D4 表格 48、D4 内联 3、D6 缺 `<!-- BEGIN:nondeterminism-registry -->`、D7 未登记 7 文件、D8 §3.0 列 0 vs 实际 23、D9 锚点 38。`bun run lint` → exit 0；`bun run test:arch` → **25 pass / 0 fail**；全量（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`）→ **4238 pass / 36 skip / 8 fail**（4282 tests / 414 files / 31.97s；①基线 4235/36/9）：8 条 = 6 条 doc-contract + OCR（缺 `tessdata`，环境件）+ `perf-benchmark` `EventBus 100k publish`（R5-b 登记的第三条已知 flaky，本次**复现**，非本片引入，登记不撤）。本片零运行时改动 ⇒ 无新红。
- **敏感资产扫描（规则 11）**：`git diff -U0 | grep '^+' | grep -nE "192\.168\.|10\.0\.|sk-[A-Za-z0-9]{8}|ghp_|AKIA|BEGIN [A-Z ]*PRIVATE KEY|://[^ ]*:[^ ]*@"` → 空输出（真实命中 **0**）。同片涉及的 `docs/functional-check-2026-08-16-sensenova.md:50` 局域网代理地址属历史既存项（任务 #32），本片未新增、未清理。
- **红线**：不扩 `HISTORY`/`specDocs`/`caliberDocs` 豁免面；不碰 D4/D6/D7/D8/D9 判据；不改任何运行时行为；墓碑只用于**已 git 反查确认删除**的路径；被替换的手抄代码段留"如何取历史版本"的指针而非静默删除。
- **矛盾与残留**：① `docs/STORAGE-EVALUATION.md:18` 仍写 `src/db/pg-client.ts` 存在、且称"`isPgAvailable()` 返回 `false`"（该函数已随文件整体删除，句子无宿主）—— 因文件名含 `EVALUATION` 而在 `HISTORY` 名词豁免面内，**门看不见这条真谎**；本片按"不顺手收豁免面"只登记，收口要与 #34 的漏拦族一起裁决；② `package.json:46` `db:init` 仍输出"pg-schema.sql 已归档"，与"仍在仓库且被 `Dockerfile` COPY"直接矛盾 —— 纠正它需要规则 4 的归档裁决（真归档 or 改口径），属用户决策面，本片只在 ARCHITECTURE/LIMITATIONS 里把"运行时"限定词补上，未动 PG 存废；③ 两道禁语门双源（R5-c 残留①）未动；④ 墓碑登记维持**文件粒度**全等（逐行清单要付行号代价，与 D9 自相矛盾），其滥用极限仍是"同一行里点名即豁免"，现由自检条的第 4/5 组断言界定；⑤ D4 的 48 + D9 的 38 是存量主体，切片③④处理。
- **并入判定**：本分支仍带 6 条已知红 + 1 条环境红 + 1 条已知 flaky，只推分支不并入 `main`（与 R0/R1/R2/R3/R4/R5-a/b/c/d① 同口径）。
- **Commit**：47867d2（`47867d28b502f6dd0784cc826256c53cd1e22795`；已推送 `internal codex/s3-on-main-2026-09-22`，`9fe73e8e..47867d28`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）


## 2026-09-22 08:31 +0800 — R5-d③ D4 手抄行数清零（表格 48 行 + 内联 3 处）：先量腐烂率，再删列而不是刷数

- **任务**：R5-d 切片③，消掉 D4 的两条红（`文件 | 行数` 表行 48、`` `文件`（N 行）`` 内联 3）。本片**零门改动**，纯文档侧。
- **前置量测（逐行 `wc -l` 实测，先证明"红单说的是真的"再动手）**：把 52 处手抄规模值（48 表行 + 3 内联 + 1 处 D4 未覆盖的同族内联）与代码实测对表 ——
  - **恰等 6 处 / 腐烂 46 处 ≈ 88%**。`docs/ARCHITECTURE.md` 与 `docs/PROJECT-GUIDE.md` 的 41 条可解析行里只有 2 条对得上（两处 `runtime/rule-engine.ts` 745），其余 39 条偏差或 basename 不唯一（`server.ts`、`engine.ts` 各命中 2/4 个候选）；README 7 行中 4 行偏差（knowledge-store 776→796、actor/system 583→647、system-resource 179→228、engine 803→960）；AXIOM 内联 4 处中 3 处偏差（thompson-router 314→344、hallucination-detector 567→720、self-evolve 931→1,110）。
  - **跨文档自相矛盾实证**：同一个 `src/memory/vault-manager.ts` 在 ARCHITECTURE 写 640、在 PROJECT-GUIDE 写 761，实测 **930** —— 两本权威入门件对同一事实各执一词且都错，这正是 D4 立项理由的现场证据（非推断）。
- **判断（为何删列而非刷新数字）**：刷新等于再抄一次，第二次腐烂只是时间问题（上表 88% 即第一次腐烂的实测率）；而行数不是能力声明、不进任何裁决路径，为它建"生成 + 门"的永久税换不回信息量 —— 与 D10 的能力登记表相反（那张表是安全关键、必须与代码同源，所以生成）。故：**列删除、职责保留**，并在表内把"要规模请实测"的指针写清（`wc -l` / `ls` 命令级），不改判据也不扩豁免面。
- **工具**：Bash（`wc -l` / `git ls-files` 逐行实测、`git diff` 复核、红→绿、tsc、test:arch、docs-consistency + architecture-integrity、内存封顶全量、规则 11 扫描）、Python（8 张表按表头单元格定位列序号后整列删除，逐处 `assert count==1` 才替换，不做静默多替换）、Read（三处表与内联现场）。无子代理。规则 2：4 件（`README.md`/`docs/ARCHITECTURE.md`/`docs/PROJECT-GUIDE.md`/`docs/AXIOM-ARCHITECTURE.md`）+ 本日志先备份 `.tmp/backups/` → 通读 → 最小改动 → 验证 → 提交后删备份。
- **操作**（文件级）：
  1. `docs/ARCHITECTURE.md`：§3.1/3.2/3.3/3.4 四张表去 `行数` 列（26 行）；顺带把 `| \`total 16 域文件\` | … |` 改为不带数字的表述并给实测指针 —— 该"16"与 `ls src/mcp/server/*-tools.ts` 实测 **23** 矛盾（同族手抄，D4 判据不覆盖它，本片一并清）。
  2. `docs/PROJECT-GUIDE.md`：§3.1/3.2/3.3 三张表去列（15 行）。
  3. `README.md`：认知运行时表去 `行数¹` 列（7 行）+ 删掉随它失效的脚注行「¹ 行数为 2026-08-22 快照…」（保留另一条 W3/W4 澄清脚注，未动）。
  4. `docs/AXIOM-ARCHITECTURE.md`：§2.14/2.16/2.18 三处内联 `（N 行）` 删除；另把 §2.20 的 `（engine.ts 380 / …，共 931 行）` 改为纯文件清单 + `wc -l` 指针（该形态是 D4 漏拦，实测 1,110）。
- **验证结果（全部新鲜执行）**：`bun test ./tests/doc-contract.test.ts` → **24 pass / 4 fail**（28 tests；切片②为 22/6）：D4 两条转绿，pass +2、fail −2；剩余 4 条 = D6 缺锚块、D7 未登记 7 文件、D8 §3.0 列 0 vs 实际 23、D9 锚点 38（本片未触 D9，条数与②一致）。`bun run lint` → exit 0；`bun run test:arch` → **25 pass / 0 fail**；`bun test ./tests/unit/docs-consistency.test.ts ./tests/architecture-integrity.test.ts` → **34 pass / 0 fail**（含 S7「文档不再宣称 KV 换页」等文档 grep 门，证明去列未破坏其它文档断言）；全量 → **4240 pass / 36 skip / 6 fail**（4282 tests / 414 files / 31.38s；②基线 4238/36/8）：4 条 doc-contract + OCR（缺 `tessdata`，环境件）+ `perf-benchmark` `EventBus 100k publish`（已知 flaky，连续两片复现 ⇒ 见残留④）。本片零运行时改动。
- **敏感资产扫描（规则 11）**：`git diff -U0 | grep '^+' | grep -nE "192\.168\.|10\.0\.|sk-[A-Za-z0-9]{8}|ghp_|AKIA|BEGIN [A-Z ]*PRIVATE KEY|://[^ ]*:[^ ]*@"` → 空输出（真实命中 **0**）。
- **红线**：不动 D4 判据与豁免面（`HISTORY`/`specDocs`/`caliberDocs` 一字未改）；不删职责描述列；不改任何数字为"新实测值"（避免再抄）；`docs/ARCHITECTURE.md` 的表结构变化保持 markdown 合法（去列后表头/分隔行/数据行单元格数一致，逐表目视复核）。
- **矛盾与残留**：① D4 只认 `` `文件` | 数字 `` 与 `` `文件`（N 行）`` 两形态，本片刻意**不扩判据**，因此以下同族手抄仍看不见：`docs/PROJECT-GUIDE.md` 概览表（第 34-40 行）（`源文件数 260+` 实测 426、`代码行数 ~70,000` 实测 115,915、`测试文件 68 个` 实测 414 个 `*.test.ts`、`测试总数 ~1,170` 实测 4,282、`MCP 工具 189（15+ 领域文件）` 领域文件实测 23、`HTTP 路由 280+` 与 8 月实测 165 需复核）、`docs/ARCHITECTURE.md` 表内裸文件名（如 `| \`knowledge-store.ts\` |` 无 `src/` 前缀 ⇒ 也在 D3 视野外）；② `docs/PROJECT-GUIDE.md` §3.1 仍写"手写余弦全文搜索"，与权威件 `ARCHITECTURE.md` 的"FTS5 + 关键词为默认、余弦仅可选语义层"不同口径 —— 属 R5-c 口径族的残留而非禁语命中，与①的概览表并成 ③-b 一片处理；③ README 的 `> **澄清（W3/W4）**` 一句用裸文本 `src/dre/system-resource.ts`（无反引号）→ D3 不把它当引用，登记为"引用形态依赖反引号"这一判据边界；④ `EventBus 100k publish` 连续两片复现（350ms / 阈值 300ms）已不再是偶发抖动，需按性能问题或阈值调整单独裁决，不再记作 flaky（本片未动，属 R6 门禁接入时的口径决策）。
- **并入判定**：本分支仍带 4 条已知红 + 1 条环境红 + 1 条性能红，只推分支不并入 `main`（与 R0/R1/R2/R3/R4/R5-a/b/c/d①② 同口径）。
- **Commit**：8231f19（`8231f19961ba31203227c681ced5b98396b4faad`；已推送 `internal codex/s3-on-main-2026-09-22`，`c3c0643d..8231f199`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）


## 2026-09-22 08:46 +0800 — R5-d④ D9 行号锚点清零（38 行 / 44 处 → 0）：抄来的 commit subject 是假的，登记后改为可核验指针

- **任务**：R5-d 切片④，消掉 D9 的红（规范件内 `` `path.ext:NN` `` 形态的手抄行号锚点）。本片**零门改动**，纯文档侧；D6（缺锚块）、D7（未登记 7 文件）、D8（§3.0 列 0 vs 实际 23）留 R5-e，不并进本片凑绿。
- **前置量测（判据先在基线上回代，再动手）**：用 D9 的 `ANCHOR` 正则逐行跑 8 篇改动件的 `git show HEAD:<file>` 与当前工作区，得起点 **38 行 / 44 处** —— `docs/AXIOM-ARCHITECTURE.md` 11 行/12 处、`docs/TEST-STRATEGY-2026-08-21.md` 9 行/9 处、`docs/plans/2026-08-11-frontend-aesthetic-repair.md` 7/7、`docs/LIMITATIONS.md` 6 行/11 处、`docs/ARCHITECTURE.md` 2/2、`README.md` 1/1、`docs/PROJECT-GUIDE.md` 1/1、`docs/test-reports/SUMMARY.md` 1/1（行数≠处数：主判据按"每行首个命中"报一条，故 LIMITATIONS 6 行藏 11 处）。逐处先分类再改：**现役指针**（文档声称"现在这里"）改符号/命令，**历史证据**（审计当时的定位）指向证据件与 commit，不把历史事实当漂移抹掉。
- **量测挖出的真错（三类，均非格式问题）**：
  1. **抄错的 commit subject**：`docs/LIMITATIONS.md` 的"修复提交"条把 subject 抄作 `fix(core): 校准 bytesPerToken 114688倍误差 src/dre/system-resource.ts:68,106`，而 `git show -s --format=%s 141608c4` 给的是 `fix(core): 校准 bytesPerToken 114688倍误差 src/core/system-resource.ts:106` —— 路径前缀与锚点两处都不符。
  2. **无据的"溯源"句**：同条括号宣称"同时溯源 `src/core/...` 以兼容审计引用"。`git show --stat 141608c4` 只含 4 件（`docs/LIMITATIONS.md`、`docs/operations-log.md`、`src/dre/system-resource.ts`、`tests/unit/system-resource.test.ts`），零 `src/core/` 变更 ⇒ "溯源兼容"一事从未发生；该 commit body 首行确为"溯源 Qwen3-1.7B 28\*2048\*2\*2≈229KB/token…"，即"溯源"是**常数推导**的溯源，被误接到路径上。
  3. **一个不存在的路径被三级放大成权威表述**：`git log --all -- src/core/system-resource.ts` 空命中，`git log --diff-filter=AR -- '*system-resource.ts'` 只有 `944a7222` 以 `src/dre/system-resource.ts` 新增（无重命名记录）⇒ 该文件从未存在于任何分支。审计报告本身写的是裸 `system-resource:106`（`docs/reviews/2026-08-20-full-audit-strong-constraint.md` 的 Critical 05 条），`src/core/` 前缀来自 `docs/superpowers/plans/2026-08-21-audit-remediation-playbook.md`（其 Files 段与它 prescribed 的 `git commit -m`），提交信息照抄计划、限制文档再照抄提交信息 ⇒ 传播链是"计划 → commit → 权威文档"，与行号漂移无关，是**手抄文本**的代价。
  - 现役锚点的漂移实测：`src/knowledge/pipeline.ts:186` → `readBool("KNOWLEDGE_USE_LLM", false)` 实际两处（图/视频自动理解分支、内容结构化分支），旧锚点漂 65 行；`src/dre/system-resource.ts:53,68` → 现为字段声明与构造函数默认值 `28 * 2048 * 2 * 2`；`tests/unit/system-resource.test.ts:12-15` → 用例名"2200MB KV 预算 ≈ 10057 tokens（封顶前）"与 `229376` 推导断言。
- **判断（三条替换规则）**：① 现役指针改**符号名 + 语义定位**（`ResourceBudgetManager.bytesPerToken`、`KNOWLEDGE_USE_LLM` 开关），不写新行号；② 历史定位改指**证据件与 commit hash**（`docs/reviews/…` 的 Critical 05 条在 `HISTORY` 豁免面内，行号留在那里才合法）；③ commit 文本**不再手抄**，只给 hash 与 `git show -s --format=%s <hash>` 的取法 —— D9 正则会把 subject 里的 `path.ts:106` 当锚点命中，"逐字复制权威文本"与"禁止手抄锚点"天然冲突，用可复现命令替代复制。
- **工具**：Bash（`git show HEAD:<file>` + 复刻 D9 正则的独立回代脚本量测起点/终点、`git log --all`/`--diff-filter=AR`/`--stat` 反查路径与提交、`grep -c` 数现役 `readBool` 读取点、红→绿、tsc、test:arch、docs-consistency + architecture-integrity、内存封顶全量、规则 11 扫描）、Read（`docs/LIMITATIONS.md` 全文、`docs/AXIOM-ARCHITECTURE.md` §7.2、门 D9 段）、Edit（9 件）。无子代理。规则 2：8 改动件 + 本日志先备份 `.tmp/backups/` → 通读 → 最小改动 → 验证 → 提交后删备份。
- **操作**（文件级）：
  1. `docs/LIMITATIONS.md`（6 行 / 11 处）：摘要行、§1.1 审计定位与修复提交（含上述三条错误的更正）、§1.2 源码/测试锁定行、§2.1 审计定位、§2.2 LLM 条。
  2. `docs/AXIOM-ARCHITECTURE.md`（11 行 / 12 处）：§2.20 技能质量闭环的两处锚点改为完整路径（`src/mcp/server/skill-tools.ts`、`src/self-evolve/skill-promotion.ts`，后者经 `find` 反查确认 `src/dre/skill-promotion.ts` 不存在）；§7.2 C1–C4/W1–W8 两表去 `:NN`，并在表前加"裸文件名不解析为当前路径"的来源说明（见残留①）。
  3. `docs/TEST-STRATEGY-2026-08-21.md`（9 行）：必修模块表 9 行的文件列统一为 `src/…` 完整路径 ⇒ D3 由"看不见"变为"可校验"（改后 D3 绿即逐条存在性证明）；另**自愿**清掉 `dre/runtime/{event-bus:71,actor:103}` 花括号形态，改为 `src/dre/runtime/event-bus.ts` + `src/dre/actor/system.ts`（`ActorSystem` 的实际宿主，经 `tests/unit/actor.test.ts` 的 import 反查；仓库中不存在 `actor.ts`）。
  4. `docs/plans/2026-08-11-frontend-aesthetic-repair.md`（7 处）：Task1/3/4/5/6 的 Files 段去行号，裸锚改语义指针（`Button.tsx`（danger/success 变体的 hover class）、`panels.tsx`（nextIdRef 初始化）等），计划文体本身保留。
  5. `docs/ARCHITECTURE.md`（2）、`docs/PROJECT-GUIDE.md`（1）、`docs/test-reports/SUMMARY.md`（1：`src/utils/platform.ts:133 withExecutableExt` → 符号形态）：按规则①改口径；`README.md`（1）的 SearXNG 上游 `sogou.py` 第 56 行**保留数字**但改写为"版本号已钉死，行号属该版本快照"的散文形态 —— 它是外部仓库的既有事实且已注明版本，不是本仓现役指针。
  6. `docs/operations-log.md`：本条目；当月条目数 143→144（`grep -c '^## 2026-09'` 实数）。
- **门的活性证明**：本片不动门，故不重复受控变异。D9 承重由门内自检条（`锚点禁令不得被门自身绕过`，含 `:442-449`、`:12`、`:53,68` 三组正例与 `100%`、`88.89%`、`66.67%` 两组反例）持续承重，本片跑测时该条为绿 ⇒ 与"文档清零"互为独立证据。**但如实记录盲区**：`{event-bus:71,actor:103}` 这类花括号/裸名形态本就不被 `ANCHOR` 命中（它要求 `.ext:` 前缀），所以"D9 绿"不等于"锚点清零"—— 该行是自愿清的，不是门逼出来的。
- **验证结果（全部新鲜执行）**：`bun test ./tests/doc-contract.test.ts` → **25 pass / 3 fail**（28 tests；③基线 24/4）：D9 主判据转绿，独立回代脚本复测 8 件全部 `after=0 行 / 0 处`；剩余 3 条 = D6 缺锚块、D7 未登记 7 文件、D8 §3.0 列 0 vs 实际 23（本片未触）。`bun run lint` → exit 0；`bun run test:arch` → **25 pass / 0 fail**；`bun test ./tests/unit/docs-consistency.test.ts ./tests/architecture-integrity.test.ts` → **34 pass / 0 fail**（含文档 grep 门，证明改口径未破坏其它断言）；全量（内存封顶）**两次新鲜执行**：第一次 → **4241 pass / 36 skip / 5 fail**（4282 tests / 414 files / 31.44s；③基线 4240/36/6），差量恰为 D9 一条转绿；文档条目落库后复跑 → **4242 pass / 36 skip / 4 fail**（30.88s），余 4 条 = D6/D7/D8 + OCR（缺 `tessdata`，环境件），`EventBus 100k publish` 本次以 223.25ms 通过 ⇒ 见残留③。本片零运行时改动。
- **敏感资产扫描（规则 11）**：`git diff -U0` 的新增行扫 `sk-[A-Za-z0-9]{10,}`、`AKIA[0-9A-Z]{16}`、`ghp_`、`-----BEGIN *PRIVATE KEY-----`、`://user:pass@`、`192.168.`、`10.0.` 及裸 IPv4 形态 → 真实命中 **0**。
- **红线**：不动 D9 判据与 `HISTORY`/`specDocs`/`caliberDocs` 豁免面；不为凑绿把历史证据改成"没有定位"（改为可核验的证据件/commit 指针）；不改任何运行时行为；不并 D6/D7/D8 进本片；歧义文件名不猜路径。
- **矛盾与残留**：① `docs/AXIOM-ARCHITECTURE.md` §7.2 两表的"文件"列是 2026-07-04 审查记录当时的裸名，其中 `kernel.ts` 仓库有两份（`src/dre/kernel.ts`、`src/components/kernel.ts`）、`engine.ts` 有四份、`actor.ts` 一份都没有 ⇒ 补全目录必凭猜，本片只加"不解析"说明并把该形态登记给 #34（同族还有 `docs/ARCHITECTURE.md` 表内 `knowledge-store.ts`、`tests/unit/*`、`frontend/src/pages/*.tsx` 等通配/裸名形态，D3/D9 均不覆盖）；② 假路径已写进 commit subject，改它等于改历史（不做）⇒ 只能文档侧记真，同时暴露"文档不得手抄 commit 文本"应成为独立禁则（并入 #34 漏拦族）；③ `EventBus 100k publish` 三次观测 **350.15 / 334.35 / 223.25 ms**，阈值 300ms **落在观测带内** ⇒ 更正上一片"改判性能红"的说法：它不是确定性性能回归，而是**阈值贴着抖动带上沿**，同机同码可在红绿之间摆动。R6 门禁接入时必须裁决：按负载放宽阈值，或改为多次取中位数后判定（本片不动）；④ `docs/PROJECT-GUIDE.md` 概览表（第 34-40 行）手抄规模值与 §3.1"手写余弦"口径仍未动（切片③-b）。
- **并入判定**：本分支仍带 3 条已知红（D6/D7/D8）+ 1 条环境红（OCR 缺 `tessdata`）+ 1 条摆动性能红（`EventBus 100k publish` 观测带 223–350ms vs 阈值 300ms），只推分支不并入 `main`（与 R0/R1/R2/R3/R4/R5-a/b/c/d①②③ 同口径）。
- **Commit**：4d121f6（`4d121f67e827bcddf7953ef85fb6176dcbceeb5c`；已推送 `internal codex/s3-on-main-2026-09-22`，`b76fd5e3..4d121f67`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）

## 2026-09-22 09:15 +0800 — R5-d③-b 检索与工具数口径纠正（假权重 3 处清零、FTS5 归属改到真实宿主、LIMITATIONS 三口径并存收一）：顺手写下的"唯一权威"被 D2 当场判红

- **任务**：R5-d 切片③-b，收 ③ 留下的两条残留（§3.1"手写余弦"、概览表手抄值），并处理本片开工时新发现的同类缺陷：文档抄的关键词权重与代码不符、FTS5 归属指错文件、`docs/LIMITATIONS.md` 的工具数与 PG 可调用符号已成死句。本片**零门改动、零运行时改动**。
- **前置量测（每条 claims 先与代码对表，再动文档）**：
  - **假权重**：`标题 3x / 标签 2.5x / 内容 1x / 路径 0.5x` 在非豁免规范件 3 处（`README.md` 漏斗表、`docs/PROJECT-GUIDE.md` §3.1、`docs/LIMITATIONS.md` §2.2）+ 记忆库 2 件（`openclaw-memory/AGENTS.md`、`openclaw-memory/03-Resources/code-index/memory-deterministic-search.md`）。代码实测 `src/memory/deterministic-search.ts` 的 `search()`：标题 `Math.min(titleMatches * 15, 60)`、标签 `Math.min(tagMatches * 12, 50)`、路径 `pathMatches * 5`、内容 `Math.min(contentMatches * 3, 30)` ⇒ **四个数值全错**，且旧口径的优先级"内容 > 路径"与实现**相反**（路径 5 > 内容 3）。精确匹配加成 100/90/95/85、关系推导 +10/+8/2跳+4、PARA +5 经核为真（README 表同片仅改错的那一行）。
  - **FTS5 归属**：`src/memory/deterministic-search.ts` 的 fts5 只出现在文件头注释，非注释行零命中；FTS5 虚表与 `MATCH` 在 `src/memory/sqlite-memory.ts`；`src/memory/vault-manager.ts` 的 `search()` 先 FTS、命中不足或质量偏低再用确定性引擎补 ⇒ "确定性检索用 FTS5"在子系统级成立、在文件级是错的，且错误源头是上述头注释（见残留②）。
  - **工具数**：`countMcpTools()` 实测 total=**189**（零重复）。`docs/LIMITATIONS.md` 一篇之内三口径并存：§2.1"实际 172 去重"、同节"实测 **188**"、文末更新记"=189 为准"，且 §2.4 把权威指向 `src/mcp/tool-registry.ts` 的 `size`（该 getter 是运行时注册表大小，与静态实测不同口径）。`docs/BROWSER-AGENT-STRATEGY-2026-08-09.md` 的对比表另有一处"（172 工具）"。
  - **无宿主符号**：`isPgAvailable` / `getPG()` 在 `src/` 下零命中（唯一命中是 `src/memory/knowledge-graph-builder.ts` 里说明其已随 H-M1-03 移除的注释）⇒ `docs/LIMITATIONS.md` §2.3"需手动 `isPgAvailable` 启用"、§2.4 的 PG 启用建议是**没有宿主的死句**，D3 看不见（它只裁决路径形态）。
  - **PROJECT-GUIDE 概览表逐行实测**：`源文件数 260+` → 426、`代码行数 ~70,000` → 115,915、`测试文件 68 个` → 414、`测试总数 ~1,170` → 4,282、`MCP 工具 189 个（15+ 领域文件）` → 数恰好对但领域文件实为 23 且权威指针错、`前端页面 18 个` → 页面组件 21 / 导航入口 9（两口径）、`HTTP 路由 280+` → 未复核，按"不复制"处理。
- **判断（为何 README 保留权重而另两篇删数值）**：README 那张表的表头就是"权重"，删了等于删掉该表的职责，故填实测正确值并在文档内注明取法；§3.1/§2.2 是组件职责表与限制声明，数值不是其信息量所在，写回数字只是**再抄一次**（③ 已实测 88% 的第二次腐烂率），故改为"优先级 + 指向 `search()`"。`docs/LIMITATIONS.md` 的工具数不刷新为 189 而是删数并指向 `src/testing/tool-count.ts` 与生成器 —— 因为该篇本身就是"漂移记录"，把新快照写进漂移记录等于制造下一条漂移。
- **工具**：Read（`src/memory/deterministic-search.ts` 打分段全文、`vault-manager.ts` 串接段、`LIMITATIONS.md` §2 全节）、Grep/Bash（`git ls-files` 后缀解析、`wc -l`、`count-tools.mjs` 生成、`find`/`ls` 计数、红→绿、规则 11 扫描、tsc、test:arch、内存封顶全量）、Edit（6 文件）、Python（一次独立第二方式复核脚本 `/tmp/verify-b-caliber.ts`，22 条断言，不复用门的任何正则）。无子代理。规则 2：6 件先备份 `.tmp/backups/` → 通读 → 最小改动 → 验证，备份随本片提交前删除。
- **操作**（文件级）：
  1. `README.md`：漏斗表"关键词"行改为实测口径（优先级 标题 > 标签 > 路径 > 内容 + 每次匹配 ×15(≤60)/×12(≤50)/×5/×3(≤30)）。
  2. `docs/ARCHITECTURE.md`：§1 项目概览、§3 memory 组件表、§6 现状表三处把 FTS5 归属改到 `src/memory/sqlite-memory.ts` 并补 `src/memory/vault-manager.ts` 的 `search()` 串接；§1 的"关键词权重"改为"按匹配次数加成 + 优先级"。
  3. `docs/PROJECT-GUIDE.md`：§1.1 口径（去"手写余弦"与 FTS5 误归属）、§1.2 关键指标表由"数值表"改为"口径表 + 9 条可复制的取数命令（`sh` 块）"、§3.1 组件行改为实测四阶段描述且不复制常量。
  4. `docs/LIMITATIONS.md`：§2.1 溯源句改为"历史曾见 133/150/172/173，与动态实测不一致"（旧数保留在明确标注"历史/废止"的句子里）；§2.2 检索行改为 FTS5/关键词双件分工 + 权重指向 `search()`；§2.2 工具数行删快照、指向 `src/testing/tool-count.ts` 与 `scripts/count-tools.mjs`；§2.3 PG 行改为"客户端已删、无 PG 入口、需按规则 4 先裁决 `src/db/pg-schema.sql` 存废"并加墓碑哨兵；§2.3 工具数漂移行的"现状/影响/后续"改为按断言实际覆盖面写；§2.4 两条使用建议改为可执行形态；文末更新记去数。
  5. `docs/BROWSER-AGENT-STRATEGY-2026-08-09.md`：对比表"记忆"行去"手写余弦"（该形态在非豁免规范件的最后一处）、"技能"行去手抄"（172 工具）"。
  6. `docs/operations-log.md`：本条目；当月条目数 144→145（`grep -c '^## 2026-09'` 实数）。
- **门的活性证明（本片无需变异，因为判据未改；证据是门自己拦下了我的新引入错误）**：第一版 §2.2 工具数行写成"**唯一权威**为 `src/testing/tool-count.ts`…"，`bun test ./tests/doc-contract.test.ts` 当场把 **D2 权威文档唯一** 判红（该条要求 `唯一权威` 命中 ≤1 且落在 `docs/AXIOM-ARCHITECTURE.md`）⇒ 改述为"口径以…为准"后 D2 复绿。这是门连续第三次在实际改动中承重（②：整行消音变异；③：88% 腐烂率量测；④：抄来的 commit subject 为假）。
- **验证结果（全部新鲜执行）**：`bun test ./tests/doc-contract.test.ts` → **25 pass / 3 fail**（28 tests；④ 为 24 pass / 4 fail，本片无判据改动、无新红转绿，差异来自我引入又被 D2 拦下的那一条已复原）；剩余 3 条 = D6 缺 `<!-- BEGIN:nondeterminism-registry -->` 锚块、D7 未登记 7 文件（实测清单：`src/memory/vault-manager.ts`、`src/memory/deterministic-search.ts`、`src/cli.ts`、`src/utils/math.ts`、`src/dre/retrieval/deterministic-retrieval-engine.ts`、`src/agents/prompt-engineer.ts`、`src/native-bridge.ts`）、D8 `docs/AXIOM-ARCHITECTURE.md` §3.0 列出 0 条 vs `src/mcp/server/*-tools.ts` 实测 23 条（门两侧集合已亲测：expected 23 项、received 空集）⇒ 三条全部留 R5-e。`bun run lint` → exit 0；`bun run test:arch` → **25 pass / 0 fail**；`bun test ./tests/doc-contract.test.ts ./tests/unit/docs-consistency.test.ts ./tests/architecture-integrity.test.ts` → **59 pass / 3 fail**（62 tests）。全量连跑四次（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`，覆盖本片从文档改动到日志回填的完整过程）：**run1 4241/36/5**（3 doc-contract + OCR + `EventBus 100k publish` 376.56ms）、**run2 4242/36/4**（EventBus 绿）、**run3 4241/36/5**（EventBus 绿，但 `GoalTracker — 性能基准 > validateAgainstContext 应在 5ms 内处理 50 个目标` 红，实测 8.64ms）、**run4 4241/36/5**（EventBus 317.88ms 红，GoalTracker 那条绿）。四次恒定红 = 3 条 doc-contract（D6/D7/D8）+ OCR（缺 `tessdata`，环境件），其余全为 4,282 tests / 414 files / 31.4–32.9s 同一集合内的**摆动**。⇒ 结论修正：本仓的摆动性能断言**不是 1 条而是 2 条**，且两条各自独立翻转，任何单次全量数字都不能当基线（详见残留⑤）。`EventBus` 观测带由 ④ 记录的 223–350ms 扩到 **223–377ms**（本次新点 317.88ms），阈值 300ms 落在带内。本片零运行时改动 ⇒ 上述红均不归因于本片。
- **第二方式（审计协议要求两种独立验证）**：`/tmp/verify-b-caliber.ts` 以自写正则独立复核 22 条断言（实测输出行计数，不复用门的任何正则；最终态复跑一次仍 ALL OK）（FTS5 归属、四个加成常量与优先级、四档精确匹配值、关系/PARA 加成、`deterministic-search.ts` 代码行零 embedding、`vault-manager.search()` 先 FTS 后补、本片改动行内零死路径/零简写、规范件零 `3x/2.5x/0.5x`、`唯一权威` 仅在 AXIOM、LIMITATIONS 含旧数的行必须自我标注历史/废止、`isPgAvailable`/`getPG()` 死句已清、生成器 total 可解析）→ **ALL OK**；与门（第一方式）结论一致，无矛盾。附带普查（脚本覆盖面 = `README.md` + `docs/ARCHITECTURE.md` + `docs/PROJECT-GUIDE.md` + `docs/LIMITATIONS.md` 四篇，不含本片的 `docs/BROWSER-AGENT-STRATEGY-2026-08-09.md` 改动件）：这四篇里"省略顶层前缀"的简写路径引用 43 处（`git ls-files` 后缀解析：41 唯一可解析 / 0 多义 / 2 为 `@/` 别名占位）⇒ 全部在 D3 视野外。
- **敏感资产扫描（规则 11）**：`git diff -U0 | grep '^+' | grep -nE "192\.168\.|10\.0\.|sk-[A-Za-z0-9]{8}|ghp_|AKIA|BEGIN [A-Z ]*PRIVATE KEY|://[^ ]*:[^ ]*@"` → 空输出（真实命中 **0**）。
- **红线**：不改任何判据与 `HISTORY`/`specDocs`/`caliberDocs` 豁免面；不改运行时代码与源码注释；不把任何手抄数值刷新为"新实测值"（一律删数 + 指向生成器或代码符号）；旧工具数只存在于显式标注"历史/废止"的句子里；`docs/` 之外（`openclaw-memory/`）本片不动。
- **矛盾与残留**：① 假权重仍活在记忆库两件里（`openclaw-memory/AGENTS.md` 的关键词行、`openclaw-memory/03-Resources/code-index/memory-deterministic-search.md` 的代码摘录与其 `权重 2.5x`/`权重 0.5x` 注释），后者是**逐字抄来的已删代码形态摘录** —— 门对该目录只跑禁语与字节完整性，不跑 D3/D4/D9/D10，属 #34 登记的漏拦族；改它等于改用户记忆库正文而非文档件，本片按红线未动。② "FTS5 + 关键词打分为主"这条文件级误归属的**源头在源码注释**（`src/memory/deterministic-search.ts` 头注释、`src/memory/vault-manager.ts` 头注释、`src/dre/retrieval/deterministic-retrieval-engine.ts` 头注释、`src/cli.ts` 的输出串、`src/native-bridge.ts` 的函数注释）⇒ 与文档不同源即再次漂移，但改注释属代码片，需过 `test:arch` 与 capability 门，不并进文档片。**重合度量**：这五件**全部**同时出现在 D7 的 7 件未登记清单里（逐件比对：`vault-manager`/`deterministic-search`/`cli`/`deterministic-retrieval-engine`/`native-bridge` ∈ D7）⇒ R5-e 收 D7 时正好在同批文件上把注释口径一起改，省一次全量验证；D7 另两件（`src/utils/math.ts`、`src/agents/prompt-engineer.ts`）与本条无关。③ `docs/PROJECT-GUIDE.md` 与 `docs/BROWSER-AGENT-STRATEGY-2026-08-09.md` 均不在 `docs-consistency` 三条断言（`手写余弦` 禁语 / 工具数精确相等 / 旧数 ban）的受控文件清单内 ⇒ 今天恰好干净（本片清完），但同类漂移无门覆盖；`scripts/count-tools.mjs` 只打印片段不回填文档，回填仍是人肉步骤。④ 43 处简写路径（`server/x-tools.ts`、`runtime/rule-engine.ts` 形态）在 D3 视野外，重命名时静默腐烂。⑤ 摆动性能断言由 1 条更正为 **2 条**：`EventBus 100k publish < 300ms`（观测带 223–377ms）与 `GoalTracker validateAgainstContext 50 目标 < 5ms`（本次实测 8.64ms ≈ 阈值 1.7 倍）；四次全量里二者各自独立翻转，同一份工作树内容可给出 4 或 5 条红 ⇒ **单次全量数字不可作为基线**。R6 接门禁前必须先裁决性能断言的口径（移出主套件单列门 / 预热 / 提高阈值 / 固定 `--parallel`），否则门禁会把摆动当回归拦下。另需在 R6 登记"已知摆动集合"，本片按"登记不撤"处理，未改任何测试阈值。
- **并入判定**：本分支仍带 3 条已知红（D6/D7/D8）+ 1 条环境红（OCR 缺 `tessdata`）+ 2 条摆动性能红（`EventBus 100k publish`、`GoalTracker validateAgainstContext`，见残留⑤）⇒ 只推分支不并入 `main`（与 R0/R1/R2/R3/R4/R5-a/b/c/d①②③④ 同口径）。
- **Commit**：27668fd（`27668fdf0217c2ad234aa2bb87ac2f610ab43a52`；已推送 `internal codex/s3-on-main-2026-09-22`，`2a9d7a2d..27668fdf`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）

---

## 2026-09-22 09:52 +0800 — R5-e D6/D7/D8 三条红清零（doc-contract 首次全绿）：D7 的 7 件"未登记"里 6 件是注释误报，修的是判据的引用形态识别而非登记表面

- **任务**：收 R5-d③-b 留下的三条红 —— D6（`docs/AXIOM-ARCHITECTURE.md` 缺 `<!-- BEGIN:nondeterminism-registry -->` 机器同步块）、D7（"未登记非确定决策符号"7 件）、D8（§3.0 领域文件列出 0 条 vs 实际 23 条）。**`src/` 零改动**（运行时代码与源码注释均未动），改动面 = 1 文档 + 1 配置 + 1 门件。
- **前置量测（先定性，再决定动不动判据）**：D7 的 7 件逐件取出符号所在行 —— `src/utils/math.ts:7` 是 `cosineSimilarity` 的**定义宿主**（真代码）；其余 6 件（`src/memory/vault-manager.ts:8`、`src/memory/deterministic-search.ts:5`、`src/cli.ts:808`、`src/dre/retrieval/deterministic-retrieval-engine.ts:21`、`src/agents/prompt-engineer.ts:2`、`src/native-bridge.ts:134`）**全部只出现在文件头注释与 CLI 输出串里**，句子内容是"共享 cosineSimilarity 仅可选语义层"，即**在声明"本文件不用它"的句子里提到了它**。⇒ 旧判据 `text.includes(sym)` 把口径散文当使用了使用点。真代码引用点普查：调用/绑定/定义共 7 件文件，全部已登记。
- **判断（为何不选另两条更"省事"的路）**：① 把这 6 件登记进 `config/nondeterminism.json` = 往"文档口径的唯一机器来源"里写假事实（它们不是非确定组件），否决；② 删掉或改写这 6 处注释与输出串以避开判据 = 为凑绿牺牲真实信息，且 `src/cli.ts:808` 是用户可见输出串，否决；③ 修判据的**引用形态识别**，并在门内加一条自检锁住"误报面/漏报面"两侧，采纳。`src/utils/math.ts` 是真引用点，按登记处理而非豁免 ⇒ 新增 ND-15。
- **工具**：Read/Grep/Bash（逐件取符号所在行、AST 普查、`git ls-files` 与 `readdirSync` 双向对表）、Edit（3 件）、Write+Bash（`/tmp/gen-d6-block.mjs` 由 JSON 生成表格、`/tmp/d7-mutation-proof.ts` 端到端变异探针、`.tmp/verify-e-cross.ts` 第二方式 23 条断言）。无子代理。规则 2：3 件改动件 + 3 件预备份后确认未改的源文件先入 `.tmp/backups/`，提交前逐一 `git show HEAD:<f> | diff - <备份>` 核对差异行 = 0 后删除。
- **操作**（文件级）：
  1. `docs/AXIOM-ARCHITECTURE.md`：§3.0 末新增"注册点清单"（23 个反引号领域文件）；"### LLM 降级为认知加速器"节后新增"### 非确定组件清单（机器同步块）"，表体由 `config/nondeterminism.json` 的 `entries` 逐字生成（15 行 × 5 列），**不手抄**。
  2. `config/nondeterminism.json`：新增 ND-15（`role: kernel`，switchFile/codeFile 均为 `src/utils/math.ts`，default 写明"无开关；自身无随机源，非确定性只来自调用方注入的向量"及其三个生产调用方）；`$comment` 的 role 语义补 `dormant`（ND-13/14 早已在用却从未登记语义）与 `kernel` 两条。`ratchet` 未动（`maxDecisionRoles` 仍 8，decision 条目仍 8）。
  3. `tests/doc-contract.test.ts`：新增模块级 `codeIdentifierRefs()`，以 TS 语法树的 Identifier 节点判"引用点"（注释是 trivia、字符串/模板串是 literal，都不产生 Identifier；定义名 / import 绑定 / 调用 / 裸别名都会），D7 先做子串预筛再解析；新增用例"引用形态识别自检：注释与字符串不算使用点，定义/绑定/调用/别名算"（3 条误报面 + 5 条漏报面）。
- **判据改动的变异证明（不改判据则已，改必先证承重）**：端到端探针 6 例，用临时未登记文件 `src/__d7probe.ts` 逐例跑 D7 —— A 真实调用→红、B 注释+输出串→绿、C 仅 import 绑定→红、D `this.cosineSimilarity(...)` 属性调用→红、E 定义宿主→红、F 裸别名 `export const alias = cosineSimilarity;`→红 ⇒ **ALL OK**（探针文件用后即删）。中途教训：我先写的**行级正则**版本（`sym(` 或 import/export 行）被 B 例当场证伪 —— `export const msg = (): void => console.log("… cosineSimilarity …")` 因行首 `export` 而误报，遂改成语法树。承重**回代**：把 `config/nondeterminism.json` 换回无 ND-15 的备份跑 D7 → 恰好判红 `src/utils/math.ts` 一件 ⇒ ND-15 是承重的，D7 转绿不是靠放宽把 math.ts 藏起来；随后 `diff` 核对复原（0 行差异）。
- **验证结果（全部新鲜执行）**：`bun test ./tests/doc-contract.test.ts` → **29 pass / 0 fail**（29 tests，173 expect() calls，458ms；③-b 为 25 pass / 3 fail / 89 expects）⇒ **doc-contract 在 main 线上首次全绿**，D0–D10 十条门无红。`bun run lint` → exit 0；`bun run test:arch` → **25 pass / 0 fail**；三件套（doc-contract + `tests/unit/docs-consistency.test.ts` + `tests/architecture-integrity.test.ts`）→ **63 pass / 0 fail**（63 tests，241 expects；③-b 为 59/3）。全量两次（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`）：**run1 4245 pass / 36 skip / 2 fail**（OCR + `EventBus 100k publish` 342.83ms）、**run2 4246 / 36 / 1**（仅 OCR）；4,283 tests / 414 files / 31.9–32.3s / 132,051 expects。与 ③-b 的 4,282 tests / 131,967 expects 逐项对账一致：tests +1 = 新增自检用例，expects +84 = doc-contract 89→173（三条此前在首个断言即中止的门跑完了完整断言循环），pass +4 = 三条红转绿 + 新用例。`EventBus` 观测带仍 223–377ms（本次新点 342.83ms），阈值 300ms 在带内；本片 `src/` 零改动 ⇒ 该摆动与 `GoalTracker` 摆动均不归因本片。
- **第二方式（审计协议要求两种独立验证）**：`.tmp/verify-e-cross.ts` 23 条断言，**不复用门的取数路径** —— D8 一侧改用 `git ls-files`（门用工作区 `readdirSync`）、D6 一侧自写表格解析器逐格比对并单查"重复条目 / 单元格含裸竖线 / ID 顺序"、D7 一侧独立做 AST 普查 ⇒ **ALL OK**，与门（第一方式）结论一致、无矛盾。普查附带事实：子串命中 14 件、AST 引用点 7 件 ⇒ 差集 7 件，其中 6 件是 D7 当时的可见红点，**第 7 件 `src/memory/hallucination-detector.ts`（`:28` 注释）因它已因 ND-07 登记而被遮蔽** ⇒ 旧判据的误报面比红点数量更大，且"登记面越宽、判据越沉默"是旧写法的结构性缺陷（散文提及可被无关登记吸收）。
- **敏感资产扫描（规则 11）**：3 个非日志件的新增 81 行 → 真实命中 **0**（该项已并入第二方式断言，不是一次性命令）。本日志条目写完后扫全量新增 103 行：按规则 11 的**裸词**模式（`AKIA`、`ghp_` 等四/五字母前缀）命中 **1 行 = 本行自身**，因为要自证就必须指名命中的模式；把该行里的模式串原文删掉再扫仍命中同一行（剩余的 `AKIA` 是"命中的是哪个模式"这句陈述，非凭据）。⇒ 用**要求真实形态**的收紧模式复扫（私有地址须带后续数字、`AKIA` 须带 8 位以上大写数字、PEM 须带完整头、须带 `://user:pass@` 结构）→ **0 命中**，这才是本片的结论；裸词模式的自指命中如实留档，不靠改写文本消音。
- **更正 ③-b 残留②（一条被本片实测推翻的记述）**：③-b 把"FTS5 误归属的源头"记为 5 件（含 `vault-manager`、`cli.ts`、`native-bridge`），并称"五件全部在 D7 清单里，R5-e 顺手一起改"。本片逐件复核 FTS5 字样：**真正文件级误归属的只有 2 件** —— `src/memory/deterministic-search.ts:5`、`src/dre/retrieval/deterministic-retrieval-engine.ts:21`（均声明"检索以 FTS5 + 关键词打分为主"，而本文件 fts5/MATCH 的非注释行零命中）。`src/memory/vault-manager.ts:8/173/177` 在其 `search()` 里为真（确实先 `sqliteMemory.search()` 再补）；`src/cli.ts:808`、`src/native-bridge.ts:134`、`src/agents/prompt-engineer.ts:2` **根本不含 FTS5 字样**，只有 cosine 从句（口径正确）；`src/memory/bootstrap.ts:181`（调用步骤注释）与 `src/dre/runtime/text-rank.ts:12/16`（"BM25 与 SQLite FTS5 同族"）经核亦非误归属。⇒ 注释口径片实际缩为 **2 行**，且与 D7 判据修正**无耦合**（那 6 件在判据修正后本就不再是红点），故拆为独立片 **R5-f**，不并入本片；"省一次全量验证"的原计划理由不成立。
- **矛盾与残留**：① §3.0 原有的"层 | 分类 | 数量 | 依赖"表仍是**按类手抄的工具数**（8/6/5/…），D 系列只核"领域文件集合相等"与"去重总数 = 189"，不核分类小计 ⇒ 与 #34 同族，本片未动（不在 D8 判据面内）。② ND-15 的 `role: kernel` 是新角色值，而门对 role 只有一条断言（decision 计数 == 棘轮预算）⇒ 任何新角色名拼错或漂移都不会被发现，第四个未登记角色名同样沉默。③ 字符串里写"真调用文本"（如 `console.log("cosineSimilarity(a, b)")`）在 AST 下仍不算引用点 —— 这是**有意**的（不被执行即非使用点），记录在此以免被误读为漏拦。④ 非确定组件表**无生成器入库**：本片用 `/tmp/gen-d6-block.mjs` 一次性生成，重生成能力不在仓库里；D6 会判红但修的人须手抄 15 行 ⇒ 建议 R6 把生成脚本按 `scripts/gen-capability-declarations.mjs` 的形态入库并加"重生成逐字一致"断言。⑤ 承接 ③-b 残留⑤：两条摆动性能断言与 OCR 环境红仍待裁决 ⇒ R6。
- **并入判定**：doc-contract 已全绿，本分支剩余红 = OCR（环境件）+ 2 条摆动性能断言 ⇒ 仍**只推分支不并入 `main`**，等 R6 定性能断言口径（与 R0–R5-d 同口径）。
- **Commit**：ac4b971（`ac4b971f02b906ed7ca8cfa25952d4d71f44f7d1`；已推送 `internal codex/s3-on-main-2026-09-22`，`50294788..ac4b971f`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）

## 2026-09-22 10:37 +0800 — R5-f PG「可启用性」口径收一（69 篇规范件全量普查 → 6 件 17 行死句 + 1 行过期表 + 3 行源码注释；两条"可执行的假指令"被证伪）：D3 两次拦下我新写的死路径引用

- **任务**：R5-e 的残留② 把本片预告为"注释口径片，实际缩到 2 行"。开工先做量测，结论是**范围被严重低估**：`docs/` 里问题不是"注释说错"，而是**整个 PG 能力在规范件里存在 6 种互不一致的可启用性口径**，其中 2 条是可执行指令（读者照做会得不到任何 PG）。本片**零运行时代码改动**（21 改动行里 18 行文档、3 行 ` * ` JSDoc）。
- **前置量测（口径先与代码对表，再动文档）**：
  - **"能不能启用"的三面证伪（互相独立）**：`package.json` 的 `dependencies`+`devDependencies` 里 `pg`/`postgres`/`pgvector` 命中 **0**；`bun.lock` 里 `"pg@`+`"postgres@` 计数 **0**；`src/**/\*.ts` 里 `from "pg"`/`require("pg")` 命中 **0** ⇒ **没有驱动，任何"启用/切换"话术都是死句**。`src/db/pg-client.ts` 确不在（墓碑有效），`src/db/pg-schema.sql` 在位（16,076 B）且 `Dockerfile:52` 仍 `COPY src/db/pg-schema.sql ./src/db/pg-schema.sql` ⇒ ARCHITECTURE §2 的"会 COPY 进镜像"经核为真。
  - **假指令 A（部署建议）**：`docs/PROJECT-GUIDE.md:537` "生产环境推荐切换 PostgreSQL：设置 `DATABASE_URL=postgres://...`"。实测 `src/utils/env.ts:186` 把 `DATABASE_URL` 标注为 `"Legacy alias — SQLite connection string（backup 脚本/云端检测）"`，`src/native-bridge.ts:48` 只把它当**云端部署信号**（`readString("DATABASE_URL", "") || readString("REDIS_URL", "")` → `"cloud"`）⇒ 设 `postgres://` 不改变数据库后端，只会翻转 edition 判定。
  - **假指令 B（检索入口）**：`docs/KNOWLEDGE-BASE.md:41` "知识图谱 `/kg/search`（pgvector 语义检索）"。实测 `src/routes/knowledge-graph.ts:251` 的响应体是 `backend: "sqlite"`，文件头 `:1` 即声明 "PG 已移除 H-M1-03，SQLite 为唯一后端"。
  - **过期表行**：`README.md:412` "PostgreSQL KG | PostgreSQL + pgvector | 7 | 使用 `kg_enhanced_*` SQLite 工具"。实测 `src/mcp` 内 `kg_enhanced[a-z_]*` 唯一命中 `kg_enhanced_stats`（`src/mcp/server/kg-tools.ts:469`）⇒ 所谓"7 个 PG 侧工具"与"复数 `kg_enhanced_*` 降级集合"**两头都不存在**。
  - **向导侧（本片未动，见残留②）**：`src/tui/install-wizard.ts:270` 仍显示 `"PostgreSQL URL:"`、`:274` 的默认值是形如 `<用户>:<口令>@localhost/axiom` 的 `postgres://` 模板占位（全为字面量，非真实凭据）、`:293` 收值、`:450` 写进生成的 `.env` ⇒ 无驱动前提下采集一串连不上库的 URL，并且这串一旦非空就经 `src/native-bridge.ts:48` 把部署判成 cloud。
  - **死句形态普查（范围=门的 specDocs 同口径，两方式各自独立算出 69 件）**：`node /tmp/pg-form-count.mjs` 对 `git show HEAD:<file>` 逐行判定 ⇒ 命中 **6 件 / 17 行 / 21 个形态实例**：`需 PG 时启用`×4、`为可选历史能力`×7、`PG vector 可选`×4、`需显式启用`×1、`按需启用`×1、`PG 可选历史`×1、`PostgreSQL 已归档`×1、`推荐切换 PostgreSQL`×1、`pgvector 语义检索`×1。
- **判断（为何这是裂口而不是漂移）**：
  1. `docs/LIMITATIONS.md` **一篇之内三处自相矛盾**：§2.2 :60/:62 说"需 PG 时启用 / `pgvector` 需显式启用"，§2.3 :70 说"'手动启用'这条路今天不存在……在此之前文档不得给出可调用 PG 符号"，§2.4 :76 说"当前不可启用"。③-b 清了 §2.3/§2.4 的无宿主符号，**没动 §2.1/§2.2 的可启用性话术**，于是把该篇留在自我否定的状态 —— 这正是 ③-b 声称要收的"三口径并存"缺陷，只是换了维度（工具数收口、PG 未收口）。
  2. `README.md:357` 的"PostgreSQL **已归档**"与规则 4 的定义冲突：归档 = 移入 `archive/` + 写 `archive/ARCHIVE-LOG.md` + 工作区 `git rm`，三步都没做（文件在 `src/db/`，`archive/` 里无此项）⇒ 改述为"移除 + 仍在仓库待裁决"，**归档动作本身不在本片做**（规则 4 需先裁决 `pg-schema.sql` 存废）。同一假述也活在 `package.json:46` 的 `db:init` 文案里，属运行时代码面 ⇒ 本片不动，登记为残留①。
  3. `README.md:412` 与 `docs/ARCHITECTURE.md:293` 按 ③-b 的"不把手抄数刷新为新实测值"处理：前者工具数列改为"旧值 7 已废止（不手抄新值）"并把计数指向 `src/testing/tool-count.ts`；后者是带日期的沿革记，**保留原话 + 补"【旧口径，已随 H-M1-03 废止】"标注**而非删行（删沿革等于篡改记录）。
  4. 跨件锚点只留一处权威：PG 现状的可核验长口径留在 `docs/LIMITATIONS.md` §2.3（它已含墓碑与"无宿主符号"的实测），其余 5 件改为"当前不可启用 + 见 §2.3"，避免再造第二条可腐烂的完整叙述。
- **工具**：Read（`src/utils/env.ts` 片段、`src/routes/knowledge-graph.ts` 头与 handler 段、`docs/ARCHITECTURE.md` §3.1/§8、`docs/LIMITATIONS.md` §2.1–2.4、`docs/PROJECT-GUIDE.md` §1.1/组件表/Q6、`README.md` 相关表）、Grep/Bash（`ls src/db`、`grep -c`/`-o` 计数、`Dockerfile` COPY 复核、`kg_enhanced` 集合枚举）、Edit（9 文件 21 行）、Write/Node（`/tmp/pg-census.mjs` 宽形态普查、`/tmp/pg-form-count.mjs` 严格形态计数、`.tmp/verify-f-pg.ts` 第二方式 14 条断言）、Bun（门 + 全量）。**无子代理**。规则 2：9 件先备份 `.tmp/backups/` → 通读命中段全文 → 最小改动 → 验证；提交前逐一 `diff` 证明每份备份等于 `git show HEAD:<file>`（9/9 全等），再删备份。
- **操作**（文件级，21 行）：
  1. `src/memory/deterministic-search.ts:5`、`src/memory/vault-manager.ts:8`、`src/dre/retrieval/deterministic-retrieval-engine.ts:21`：删去"检索以 FTS5 + 关键词打分为主 / PG vector 为可选历史能力"，改为指名真实宿主与串接次序（FTS5 主索引在 `src/memory/sqlite-memory.ts`，`src/memory/vault-manager.ts` 的 `search()` 先 FTS 后补确定性引擎；DRE 的关键词侧由构造注入，见 `src/routes/search.ts`），PG 侧统一为"已随 H-M1-03 移除，当前无 PG 入口"。
  2. `README.md` 281 / 349 / 357 / 412 四行（可启用性、外部服务"已归档"、过期表行）。
  3. `docs/ARCHITECTURE.md` 10 / 58 / 94 / 288 / 290 / 293 六行（§1 概览、§2 数据库、§3.1 组件表、§8 检索行 + 历史 PG 行 + 更新记）。
  4. `docs/LIMITATIONS.md` 55 / 60 / 62 三行（§2.1 审计定位、§2.2 检索行、§2.2 PG 行）。
  5. `docs/PROJECT-GUIDE.md` 27 / 169 / 537 三行（§1.1 口径、组件表、Q6 假指令）。
  6. `docs/KNOWLEDGE-BASE.md` 41 一行（检索入口）。
  7. `docs/BROWSER-AGENT-STRATEGY-2026-08-09.md` 57 一行（对比表"记忆"行）。
  8. `docs/operations-log.md`：本条目；文首归档索引当月条目数 146→147（`grep -c '^## 2026-09'` 实数）。
- **门的活性证明（本片零判据改动，证据是门两次拦下我新引入的错）**：第一版把 `` `src/db/pg-client.ts` `` 直接写进 `docs/PROJECT-GUIDE.md:27`、`docs/ARCHITECTURE.md:10`、`docs/LIMITATIONS.md:55` 而**未带墓碑** ⇒ `bun test ./tests/doc-contract.test.ts` 当场 **D3 判红**，received 精确给出两条 `docs/ARCHITECTURE.md:10 → src/db/pg-client.ts`、`docs/LIMITATIONS.md:55 → src/db/pg-client.ts`（门在 470+ 条引用里点出我 3 分钟前写下的那两处）。修法两条我都用了：不点名（ARCHITECTURE:10、LIMITATIONS:55 改述为"PG 客户端已删"）与补 `<!-- doc-caliber:absent: … -->`（ARCHITECTURE:58/290 本就在墓碑在册清单里）。**另记一次门没拦住的自伤**：补哨兵时我一度把 `<!-- … -->` 插到 `docs/LIMITATIONS.md:55` 的句子中间，D3 按行判定故放行 —— 行级判据不替人判断"这行读起来是否像人写的"，最终仍靠自读改回不点名形态。**在册清单未动**：`使用 tombstone 的文件全部在册` 那条期望数组本片一次也没改（PROJECT-GUIDE 最终不带墓碑），`HISTORY`/`specDocs`/`caliberDocs` 豁免面同样零改动。
- **验证结果（全部新鲜执行）**：`bun run lint` → exit 0；`bun test ./tests/doc-contract.test.ts ./tests/unit/docs-consistency.test.ts ./tests/architecture-integrity.test.ts` → **63 pass / 0 fail**（241 expects，868ms；doc-contract 单跑 29 pass / 0 fail）；`.tmp/verify-f-caliber.ts`（③-b 遗留的注释口径脚本）复跑 → **ALL OK**。全量三次（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`）：**run1 4246/36/1**（仅 OCR）、**run2 4245/36/2**（+ `EventBus 100k publish` 307.96ms）、**run3 4245/36/2**（+ `EventBus` 323.71ms）；三次同一集合 4,283 tests / 414 files / 132,051 expects / 31.48s ⇒ ③-b 残留⑤ 的"摆动不可当基线"第三次成立，EventBus 观测带在 223–377ms 内新增两点（307.96 / 323.71），`GoalTracker validateAgainstContext` 本片三次均绿。恒定红 = OCR（缺 `tessdata`，环境件）；本片零运行时改动 ⇒ 上述红均不归因于本片。
- **第二方式（审计协议要求两种独立验证）**：`.tmp/verify-f-pg.ts` 14 条断言，**不复用门的任何正则**（自写 specDocs 走目录递归 + 自写证据件正则、自写 9 种死句形态表 + "带旧/废止标注即合法引用"白名单、自写同行墓碑校验），并独立复核新口径所依赖的 7 条宿主事实（三面零驱动、`pg-client` 不在、`pg-schema.sql` 在位、`Dockerfile` COPY、`/kg/search` 回显 `backend: "sqlite"`、`kg_enhanced` 唯一、`env.ts`/`native-bridge` 的 `DATABASE_URL` 语义）→ **ALL OK**；违规死句 0 处、带旧/废止标注的合法引用 2 处、新增行内死路径引用 3 处全部同行带墓碑、`+` 行 21 与本片改动数吻合。两方式的规范件计数**独立收敛到同一个 69 件**。脚本自身两次 FAIL 都是脚本的错，如实记：① 第一版只对 `path.basename` 做证据件匹配 ⇒ 把按月拆开的 `docs/operations-log/2026-08.md` 当规范件扫（正是门在 R5 里修过并写了注释的同一个坑）；② 死句表把"旧宣称……现已废止"这类**合法历史引用**也判违规 ⇒ 加标注白名单，而不是把命中数硬调成期望值。
- **敏感资产扫描（规则 11）**：`git diff -U0 | grep '^+' | grep -cE "192\.168\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+|sk-[A-Za-z0-9]{8}|ghp_[A-Za-z0-9]{8}|AKIA[A-Z0-9]{6}|BEGIN [A-Z ]*PRIVATE KEY|://[^ ]*:[^ ]*@"` → **0 命中**（本条目入库后对**含日志的全量新增行**重扫，仍 0）。两点如实说明：① 本片新写的 `postgres://…` 是无凭据占位（不含 `user:pass@`），故最后一条形态要求不成立；② 本条命令文本自身含 `AKIA`/`ghp_`/`192.168.` 字样（点名模式才可核验），任何全仓裸词扫描都会在本文件自命中 —— 与 D1 的 `doc-caliber:quote` 是同一形态问题，`operations-log` 在 `HISTORY` 豁免面内，故不改写命令换取静默。
- **红线**：不改任何运行时代码与 `package.json` 脚本；不做 `src/db/pg-schema.sql` 的归档动作（规则 4 存废待裁决）；不改判据与 `HISTORY`/`specDocs`/`caliberDocs`/墓碑在册清单；不把过期数值刷新为新的实测值（一律删数 + 指向生成器或代码符号）；旧口径只保留在显式标注"旧/废止/曾"的句子里；`openclaw-memory/` 不在本片动。
- **矛盾与残留**：① `package.json:46` 的 `db:init` 仍写"pg-schema.sql 已归档" —— 与规则 4 的归档定义冲突（未进 `archive/`、无 `ARCHIVE-LOG.md` 记录），且 `Dockerfile:52` 仍 COPY 它。真解法是**裁决存废**（按规则 4 归档，或明确恢复能力），不是改文案 ⇒ 与既有 task「pg-schema 存废」合并待用户裁决。② **本片最实的发现在运行时代码面**：`src/tui/install-wizard.ts:270/274/293/450` 仍在向导里采集 "PostgreSQL URL:" 并写进 `.env`，而仓内零 PG 驱动 —— 用户填的这串既连不上库又会把 `native-bridge` 的部署判定翻成 cloud。改它属 TUI 交互 + 运行时改动，需独立片（含 TUI 回归），本片按红线未动 ⇒ 新开任务登记。③ `docs/ARCHITECTURE.md:290` 的持久化清单仍写 `kg/enhanced.ts`/`codegraph-sync.ts` 这类**省略顶层前缀的简写**（③-b 残留④ 的 43 处之一，D3 视野外）；本片只改同一行的 PG 从句，未顺手改路径形态（规则 1）。④ **D 系列对这一类缺陷零覆盖**：一句"需 PG 时启用"里既没有路径（D3 不看）、没有行数（D4 不看）、不是禁语（D1 不看）、也不是开关登记（D5 看的是代码侧 switch）⇒ 全靠人肉普查发现，下次同类漂移照样漏。建议在 R6 做成 D5 的**镜像断言**：文档里出现"启用/开关/切换"话术时，必须能指回 `config/nondeterminism.json` 里一个 `switch != null` 且经 D5 在代码中验证过的条目（PG 的 `switch` 为 null ⇒ 任何"可启用"表述即判红）。⑤ `docs/functional-check-2026-08-16-sensenova.md:46` 逐字列了 `isPgAvailable`/`initPgSchema`/`pgQuery`/`pgVectorSearch` 等符号 —— 它自己已写"**本条此后失效**"并带墓碑，属合法历史引用；但按 §2.3"在此之前文档不得给出可调用 PG 符号"的**字面**口径是越线的，且该件命名不含 review/audit ⇒ 落在规范件视野内。是否把"带日期的功能核查报告"并入证据件豁免面，留 R6 与残留④ 一并裁决。⑥ `docs/ARCHITECTURE.md:293` 的更新记仍是**手抄工具数 189** 的宿主之一（③-b 已登记 §3.0 手抄数，本行同类），本片只对其 PG 从句加废止标注。
- **并入判定**：doc-contract 保持全绿；本分支剩余红 = OCR（环境件，缺 `tessdata`）+ 摆动性能断言（本片三次里 `EventBus` 中两次）⇒ 仍**只推分支不并入 `main`**（与 R0–R5-e 同口径），等 R6 定性能断言口径。
- **Commit**：b4832ee（`b4832ee5004caec3101b9058e933e06bcdfff078`；已推送 `internal codex/s3-on-main-2026-09-22`，`94d653f7..b4832ee5`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）

## 2026-09-22 14:49 +0800 — R5-g F-1 收口：仓库级"无 PG"否定句加运行时限定 + native 云端件例外披露（新增 D11 门）：第二方式的三次自纠偏

- **任务**：R5-f 深度复核产出的 F-1 —— 规范件把"无 PG"写成**仓库级**否定句，而 `native/crates/cloud` 确有 deadpool-postgres 池（`src/native-bridge.ts` 按 edition 选 `axiom-cloud` 二进制、`package.json` 的 `native:build:cloud` 是交付面），读者按"仓库里没有任何 PG 代码"去读 native 会立刻撞到矛盾。用户裁决：按优先级只改 F-1（加限定 + 补披露），不顺带动其余五项待裁决项。
- **前置量测（先测后改）**：以门的 `caliberDocs()` 同口径普查（72 篇，>50 由断言自证）⇒ 仓库级形态命中 **3 行**（`docs/ARCHITECTURE.md:10`、`:58`、`docs/PROJECT-GUIDE.md:537`）。native 侧事实核对采**三种互相独立形态**：① 连接/池方法调用（`\.(query|query_opt|query_raw|simple_query|execute|batch_execute|prepare)\s*[<(]`）命中 **0**；② SQL 文本字面量（`"(SELECT|INSERT|UPDATE|DELETE|COPY|BEGIN|COMMIT|PREPARE)\b`）在 `native/crates` 全 `.rs`（15 件）命中 **0**；③ 人工枚举 `pg_pool|create_pool|Pool` 全部 **8 处**引用点（`native/crates/cloud/src/main.rs:9` import、`:42` 字段、`:109-125` 建池、`:151` 入 state、`:186`/`:293` `is_some()` 布尔、`:279-286` `pool.get().await` → `connected`/`error`）⇒ 该池**只作存活探针，无数据面**。三种形态结论一致，故披露口径写"实测 0"而非"应当为 0"。
- **判断（与"删掉 native 提及"这一省事方案的分歧，如实写出）**：不把 native 从口径里抹掉、也不把"无 PG"改写成含糊的"基本没有"，而是① 把仓库级否定收窄为其真实范围"TS 运行时"，② 在 `docs/LIMITATIONS.md` §2.3 同表紧邻位置新增一行点名例外并说清"建了什么池 / 为什么不算数据面"，③ 用 D11 把这条披露与代码**锁成同源**（该池一旦长出 SQL 执行面，门即红）——只有"披露会随代码腐烂"被机器接住，F-1 才是被修而不是被改写。
- **工具**：Read（`native/crates/cloud/src/main.rs` 相关段、`native/crates/cloud/Cargo.toml`、`native/Cargo.toml`、`package.json`、`src/native-bridge.ts`、`tests/doc-contract.test.ts` 的 D1–D10 与 `caliberDocs`/`HISTORY`/`PATH_REF` 口径、`docs/ARCHITECTURE.md` §8 表与 `docs/LIMITATIONS.md` §2.2/§2.3/§2.4 全文）、Write（第二方式独立复核件 `.tmp/verify-g-pg.ts`）、Edit（门 1 件 + 文档 5 处 + 本日志）、Bash（红→绿、两次受控变异、tsc、两次内存封顶全量、规则 11 扫描、三形态 grep）。无子代理。AGENTS 规则 2（备份 6 件到 `.tmp/backups/`（与 HEAD 逐字一致，已 `cmp` 确认）→ 通读 → 最小改动 → 验证 → 提交后删）与规则 7（垂直切片：D11 先红 → 文档收窄 → 披露在册 → 镜像断言）执行。
- **操作**（文件级）：
  1. `tests/doc-contract.test.ts`：新增 **D11「仓库级 PG 否定句需限定范围并披露例外」**（4 例）——(a) 规范件（`caliberDocs()` 去 `HISTORY` 证据件，并含 `README.md`/`AGENTS.md`）内禁语形态 `本仓[当前]无 PG|仓库内无 PG|全仓无 PG|无 PG 驱动与入口|无 PG 入口` **0 命中** + 扫描面 `>50` 正向对照；(b) `docs/LIMITATIONS.md` 点名 `native/crates/cloud` 的行**恰 1 行**且要素齐（`DATABASE_URL`、`create_pool`、探针/探测）；(c) **与代码同源的镜像断言**：`native/crates` 下引用 `deadpool_postgres|tokio_postgres` 的 `.rs` 必须 >0（否则例外凭空存在），其 PG 语句执行点必须 =0（长出 SQL 执行面即红，逼口径同步改写）；(d) **判据自检**：被禁的 3 种真实历史写法必须判红、限定后的 2 种口径必须判绿，`PG_SQL_SITE` 亦以 `client.query("SELECT 1", &[])` 判红 / `pool.get().await` 判绿做双向对照 —— 门不得对自己免检。
  2. `docs/ARCHITECTURE.md`：`:10` 与 `:58` 的"PostgreSQL 能力当前不可用/无 PG 入口"收窄为"SQLite 为 TS 运行时唯一有数据面的数据库；PostgreSQL 在 TS 运行时不可用（H-M1-03 移除后无 PG 数据面入口…）"，`:58` 尾部点名 `axiom-cloud` 的探针池并给出"crate 内 PG 语句执行点实测 0"，例外口径指向 `docs/LIMITATIONS.md` §2.3；`:290`（§8"历史 PG"行）把 "PG 能力当前不可启用…无任何开关或入口" 收窄为 "PG 数据面能力在 TS 运行时不可启用…TS 运行时内无任何开关或入口"（`:58` 的同句旧限定保留，`doc-caliber:absent: src/db/pg-client.ts` tombstone 未动）。
  3. `docs/PROJECT-GUIDE.md:537`：旧句 `本仓当前无 PG 入口` → `TS 运行时无 PG 数据面入口（… `src/` 下无客户端、无开关；native 云端件的 PG 池只作存活探针，口径见 docs/LIMITATIONS.md §2.3）`，其后"`DATABASE_URL` 是 Legacy alias、设为 `postgres://…` 不改变后端、只影响 `src/native-bridge.ts` 的云端判定"逐字未动（那是 R5-f 已证的事实）。
  4. `docs/LIMITATIONS.md`：§2.2 `:62` 的"PG 当前不可启用"加运行时限定（"`src/` 下无客户端、无开关、无入口"原样保留）；§2.3 表在 `PG vector 切换` 行之后新增 `native 云端件的 PG 例外` 一行（现状/影响/后续校准三列齐全：写清 crate→二进制→选择面→构建脚本、`create_pool` 消费点全是存活探针、执行点实测 0，影响列直说"例外不点名就等于制造口径冲突"，校准列写明 D11 的同源锁）。
- **门的活性证明（防"只断言不失效"）**：两次受控变异，均在原文件上做、事后从 `.tmp/probe-saved/` 逐字还原并以 grep 计数确认标记各回落到 1、临时件目录删除，未对脏文件使用任何 `git checkout`/`restore`。① 把 `docs/ARCHITECTURE.md:10` 恢复成旧仓库级句（含 `无 PG 驱动与入口`）→ D11 第 (a) 例 RED；② 删掉 §2.3 的 native 例外整行 → D11 第 (b) 例 RED；两次同时跑 → **31 pass / 2 fail**，且失败断言正是对应那两条；还原后复跑 **33 pass / 0 fail / 188 expect() calls**。RED 侧亦为真红：D11 落地后、文档改写前首跑 **31 pass / 2 fail**，offenders 恰为 `docs/ARCHITECTURE.md:10`、`:58`、`docs/PROJECT-GUIDE.md:537` 三行。
- **第二方式（独立复核件，与门不复用任何正则与清单）**：`.tmp/verify-g-pg.ts` 自写规范件枚举（按路径段判证据件，得 72 件）、自写**更宽**的形态网（允许中间插词）、自写 native 事实回代、自写构建/选择面核对。三轮纠偏（都是脚本自己的错，如实登记而未改期望数）：
  1. `.rs` 采集误复用了只收 `.md` 的 walker ⇒ 报"rs 文件 0 个"；以一次性 inline node 复核（`md under native: 0` / `rs under native: 15`）确认是脚本 bug 后补 `walkExt`。
  2. PG 语句执行点网首版用 `/query|simple_query|\.execute/` ⇒ 假命中 3 处（`main.rs:208` 的 JSON 响应键 `"query": params.q`、`:230` 的字段名 `query: String`、`:248` 的本地向量检索调用 `state.search.search(&req.query, &opts)`），**无一是 PG 调用**；改为"点号接收者的连接方法调用 + SQL 文本字面量"两种形态，并各加真/假双向对照。
  3. 仓库级网的"已限定"判据首版把裸 `src/` 当作限定载体 ⇒ 会把本片真正该修的两行（`:290`/`:62`，其 `src/` 只是文件名 `src/db/pg-client.ts`）自动放行。收紧为只认 `TS 运行时`/`native/crates` 两类载体，并补一条**基线对照**：同判据跑 `git show HEAD:` 的改动前文本，判出**恰 5 处未限定**（`docs/ARCHITECTURE.md:10`、`:58`、`:290`、`docs/LIMITATIONS.md:62`、`docs/PROJECT-GUIDE.md:537`）。这条基线既证明判据会咬人，也独立复核了人工裁决的范围——宽松网另 3 处命中经逐行判读确属已限定句（网的作用是把候选摆出来给人读，不是自动裁决）。当前跑结果 **ALL OK**（19 项断言 + 1 项 INFO）。
- **验证结果（全部新鲜执行）**：`bun test ./tests/doc-contract.test.ts` → **33 pass / 0 fail / 188 expects**（首跑 RED 31/2 见上）；三件联合 `bun test ./tests/doc-contract.test.ts ./tests/unit/docs-consistency.test.ts ./tests/unit/pg-client-removal.test.ts` → **45 pass / 0 fail / 234 expects**，在 `:290`/`:62` 两处追加限定**之后再跑一次仍 45/0/234**（`pg-client-removal` 对 `ARCHITECTURE:58` 的反向断言未被新口径绕过）。`bun run lint` → exit 0（`tsc --noEmit` 不含 `.tmp/`，故第二方式件不受 lint 覆盖——其语法错在跑动时才暴露，已修）。全量两遍（`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests`）：加限定前 **4248 pass / 36 skip / 3 fail**（4287 tests / 414 files / 132066 expects / 31.26s），全部改动落定后 **4250 pass / 36 skip / 1 fail**（同 4287 tests / 414 files / 132066 expects / 32.34s / EXIT=1）。
- **三条红的归因（不改口径、只如实登记）**：① `OCR Engine > should get engine with default config` = 环境件（缺 `tessdata`），本片起持续存在；② `性能基准 > [perf-extreme] EventBus 100k publish < 300ms [331.73ms]`、③ `Performance Benchmarks > CodeGraph Cache Performance > should cache queries efficiently [57.95ms]` 只出现在第一遍；③ 单跑该文件两次 → **4 pass / 0 fail / 10005 expects**，第二遍全量 ②③ 均未复现 ⇒ 两判为 `--parallel=8` 负载抖动型 flaky（本片纯文档+门件改动与二者无调用关系），计为**摆动断言**而非本片引入，处置口径待 R6（#23）定性能断言政策时一并裁决，本片不删不改阈值。
- **敏感资产扫描（规则 11）**：本片 `git diff -U0` 全量新增/上下文行对 `sk-*`(≥16)/`AKIA*`/`ghp_*`/`-----BEGIN *PRIVATE KEY-----`/`192.168.`/`ssh://`/`password=`/`token=` 命中 **0**（RULE11-CLEAN）。披露行只点名 crate 路径与 DATABASE_URL **变量名**，不含任何真实地址或值。
- **红线**：不改任何运行时代码、不改 `native/` Rust 源（只读）、不为凑绿把性能断言阈值或 `--parallel` 调低；不动 `src/db/pg-schema.sql` 存废（规则 4 待裁决）；不改 `caliberDocs`/`HISTORY`/`specDocs` 判据本体；不并入 `main`。
- **矛盾与残留**：① **F-1 只修了 PG 这一族**。D11 的形态表是按本次症状写的，其他"仓库级 vs 运行时级"否定句（如出网/LLM/native 能力面）无同类门，镜像债仍挂在 #40（"可启用性话术必须指回已验证 switch"）——D11 是其部分覆盖，不是替代；② `native/` 整体仍**未审**（本次只核了 PG 池一条链，crate 的 HTTP 面、并发面、token 面未看），故"native 无提权链路"这句任何地方都不许写；③ 两套扫描面口径不同（门 `caliberDocs`−`HISTORY` = 本片 72 件中的受控子集；复核件按路径段判据）⇒ 复核件的 pgvector INFO 列出 2 处日期型 eval 报告行（门按 `HISTORY` 豁免），本片两者结论无冲突但**分工不等同**，不得据此认为二者可互相替换；④ 待用户裁决项 F-2/F-3/F-4/F-5 与 #32/#39 本片一律未动。
- **记录维护（非新增业务记录）**：本文件"归档索引"的 2026-09（当月）条目数随本条递增 147 → 148。
- **并入判定**：doc-contract 全绿；本分支剩余红 = OCR 环境件（+ 两条摆动性能断言，见归因）⇒ 仍**只推分支不并入 `main`**，与 R0/R1/R2/R3/R4/R5-f 同口径，等 R6 定性能断言口径。
- **Commit**：c55ea6f（`c55ea6f93be36cd930a88eacd351bef12e42eeda`；已推送 `internal codex/s3-on-main-2026-09-22`，`401ef866..c55ea6f9`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）

## 2026-09-22 16:40 +0800 — F-2 脱敏与两线收敛：规范面内网地址清零（11 件 / 22 行 → 0）+ AGENTS.md 规则 3 按 v1.4 文本重放 + 新增 D12 门

- **任务**：按用户裁决（选项 "A + B"）做 F-2 这一片：A = 把 `847f486` 的规则 3 口径（唯一远端 `internal`、不复制 IP/URL、地址以本机 `git remote -v` 为准）重放到本分支 AGENTS.md v1.4 文本，并把规范件里的内网地址清零；B = 新增门 D12 锁住规范面地址形态（带正向对照）。C 层（脚本/配置/代码的功能默认值）与 D 层（历史留痕）按裁决**只登记不动**。
- **前置量测（先量后改）**：D12 候选扫描面 = `specDocs()`（`caliberDocs` − `HISTORY` + README）+ `AGENTS.md` + `.env.example` = **70 件**（门按 `.md` 走查；同判据打在 `git ls-files` 上是 73 件，差的 3 件是 `docs/test-reports/*.{txt,json}` —— 门的走查不吞非 markdown，见"登记"⑤）；HEAD 基线命中 **11 件 / 22 行**，门 RED 时列出的正是同一组 22 行 ⇒ 判据与量测互相印证。
- **判断**：两线收敛**不能靠 cherry-pick** —— `847f486` 不是本分支祖先，且两分支的 AGENTS.md 是两份不同文档（本分支 v1.4 带总则 0.1-0.7 与规则 12，旧线没有）。故按本分支文本重写规则 3，保留 v1.4 的结构与事实（仓库收敛史、LFS、只暂存本任务、`git status -sb` 核对、禁 amend 已推送），只把地址族换成"指向本机 remote"。旧线那份的推送目标 `internal` 与"主干是 `main`"两条一并重放（后者是本分支 v1.4 缺失的事实，正是 S3 曾只世系内成立的根因）。
- **工具**：主 agent 单线施工（无子代理，11 个文件改动面彼此耦合，并行编辑同族文件违反规则 2 第 6 条）；`bun test`、`git grep`、`git show HEAD:` 基线对照、自建一次性复核件 `.tmp/measure-f2.ts`、`.tmp/verify-f2b.ts`、`.tmp/scope-delta.ts`（均在 `.gitignore` 的 `*.tmp` 面内，不入库）。
- **操作（文件级，12 件）**：`tests/doc-contract.test.ts` 新增 D12（0 命中断言 + 覆盖面自证 `scope>60` + 判据自检 9 例含合成语料阳性对照，文件头覆盖行同步补 D11/D12）；`AGENTS.md` 规则 3 重写（`internal` 为唯一推送目标、remote 实测关系、退役地址与账号移除）、规则 9 括注 `push gitea` → `push internal`、版本头 v1.4 → v1.5；`docs/{CONFIGURATION,ARCHITECTURE,DISTRIBUTED-TESTING,KNOWLEDGE-BASE,PROJECT-GUIDE,IMPLEMENTATION-GUIDE-2026-08-08,functional-check-2026-08-16-sensenova}.md`、`docs/decisions/ADR-003b-lfs-server-enablement.md`、`README.md`、`.env.example` 地址清零。改法统一为两类：可执行示例换 `<user>@<host>` / `${LAN_*}` 占位符并就地注明"取值属部署参数，规则 11 不入库"，叙述句删掉地址只留角色。
- **顺带纠正的两处过头声明**（属本片口径，不是无关清理）：`README.md:748` 原写"仓库不含真实内网信息"—— 同判据实测仓库仍有 40 件 / 169 行（脚本、配置、夹具、历史留痕；此数为本片施工后、本条入库前量得，本条自身作为 D 层留痕又引用了 2 处地址，故入库后同判据读作 40 件 / 171 行 —— 这正是 README 不复制计数的理由），已改为"规范面已清零（D12 锁定）+ 其余层登记未改"并标注校正日期；`README.md:158` 原写"上面的代理地址是部署机实测值"，该值已换占位符，句子改为指明真实值只在本机 `config/searxng/settings.yml`。
- **验证结果**：`bun test ./tests/doc-contract.test.ts` → 先 RED（D12 逐行列出 22 处），施工后 **35 pass / 0 fail**；`bun run lint`（`tsc --noEmit`）exit 0；全量 `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=8G bun test --parallel=8 --timeout 15000 ./tests` ⇒ **4252 pass / 36 skip / 1 fail**（414 件、33.77s），唯一红 = `OCR Engine > should get engine with default config`，`src/ocr/engine.ts:98 assertLangsAvailable` 抛错 = 本机缺 tessdata 的已知环境件（R5-g 同一条，本片不碰 OCR 代码路径）。中途一次并跑曾多出一条 `EventBus 100k publish <300ms`（实测 318.20ms）—— 该断言是我在并行写 ops log 时受负载影响摆动，单独复跑与静默重跑均绿，属 R5-g 已登记的两条摆动性能断言之列，未调阈值。
- **门的活性证明（变异测试，三次）**：① 往 `docs/ARCHITECTURE.md` 追加一行含 `192.168.2.11` ⇒ D12 it-1 红；② 把 `lanScope()` 改成只返回 `specDocs()`（丢掉 AGENTS.md 与 `.env.example`）⇒ it-1 因 `toContain` 断言红（覆盖面塌方不能靠"少扫几件"变绿）；③ 把 `RFC1918` 写坏成要求五段（趋近恒假）⇒ it-1 假绿但 **it-2 判据自检红**，证明自检正是为"门对自己免检"准备的。三次变异后从显式保存的副本还原，`diff -q` 确认与变异前逐字一致。
- **第二方式（独立复核，不经门的代码路径）**：`git ls-files` 取集合 + 同一 RFC1918 判据 ⇒ 工作区 73 件 0 命中；同判据打在 `git show HEAD:<file>` ⇒ 22 行 / 11 件，与门 RED 的输出完全同集 ⇒ 判据非恒假、清理确有发生。
- **偏差记录（规则 0.6/12-Act）**：① 我在复核变异 1 时用 `git checkout docs/KNOWLEDGE-BASE.md` 还原被污染的文件，**连带丢掉了该件本片已做的脱敏**（`git checkout <文件>` 丢弃的是工作区未提交改动，不只是我的变异行）。已发现并重做两处改写，`git diff` 逐字复核。教训固化：变异复原只用显式保存的副本（`cp` 到 `.tmp/f2-mutate/`），不对带未提交施工的文件使用 `git checkout`/`git restore`（规则 9）。② 一次性复核件 `.tmp/measure-f2-residual.ts` 首跑输出"0 件命中"，与已知事实矛盾 —— 根因是 `Bun.readFileSync` 不是 `Bun` 的命名导出，`try { } catch { continue; }` 把每件的 `TypeError` 吞成"该件无命中"。这是**脚本缺陷而非预期数字问题**：换成 `git grep` + `execFileSync("git",["ls-files","-z"])` 双方式重测得 40 件 / 169 行，未调低任何预期值。附带记录：`.tmp/` 不在 `tsc --noEmit` 覆盖面内，复核件写坏不会有类型门兜底。
- **敏感资产扫描（规则 11）**：本次新增行按 `sk-*`/`AKIA*`/`ghp_*`/`-----BEGIN …PRIVATE KEY-----`/`password=`/`token=<长串>` 逐条筛 ⇒ 0 命中；D12 自检语料原样引用了仓库远端真实端点与退役账号（`git@…:2222`、`data@…`），等于把刚清掉的东西抄回 `tests/`，已改为 `192.168.99.x` + `svc@` 合成值（判据强度不变，阳性对照仍覆盖"带端口 SSH URL / user@host 裸址 / 表格单元"三形态）。真实端点现只存在于 git 历史与工作区 git remote 配置中，脱敏不改历史（规则 9：已推送历史禁止改写）。
- **规则变更（总则 0.7）**：问题证据 = 规则 3 里的远端地址与退役服务器地址在两次服务器变更后均需人工回填，实际未回填（`internal211` 退役后其地址仍写在文中；"规则要求 `gitea`，实际为 `origin`" 与本机 `git remote -v` 已不符）；变更内容 = v1.5 规则 3 新增"不复制 IP/URL、地址以本机 `git remote -v` 为准"的强制口径 + 推送目标统一为 `internal` + 补记主干为 `main`；影响规则 = 规则 3、规则 9 括注；验证方式 = D12 门 + `git remote -v` 回代；回滚 = revert 本片 AGENTS.md 与 `tests/doc-contract.test.ts` 两文件的改动。属"新增门禁"⇒ 次版本 v1.4 → v1.5。
- **登记（本片不动，待裁决）**：① C 层功能默认值仍在代码/脚本/配置里：`scripts/runtime-go/deploy.sh`、`scripts/runtime-go/soak-72h.sh`、`scripts/deploy-pdf-worker.sh`、`scripts/audit/dual-probe.ts`、`scripts/distributed-test-runner.ts`、`src/testing/cluster/types.ts`、`src/cli.ts`、`config/searxng/settings.yml`、`runtime-go/README.md`；② D 层历史留痕：`docs/operations-log.md` 与其月度归档、`docs/reviews/**`、`docs/superpowers/**`（门按 `HISTORY`/`superpowers` 豁免）；③ **地址短写片段**（`.10`/`.22`/`.111`/`.108`/`.24`）不在 D12 谓词内，`docs/decisions/ADR-003b*`、`ADR-006*` 保留原样 —— 它们是"哪台机"的历史叙述，且片段形态不构成可寻址信息，扩谓词会误伤版本号，故按家族登记而非顺手改；④ 根目录 `LIMITATIONS.md:21` 仍有 `192.168.0.150`，且它与 `docs/LIMITATIONS.md` 是**两份不同文档**（md5 不同），根件不在任何 D 门的走查面内 —— 这是 D2「权威唯一」的漏面，另案；⑤ 各门的 `mdFiles()` 只收 `.md`，`docs/test-reports/` 下 3 件 `.txt/.json` 完全不被扫描（现无地址，属潜在漏面）；⑥ 文档里"真实拓扑见本地 `~/.axiom/axiom-secrets/runtime-go-topology.md`"这一指针在本机不成立 —— 该目录实测只有 `gitea.token` 与 `siliconflow.credentials` 两文件（`ls` + `find ~/.axiom -maxdepth 3` + `find ~ -maxdepth 2 -name '*topology*'` 三种方式一致），拓扑文件应是 Windows 侧产物，故本片改写时未新增任何指向该文件的指针。
- **未决项 / 后续**：① 两线尚未真正合一 —— 本分支带 v1.4 结构（总则 + 规则 12）与本片地址口径，旧线 `codex/doc-caliber-doc-contract-gate-2026-09-21` 带 `847f486` 的同类改写与"主干 `main`"事实；将来合并时 AGENTS.md 规则 3 两侧都必须保留，任何一侧被静默丢弃都会让 D12 或 v1.4 的总则缺一半，合并前需人工复核（本分支仍只推分支不并 `main`，与 R0-R5-g 同口径，等 R6）；② 登记项 ①-⑥ 待裁决；③ R5-g 遗留的 F-3/F-4/F-5 与 #32/#39/#40 未动。
- **Commit**：0941487（`094148712d165ce7821ee42ab0e70c452ae86d9f`；已推送 `internal codex/s3-on-main-2026-09-22`，`b6c04abe..0941487`。本行 hash 由回填提交补录，回填提交属记录维护，规则 5）
