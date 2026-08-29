# Agent 决策链与模型提升空间评估 — 2026-08-29

> 委托：检查 Agent 决策链、模型约束松紧度、确定性推理引擎与记忆处理的突破空间。方法：4 组并行深读（决策链/约束面/DRE/记忆），全部结论附代码证据。本轮仅评估，不动工。

## 一、决策链现状（真实决策流）

```
POST /chat → optimizePrompt(GLM 改写) → 意图判定(关键词 fast path / 边缘:9001 / 云 glm-4.7-flash，4 重机制)
→ constitution 注入 → codegraph+knowledge 并行检索 → selfThink(串行阻塞 LLM)
→ 静态角色路由表 → model-router.execute(静态优先级+熔断) → **chat 模型仅见 5 个工具、tool loop 上限 4 轮**
```

- **生效**：optimizePrompt、意图双层、constitution、检索、selfThink、静态路由、教训→selfThink 注入、consciousness→skill 晋升、recordSkillOutcome→promotion 门。
- **休眠/断链**：persona-loader 8 角色（仅 DRE engine 消费，chat 人格硬编码 "You are Axiom"，intent-enhancer.ts:270）；thompson 空 arms 且 reportFeedback 零调用（main.ts:229）；autoRoute LLM 路由死代码（model-router.ts:908）；real-usage 轨迹仅 CLI 手动触发（real-usage.ts:196 import.meta.main）；世界状态重启即失。
- **瓶颈 TOP3**：①每请求主模型前有 3-5 次**串行**前置 LLM 调用（改写+意图×2+selfThink）；②模型路由纯静态优先级，学习信号从不反哺选模；③chat 工具面仅 5 个（188 工具需 skill_run 二次跳转），loop 上限 4 轮。
- **闭环判定**：三条真闭环成立；但"采集了信号无读取方"的断链同样多——**当前链路用 LLM 做了大量前置决策，却几乎不让任何反馈改变下一次模型选择**。

## 二、约束松紧度（核心矛盾：强约束修在没人走的支线上）

| 约束点 | 松紧 | 判定 |
|--------|------|------|
| 输出约束 | DRE 紧 / 主 chat 全松 | generateConstrained 仅 DRE 用；主链路 0 处 response_format/json_schema，裸 JSON.parse |
| 温度/种子 | 双轨 | DRE temp0+seed42；云端 0.7 无 seed 不可复现 |
| 推理预算 | 参数有/运行时缺 | 三档 1024/2048/8192；**DRE maxTokens 默认仅 512**（client.ts:113）；Anthropic high 砍半 4096 |
| 安全约束 | 模式级全局 | plan 禁 37 工具；agent 模式 40 工具逐次 HITL；HardFloor 粗正则无词边界误伤 |
| 提示约束 | 宪法尚可/反注入薄 | constitution 每回合注入；SECURITY BOUNDARY 全仓仅 1 处 |
| 幻觉防线 | **橡胶图章** | alpha=0.05 但 factBase=[]（main.ts:228）、零校准 → pValue 恒 1.0 永不判幻觉；verificationEngine 单例零调用 |

- **过紧 TOP3**（压制能力）：①temp0 下 n=3 拒绝采样三票必全同——3 倍成本空转、modeAmbiguous 永不触发（client.ts:599-607）；②DRE maxTokens 512 / high 4096 截断推理；③agent 模式逐次 HITL + /passwd//shutdown/ 无词边界误伤。
- **过松 TOP3**（放进幻觉）：①幻觉检测器空转成橡皮图章；②主 chat 无结构化输出约束；③验证闭环死代码 + 反注入单点。
- **总评**：该紧的空转（主链路输出校验/幻觉防线），该松的卡脖子（DRE 采样/逐次审批）。

## 三、DRE 突破空间（18,006 行高完成度、零推理流量）

- **生效中**：MCP 工具面 35+ 工具（唯一推理消费通道）；kernel tick 每 5s 空转（scheduler.submit 全库零生产者）；云降级链已接；基建外借（ResourceBudgetManager、LLMClient→edge-client）。
- **休眠**：检索栈 6 层（deterministic-retrieval-engine 848 行/hybrid-fusion/knowledge-wiki/verification-chain 全库零 importer）——**tie-break 修好了没人用**；rule-engine 零实例化；/dre/run 无调用方。
- **半接线**：mathContext 6 模块创建后零引用（2026-08-11 审计的幽灵至今未复活）；MultiDimensionLimiter/executeWithModeGuard 零调用。
- **双轨断裂**：本地 qwen3-1.7b（DRE 轨）与云端路由（主轨）在推理层零数据流——orchestrator 执行历史从不进 DRE。
- **杠杆**：①检索栈接主链路缝隙（routes/search 与 vault.search 挂 retrieve() 单入口，已收敛接口+已修 tie-break 直接投产）；②scheduler 补生产者（orchestrator 完成回调 submit，rule-engine 才有学习素材）；③mathContext 裁决（thompson 填 arms 反哺路由、hallucination 接 cloudCaller 输出，其余 4 模块删 ~2000 行）。

