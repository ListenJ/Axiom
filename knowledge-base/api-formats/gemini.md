# Gemini — generateContent（Gemini API）

> 来源：https://ai.google.dev/api/generate-content 与 thinking-mode 文档（webfetch 多次 transport error，本文基于已有知识撰写，2026-08-01 核对；Gemini 3 的 thinkingLevel 细节参考了 OpenRouter 官方文档的映射说明）
> 属于 **Gemini generateContent 风格**：`contents[{role,parts}]`，无 `messages` 数组；思考用 `generationConfig.thinkingConfig`。

## 请求格式

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
x-goog-api-key: <API_KEY>        （也可用 ?key=<API_KEY> 查询参数）
Content-Type: application/json

{
  "system_instruction": {"parts": [{"text": "..."}]},
  "contents": [
    {"role": "user", "parts": [{"text": "..."}]}
  ],
  "generationConfig": {
    "temperature": 0.7,
    "thinkingConfig": {"thinkingBudget": 1024}
  }
}
```

- 鉴权：`x-goog-api-key` 头（无 Bearer 前缀），或 URL `?key=`。
- 模型名示例：`gemini-3-pro`、`gemini-3-flash`、`gemini-2.5-flash`、`gemini-2.5-pro`。
- OpenAI 兼容端点：`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`（支持 `reasoning_effort`，具体枚举以官方文档为准）。

## 思考 / 推理参数

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `generationConfig.thinkingConfig.thinkingBudget` | 整数 ≥ 0 | Gemini 2.5：思考 token 预算上限；`0` = 关闭思考；省略 = 默认开启 |
| `generationConfig.thinkingConfig.thinkingLevel` | `minimal` / `low` / `medium` / `high` | Gemini 3：档位制；OpenRouter 映射 `reasoning.effort` 时 `xhigh` 会映射到 `high` |
| `generationConfig.thinkingConfig.includeThoughts` | bool | 是否把思考内容包含在响应 parts 中（部分模型默认省略） |

## 响应格式

```json
{
  "candidates": [{
    "content": {
      "role": "model",
      "parts": [
        {"text": "思考过程...", "thought": true},
        {"text": "最终答案"}
      ]
    },
    "finishReason": "STOP"
  }],
  "usageMetadata": {
    "promptTokenCount": 10,
    "candidatesTokenCount": 100,
    "thoughtsTokenCount": 80,
    "totalTokenCount": 110
  }
}
```

- 思考内容是与文本同级的 `parts` 元素，`thought: true` 标记；`usageMetadata.thoughtsTokenCount` 单独统计思考 token。
- 多轮对话中**不要**把 thinking parts 回传给 API。

## 流式响应

- 端点：`POST /v1beta/models/{model}:streamGenerateContent?alt=sse`（或 `alt=json` 多行 JSON 流）。
- SSE `data:` 行内每个 chunk 都是一个完整 `GenerateContentResponse`（含 `candidates[0].content.parts`、`usageMetadata`），与 OpenAI 的 `delta` 增量结构不同——思考 part 与文本 part 会分布在不同的 chunk 中。

## 总结（一句话）

Gemini 2.5 用 `thinkingConfig.thinkingBudget`（预算制，0 关闭），Gemini 3 改用 `thinkingConfig.thinkingLevel`（minimal~high 档位制）；思考内容以 `thought:true` 的 part 返回，用量在 `usageMetadata.thoughtsTokenCount`，另有 `v1beta/openai/` 的 OpenAI 兼容端点承接 `reasoning_effort`。
