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
| 2026-09（当月） | 91 | 本文件 |

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
