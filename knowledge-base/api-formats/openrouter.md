# OpenRouter — 统一透传 / reasoning 归一化

> 来源：https://openrouter.ai/docs/api_reference/parameters.md 、https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md 、https://openrouter.ai/docs （webfetch 成功，2026-08-01）
> OpenRouter 是 OpenAI Chat Completions 兼容网关，背后代理 400+ 模型（OpenAI / Anthropic / Gemini / DeepSeek 等），负责把统一的思考参数翻译成各供应商原生格式。

## 请求格式

```
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer <OPENROUTER_API_KEY>
HTTP-Referer: <your-site-url>        （可选，榜单归因）
X-OpenRouter-Title: <your-app-name>  （可选）

{
  "model": "~openai/gpt-latest",
  "messages": [{"role": "user", "content": "..."}],
  "reasoning": {"effort": "high"}
}
```

模型名示例：`~openai/gpt-latest`、`~anthropic/claude-sonnet-latest`、`google/gemini-3.1-pro-preview`、`deepseek/deepseek-r1`；后缀 `:thinking` 可强制启用扩展推理（Anthropic 模型除外）。

## 思考 / 推理参数

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `reasoning`（对象，推荐） | `{effort, max_tokens, exclude, enabled}` | 统一推理配置 |
| `reasoning.effort` | `max` / `xhigh` / `high` / `medium` / `low` / `minimal` / `none` | 档位制；`none` = 关闭 |
| `reasoning.max_tokens` | 整数 | token 预算制（Anthropic / Gemini / 部分 Qwen 用），effort 会按预算百分比换算 |
| `reasoning.exclude` | bool | 思考内部使用但不返回 |
| `reasoning_effort`（顶层，兼容） | 同上枚举 | 旧式参数，`include_reasoning` 为其废弃别名 |
| `verbosity` | `low`~`max` | 输出详略度；Anthropic 模型映射到 `output_config.effort` |

**归一化映射（关键）**：
- → Anthropic：`budget_tokens = max(min(max_tokens × ratio, 128000), 1024)`；ratio = 0.95(max/xhigh) / 0.8(high) / 0.5(medium) / 0.2(low) / 0.1(minimal)；默认开启 summarized thinking（`thinking.display: "summarized"`）。
- → Gemini 3：`effort` 直接映射 `thinkingLevel`（minimal/low/medium/high，`xhigh` 映射为 `high`）；`max_tokens` 透传为 `thinkingBudget`（实际 token 由 Google 决定）。
- → OpenAI：`effort` 透传（o 系列 / GPT-5 系列支持）。
- 各模型支持的 effort 档位可查 `GET /api/v1/models` 响应中的 `reasoning` 元数据（`supported_efforts` / `default_effort` / `mandatory`）。

## 响应与思考内容

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "最终答案",
      "reasoning": "思考过程",
      "reasoning_details": [
        {"type": "reasoning.summary", "summary": "...", "format": "anthropic-claude-v1"},
        {"type": "reasoning.text", "text": "...", "signature": null, "format": "anthropic-claude-v1"}
      ]
    }
  }],
  "usage": {"prompt_tokens": 10, "completion_tokens": 100, "total_tokens": 110}
}
```

- 思考字段：`message.reasoning`（字符串）与 `message.reasoning_details`（结构化数组：`reasoning.summary` / `reasoning.encrypted` / `reasoning.text`）。
- 回传历史时 `reasoning_content` 是 `reasoning` 的合法别名；`reasoning_details` 需原样保留（顺序不可改）。
- 注意：部分模型（如 OpenAI o 系列）不返回思考明文，此时无 `reasoning` 字段。

## 流式响应

OpenAI 风格 SSE；思考增量在 `choices[].delta.reasoning`（及 `delta.reasoning_details`），正文在 `delta.content`；`usage` 在末尾 chunk（`stream_options.include_usage`）。

```text
data: {"choices":[{"index":0,"delta":{"reasoning":"思考..."}}]}
data: {"choices":[{"index":0,"delta":{"content":"答案..."}}]}
data: {"choices":[],"usage":{"completion_tokens_details":{"reasoning_tokens":80}}}
data: [DONE]
```

## 总结（一句话）

OpenRouter 用统一 `reasoning` 对象（`effort` 七档 + `max_tokens` + `exclude`）代理各家的思考参数，负责向 Anthropic/Gemini 的原生格式换算，思考内容以 `message.reasoning` / `reasoning_details` 返回——是本项目"多供应商统一适配"的现成参考模型。
