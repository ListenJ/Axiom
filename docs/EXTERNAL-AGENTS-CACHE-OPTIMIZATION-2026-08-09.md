# 外部 Agent 缓存与上下文优化调研（Hermes / OpenCode / Kimi Code）

> 日期：2026-08-09
> 状态：调研完成，等待实施立项
> 范围：模型输入输出组织、前缀缓存与压缩、工具链调用与上下文可恢复性

## 摘要

本文件整理 Hermes Agent、OpenCode、Kimi Code 在模型调用侧的优化机制，并对 Axiom 本地实现做差距对照。核心结论是：三家都没有把“上下文压缩”当作独立魔法算法，而是围绕 provider 的 prefix cache 建立可维护的 prompt 纪律——稳定前缀放在最前、易变内容放入尾部或当前 user message、压缩中段、保护 head/tail、工具输出可恢复外置、工具面与注册面分离。OpenCode ACP、Hermes 的 session lineage、Kimi 生态的 pi-for-k3 都展示出“显式缓存键 + 命中率观测 + 稳定工具顺序”的真实收益，但性能数据多来自第三方自述，需用我们自己的调用量复测。

与本地 Axiom 对照后，判断是：我们不缺一个“更好的 CLI”，缺的是把这些纪律固化为统一运行时组件。现有 ContextAssembler、TokenBudget、RateDistortion、ReadOptimizer、Blackboard、PiEngine 已覆盖部分底层能力，但没有请求层缓存头、缓存命中率采集、可恢复工具输出、模型可见工具裁剪和双阈值会话健康，因此存在可自研的增量空间。

## 1. 调研范围与方法

- 官方文档与源码仓库：NousResearch/hermes-agent、opencode-ai/opencode、MoonshotAI/kimi-cli、Moonshot/Kimi 开放平台。
- 第三方生态与深挖文档：bgauryy/open-docs、ranxianglei/opencode-acp、WuP1ao0/pi-for-k3、pi-opencode-go-cache。
- 方法：官方文档优先；第三方源码分析只补充实现细节；性能数据标注为第三方自述，不作为已核验事实。

## 2. Hermes Agent

### 2.1 Prompt 分层

事实：Hermes 官方 Prompt Assembly 文档把 system prompt 分成 stable -> context -> volatile 三层。stable 包含 SOUL/MEMORY/USER/skills/environment/platform hints；context 是唯一项目上下文文件（.hermes.md/AGENTS.md/CLAUDE.md/.cursorrules），带安全扫描与截断；volatile 包含 memory snapshot、timestamp、session/model/provider 行。

事实：PR #5146 将 pre_llm_call 插件上下文从 system prompt 移到当前 user message，明确目标是避免每轮变更破坏 prompt cache prefix。这是对 prefix cache 的显式工程约束，不是隐藏实现。

### 2.2 压缩

事实：官方 Context Compression 文档采用双压缩层：Agent Compressor 默认 50% 触发，Gateway Hygiene 85% 触发，作为 safety net。算法分 4 阶段：prune 旧 tool results（>200 字符替换占位符，无 LLM 调用）-> 保护 head(3) + token-budget tail（默认 target 20%）-> 结构摘要（便宜模型，summary 预算 max 12K/20%）-> 重组并对齐 tool_call/tool_result 边界。

事实：官方文档记录了失败模式：silent JSON parse drop、tool ordering 400、anti-thrashing lock（连续两次收益 <10% 后永久停压缩）。

判断：Hermes 是目前三个项目中最接近“缓存纪律即架构”的：稳定层与易变层分离、in-place 软归档、session_search 保留记录，这些都不依赖单一模型，值得作为我们运行时组件的参照。

## 3. OpenCode

### 3.1 官方能力

事实：OpenCode 配置支持 compaction（auto/prune/reserved）、LSP、agents/subagents、permissions、snapshots、MCP、plugins。

### 3.2 Prompt 处理（第三方源码分析）

推测（基于 bgauryy/open-docs 对 session/prompt.ts 的分析）：system prompt 拼接顺序为 provider header -> provider prompt -> environment -> custom instructions -> agent prompt -> user override；常用 prompt 驻留 SystemPrompt 文件，未发现显式 cache_control 管线；内置工具 16 个 + MCP，模型可见工具数量默认不裁剪；compaction 默认 auto，约 95% 触发，prune 默认 false。

事实：OpenCode 将 LSP diagnostics/hover 暴露为独立工具，payload 较小，用语义信息替代全文件读取。

### 3.3 ACP 插件

事实：opencode-acp 是模型主动管理上下文的插件，提供 compress/decompress/status/search_context 工具，采用 T1/T2/T3 三层压缩。

推测（第三方项目自述）：50 次工程 session、30k+ API calls 中 97% 请求 <200K（1M 窗口），p90 150K、p95 180K，缓存命中率约 91%。主张显式保住 prefix、压缩旧中段，可同时提高缓存命中与上下文可控性；传统压缩会强制全量重新命中缓存。

