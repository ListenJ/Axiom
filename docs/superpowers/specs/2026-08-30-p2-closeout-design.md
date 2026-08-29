# P2 收尾迭代设计 — 约束再校准 / 幽灵裁剪 / 白名单自动发现 / HITL 标注管道 / M10 降级上下文 / W5W8 基准门禁 — 2026-08-30

> **来源**：docs/knowledge/agent-decision-chain-assessment-2026-08-29.md（P0/P1 已完成，见第六/七节）；联合审查与各轮回写中的遗留清单。用户指示继续。
> **原则**：接线型/清账型改动、可降级、TDD、AGENTS 规则全程适用。本迭代完成后评估报告杠杆清单全清。

## S1: DRE 约束再校准（过紧修复）
**证据**：temp0+seed42 下 n=3 拒绝采样三票必全同（client.ts:599-607，3 倍成本空转、modeAmbiguous 永不触发）；DRE maxTokens 默认 512（client.ts:113）过小；Anthropic high 砍半至 4096（reasoning-effort.ts:100）。
**设计**：①`generateConstrained` 内 temp===0（或 seed 已固定）时 n 强制 1（三票同值数学等价单票，省 2/3 成本）；temp>0 保持 n=3 投票。②maxTokens 默认 512→2048（可 env 覆盖，注释说明预算联动 clampMaxTokens）。③reasoning-effort high 档 4096→8192（对齐 BUDGETS 上限）。
**验收**：n=1 分支测试；maxTokens/4096 三处断言；既有 DRE 测试全绿。

## S2: 幽灵裁剪（减 ~2000 行维护税）
**证据**：mathContext 6 模块 main.ts:225-242 实例化后全库零消费者（评估已核）；其中 thompson/hallucinationDetector 已在 P0/P1 接线（保留）；RateDistortionCompressor 生效实例在 components/token-budget.ts（main.ts:230 为重复休眠实例）；autoRoute 死代码（model-router.ts:908）。
**设计**：①main.ts 移除休眠实例化块（VIBCompressor/ConformalRetriever/MathEnhancedMemory/ConsensusEngine/重复 RateDistortion；保留 thompson/hallucinationDetector/detector 配置）；②零引用模块文件按规则 4 归档删除（先 grep 确认零引用：VIBCompressor 仅被休眠的 MathEnhancedMemory 内用、ConformalRetriever 零调用、ConsensusEngine 零调用——逐个核实后归档至 archive/ + ARCHIVE-LOG + git rm）；③autoRoute 方法删除（确认零引用）。** RateDistortionCompressor 模块文件保留**（components 真实使用）。
**验收**：tsc 0；测试全绿（引用这些类的测试如存在则随删/随归档）；行数净减统计入日志。

## S3: test:full 白名单自动发现（根治组合序结构性弱点）
**证据**：手工白名单两次漏新测试（P1 五文件回退事件）；组合序依赖 audit-regression-stress 残留 tick。
**设计**：新脚本 `scripts/test-full.ts`——递归收集 `tests/**/*.test.ts`，排除清单（tests/stress/、tests/e2e/、`*.slow.ts`、已知存量 flaky：audit-regression-stress），spawn `bun test <files>`（继承 stdio，非零退出码透传）；package.json `test:full` 指向 `bun run scripts/test-full.ts`。排除清单即"已知 flaky/环境依赖"的显式账本。
**验收**：脚本输出清单数 ≥600；全量跑绿；排除清单有注释依据；新增测试自动纳入（放一个空壳测试验证收集）。

## S4: HITL 真值标注管道（校准闭环人工入口）
**现状**：S5 已落 verdict 持久化 + 保守自动校准；真值标注无入口。
**设计**：hallucination_verdicts 加 `label INTEGER`（0/1/null）列；新 MCP 工具 `hallucination_feedback`（mcp/server/safety-tools.ts：入参 verdict id + isFact 布尔 + 备注，写 label）；calibrateFromStored **优先用有 label 的对**（label 即真值），无 label 对仍走极化组保守策略。工具经注册表自动获得 HardFloor/权限层（188→189 计数联动 tool-count.ts 单一事实源更新 + docs 数字同步）。
**验收**：工具行为测试；calibrate 优先级测试；tool-count 断言更新后 architecture-integrity 绿。

## S5: M10 云端降级上下文补全
**证据**：cloudConsciousnessStep 只发 input.observation（engine.ts:746 附近），本地工作记忆不随行，降级后行为不一致。
**设计**：cloud prompt 注入本地工作记忆摘要（ConsciousnessStream working memory 尾部 N 条 + 最近反思结论，截断 ≤2KB）作为 system 附加段；记忆不可用时现状直发。**不改返回结构**。
**验收**：注入测试（mock caller 捕获 prompt）；记忆空时逐字节现状。

## S6: W5/W8 重立项前置门禁（真实规模基准）
**证据**：修订决定"W5 延期：索引优化下迭代"；S4 评估要求"前置门禁=真实规模基准数据"。现有 FTS vs LIKE 对比仅 300 行玩具数据。
**设计**：基准脚本 `scripts/bench-kal-retrieval.ts`——生成合成库（10k/50k/100k 行 CJK+英文混合 kg_nodes/knowledge_node），对 LIKE（现状）vs FTS（trigram，S2 基建）跑标准查询集（精确词/改写/前缀），输出 p50/p95 表格 Markdown 报告至 docs/knowledge/kal-benchmark-<date>.md。**结论写进报告：FTS 增益 <2x 则 W5/W8 正式关闭（不做），≥2x 则立项排期。**
**验收**：脚本能跑（本地生成合成库不入库 data/ 真实库）；报告产出；结论明确。

## 非目标
HITL 标注 UI（仅管道）；MultiDimensionLimiter/executeWithModeGuard 处置（避免扩面）；外围 9 棵树。

## 验收清单
- [ ] S1-S6 各红→绿或产出证据；`bun test ./tests`（自动发现）全绿；tsc 0
- [ ] S2 归档按规则 4（archive/ + ARCHIVE-LOG + git rm）
- [ ] S4 tool-count 189 联动（tool-count.ts/docs/architecture-integrity）
- [ ] S6 基准报告落 docs/knowledge/ 且结论明确
- [ ] 评估报告终版回写（杠杆清单全清）+ operations-log 留痕
