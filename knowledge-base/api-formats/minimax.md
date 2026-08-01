# MiniMax — OpenAI 兼容 / Anthropic 兼容

> 来源：https://platform.minimaxi.com/docs/guides/text-generation 、https://platform.minimaxi.com/docs/api-reference/text-openai-api （webfetch 成功，2026-08-01）
> MiniMax 同时提供 OpenAI 与 Anthropic 两套兼容端点，官方推荐 Anthropic 端点（支持 thinking 块与 Interleaved Thinking）。

## 请求格式

| 格式 | base_url | 端点 |
| --- | --- | --- |
| Anthropic 兼容（推荐） | `https://api.minimaxi.com/anthropic` | `POST /v1/messages` |
| OpenAI 兼容 | `https://api.minimaxi.com/v1` | `POST /chat/completions` |

鉴权均为 `Authorization: Bearer <MINIMAX_API_KEY>`。模型名示例：`MiniMax-M3`（1M 上下文）、`MiniMax-M2.7`、`MiniMax-M2.7-highspeed`、`MiniMax-M2.5`、`MiniMax-M2`、`M2-her`。

```json
POST https://api.minimaxi.com/v1/chat/completions
{
  "model": "MiniMax-M3",
  "messages": [{"role": "user", "content": "..."}],
  "thinking": {"type": "adaptive"}
}
```

## 思考 / 推理参数（OpenAI 兼容端）

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `thinking` | `{type: "adaptive"}` / `{type: "disabled"}` | M3 的思考开关；**省略默认开启**；`adaptive` = 开启。M2.x 思考**无法关闭**（传 disabled 无效） |
| `reasoning_split` | bool | 思考内容输出形态开关（见下）；不影响思考是否开启 |
| `stream_options.include_usage` | bool | 流式返回 token 用量 |

- 思考模式不支持用户调节强度档位（无 `reasoning_effort`）；预算由服务端自适应。
- Anthropic 兼容端：`thinking` 块 + Interleaved Thinking（思考穿插在工具调用轮次之间），是官方推荐的完整能力路径。

## 响应与思考内容

**默认（`reasoning_split=false`）**：思考内嵌在 `content` 的 `<think>...</think>` 标签内，与最终答案在同一字段——这是最特殊的输出形态。

**`reasoning_split=true`**：思考分离到独立字段：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "最终答案",
      "reasoning_content": "...",              // 思考文本
      "reasoning_details": [{"text": "...", ...}]  // 结构化（与 OpenRouter 同名）
    }
  }]
}
```

- 多轮 Function Call：必须把完整 assistant 消息（含思考字段 / `<think>` 标签）追加回历史，保持思维链连续。

## 流式响应

OpenAI 风格 SSE；`reasoning_split=true` 时思考增量在 `delta.reasoning_details`（需按文本增量拼接），正文在 `delta.content`；`include_usage` 时末尾 chunk 带 `usage`。

```text
data: {"choices":[{"index":0,"delta":{"reasoning_details":[{"text":"思考..."}]}}]}
data: {"choices":[{"index":0,"delta":{"content":"答案..."}}]}
data: [DONE]
```

## 总结（一句话）

MiniMax M3 用 `thinking.type`（adaptive/disabled，默认开，M2.x 不可关）控制思考，无强度档位；输出形态由 `reasoning_split` 决定——`false` 时思考藏在 `content` 的 `<think>` 标签里，`true` 时拆到 `reasoning_content` / `reasoning_details`，Anthropic 端则是标准 thinking 块 + Interleaved Thinking。
