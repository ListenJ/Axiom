# DeepSeek — Chat Completions（OpenAI 兼容 + Anthropic 兼容）

> 来源：https://api-docs.deepseek.com/ 与 https://api-docs.deepseek.com/guides/thinking_mode （webfetch 成功，2026-08-01）
> 官方声明：API 格式兼容 OpenAI / Anthropic，修改 base_url 即可用对应 SDK 接入。

## 请求格式

| 格式 | base_url | 说明 |
| --- | --- | --- |
| OpenAI 兼容（默认） | `https://api.deepseek.com` | `POST /chat/completions`，`Authorization: Bearer <key>` |
| Anthropic 兼容 | `https://api.deepseek.com/anthropic` | `POST /v1/messages`，Anthropic 头格式 |

模型名示例：`deepseek-v4-flash`、`deepseek-v4-pro`（`deepseek-v4-flash` 已更新至 V4-Flash-0731，调用名不变）。

```json
POST https://api.deepseek.com/chat/completions
{
  "model": "deepseek-v4-pro",
  "messages": [{"role": "user", "content": "..."}],
  "thinking": {"type": "enabled"},
  "reasoning_effort": "high",
  "stream": false
}
```

## 思考 / 推理参数（OpenAI 兼容端）

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `thinking` | `{type: "enabled"}` / `{type: "disabled"}` | 思考开关；**默认开启**，默认 effort 为 `high` |
| `reasoning_effort` | `low` / `high` / `max` | 思考强度（另有 `xhigh` 可传，按映射处理） |

effort 实际映射（官方表格）：

| 请求值 | v4-flash 实际 | v4-pro 实际（2026 年 8 月初将更新） |
| --- | --- | --- |
| low | low | high |
| high | high | high |
| xhigh | high | high |
| max | max | max |

Anthropic 兼容端控制参数：`{"reasoning": {"effort": "none/low/high/max"}}`（`none` 关闭思考）与 `{"output_config": {"effort": "low/high/max"}}`。

- **限制**：思考模式下 `temperature`、`top_p`、`presence_penalty`、`frequency_penalty` 不生效（不报错，静默忽略）。

## 响应与思考内容

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "最终答案",
      "reasoning_content": "思考过程（与 content 同级）"
    }
  }],
  "usage": {"prompt_tokens": 10, "completion_tokens": 100, "total_tokens": 110}
}
```

- **思考内容字段：`reasoning_content`**（非流式在 `message`，流式在 `delta.reasoning_content`），这是 DeepSeek 系的标准字段。
- 多轮：无工具调用时历史 `reasoning_content` 可忽略（回传会被无视）；**带 `tools` 时每轮的 `reasoning_content` 必须原样回传**，否则返回 400。

## 流式响应

OpenAI 风格 SSE，与官方格式一致：

```text
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}
data: {"choices":[{"index":0,"delta":{"reasoning_content":"思考..."}}]}   ← 思考增量
data: {"choices":[{"index":0,"delta":{"content":"答案..."}}]}
data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{...}}
data: [DONE]
```

## 总结（一句话）

DeepSeek 同时提供 `thinking`（开关）+ `reasoning_effort`（low/high/max）两个 OpenAI 兼容字段（Anthropic 端用 `reasoning.effort` / `output_config.effort`），思考内容经 `reasoning_content` 返回——是本项目映射层可直接复用的最接近 OpenAI 语义的参考实现。
