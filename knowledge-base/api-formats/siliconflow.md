# SiliconFlow — Chat Completions（OpenAI 兼容）

> 来源：https://docs.siliconflow.cn/en/api-reference/chat-completions/chat-completions （webfetch 成功，2026-08-01）
> 硅基流动：OpenAI Chat Completions 兼容聚合平台，代理多家属地化开源/闭源模型。

## 请求格式

```
POST https://api.siliconflow.cn/v1/chat/completions
Authorization: Bearer <SILICONFLOW_API_KEY>

{
  "model": "Pro/zai-org/GLM-4.7",
  "messages": [{"role": "user", "content": "..."}],
  "enable_thinking": true,
  "thinking_budget": 4096
}
```

模型名示例：`Pro/zai-org/GLM-4.7`、`deepseek-ai/DeepSeek-V3.2`、`Qwen/Qwen3.5-397B-A17B`、`zai-org/GLM-4.6V`（视觉）。响应头 `x-siliconcloud-trace-id` 可用于排查问题。

## 思考 / 推理参数

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `enable_thinking` | bool | 思考开关；支持 GLM-5/GLM-4.7、DeepSeek-V3.2/V3.1-Terminus、Qwen3 全系、Hunyuan-A13B、GLM-4.5V、Qwen3.5 系列等（见模型页） |
| `thinking_budget` | int，`128 ~ 32768` | 思维链输出 token 上限（对推理类模型通用） |
| `reasoning_effort` | `high` / `max` | **仅 `deepseek-ai/DeepSeek-V4-Flash`**；兼容性上 `low`/`medium` 映射为 `high`，`xhigh` 映射为 `max`；常规请求默认 high，agent 类请求（Claude Code / OpenCode）自动为 max |

- 注意：无 Anthropic / Gemini 原生端点，只有 OpenAI 兼容一种格式；`min_p` 等个别参数仅对部分模型生效。

## 响应与思考内容

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "最终答案",
      "reasoning_content": "思考内容（与 content 同级）"
    }
  }],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 1540,
    "total_tokens": 1555,
    "completion_tokens_details": {"reasoning_tokens": 1190}
  }
}
```

- **思考内容字段：`message.reasoning_content`**；用量单独统计在 `usage.completion_tokens_details.reasoning_tokens`。
- 官方 OpenAPI 描述中 `reasoning_content` 标注"仅 deepseek-R1 系列与 Qwen/QwQ-32B 支持"，但示例响应（GLM-4.7 等）均返回该字段——实现时应对所有模型做兼容读取。

## 流式响应

OpenAI 风格 SSE；思考增量在 `delta.reasoning_content`，正文在 `delta.content`；示例中每个 chunk 都带 `usage` 字段（首个 chunk 起即有 token 计数），`data: [DONE]` 结尾。

```text
data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":null,"role":"assistant"}}]}
data: {"choices":[{"index":0,"delta":{"reasoning_content":"思考..."}}]}
data: {"choices":[{"index":0,"delta":{"content":"答案..."}}]}
data: [DONE]
```

## 总结（一句话）

SiliconFlow 用 `enable_thinking`（bool 开关）+ `thinking_budget`（128~32768 预算）控制思考，仅 V4-Flash 模型额外支持 `reasoning_effort`（high/max，low/medium 自动映射 high）；思考内容经 `reasoning_content` 返回，用量有独立 `reasoning_tokens` 统计。
