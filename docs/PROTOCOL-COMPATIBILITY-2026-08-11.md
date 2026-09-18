# Axiom 协议兼容覆盖矩阵（2026-08-11）

> 目的：拉取各大 AI 供应商文档，确定通信方式与协议，找出「支持多少协议才能做到最大兼容覆盖」。
> 结论先行：**OpenAI 兼容 REST（/v1/chat/completions + SSE + function calling + /v1/embeddings）+ MCP（stdio + Streamable HTTP）= 当前生态的工程最大覆盖**。没有任何一家目标供应商「必须」走非 OpenAI 协议；Anthropic /v1/messages 是可选加分面（覆盖 Claude Code 类 Coding Agent）。
> 标注：事实=官方文档直接核验；推测=基于官方索引/第三方佐证，待复核。

## 1. 核心结论

1. **国际三家**：OpenAI 原生 Chat Completions（/v1/chat/completions，Bearer，SSE `data: [DONE]`，tools，image_url）与 Responses API（/v1/responses，新默认）；Anthropic 原生 Messages API（/v1/messages，`x-api-key` + `anthropic-version`，SSE 事件 message_start/content_block_delta/message_delta/message_stop，tool_use/tool_result 块）；Gemini 原生 generateContent/streamGenerateContent（v1beta，contents/parts，functionCall/functionResponse）。**三者互不兼容，但都通过 OpenAI 兼容网关/代理广泛可用**（OpenRouter、硅基、智谱等均提供 OpenAI 兼容面）。
2. **中文六家（DeepSeek/SiliconFlow/智谱/Moonshot/MiniMax/OpenRouter）**：6/6 提供 OpenAI 兼容端点；Anthropic 兼容是附加通道（DeepSeek /anthropic、SiliconFlow /v1/messages、智谱 /api/anthropic、MiniMax /anthropic），非必需。
3. **长尾 + 本地（NVIDIA NIM/Mistral/xAI/Together/Groq/Ollama/llama.cpp/LM Studio）**：全部提供 OpenAI 兼容 /v1/*；本地三家还提供 /v1/embeddings。
4. **嵌入缺口**：DeepSeek、Kimi 无官方 /embeddings → 需至少 1 个嵌入供应商（SiliconFlow bge-m3 / 智谱 embedding-3 / OpenRouter 统一嵌入）。

## 2. 协议兼容矩阵

| 供应商 | baseUrl | 认证 | OpenAI 兼容 | SSE | 工具 | 多模态 | 嵌入 | 差异/注意 |
|---|---|---|---|---|---|---|---|---|
| OpenAI | api.openai.com/v1 | Bearer | 原生 | ✅ | ✅ | ✅ image_url | ✅ | Responses API 为新一代；Chat Completions 仍可用
| Anthropic | api.anthropic.com/v1 | x-api-key + anthropic-version | ❌ 原生 Messages | ✅ 事件流 | ✅ tool_use | ✅ base64 image | ❌ | 需要单独适配器；各网关提供 OpenAI 兼容面
| Gemini | generativelanguage.googleapis.com/v1beta | API key (x-goog-api-key) | ❌ 原生 generateContent | ✅ | ✅ functionCall | ✅ 原生 | ✅ | 需要单独适配器或经 OpenAI 兼容代理
| DeepSeek | api.deepseek.com | Bearer | ✅ | ✅ | ✅ | ❌ 文本 | ❌ | reasoning_content；Anthropic 格式 /anthropic；Responses API 仅 v4-flash
| SiliconFlow | api.siliconflow.cn/v1 | Bearer | ✅ | ✅ | ✅（≤128 工具） | ✅ | ✅ bge-m3 等 | 免费模型；thinking 参数；/v1/messages 兼容面；/v1/rerank
| 智谱 GLM | open.bigmodel.cn/api/paas/v4 | Bearer | ✅ | ✅ | ✅ 并行+流式 | ✅ GLM-4.5V/4.6V | ✅ embedding-3 | /api/anthropic；thinking.type；部分高级工具仅官方 SDK
| Moonshot Kimi | api.moonshot.cn/v1 | Bearer | ✅ | ✅ | ✅ 多步 | ⚠️ 视模型 | ❌ | thinking 走 extra_body；Context Caching 自动命中
| MiniMax | api.minimaxi.com/v1 | Bearer | ✅ | ✅ | ✅ | ✅ M3 图+视频 | ⚠️ embo-01 待核 | 三协议并存（OpenAI/Anthropic/原生 v2）；思考内嵌 <think>
| OpenRouter | openrouter.ai/api/v1 | Bearer | ✅ | ✅ | ✅ | ✅ 透传 | ✅ 统一嵌入 | :free/:nitro/:floor/:thinking 变体；402/529 需重试
| NVIDIA NIM | integrate.api.nvidia.com/v1 | Bearer nvapi-* | ✅ | ✅ | ✅ | ✅ 按模型 | ✅ | 免费原型额度约 40 RPM；模型 nvidia/ 命名空间；自托管另有 /v1/messages
| Mistral | api.mistral.ai/v1 | Bearer | ✅ | ✅ | ✅ | ✅ Pixtral（待核） | ✅ | OpenAI SDK 换 base_url 即用
| xAI Grok | api.x.ai/v1 | Bearer xai-* | ✅ | ✅ | ✅ function+web | ⚠️ 按模型 | ❌（未见） | 另有 /v1/responses
| Together | api.together.ai/v1 | Bearer | ✅ | ✅ | ✅ | ✅ | ✅ | 模型 ID 必须 <provider>/<model>；Assistants/Batch 未实现
| Groq | api.groq.com/openai/v1 | Bearer | ✅ | ✅ | ✅ | ✅ 部分 | ✅ | 免费档限速（约 30 RPM/模型）；另有 Responses API
| Ollama | localhost:11434 | 无（apiKey 占位） | ✅ /v1/* | ✅ | ✅（多工具流式有 bug） | ✅ | ✅ | 原生 /api/chat、/api/embed 更丰富
| llama.cpp | localhost:8080 | 可选 --api-key | ✅ /v1/* | ✅ | ✅（--jinja） | ✅ | ✅ | 原生 /completion 非 OpenAI 形状
| LM Studio | localhost:1234/v1 | 无 | ✅ /v1/* | ✅ | ✅ | ✅ | ✅ | 另有 Anthropic 兼容；可作 MCP 客户端

## 3. 协议面建议（最大覆盖最小成本）

1. **协议层只做 1 个**：OpenAI-compatible 适配器（统一 base_url 映射 + Bearer + /chat/completions + SSE + tools + image_url + /v1/embeddings）。覆盖：OpenAI、DeepSeek、SiliconFlow、智谱、Moonshot、MiniMax、OpenRouter、NVIDIA NIM、Mistral、xAI、Together、Groq、Ollama、llama.cpp、LM Studio（15+ 家）。
2. **归一化映射表**：各家扩展参数字段不同（reasoning_content / thinking.type / thinking.keep / reasoning_effort / <think>），按模型路由的「供应商参数映射表」收敛，业务层不写多套。
3. **嵌入统一 1 家**：SiliconFlow bge-m3（8192 tokens、免费额度、VL 嵌入）或智谱 embedding-3（可调维度）或 OpenRouter 统一嵌入。
4. **可选第二协议**：Anthropic Messages 适配器（覆盖 Claude Code/OpenCode 直连场景；DeepSeek/SiliconFlow/智谱/MiniMax/NVIDIA NIM/LM Studio 已自带该面）。
5. **MCP 工具面**：stdio + Streamable HTTP 双传输，严格实现 initialize → capabilities → notifications/initialized、tools/list（JSON Schema inputSchema）、tools/call（isError/structuredContent）、tools/list_changed。
6. **不建议**：为 Gemini 原生格式专门写适配器（无一家强制要求）；直接接各家原生协议（除非用专有能力）。

## 4. 仓库落地落差（事实，来自本仓库只读检查）

- docs/ARCHITECTURE-REVIEW.md：MCP 工具面（stdio + Streamable HTTP）已就绪；但 `/v1/*` OpenAI 兼容 REST 端点「不存在」（响应形状/SSE 格式不兼容）→ 标为 P2 适配层约 100 行。
- provider/baseURL 四表漂移需统一（ofoxai 双域名、opencode 双域名、nim/nvidia-nim、minimax 双默认）——见 AUDIT-2026-08-11.md 第 3 节。
- 前端模型选择器目前假配置（/chat 忽略 model）——见 AUDIT 第 3 节，模板化后一并修。

## 5. 主要来源

- OpenAI: https://platform.openai.com/docs ｜ Anthropic: https://docs.anthropic.com ｜ Gemini: https://ai.google.dev/gemini-api/docs
- DeepSeek: https://api-docs.deepseek.com/zh-cn/ ｜ SiliconFlow: https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions ｜ 智谱: https://docs.bigmodel.cn/cn/guide/platform/model-migration ｜ Kimi: https://platform.kimi.com/docs/api/overview ｜ MiniMax: https://platform.minimaxi.com/docs/api-reference/text-openai-api ｜ OpenRouter: https://openrouter.ai/docs
- NVIDIA: https://docs.api.nvidia.com/nim/reference/llm-apis ｜ Mistral: https://docs.mistral.ai/api/ ｜ xAI: https://docs.x.ai/developers/rest-api-reference/inference/chat ｜ Together: https://docs.together.ai/docs/openai-api-compatibility ｜ Groq: https://console.groq.com/docs/overview
- Ollama: https://docs.ollama.com/api/openai-compatibility ｜ llama.cpp: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md ｜ LM Studio: https://beta.lmstudio.ai/docs/developer/openai-compat ｜ MCP: https://modelcontextprotocol.io/specification/2025-06-18

> 备注：Gemini/OpenAI/Anthropic 三家的原生协议条目基于官方文档（稳定 URL）；本表不替代接入前的实测。