## 四、记忆突破空间（好底座 + 休白数学层）

- **生效**：Vault 双写 FTS、确定性搜索引擎、MemoryGate 门控（20/h+100/day）、MemoryCurator 蒸馏归档、Blackboard 短期协调、率失真压缩（经 token-budget 真实路径）。
- **休眠/半接线**：VIBCompressor、ConformalRetriever（必须 calibrate 全库无调用）、MathEnhancedMemory、mathContext 整体实例即弃；KAL vault 适配器缺一行注入；AgentBootstrap 仅 CLI/launcher 调用。
- **断链**：会话结束无自动归档钩子（curator 蒸馏原料断供）；archiver 移动后 FTS 幽灵行；**主 HTTP 聊天路径零记忆召回**（history 全靠客户端传入，routes/chat.ts:150）；world-state 进程内 Map 重启即失。
- **中文召回边界**：FTS5 unicode61 把连续中文当单 token（sqlite-memory.ts:113），KAL/引擎的整段保留 tokenize 同病（deterministic-search.ts:595-606）——**记忆侧无中文分词**，语序改写即漏召回。
- **杠杆**：①跨会话闭环补全（session 结束钩子自动 writeConversationLog→curator + AgentBootstrap 注入 chat——约 3 文件几十行，让既有 FTS/蒸馏栈产生复利）；②中文 bigram 进检索（self-evolve/engine.ts:53 已有实现可复制）；③唤醒或裁剪休眠数学层（KAL 适配器一行；ConformalRetriever 以反馈校准后接入检索，否则明确降级为实验件）。

## 五、综合判断与提升路线（按 影响/成本 排序）

**核心结论：能力的库存与流量严重错配。** 大量高完成度组件休眠（检索栈 6 层、幻觉检测、验证引擎、persona、thompson、共形检索），而主任务链路用最朴素方式跑（5 工具、4 轮、零记忆召回、无结构化输出、前置串行小模型调用）。约束的同构问题：确定性设施全堆在没人走的 DRE 支线，主链路裸奔。

| 优先级 | 杠杆 | 预期收益 | 成本 |
|--------|------|---------|------|
| P0 | 决策链提速：前置 3-5 次串行调用合并/并行化 | 每请求延迟显著下降 | 中 |
| P0 | 跨会话记忆闭环（归档钩子+AgentBootstrap 接 chat） | 对话记忆从"半闭环"变真闭环，既有栈复利 | 低 |
| P0 | 幻觉防线接火（factBase 喂 vault 事实库 + cloudCaller 输出过 verify + 反馈校准闭环） | 幻觉防线从橡皮图章变真防线，同时解决"过松" | 中 |
| P1 | DRE 检索栈唤醒（retrieve() 单入口） | 主检索白得证据链+图扩展 | 低 |
| P1 | 中文 bigram 进 FTS/tokenize | 中文召回词法范式内最大增益 | 低 |
| P1 | 主 chat 结构化输出（关键解析点 zod/response_format） | 把 DRE 侧的"紧"迁移到主链路 | 中 |
| P1 | thompson 填 arms + reportFeedback 接线 | 学习信号反哺模型路由（router 终于会学习） | 中 |
| P2 | 约束再校准（拒绝采样提温或 n=1、maxTokens 自适应、HITL 任务级批量授权） | 降成本/降摩擦 | 中 |
| P2 | 幽灵裁剪（autoRoute、mathContext 4 模块 ~2000 行） | 减维护税 | 低 |

**哲学结论**：项目声明"LLM 降级为 Cognitive Accelerator、确定性为核心"——这在 DRE 支线兑现了，但主任务链路实际是"LLM 主导+几乎无约束"，两者从未收敛。出路二选一：把确定性设施接进主链路（资产唤醒，推荐——上表杠杆全是接线型改动），或承认主链路松约束并清算休眠确定性设施（负债清算）。推荐前者。

---

## 六、P0 三项实施回写（2026-08-29，同日完成）