事实：ACP 文档也指出，原地修改现有消息会破坏 LLM 前缀缓存；protectedTools 可硬排除某些工具输出不被压缩。

判断：ACP 是验证性实验，但绑定 OpenCode 插件体系，不是可移植运行时。

## 4. Kimi Code / Moonshot

### 4.1 Context Caching

事实：Moonshot/Kimi 开放平台说明 Context Caching 自动开启，无需单独创建缓存；前缀超过 256 token 可命中；适合固定大 system、知识文档、工具定义，不适合频繁变化上下文或 RAG 型长内容。

### 4.2 Kimi CLI 参数面

事实：Kimi CLI 文档提供 KIMI_MODEL_MAX_CONTEXT_SIZE、KIMI_MODEL_MAX_COMPLETION_TOKENS、KIMI_MODEL_THINKING_KEEP 等环境变量，属于参数暴露面，没有独立架构机制。

### 4.3 第三方生态

推测（pi-for-k3 自述）：K3 prefix-cache optimizer 做 byte-stable prefix、per-turn miss attribution、idle 预热、稳定工具顺序、summary chain，声称比裸 pi 便宜约 43%、比 Kimi Code 便宜约 56%（SWE-bench Verified Mini），未独立复现。

推测（pi-opencode-go-cache 自述）：为 opencode-go 模型打 prompt_cache_key + 24h retention + 3-5 个 cache_control breakpoints；opencode CLI 默认对 openai-completions 模型不发送这些字段。

判断：Kimi 的主要优化杠杆是自动前缀缓存，工程重点在于 prompt 编排纪律与缓存命中观测，而非压缩算法本身。

## 5. 本地 Axiom 现状对照

| 机制 | 本地状态 | 缺口 |
|---|---|---|
| stable/context/volatile 分层 | prompt-pool 有 cacheControlMarker 元数据 | 无请求层真正发送 cache_control / breakpoints |
| 请求层缓存键与保留期 | 未发现 prompt_cache_key / prompt_cache_retention | 缺 provider 适配层 |
| 缓存命中率采集 | prompt-pool 定义 hitRate 字段 | 未发现 usage.cached_input_tokens 采集与上报 |
| 可恢复工具输出 | PiCode 有本地检索，Vault/Blackboard 可外置记忆 | 对话中 tool_result 不落地、不可按需展开 |
| 工具面裁剪/稳定顺序 | MCP 与本地工具全量注册 | 无 per-session 工具裁剪与稳定排序 |
| 双层压缩 | TokenBudget 按调用预算压缩 | 无 50%/85% 会话健康双阈值 |
| tool pair 保护 | RateDistortion/TokenBudget 可 drop/trim | 无 tool_call/tool_result 边界对齐保护 |
| LSP/语义 | CodeGraph 索引存在 | 无实时 LSP diagnostics/hover 接入 |
| session 可搜索 | Vault/Blackboard/KG 跨会话检索存在 | 无 session lineage / session_search |

## 6. 事实 / 推测 / 判断标注

- 事实：官方文档、官方源码行为、公开 PR 描述。
- 推测：第三方源码分析结论、第三方项目自述性能数字，均需按版本与调用量复测。
- 判断：本文中关于“是否值得自研”“优先做哪层”的结论属于工程判断，不是可核验事实。

## 7. 结论

可以做出更好的东西，但方向不是再造一个 CLI。三家共同的工程模式可抽象为四个可复用组件：

1. ContextCacheDiscipline：稳定前缀 -> 上下文 -> 易变尾部，provider 支持时发送缓存头并采集命中率。
2. RecoverableToolOutput：工具结果外置可恢复，避免压缩吞掉信息。
3. AdaptiveCompaction：双阈值 + head/tail 保护 + tool pair 对齐 + 会话健康。
4. ToolSurface：注册面与模型可见面分离，按会话裁剪、稳定排序、批量压缩。

## 8. 来源

- Hermes Prompt Assembly: https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly
- Hermes Context Compression: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/context-compression-and-caching.md
- Hermes PR 5146: https://github.com/NousResearch/hermes-agent/pull/5146
- OpenCode DeepWiki: https://deepwiki.com/opencode-ai/opencode/2-configuration-system
- OpenCode prompt processing: https://github.com/bgauryy/open-docs/blob/main/docs/opencode/04-prompt-processing.md
- OpenCode ACP: https://github.com/ranxianglei/opencode-acp
- Kimi Context Caching 实践: https://platform.kimi.com/blog/posts/enhance-kimi-api-bot-with-context-caching
- Kimi CLI Env Vars: https://moonshotai.github.io/kimi-cli/en/configuration/env-vars.html
- pi-for-k3: https://github.com/WuP1ao0/pi-for-k3
- pi-opencode-go-cache: https://www.npmjs.com/package/pi-opencode-go-cache
- OpenCode prompt cache PR: https://github.com/anomalyco/opencode/pull/22569