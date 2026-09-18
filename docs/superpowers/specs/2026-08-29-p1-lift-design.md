# P1 提升迭代设计 — 检索唤醒 / 中文召回 / 结构化输出 / 学习回路 / 校准积累 — 2026-08-29

> **来源**：docs/knowledge/agent-decision-chain-assessment-2026-08-29.md §五 P1 行（P0 三项已完成，见该报告第六节）。用户指示继续下一步。
> **原则**：同 P0——接线型改动、可降级、TDD、AGENTS 规则全程适用。

## S1: DRE 检索栈唤醒（retrieve() 单入口接主检索缝隙）

**现状**：deterministic-retrieval-engine（848 行）+ hybrid-fusion + knowledge-wiki + verification-chain 全库零 importer；tie-break 已修；接口已收敛（retrieve() 单入口，deterministic-retrieval-engine.ts:19）。
**设计**：①在 routes/search.ts 的搜索响应中并入 DRE 检索结果（`retrieve()` 输出作为补充来源段，标注 `source: "dre"`；DRE 未启用/异常时静默跳过）；②VaultManager.search 的候选回退链挂 retrieve()（FTS 命中 <3 时确定性引擎+图扩展补充——读 vault-manager.ts:176-206 现有回退语义后取最小接线，避免改变现有排序契约）。**不改** DRE 检索算法本身。
**验收**：routes/search 响应含 dre 段（有知识网络数据时）；vault 回退链测试红→绿；DRE 禁用时行为与现状逐字节一致。

## S2: 中文 bigram 召回（词法范式内最大增益）

**现状**：FTS5 unicode61 把连续中文当单 token（sqlite-memory.ts:113）；deterministic-search tokenize 同病（:595-606）；KAL sanitizeFTS5 同构。语序改写即漏召回。
**设计**（两层，均带降级）：
1. **内存引擎**（零迁移）：deterministic-search tokenize 引入 CJK bigram（复用 src/self-evolve/engine.ts:53 既有实现；ASCII 词保持原样），倒排索引与查询侧同步——同引擎内写入/查询一致即生效。
2. **SQLite FTS**：memory_notes_fts 迁移为 `tokenize='trigram'`（SQLite ≥3.34 支持子串匹配，bun:sqlite 打包版本需实测确认；**trigram 最小 3 字符——中文双字词需 bigram 兜底**，故查询侧仍做 bigram OR 扩展 + trigram 索引子串）。迁移策略：启动时检测 sqlite_master 中 memory_notes_fts 的 tokenizer，非 trigram 则重建+全量回填（事务内，失败回退保留旧表并 debug 告警，检索降级 LIKE 不中断）。KAL queryVault 的 FTS 查询同步适配。
**验收**：中文改写召回测试（"机器学习" vs "学习机器"等）红→绿；迁移失败降级路径测试；既有 FTS 测试全绿。

## S3: 主链路结构化输出收紧（把 DRE 侧的"紧"迁到主链路）

**现状**：intent-enhancer、edge preflight、risk-monitor 的 JSON 解析靠 extractJson+手写字段检查；无 schema。
**设计**：三处解析点接 zod schema（严格字段类型 + 安全回退路径保持不变——解析失败行为与现状一致，只是失败更早更明确）；DRE `parseCloudDecisionOrThrow` 同样接 zod。**不做** response_format 全量接入（需 provider 能力矩阵，P2）。每处 schema 导出便于复用。
**验收**：各解析点畸形输入测试（错型/缺字段）返回与现状一致的降级结果；zod schema 单测。

## S4: thompson 学习回路（arms 填充 + 反馈接线 + 平级 tie-break）

**现状**：main.ts:229 arms:[]；reportFeedback 零调用；模型选择纯静态优先级。
**设计**：①arms 由 model-router 的 providers 构建（RouterArm{id: providerId, model, provider}，均匀先验 alpha=beta=1）；②反馈接线：router.execute 的既有成功/失败记录点（model-router.ts:387-423 四路记录处）同步 `thompsonRouter.reportFeedback(armId, success)`；③**消费（最小侵入）**：同优先级候选 ≥2 时按 thompson 采样权重 tie-break（不改优先级排序本身）；空 arms/未注入时行为与现状一致。
**验收**：同优先级 tie-break 随成功记录偏向赢家（确定性测试：固定序列反馈后选择可预期）；既有 router 测试全绿。

## S5: 校准数据积累（幻觉防线判别力解锁）

**现状**：Task C 双缝 verify 已运行，verdict 未持久化；calibrate（hallucination-detector）需 (statement, evidence, label) 对，零数据。
**设计**：①SQLite 新表 `hallucination_verdicts`（statement 摘要/evidence 指纹/pValue/verdict/时间戳，migrate.ts 纳管）；②两缝 verdict 落库（异步，不阻塞响应）；③`calibrateFromStored(minPairs)` 维护函数：数据 ≥50 对时以"证据相似度≥0.5 且用户显式纠正"作为正例的保守自动标注起步，接入 detector.calibrate（启动时自动尝试，不足则跳过）。**标注策略保守起步、代码注释声明半自动性质**；真值标注 UI 属后续。
**验收**：verdict 落库测试；calibrateFromStored 不足跳过/充足生效两分支测试；migrate 幂等。

## 非目标
P2 项（拒绝采样提温/maxTokens 自适应/HITL 批量授权/幽灵裁剪/response_format 能力矩阵）；thompson 全面接管路由（仅平级 tie-break）。

## 验收清单
- [ ] S1-S5 各红→绿；`bun run test:full` ≥600 全绿；tsc 0
- [ ] S2 迁移失败降级路径验证（旧表保留、检索不中断）
- [ ] S4 既有 router 语义不回退（优先级排序不变）
- [ ] 评估报告回写 + operations-log 全程留痕