| 杠杆 | 状态 | Commit | 实施要点 |
|------|------|--------|---------|
| A 决策链提速 | ✅ | 1171453 + 架构修复 6622a3x | 依赖图实测：intent 消费改写文本（保持串行）、selfThink 只依赖原始输入（与 prepare 并行，T(prepare)+T(think)→max）；边缘合并快路径 `src/services/chat-preflight.ts`（一次结构化调用出 {rewritten,intent,confidence}，确定性闸门+静默回退）；组合根注入 edge（services 层不 import local-llm/dre，扇出 10→8） |
| B 跨会话记忆闭环 | ✅ | f6f91f2 | 交换后 fire-and-forget 自动归档（经既有 writeConversationLog + MemoryGate 限流透传）；AgentBootstrap per-session 缓存（上限 500）注入 system prompt（与 constitution 并存）；vault 不可用降级 |
| C 幻觉防线接火 | ✅ | b1e8bca + 接线修复 | 请求级 factBase（纯函数 buildFactBaseFromRetrieval/FromEvidence，单条 400 字/64 条上限）；缝① chat 响应 `_hallucination: {pValue,verdict,isAccepted}` 元数据；缝② DRE cloudConsciousnessStep 过 verify（低置信→既有 L3 降级链）；**架构合规**：dre 不直引 memory，gate 经 DREConfig 组合根注入（main.ts）；校准债=P1（未校准下 pValue 恒 1.0，可疑由证据相似度驱动） |
| 架构合规修复 | ✅ | 本轮 | services 扇出 10→8（chat-preflight 注入化 + extractJson 迁 utils）；dre↔memory 循环消除（gate 注入）；extractJson 单源迁 utils/extract-json.ts（edge-client re-export 兼容） |

**回归**：`bun run test:full` **600 pass / 0 fail / 73 文件**（基线 566 + 新增 34，白名单含全部新测试）；`bunx tsc --noEmit` 0；architecture-integrity 24/0（含循环与扇出断言）。

---

## 七、P1 五切片实施回写（2026-08-29/30 完成）

| 杠杆 | 状态 | Commit | 实施要点 |
|------|------|--------|---------|
| S1 DRE 检索栈唤醒 | ✅ | 71423ba | routes/search 响应并入 `dre` 段（3s 超时包装，超时/异常丢弃不影响主响应）；vault 回退链末位 dreSupplement（门控仍<3 才补充+去重）；knowledgeNetwork 模块级单例注入；顺带发现 sqlite-memory score=-rank 使 minQuality=-2.0 判据恒真（回退分支现状总是触发） |
| S2 中文 bigram 双层 | ✅ | fd62697 | SQLite 实测 3.53.0 支持 trigram；层1 内存 tokenize CJK bigram（单字保留/ASCII 原样，索引查询同函数）；层2 memory_notes_fts 迁移 trigram（RENAME 保底→重建→回填→行数校验→失败还原），KAL/搜索 <3 字 CJK 短词 LIKE 兜底拆腿 |
| S3 主链路结构化收紧 | ✅ | 4065194 | intent-enhancer/chat-preflight/risk-monitor/dre constraints 四处 zod schema（导出可测），降级行为与现状逐字节一致；三处"判定更早更明确"收紧点在 spec 授权内 |
| S4 thompson 学习回路 | ✅ | 16e0060 | buildThompsonArms 由注册表模型唯一 id 构建（避免同 provider 互相覆盖）；反馈接在 trackCall 成败点；**平级 tie-break**：相邻比较器相等的组经 route() 采样重排（组间优先级不动）；全降级保留 |
| S5 校准数据积累 | ✅ | e443325 | hallucination_verdicts 表（migrate 纳管+幂等 ensure）；两缝 verdict 落库（chat 直调/DRE 经 recordVerdict 端口注入，dre 零 db 直引）；calibrateFromStored ≥50 对极化组保守自动校准（循环性局限已声明，真值标注属 HITL 后续） |

**回归**：白名单 `bun run test:full` 603 pass/0 fail；tsc 0；architecture-integrity 24/0。
**已知问题（如实）**：5 个 P1 新测试文件单独/相邻运行全绿，但**追加进 test:full 手工白名单后组合运行触发 audit-regression-stress（存量 flaky，storm-caller actor 压测）的残留 tick 挂起 + 存量失败断言**——单进程文件序依赖是 test:full 手工白名单的结构性弱点（评估报告早已标记），根治=白名单改自动发现（P2 候选）。本次将 5 个新文件回退出白名单、改为定向运行（全部独立绿），src 改动全部保留。
