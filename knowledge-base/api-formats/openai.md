# OpenAI — Chat Completions / Responses API

> 来源：https://platform.openai.com/docs/api-reference/chat/create （webfetch 返回 403，本文基于已有知识撰写，2026-08-01 核对）
> 属于 **OpenAI Chat Completions 风格**，是行业事实标准格式。

## 请求格式

```
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer sk-...
Content-Type: application/json

{
  "model": "gpt-5",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "max_completion_tokens": 8192,
  "stream": false
}
```

- 鉴权头：`Authorization: Bearer <api_key>`，不需要额外的版本头。
- 模型名示例：`gpt-5`、`gpt-5-mini`、`o3`、`o4-mini`（o 系列 / GPT-5 系列支持思考）。

## 思考 / 推理参数

| 参数 | 位置 | 取值 | 说明 |
| --- | --- | --- | --- |
| `reasoning_effort` | 请求顶层 | Chat Completions：`minimal` / `low` / `medium` / `high` | 控制思考强度，仅对支持思考的模型生效 |
| `reasoning`（对象） | Responses API | `{effort, max_tokens?, context?, mode?}` | Responses API 下的统一推理配置；`mode: "pro"` 走 pro 变体，`context: "auto"/"all_turns"/"current_turn"` 控制回传思考的利用范围 |

- 注意：`temperature`、`top_p` 等采样参数在思考模型上可能被忽略或限制。
- 思考 token 数计入 `max_completion_tokens` 与计费（`usage.completion_tokens_details.reasoning_tokens`）。

## 流式响应（SSE）

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}
...
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"completion_tokens_details":{"reasoning_tokens":12}}}
data: [DONE]
```

- `usage` 只在最后一个 chunk 返回，需传 `stream_options: {"include_usage": true}`。
- **思考内容**：Chat Completions 端点不返回思考明文；Responses API 返回 `type: "reasoning"` item（`encrypted_content` 加密内容 + `summary`，需 `include: ["reasoning.encrypted_content"]` 才能拿到）。
- 流式 Responses API 有独立 `response.reasoning_summary_text.delta` 事件。

## 总结（一句话）

OpenAI 原生 `reasoning_effort`（`minimal~high`）控制思考强度，但官方不回传思考明文（计费口径是 `usage.completion_tokens_details.reasoning_tokens`），思考内容只在 Responses API 以加密/摘要 item 形式存在——这与 DeepSeek 的 `reasoning_content`、Anthropic 的 thinking 块完全不同，适配时需用 `message.reasoning` 之类字段承接第三方透传内容。
