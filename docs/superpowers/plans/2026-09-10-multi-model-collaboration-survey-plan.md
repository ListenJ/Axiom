# 多模型协同系统：复用 vs 新建勘察报告 + 切片化测试计划

> 日期：2026-09-10 ｜ 任务级别：T3（架构/新模块，需用户确认关键决策后动工）
> 设计来源：docs/superpowers/plans/2026-09-09-multi-model-collaboration-design.md
> 状态：**已冻结（2026-09-10 用户批准 D1-D4=全部建议默认值，见第六节）**；S1 开工
> 事实基准：以下接口签名均来自 2026-09-10 实际读码，行号可跳转；标注 事实/推测/判断

## 一、核心发现：设计文档要的能力，仓库已有 70% 现成实现

设计文档把多模型协同描述成待建系统，但**代码勘察证明中枢-执行、模型注册、任务分发、上下文压缩、幻觉检测、提示词池均已存在**。真实工作量是"接线 + 补交叉验证"，不是"从零构建"。

**判断**：若按设计文档字面新建，将大面积重复实现（违反规则 1/8）。正确路径是复用现有接缝，仅新建缺失的交叉验证协调层。

## 二、逐项能力映射（事实）

| 设计需求 | 现有实现 | 接口证据 | 判定 |
|---|---|---|---|
| ① 模型注册/配置 | `model-capability-registry.ts`：`registerModel`/`unregisterModel`/`getModel`/`listAllModels`/`assignModel`/`getFallbackChain` | [registry L118-206](file:///d:/openclaw-fusion/src/router/model-capability-registry.ts#L118) | **可复用** |
| ① 动态切换/降级 | `MultiPlatformRouter.execute()` 含 fallback 链、`isPermanentFailure`/`recordPermanentFailure`/黑名单 | [model-router L328](file:///d:/openclaw-fusion/src/router/model-router.ts#L328)、[L241-261](file:///d:/openclaw-fusion/src/router/model-router.ts#L241) | **可复用** |
| ① 负载均衡 | `Dispatcher`（Semaphore 256 并发闸）+ thompson-router（学习式选路） | [dispatcher L59-101](file:///d:/openclaw-fusion/src/router/dispatcher.ts#L59) | **可复用** |
| ② 任务分类 | `TaskOrchestrator.classifyTask()`（关键词，无 LLM）；`intent-router.ts` | [task-orchestrator L115](file:///d:/openclaw-fusion/src/router/task-orchestrator.ts#L115) | **可复用** |
| ② 模型匹配分发 | `router.assign(role)`/`executeWithRole`/`batchExecute`；`DynamicModelAssigner` | [model-router L1078-1135](file:///d:/openclaw-fusion/src/router/model-router.ts#L1078) | **可复用** |
| ② 中枢-执行模式 | `TaskOrchestrator.execute()` 完整 U→R→E→O：多角色并行 + `synthesizeAnswer` 汇总 | [task-orchestrator L62-108](file:///d:/openclaw-fusion/src/router/task-orchestrator.ts#L62) | **可复用（核心已存在）** |
| ③ 上下文统一表示/压缩 | `ContextManager.checkUsage`/`splitContext`（摘要+存储） | [context-manager L119-195](file:///d:/openclaw-fusion/src/context/context-manager.ts#L119) | **可复用** |
| ④ 知识库检索增强 | `TaskOrchestrator.retrieveContext()` 已接 Vault/SQLite/codegraph；KAL；KG | [task-orchestrator L70](file:///d:/openclaw-fusion/src/router/task-orchestrator.ts#L70) | **可复用** |
| ⑤ 交叉验证防幻觉 | `ConformalHallucinationDetector`（单模型事实核查）；`ValidationPipeline`（S-A8 多级校验） | [hallucination-detector L290](file:///d:/openclaw-fusion/src/memory/hallucination-detector.ts#L290)、[validation-pipeline L74](file:///d:/openclaw-fusion/src/semantic/validation-pipeline.ts#L74) | **需新建协调层** |
| ⑥ 输入增强模板/提示词版本 | `UserAgentPromptPool`（缓存/装配）；`prompt-optimizer`（策略/确定性门） | [prompt-pool L396](file:///d:/openclaw-fusion/src/agents/prompt-pool.ts#L396)、[prompt-optimizer](file:///d:/openclaw-fusion/src/agents/prompt-optimizer.ts) | **可复用** |

## 三、真实缺口（仅 3 处，均需新建/扩展）

1. **【缺口 A·核心】多模型交叉验证协调器**：设计 3.3 要求"关键结论至少两个不同模型独立验证"。现有 `ConformalHallucinationDetector` 是单模型 Jaccard/BM25 核查，`ValidationPipeline` 是单输入多级语法/实存/逻辑校验——**二者都不做"同一结论喂给 ≥2 模型投票"**。需新建 `CrossValidator`：接收结论 + N 个验证角色 → 经 `Dispatcher` 并发调用 → 聚合投票 → 分歧时按 `ValidationPipeline` 或仲裁角色裁决。
2. **【缺口 B】指挥模型验证执行结果并修正**：设计 3.1 要求指挥层回验。`TaskOrchestrator.synthesizeAnswer` 现仅"汇总"不"回验修正"。需在编排链插入审核回环（复用 `router.evaluate`/`decide` 角色）。
3. **【缺口 C】用户级"任务→模型组合"配置持久化**：设计第 4 节交互流程。现有 assign 是系统策略，缺用户自定义映射的存储/读取。属可选增强，非 MVP。

## 四、设计文档需修正项（规则 10 独立判断，不照搬）

- **模型名单过时**（设计 2.1）：GPT-4/GPT-3.5/Llama 2/PaLM 2 为 2023 世代；`UNIFIED_REGISTRY` 实际含 deepseek/qwen/等现役模型。**判断**：分层用"能力档位"抽象（decision/architecture/evaluation/coding/light），不绑定具体产品名。
- **性能指标无测量协议**（设计 5.1-5.3）：">99.5% 切换成功率""降本 40%"不可直接验收。**判断**：转切片计划时每项须绑定可复现测量法（soak/回放/成本核算），否则不作门禁。
- **交叉验证与降本目标存在张力**（3.3 vs 5.2）：≥2 模型验证天然增本。**判断**：MVP 对"关键结论"（可配置触发条件）才交叉验证，非全量。

## 五、切片化测试计划（草案，TDD 垂直切片）

> 门禁：规则 7 垂直切片 + 规则 6 反馈回路 + 规则 5 留痕。所有 LLM 调用经 fake router 注入（对齐 S-A8 生产接口对齐惯例），零网络确定性。

| 切片 | 范围 | 接缝 | 验收 |
|---|---|---|---|
| **S0** | 计划冻结 + 关键决策确认（见第六节） | — | 用户批准 D1-D4 |
| **S1** | `CrossValidator` 纯聚合逻辑（投票/分歧判定），先不接 LLM | 输入 N 个 verdict → 输出 一致/分歧/裁决 | 单测：全一致/2-1分歧/全分歧/单模型退化 |
| **S2** | `CrossValidator` 接 `Dispatcher.dispatch(role)` **顺序分发**（fake router 注入；excludeModels 须累积前序已用模型以保证"独立模型"去重，故非并发） | deps: {dispatch} | 单测：≥2 角色调用、excludeModels 防重复、错误隔离→abstain |
| **S3** | 分歧裁决接 `ValidationPipeline`（S-A8 复用）或仲裁角色 | deps: {validate 或 dispatch} | 单测：分歧→触发裁决、裁决失败 fail-closed |
| **S4** | `TaskOrchestrator` 审核回环（缺口 B）：执行→指挥回验→修正 | 扩展 execute() 可选 verify 阶段 | 单测：回验通过直出、不通过触发一次修正、二次仍不过降级 |
| **S5** | 端到端 fail-closed 铁律（对齐 S-A8 切片 7）：真实 fake router + 断言交叉验证拦截幻觉结论 | 集成 | 单测：幻觉注入→拦截、正常→放行、协调器异常→fail-closed+告警 |
| **S6** | 关键结论触发策略（缺口 D，平衡 3.3 与降本）：可配置哪些任务需交叉验证 | options | 单测：触发/不触发边界 |
| **S7** | 回归收口：tsc + test:full + 报告 + 留痕 | — | 全绿 |

**不做项**：缺口 C 用户配置持久化（另立）；设计 5.x 全部指标测量（无协议，先建 S1-S7 功能正确性，性能测量另立 soak）；跨平台调度（设计 8 未来扩展）。

## 六、关键决策（2026-09-10 用户批准，全部采纳建议默认值——已冻结）

- **D1 范围**：✅ MVP 只做缺口 A（交叉验证协调器）+ B（审核回环）；C（用户配置持久化）另立计划。
- **D2 交叉验证模型来源**：✅ 复用 `Dispatcher.dispatch(role)` + `executeWithRole`（现役 registry 角色），不新定义验证角色组。
- **D3 分歧裁决策略**：✅ 多数投票（agree/disagree 计票）；平票或全失败交仲裁角色（S3 接 `router.evaluate`/`ValidationPipeline`）。
- **D4 触发条件**：✅ 关键结论触发（S6 可配置策略），非全量交叉验证；默认阈值在 S6 校准。

## 七、复现命令（本文件为文档，无代码）

```bash
# 勘察证据核对（只读）
grep -rn "^export " src/router/model-capability-registry.ts   # ①注册
sed -n '62,108p' src/router/task-orchestrator.ts              # ②中枢-执行
grep -n "class ConformalHallucinationDetector" src/memory/hallucination-detector.ts  # ⑤现状
```
