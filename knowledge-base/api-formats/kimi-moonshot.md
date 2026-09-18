# Kimi (Moonshot) — Chat Completions

> 来源：https://platform.moonshot.cn/docs/api/chat （webfetch 成功，2026-08-01）
> 严格 OpenAI Chat Completions 兼容格式，`Authorization: Bearer <MOONSHOT_API_KEY>`。

## 请求格式

```
POST https://api.moonshot.cn/v1/chat/completions
Authorization: Bearer <MOONSHOT_API_KEY>

{
  "model": "kimi-k2.6",
  "messages": [{"role": "user", "content": "..."}]
}
```

模型名示例：`kimi-k3`（始终思考）、`kimi-k2.7-code`（思考不可关）、`kimi-k2.6`、`kimi-k2.5`、`moonshot-v1-128k`（旧版无思考）。

## 思考 / 推理参数（按模型分）

| 模型 | 参数 | 取值 | 说明 |
| --- | --- | --- | --- |
| kimi-k3 | 顶层 `reasoning_effort` | `low` / `high` / `max`（**默认 `max`**） | 始终思考，无需开关；始终启用 Preserved Thinking |
| kimi-k2.6 / k2.5 | 顶层 `thinking` | `{type: "enabled"}` / `{type: "disabled"}`（默认 enabled） | 思考开关 |
| kimi-k2.6 | `thinking.keep` | `null`（默认，不保留历史思考）/ `"all"` | Preserved Thinking：保留历史轮次的 `reasoning_content` |
| kimi-k2.7-code | `thinking` | `{type: "enabled", keep: "all"}` | 固定开启 + 固定保留，传 `disabled` 报错 |
| moonshot-v1-* | — | — | 不支持思考 |

- OpenAI 兼容端点下字段名即以上顶层字段（无 `reasoning_effort` 之外的包装）。
- `thinking.type` 语义与 DeepSeek 相同（enabled/disabled），`keep` 是本家扩展。

## 响应与思考内容

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "最终答案",
      "reasoning_content": "推理过程（仅思考模式启用时返回）"
    }
  }],
  "usage": {"prompt_tokens": 19, "completion_tokens": 21, "total_tokens": 40, "cached_tokens": 10}
}
```

- **思考内容字段：`message.reasoning_content`**（与 DeepSeek 同名）。
- **多轮必读**：思考模式下，每轮 assistant 消息的 `reasoning_content` 必须原样保留在 `messages` 里回传，否则模型可能丢失推理上下文。

## 流式响应

OpenAI 风格 SSE，`delta.content` 增量；`usage` 需 `stream_options: {"include_usage": true}` 时在最后一个 chunk（`data: [DONE]` 之前）返回，且含 `cached_tokens`。

```text
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}
data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}
...
data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":19,"completion_tokens":13,"total_tokens":32,"cached_tokens":12}}
data: [DONE]
```

- 思考流式增量：官方文档流式示例未展开展示，但响应 schema 中 `reasoning_content` 与 `content` 同级，建议实现时兼容 `delta.reasoning_content`。

## 总结（一句话）

Kimi 分两套语义：K2.x 用 `thinking.type`（enabled/disabled，可加 `keep:"all"` 保留历史思考）控制思考，K3 用 `reasoning_effort`（low/high/max，默认 max）调节强度；思考内容统一经 `reasoning_content` 返回，多轮必须回传。
