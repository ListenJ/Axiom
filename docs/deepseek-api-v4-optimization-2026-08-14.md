# DeepSeek V4 API 针对性优化 — 2026-08-14

## 摘要

本文件沉淀 2026-08-14 拉取的 DeepSeek 官方 API 文档要点，并记录 Axiom 项目针对 DeepSeek V4 模型所做的适配：
流式透传 `reasoning_content`（思考链）、移除已弃用的 R1/reasoner 条目、注册表价格与上下文参数更新、思考强度映射说明。
核心结论：DeepSeek 当前正式模型为 `deepseek-v4-flash` 与 `deepseek-v4-pro`（OpenAI 兼容）；旧模型名 `deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 弃用（早于本文档日期，项目必须迁移）；思考模式默认开启且不支持 temperature/top_p/presence_penalty/frequency_penalty（静默忽略）；工具调用场景必须回传 `reasoning_content`，否则 400。

## 来源（官方文档，2026-08-14 抓取）

- 首次调用：https://api-docs.deepseek.com/
- 模型与价格：https://api-docs.deepseek.com/quick_start/pricing/
- 思考模式：https://api-docs.deepseek.com/guides/thinking_mode/
- 工具调用：https://api-docs.deepseek.com/guides/tool_calls/
- 错误码：https://api-docs.deepseek.com/quick_start/error_codes/

## 关键结论（事实 / 推测 / 判断）

### 事实：模型与端点
- OpenAI 格式 base_url：`https://api.deepseek.com`；Anthropic 格式：`https://api.deepseek.com/anthropic`；项目内 `/v1` 后缀与官方 `https://api.deepseek.com` 兼容（历史兼容端点）。
- 正式模型：`deepseek-v4-flash`（DeepSeek-V4-Flash-0731）、`deepseek-v4-pro`（DeepSeek-V4-Pro-0813）。
- `deepseek-chat` / `deepseek-reasoner` 将于 **2026-07-24 弃用**，兼容映射：`deepseek-chat` ↔ `deepseek-v4-flash` 非思考模式，`deepseek-reasoner` ↔ `deepseek-v4-flash` 思考模式。
- 上下文长度 **1M**，最大输出 **384K**。
- 功能：JSON Output ✓、Tool Calls ✓、Responses API ✓、Anthropic API ✓、Chat Prefix Completion (Beta) ✓、FIM Completion (Beta，仅非思考模式)。
- 当前直连价格（每 1M tokens）：flash 输入 $0.14（缓存未命中）/ $0.0028（命中）、输出 $0.28；pro 输入 $0.435 / $0.003625、输出 $0.87。
- **2026-08-16 16:00 UTC 起改为峰谷计费**：flash 谷 $0.22 入 / $0.66 出，峰 $0.44 / $1.32；pro 谷 $0.66 / $1.98，峰 $1.32 / $3.96。高峰时段 01:00-04:00 与 06:00-10:00 UTC。
- 并发限制：flash 2500，pro 500。

### 事实：思考模式参数
- 默认思考开启、默认 effort=high。
- 切换：OpenAI 格式 `extra_body.thinking = {"type":"enabled|disabled"}`；`reasoning_effort` 取值与映射：low→low、medium→high、high→high、xhigh→high、max→max。
- 思考模式**不支持** `temperature`、`top_p`、`presence_penalty`、`frequency_penalty`（设置不报错但无效）。
- 思考链经 `reasoning_content` 返回（与 `content` 同级）；流式时经 `delta.reasoning_content` 返回。
- 多轮：两次 user 消息之间若无工具调用，中间的 assistant `reasoning_content` 无需回传（传了也会被忽略）；若有工具调用，`reasoning_content` 必须随后续请求回传，否则 **400**。

### 事实：工具调用与错误码
- 工具调用走 OpenAI 兼容 `tools` 协议；strict 模式（Beta）需 base_url `https://api.deepseek.com/beta` 且所有 function 设置 `strict: true`。
- 错误码：400 请求体格式、401 鉴权失败、402 余额不足、422 参数无效、429 限流、500 服务端错误、503 过载（建议退避重试）。

