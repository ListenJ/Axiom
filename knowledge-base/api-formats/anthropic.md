# Anthropic — Messages API（Extended Thinking）

> 来源：https://docs.anthropic.com/en/api/messages 与 extended-thinking 文档（webfetch 多次 transport error，本文基于已有知识撰写，2026-08-01 核对；参考了 OpenRouter 迁移文档对 Claude 4.6/4.7/5 系列思考行为的描述）
> 属于 **Anthropic Messages 风格**：`system` 独立于 `messages`、`max_tokens` 必填、思考用 `thinking` 对象。

## 请求格式

```
POST https://api.anthropic.com/v1/messages
x-api-key: sk-ant-...
anthropic-version: 2023-06-01
Content-Type: application/json

{
  "model": "claude-opus-4-7",
  "max_tokens": 32000,
  "system": "You are a helpful assistant.",
  "messages": [
    {"role": "user", "content": "..."}
  ],
  "thinking": {"type": "enabled", "budget_tokens": 16000}
}
```

- 鉴权：`x-api-key` 头 + 必填版本头 `anthropic-version`。
- 模型名示例：`claude-opus-4-7`、`claude-sonnet-4-6`、`claude-haiku-4-5`（以官方列表为准）。

## 思考 / 推理参数

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `thinking`（对象） | `{type: "enabled", budget_tokens: N}` | 经典 Extended Thinking；`budget_tokens` 范围 1024 ~ 128000，且**必须小于 `max_tokens`** |
| `thinking` | `{type: "disabled"}` | 关闭思考（部分新模型禁止关闭） |
| `thinking`（新模型，adaptive） | `{type: "adaptive", effort: "low"/"medium"/"high"/"xhigh"}` | Claude 4.6+ 引入自适应思考；Claude 4.7 Opus / Claude 5 Sonnet 等**仅支持 adaptive 模式**，且采样参数被移除 |
| `output_config` | `{effort: "low"/"medium"/"high"/"xhigh"/"max"}` | Claude 4.6+ 控制输出"努力程度"（OpenRouter 将 `verbosity` 映射到此字段） |

- OpenAI 兼容端点下无 `reasoning_effort`；OpenRouter 会把 `reasoning.effort` / `reasoning.max_tokens` 换算为 `budget_tokens`（预算 = `max(min(max_tokens × ratio, 128000), 1024)`，ratio：max/xhigh 0.95、high 0.8、medium 0.5、low 0.2、minimal 0.1）。

## 响应格式

```json
{
  "content": [
    {"type": "thinking", "thinking": "思考过程...", "signature": "..."},
    {"type": "text", "text": "最终答案"}
  ],
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 10, "output_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
}
```

- 思考内容在 `content` 块数组中，`type: "thinking"`；受签名保护时返回 `type: "redacted_thinking", data: "base64"`。
- `usage.output_tokens` 含思考 token；思考耗尽预算时 `stop_reason = "max_tokens"`。
- **多轮必读**：带 `thinking` 块的历史消息必须原样回传（含 `signature`），否则 400 错误。

## 流式响应（SSE 事件）

```
event: message_start
event: content_block_start   {"content_block":{"type":"thinking","thinking":""}}
event: content_block_delta   {"delta":{"type":"thinking_delta","thinking":"思考..."},"signature_delta":"..."}
event: content_block_stop
event: content_block_start   {"content_block":{"type":"text","text":""}}
event: content_block_delta   {"delta":{"type":"text_delta","text":"答案..."}}
event: content_block_stop
event: message_delta         {"stop_reason":"end_turn","usage":{"output_tokens":100}}
event: message_stop
```

- 与 OpenAI SSE 的 `delta` 结构完全不同：Anthropic 用**事件流**，每个事件一行 JSON，思考增量在 `thinking_delta`，且带 `signature_delta` 用于回传校验。

## 总结（一句话）

Anthropic 用 `thinking` 对象（`budget_tokens` 预算制，新模型改 adaptive + effort 档位）控制思考，思考以 `content` 块（thinking / redacted_thinking）返回，流式走事件流而非 OpenAI 风格 delta，且多轮必须原样回传带签名的 thinking 块。
