# ModelScope API-Inference 能力收集（2026-10-06）

> 摘要：ModelScope API-Inference 服务可用，`MODELSCOPE_API_KEY` 鉴权已通过；chat、SSE 流式、JSON 输出和 tool calling 已有实测。当前账号/端点的 `/v1/models` 未列出 embedding 模型，`/v1/embeddings` 对常见 embedding ID 返回 `Invalid model id`；`/v1/rerank` 不存在。图片编辑路由存在，但远程图片抓取未完成验证。

## 一、连接与鉴权

- Base URL：`https://api-inference.modelscope.cn/v1`
- 鉴权：`Authorization: Bearer <ModelScope API-Inference token>`
- 本地凭据变量：`MODELSCOPE_API_KEY`，已放在 `~/.axiom/axiom-secrets/modelscope.credentials`，文件权限 0600。
- 本次实测：最小 chat completion 返回 HTTP 200，证明 token 对 API-Inference 有效。
- 进程/仓库中未写入 token；知识文件不记录 token 值。

## 二、模型清单

`GET /v1/models` 返回 HTTP 200，共 **35** 个模型。当前列表按名称可分为：

| 类别 | 代表模型 |
|---|---|
| DeepSeek 对话/推理 | `deepseek-ai/DeepSeek-V4-Flash-0731`、`deepseek-ai/DeepSeek-V4-Pro`、`deepseek-ai/DeepSeek-V4.1-Flash` |
| Qwen 对话/推理 | `Qwen/Qwen3.5-27B`、`Qwen/Qwen3.5-35B-A3B`、`Qwen/Qwen3.5-122B-A10B`、`Qwen/Qwen3.8-27B`、`Qwen/Qwen3.8-Flash-Next` |
| GLM | `ZhipuAI/GLM-4.7-Flash`、`ZhipuAI/GLM-5.2` |
| MiniMax | `MiniMax/MiniMax-M1-80k`、`MiniMax/MiniMax-M3` |
| 其他对话 | `mistralai/Mistral-Large-Instruct-2407`、`stepfun-ai/Step-3.5-Flash`、`stepfun-ai/Step-3.7-Flash` |
| 视觉/多模态 | `OpenGVLab/InternVL3_5-241B-A28B`、`PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT` |
| 图像编辑 | `Qwen/Qwen-Image-Edit`、`MusePublic/Qwen-Image-Edit` |

未在列表中看到 `BAAI/bge-m3`、`Qwen3-Embedding-*` 或其他 embedding 模型。

## 三、实测能力矩阵

| 能力/端点 | 状态 | 证据 |
|---|---|---|
| `GET /v1/models` | 可用 | HTTP 200，35 个模型 |
| `POST /v1/chat/completions` | 可用 | HTTP 200；`deepseek-ai/DeepSeek-V4-Flash-0731` 正常返回 usage |
| SSE 流式（`stream:true`） | 可用 | HTTP 200，返回 `data: {"object":"chat.completion.chunk",...}` |
| JSON 输出（`response_format:json_object`） | 请求被接受 | HTTP 200；本次受 `max_tokens` 限制只看到部分 JSON |
| Tool calling | 可用 | HTTP 200；`finish_reason=tool_calls`，返回 `get_weather({"city":"Paris"})` |
| `POST /v1/embeddings` | 当前不可用 | 对 `BAAI/bge-m3`、`Qwen/Qwen3-Embedding-8B` 等均 HTTP 400 `Invalid model id` |
| `POST /v1/rerank` | 不存在 | HTTP 404 |
| `POST /v1/images/generations` | 路由存在 | 对 `MusePublic/Qwen-Image-Edit` 要求 `image_url`；公开图片源抓取超时，未完成图片输出验证 |
| 速率限制响应头 | 未观察到 | 本次 chat 响应未返回 `x-ratelimit-*` / quota / retry 头 |

## 四、对 Axiom 的意义

1. **可以作为受限 chat/工具任务 provider**：基础 chat、流式、JSON、tool calling 均有实测，适合作为受限任务的模型出口。
2. **不能作为当前 embedding provider**：没有可用 embedding 模型；不应把 ModelScope 写入 embedding registry，否则会形成“路由存在但调用必失败”的假能力。
3. **需要按模型做能力白名单**：35 个模型不是同质的；是否支持 tool calling、JSON、视觉输入需要按模型单独探测，不能只按 provider 放行。
4. **需要继续收集配额/合规信息**：当前未从接口获得明确 RPM/TPM/日额度；生产接入前需从 ModelScope 控制台确认额度、并发、数据保留与内容限制。
5. **图片编辑需单独验证**：路由存在，但需要用 ModelScope 可访问的图片 URL 或上传链路确认返回结构、计费与超时行为。

## 五、建议的下一步信息收集

- 针对“受限任务”的具体类型，列出候选模型（文本 / 工具 / JSON / 视觉 / 图像编辑）。
- 对候选模型逐一探测：tool calling、JSON 输出、上下文长度、并发下的错误码。
- 从 ModelScope 控制台确认 API-Inference 的额度、限流、付费/免费边界和数据使用条款。
- 若需要 embedding，另行选择支持 `/v1/embeddings` 的 provider，或落地本地 `BAAI/bge-m3` 服务。