### 判断：项目适配决策
- 项目 registry 移除 `deepseek-r1`（旧 R1 已停用），DeepSeek 只保留 V4 两档：`deepseek-v4-flash`（快/便宜，通用）与 `deepseek-v4-pro`（强推理，承接原 R1 的 deep_research/math/evaluation 角色）。
- `buildReasoningParams` 对 DeepSeek 恒定注入 `thinking.type=enabled` + `reasoning_effort`（符合默认思考开启；若需非思考模式，后续可依据模型档位下发 `type=disabled`）。
- `provider-caller` 原生流式把 `delta.reasoning_content` 封装为 `{"_axon":"thinking",...}` 事件透传前端（ThinkingPanel 渲染），缓冲回退路径同样先发 thinking 再发正文——避免 CoT 被丢弃。
- 工具循环（chatStream toolLoop）在追加 assistant 消息时暂未回传 `reasoning_content`；若 DeepSeek 思考模式下启用工具调用，需要补上 assistant `reasoning_content` 字段回传（当前未启用 DeepSeek 思考模式工具调用，属后续待办，风险已记录）。

## 已实施变更
- `src/router/provider-caller.ts`：NativeStreamResult/callProvider 返回 `thinking?: string[]`；流式解析 `delta.reasoning_content` 并输出 `_axon` thinking 事件；非流式读取 `message.reasoning_content`。
- `src/router/model-router.ts`：缓冲回退路径先 yield thinking（`_axon`）再 yield 正文。
- `src/router/models/registry.ts`：删除 `deepseek-r1`；`deepseek-v4-pro` roles 增加 deep_research/math/evaluation；V4 描述更新为直连价格与 384K 最大输出。
- `src/router/reasoning-effort.ts`：注释补充 DeepSeek effort 官方映射。
- 测试：`tests/provider-caller-reasoning.test.ts`（3）、`tests/router/chat-stream-reasoning.test.ts`（1），全绿。

## 后续待办（风险登记）
1. DeepSeek 思考模式 + 工具调用：多轮工具循环需回传 `reasoning_content`（官方 400 约束），当前未启用该组合。
2. 峰谷计费生效（2026-08-16）后，成本统计/路由可考虑错峰调度（属可选优化）。
3. 非思考模式（`thinking.type=disabled`）目前无显式开关，若 flash 用于纯检索/改写可考虑按任务下发。
## 更新（2026-08-14 二轮）：待办 #1/#2 已实施

- **思考模式适配**：
  - `buildReasoningParams(provider, effort, { thinking })` 支持 DeepSeek 非思考模式（`thinking.type=disabled`），默认仍 enabled。
  - `provider-caller` 对非 DeepSeek 供应商发送前剥离 `reasoning_content`（sanitizeMessages），DeepSeek 保留。
  - `ExecuteInput`/`chatStream`/`executeWithRole` 新增 `thinking?: boolean` 透传。
- **工具 + 思考模式（待办 #1 已解决）**：
  - `model-router.chatStream` 原生/缓冲两条工具循环路径，以及 `services/tool-loop.ts`（/chat 非流式），在 assistant 工具消息上回传 `reasoning_content`（拼接 thinking 片段），满足官方 400 约束。
- **峰谷调度（待办 #2 已解决）**：
  - 新增 `src/router/rate-tier.ts`：`isDeepSeekPeak`（01-04 / 06-10 UTC）、`deepSeekRateTier`、`effectivePriorityForRateTier`（高峰 deepseek-v4-pro 优先级 +8）。
  - `model-router.execute` 与 `chatStream` 排序改用 `effectivePriorityForRateTier`：高峰时 flash/免费/其他供应商优先，谷时恢复 pro 优先。
- 新增测试：`tests/router/rate-tier.test.ts`（5）、`tests/provider-caller-thinking.test.ts`（4）、`tests/router/chat-stream-thinking-tools.test.ts`（2）、`tests/tool-loop-reasoning.test.ts`（1）。
- 验证：router/provider 相关 47/47 全绿，后端 tsc 干净。

## 更新（2026-08-14 三轮）：轻任务非思考 + 峰谷成本核算 + env 全供应商模板

- **轻任务默认非思考**：`reasoning-effort.ts` 新增 `defaultThinkingForRole`（general-tool/review/general-chat/english/intent-classifier/memory/embedding → false）；`model-router.execute` 与 `chatStream` 以 `thinking ?? defaultThinkingForRole(role)` 生效（显式传入优先）。
- **峰谷成本核算**：`rate-tier.ts` 新增 `DEEPSEEK_PEAK_PRICING`（V4 峰价）+ `deepSeekInputPrice/OutputPrice/estimateDeepSeekCostUsd`（谷价=峰价一半）；`model-advisor` 的 DeepSeek 表更新为 V4 两档（移除 deepseek-chat/reasoner 旧条目），`estimateCostPerCall` 对 V4 按调用时刻峰谷计价。
- **峰谷调度可配置**：`DEEPSEEK_PEAK_SCHEDULING` env（默认 1；0/false/no 关闭，优先级恒用注册表原值），`rate-tier.isRateTierSchedulingEnabled` 接入 `effectivePriorityForRateTier`。
- **env 全供应商模板**：重写 `.env.example`（128 行）——覆盖 api-key-store 全部供应商（DeepSeek/SiliconFlow/OfoxAI/OpenRouter/智谱/Kimi/MiniMax/NVIDIA NIM/OpenCode/OfoxAI-Anthropic/OfoxAI-Gemini/OpenAI 后备）与国内/海外变体，每个供应商可配 `<前缀>_BASE_URL` 覆盖端点；含峰谷开关、GLM 免费模型、网关/记忆/日志配置说明。
- 新增测试：tests/router/rate-tier-pricing.test.ts（5）、tests/reasoning-default-thinking.test.ts（3）、tests/router/light-role-thinking.test.ts（2）。
- 验证：router/provider 相关 58/58 全绿；后端 tsc exit 0。

