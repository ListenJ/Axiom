# P0 提升迭代设计 — 决策链提速 / 记忆闭环 / 幻觉防线接火 — 2026-08-29

> **来源**：docs/knowledge/agent-decision-chain-assessment-2026-08-29.md（P0 三项杠杆），用户已确认方向并批准开工。
> **原则**：接线型改动、行为可降级、每项 TDD、AGENTS 规则全程适用。本轮范围仅 P0 三项；P1/P2 后续迭代。

## A. 决策链提速（前置 3-5 次串行 LLM 调用合并/并行）

**现状证据**：services/chat.ts:73 optimizePrompt（GLM 改写）→ :81 keyword fast path → :91 intent-enhancer（边缘:9001→云 glm-4.7-flash）→ routes/chat.ts:60 selfThink（串行阻塞，engine.ts:129 一次 think LLM）→ 主模型。

**设计**（以通读后真实数据依赖为准，两步走）：
1. **并行化**：optimizePrompt、intent-enhancer、selfThink 三者均以原始用户输入为输入、互不消费彼此输出（执行时核实：若 intent 消费改写后 prompt 则该项保持串行，仅并行真正独立者）→ `Promise.all` 并行 + 各自带独立超时与既有降级路径（失败回退原值，不阻塞主模型）。
2. **边缘合并调用**：边缘 :9001 可用时，改写+意图合并为**一次**结构化调用（返回 `{rewritten, intent, confidence}`），边缘不可用回退现有两次串行调用。主模型调用本身不动。
3. **验收**：行为回归（chat 既有测试全绿）；单元测试证明三调用并发发起（mock 计时/调用序）；合并调用的结构化解析失败回退旧路径。

## B. 跨会话记忆闭环（会话自动归档 + chat 接入 bootstrap 召回）

**现状证据**：writeConversationLog（vault-manager.ts:362-387）仅手工 API POST /memory/sessions/{id}/archive 可达；主 HTTP 聊天 history 全靠客户端传入（routes/chat.ts:150）；AgentBootstrap 仅 cli/launcher/routes/vault 调用。

**设计**：
1. **自动归档**：每次 chat 交换完成（非空响应）后，经既有 writeConversationLog 追加会话日志（含 sessionId/user/assistant 对），**受 MemoryGate 既有去重+限流约束**（20/h、100/day）防刷写；写入失败静默 debug 不影响响应。
2. **召回接线**：chat 首次见到某 sessionId 时调 AgentBootstrap.load()（缓存 per-session），将 SOUL/IDENTITY/USER 与相关记忆注入 system prompt（现 chat.ts 仅硬编码人格 + constitution）；bootstrap 失败降级为现状。
3. **验收**：测试——交换后 vault 会话文件存在（经 writeConversationLog 路径）；二次请求 system prompt 含 bootstrap 内容；MemoryGate 限流仍生效。

## C. 幻觉防线接火（factBase 喂证据 + verify 接线）

**现状证据**：hallucinationDetector 实例化即弃（main.ts:228 `factBase: []`），calibrate 零调用 → pValue 恒 1.0 永不判幻觉；chat 流程已有检索证据（services/chat.ts:118-191 codegraph+knowledge）却未用于校验响应。

**设计**（可观测优先，不阻断响应）：
1. **按请求构建 factBase**：chat 流程把本次检索命中的证据（knowledge 结果 + codegraph 摘要）转为 FactEntry[]，设入 hallucinationDetector.setFactBase（请求级，不污染全局）。
2. **verify 接线两缝**：①chat 响应生成后对响应摘要跑 verify()，verdict 写入响应元数据（`_hallucination: {pValue, verdict}`）+ logger；②DRE cloudConsciousnessStep（engine.ts:715）输出同样过 verify，低置信结果走既有 ruleBased 降级标记。
3. **校准债声明**：真实 calibrate 需要标注对，P0 不做（记录为 P1：积累 (evidence,response,verdict) 序列后再校准）；本迭代交付"防线从橡皮图章变为真实运行的可观测校验"。
4. **验收**：测试——带证据 factBase 下 verify 对无支撑陈述返回可疑 verdict、对证据支撑陈述返回通过；chat 响应含 _hallucination 元数据；factBase 按请求隔离。

## 非目标
- thompson 填 arms / 结构化输出 / 中文 bigram（P1）；校准数据积累与真实 calibrate（P1）；行为阻断式审查（本迭代只观测）。

## 验收清单
- [ ] A：前置调用并行化（或合并）红→绿；chat 既有测试全绿
- [ ] B：自动归档 + bootstrap 召回红→绿；MemoryGate 限流不回退
- [ ] C：factBase 请求级注入 + 两缝 verify 红→绿；响应元数据可观测
- [ ] `bun run test:full` ≥566 全绿；tsc 0；报告回写
