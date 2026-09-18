# Hermes / OpenCode / Kimi Code 优化机制评估与自研可行性

> 状态：评估完成，等待立项确认
> 关联：docs/EXTERNAL-AGENTS-CACHE-OPTIMIZATION-2026-08-09.md
> 日期：2026-08-09

## 1. 结论先行

可以做更好的东西，但“更好”不是用又一个 CLI 替代三个 CLI，而是把三家的工程纪律抽象为 Axiom 自己的运行时组件。

依据：
1. 三家的优化与具体模型/Provider 绑定，各自维护 prompt/compaction/session 实现，继续封装外部 CLI 只会继承其限制，无法组合。
2. 本地已经具备 ContextAssembler、TokenBudget、RateDistortionCompressor、ReadOptimizer、Blackboard、PiCodeEngine、CodeGraph，覆盖底层能力的一半；缺的是请求层缓存协议、可恢复工具输出、工具面裁剪和会话健康。
3. 当前 opencode-tool-agent / hermes-agent / kimi-code-agent 仍有 spawn/直连路径，与原生 Agent + Pi 收敛方向冲突，是维护成本与故障面。

## 2. 三家机制解构

| 项目 | Prompt 组织 | 缓存策略 | 压缩策略 | 工具链 |
|---|---|---|---|---|
| Hermes | stable/context/volatile 三层 | pre_llm_call 不破坏 system prefix | 50% + 85% 双阈值，4 阶段，head/tail 保护，tool pair 对齐 | tool registration/exposure 分离，session 基础设施 |
| OpenCode | provider header -> ... -> user override | 默认无显式 cache_control（第三方分析） | auto compaction ~95%，prune false | 16 tools + MCP 全量暴露；LSP 小 payload；ACP 模型主动压缩 |
| Kimi Code | 官方未强调分层，生态强调静态在前 | 自动前缀缓存，256 token 起 | CLI 参数暴露面；pi-for-k3 做 byte-stable prefix + 预热 | 官方 CLI/MCP 配置；第三方缓存键插件 |

详见知识文档。

## 3. 本地资产盘点

- ContextAssembler: src/components/context-assembler.ts
- TokenBudget: src/components/token-budget.ts
- RateDistortionCompressor: src/context/rate-distortion-compressor.ts
- ReadOptimizer: src/utils/read-optimizer.ts
- Blackboard: src/memory/blackboard.ts
- PiCodeEngine: src/pi-agent/pi-code-engine.ts
- CodeGraph: src/memory/codegraph-index.ts
- 外部适配器: src/agents/opencode-tool-agent.ts、hermes-agent.ts、kimi-code-agent.ts

## 4. 差距矩阵

| 能力 | Hermes | OpenCode | Kimi 生态 | Axiom 现状 | 优先级 |
|---|---|---|---|---|---|
| 缓存分层稳定前缀 | Y | 部分 | 生态插件 | 仅元数据 | P0 |
| 请求层缓存头/键 | Y | 默认缺 | 生态插件 | 缺 | P0 |
| 缓存命中率观测 | Y | 部分 | 生态插件 | 缺 | P0 |
| 可恢复工具输出 | Y | ACP 部分 | pi-lcm 生态 | 缺 | P0 |
| 工具面裁剪/稳定顺序 | Y | 缺 | 生态插件 | 缺 | P1 |
| 双阈值会话健康 | Y | auto compaction | 生态 | 缺 | P1 |
| tool pair 对齐 | Y | 部分 | 生态 | 缺 | P1 |
| LSP/语义读取 | 部分 | Y | 有 read 预算 | CodeGraph 无 LSP | P2 |

## 5. 推荐设计

不在现有外部 CLI 封装上继续堆功能。新增一个运行时层：

1. ContextCacheDiscipline
   - 稳定前缀：系统身份/技能/环境/工具定义（字节稳定）
   - 中间层：项目上下文、长期记忆
   - 尾部：会话/时间戳等易变信息放入 user message 或最后
   - Provider 适配：Anthropic cache_control、OpenAI/OpenCodeGo prompt_cache_key/retention、Kimi 自动缓存
   - 采集：cached_input_tokens / cache_read_input_tokens，命中率按会话上报

2. RecoverableToolOutput
   - 大工具结果写 Vault/SQLite/Blackboard，消息中保留占位符 + tool_id
   - 提供 read_tool_result / expand_tool_result 工具
   - 压缩旧 tool_result 时先外置，不静默丢弃

3. AdaptiveCompaction
   - Agent 层 50% 阈值 + Gateway 层 85% safety net
   - 保护 head(3) + tail 预算；中段摘要；tool_call/tool_result 作为原子单元
   - in-place soft archive，保留 session lineage，可 search

4. ToolSurface
   - ToolRegistry 注册面与模型可见面分离
   - 每会话按任务裁剪工具，稳定顺序
   - 对可并行/可批处理工具做合并，减少 round-trip

接入点：
- ContextAssembler 增加 CacheDiscipline 与 hit report
- internal-agent 增加 RecoverableToolOutput 与 AdaptiveCompaction
- model-router 增加 provider cache adapter
- MCP tool-registry 增加 ToolSurface 筛选
- frontend Settings/Agents 增加缓存命中率展示（实施阶段再定）

## 6. 差异化亮点

- 统一缓存诊断：每个会话可看到缓存命中率、节约 token、断链原因。
- 可恢复上下文：压缩不丢信息，模型可按需展开。
- 工具面裁剪 + 稳定顺序：同时降低 token 与缓存抖动。
- 双阈值健康：避免单点压缩触发，也避免过晚触发。
- LSP + CodeGraph 混合语义读取：替代全文件灌入。

## 7. 风险与验证

- Provider 缓存语义差异大：先支持 1-2 个 provider，加集成测试。
- 字节稳定性会被 timestamp/session id 破坏：所有易变字段必须移出稳定前缀。
- 压缩即改前缀，会失配缓存：压缩应批量执行，不在每轮破坏。
- 第三方性能数字不可直接引用：需要建立 benchmark harness，以真实任务统计命中率/延迟/token。
- 不引入新的 console.log / process.env 直读；遵循现有架构约束。

## 8. 下一步

待确认后立项：
1. 写正式 spec（ContextCacheDiscipline + RecoverableToolOutput + AdaptiveCompaction + ToolSurface）。
2. 按垂直切片实施：缓存观测 -> 工具外置 -> 工具面 -> 双阈值。
3. 补测试与压测。