## 更新（2026-08-14 四轮）：token-tracker 落库成本 + 峰谷回算 + 前端用量/右栏集成 + 左栏精简

- **后端成本落库**：token_usage 表新增 `cost_usd REAL DEFAULT 0`（CREATE TABLE 更新 + 老库 ALTER 迁移）；`record()` 对 DeepSeek V4 按调用时刻峰谷计价（其余模型 0）；flush 写入 cost_usd；启动时 `backfillCostUsd()` 按历史行 timestamp 峰/谷回算（幂等）。
- **聚合透出**：getOverallStats/getStatsByModel/getStatsByRole/getDailyStats/getRecentUsage 均返回 costUsd；`/api/token-details` 的 perModel/hourlyTrend/overall/recentCalls 透出 costUsd。
- **前端用量面板**：UsageStatsPanel 改走实时 `/api/token-details`（替代空表 /memory/usage），展示总成本 + 每模型成本（DeepSeek 峰谷计价标注），复用 Chat hub 用量页签。
- **右栏集成**：RightToolbar 新增「用量」工具（RightbarTool 增加 'usage'），渲染 UsageStatsPanel。
- **左栏精简**：Sidebar 移除 Git 仓库状态（段2）与 MCP·Skill（段3）——重叠内容并入右栏（GitPanel/SummaryPanel/用量），左栏只保留工作区 + 会话管理（含顶部 Logo/新建对话/账号栏）。
- 新增测试：tests/token-tracker-cost.test.ts（3：峰时计价聚合/非 DeepSeek 0/历史回算幂等）；frontend/src/components/chat-panels-usage.test.tsx（1：成本展示）。
- 验证：前端 49 文件/298 测试全绿 + tsc 干净；后端 router/provider/token-tracker 61/61 全绿 + tsc exit 0；前端 eslint 0 问题。

## 更新（2026-08-14 五轮）：Perf 成本卡片 + 多供应商直连价表 + /memory/usage 改接

- **Perf 页成本卡片**：PerfPanel 新增「近 7 天模型成本」卡片（token-tracker 实时库，含 DeepSeek 峰谷计价标注）；Perf.test 新增断言（mock tokenDetails）。
- **多供应商直连价表**（rate-tier.ts）：
  - 新增 `MODEL_PRICING`（键 provider/model）+ `estimateModelCostUsd`（DeepSeek 峰谷优先，其次直连价，未收录 undefined）。
  - Kimi（官方 platform.kimi.com 定价，¥/1M）：kimi-k2.6 6.5/27、kimi-k2.5 4/21、kimi-k3 20/100。
  - MiniMax（官方 pricing-paygo，¥/1M，M3 五折后标准价）：MiniMax-M3/M2.7/M2.5 2.1/8.4。
  - 智谱免费：glm-4.7-flash / glm-4-flash 0/0。
  - CNY→USD 用估算汇率 `CNY_PER_USD=7.2`（假设，非官方，知识文件已注明）。
  - token-tracker `record()` 与 `backfillCostUsd()` 改用 `estimateModelCostUsd`（历史行按 timestamp 统一回算，幂等）。
- **/memory/usage 改接 token-tracker**：handleModelUsage 不再读死表 model_usage，改走 getTokenTracker().getStatsByModel（返回形状兼容前端，含 cost_usd）。
- 修复：String.replace `$` 特殊模式导致 Perf.tsx 文本损坏（改用函数式替换；Perf.tsx 尾部残留截断）。
- 新增/扩展测试：rate-tier-pricing（+4：Kimi/MiniMax/智谱/未收录）、token-tracker-cost（+1：Kimi 落库）、Perf.test（+1：成本卡片）。
- 验证：前端 49 文件/299 测试全绿 + eslint 0 + tsc 干净；后端 66/66 全绿 + tsc exit 0。
