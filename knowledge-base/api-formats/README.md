# API 调用格式与思考强度参数速查

> 本目录为"思考强度（reasoning effort）"等参数在不同 LLM 供应商之间的映射提供文档依据，供本项目 API 适配层参考。
> 文档日期：2026-08-01。各文档标注了来源 URL 与抓取状态（webfetch 失败者基于已有知识撰写，请注意核对）。

## 总览表

| 供应商 | 支持思考参数 | 参数名（原生格式） | 取值 | 思考内容字段 | 详细文档 |
| --- | --- | --- | --- | --- | --- |
| OpenAI | ✅（o / GPT-5 系列） | 顶层 `reasoning_effort`（Chat Completions）；Responses API 用 `reasoning` 对象 | Chat Completions：`minimal`/`low`/`medium`/`high` | 官方不回传明文思考；`usage.completion_tokens_details.reasoning_tokens` 计费 | [openai.md](openai.md) |
| Anthropic | ✅ | `thinking`（Messages API）；新版模型用 `thinking.effort` | `{type:"enabled", budget_tokens:1024~128000}`；adaptive 模型 `effort: low/medium/high/xhigh` | `content` 块中 `type:"thinking"`（加密时为 `redacted_thinking`） | [anthropic.md](anthropic.md) |
| Gemini | ✅ | `generationConfig.thinkingConfig` | Gemini 2.5：`thinkingBudget`（int，0=关闭）；Gemini 3：`thinkingLevel`（minimal/low/medium/high） | `parts` 中 `thought:true` 的 part；`usageMetadata.thoughtsTokenCount` | [gemini.md](gemini.md) |
| DeepSeek | ✅ | 顶层 `thinking` + `reasoning_effort` | `thinking.type: enabled/disabled`；`reasoning_effort: low/high/max` | `message.reasoning_content`（与 `content` 同级） | [deepseek.md](deepseek.md) |
| OpenRouter | ✅ 统一/透传 | `reasoning` 对象（兼容顶层 `reasoning_effort`） | `effort: max/xhigh/high/medium/low/minimal/none`；或 `max_tokens` | `message.reasoning` / `message.reasoning_details`（流式在 `delta` 中） | [openrouter.md](openrouter.md) |
| Kimi (Moonshot) | ✅ | `thinking`（K2.x）；`reasoning_effort`（K3） | `thinking.type: enabled/disabled`（+`keep: all`）；K3：`low/high/max` | `message.reasoning_content` | [kimi-moonshot.md](kimi-moonshot.md) |
| MiniMax | ✅（M3；M2.x 思考不可关） | 顶层 `thinking` | `{type: "adaptive"|"disabled"}`；`reasoning_split` 控制输出形态 | `reasoning_content` / `reasoning_details`；默认内嵌 `<think>` 标签 | [minimax.md](minimax.md) |
| SiliconFlow | ✅（按模型） | `enable_thinking` + `thinking_budget`；V4-Flash 另有 `reasoning_effort` | bool；`thinking_budget: 128~32768`；`reasoning_effort: high/max` | `message.reasoning_content`；`usage.completion_tokens_details.reasoning_tokens` | [siliconflow.md](siliconflow.md) |

## 三种请求风格

| 风格 | 代表 | 请求要点 |
| --- | --- | --- |
| OpenAI Chat Completions | OpenAI、DeepSeek、Kimi、MiniMax、SiliconFlow、OpenRouter | `POST /chat/completions`，`messages[]`，思考参数为顶层字段 |
| Anthropic Messages | Anthropic、MiniMax（Anthropic 兼容端点）、DeepSeek（`/anthropic` 端点） | `POST /v1/messages`，`system` 独立于 `messages`，`max_tokens` 必填，思考用 `thinking` 对象 |
| Gemini generateContent | Gemini（及 `v1beta/openai/` 兼容端点） | `POST /models/{model}:generateContent`，`contents[{role,parts}]`，思考用 `generationConfig.thinkingConfig` |

## 适配要点（供代码层参考）

1. **开关类**：OpenAI/DeepSeek/Kimi/MiniMax 均为顶层布尔式开关（`thinking` / `enable_thinking`），Anthropic 需 `budget_tokens`（最低 1024），Gemini 2.5 用 `thinkingBudget: 0` 关闭。
2. **强度类**：业界事实标准是 `reasoning_effort` 枚举 `low/medium/high`（各家扩展 `minimal`/`xhigh`/`max`）；OpenRouter 统一为 `reasoning.effort` 并负责向各家转换（如 Anthropic 换算 `budget_tokens`、Gemini 3 映射 `thinkingLevel`）。
3. **思考内容回传字段名**：DeepSeek/Kimi/SiliconFlow 用 `reasoning_content`；OpenRouter 用 `reasoning`（`reasoning_content` 是合法别名）；Anthropic/Gemini 用结构化块（thinking 块 / thought part）。
4. **流式**：除 Gemini 外均为 OpenAI 风格 SSE；思考文本在 `delta.reasoning_content` / `delta.reasoning_details`；`usage` 一般在最后一个 chunk（Kimi/MiniMax/SiliconFlow 需 `stream_options.include_usage`）。
5. **多轮工具调用**：DeepSeek、Anthropic、MiniMax 要求把上一轮的思考内容原样回传，否则报错（400）或推理断裂。
