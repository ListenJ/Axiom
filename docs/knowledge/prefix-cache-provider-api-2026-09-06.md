# 模型前缀缓存 provider 官方文档核查 — 2026-09-06

> **摘要**：为前缀缓存优化计划（`docs/superpowers/plans/2026-09-06-prefix-cache-optimization-plan.md`）P1-D「请求层 provider 缓存适配」核查三家 provider 的官方缓存语义。**核心结论**：DeepSeek 系与智谱均为**自动隐式缓存**（无请求参数可注入），仅 OpenAI 官方端点有显式 `prompt_cache_key` 参数——当前三家 provider（opencode/deepseek-v4-flash、zhipu/glm-4.7-flash、sensenova/deepseek-v4-flash-sensenova）无一适用参数注入，**P1-D 缩窄为 usage 缓存字段全量透传**（P0-A 已覆盖），前缀稳定性（P1-C）成为唯一真正提升命中率的杠杆。

## DeepSeek（含 sensenova 转发端点）【事实】

- 官方文档：[Context Caching - DeepSeek API Docs](https://api-docs.deepseek.com/guides/kv_cache/)
- 响应 `usage` 新增两字段：`prompt_cache_hit_tokens`（命中缓存、按显著低价计费）与 `prompt_cache_miss_tokens`（未命中、标准输入价），**hit + miss = prompt_tokens**。
- [Context Caching on Disk 公告](https://api-docs.deepseek.com/news/news0802/)：缓存**自动**生效，无需代码变更；命中输入价降至约 1/10。
- 缓存按**前缀匹配**：请求间共享相同前缀即可复用；无任何请求参数可控缓存。

## OpenAI 官方端点（当前未接入，仅备忘）【事实】

- 官方文档：[Prompt caching | OpenAI API](https://developers.openai.com/api/docs/guides/prompt-caching)
- 自动前缀缓存：请求共享 ≥1024 token 相同前缀即自动缓存（[Cookbook：TTFT 最高降 80%、输入成本最高降 90%](https://developers.openai.com/cookbook/examples/prompt_caching_201)）。
- 显式参数：`prompt_cache_key`（路由相关请求到同一缓存桶）与 `prompt_cache_options.mode` / `prompt_cache_breakpoint`——**仅 OpenAI 官方/兼容其规范的端点适用**。
- usage 返回 `prompt_tokens_details.cached_tokens`。
- 社区实测注意：命中非完全确定（缓存生效有秒-分钟级延迟；[并行会话同 key 不保证命中](https://community.openai.com/t/using-same-prompt-cache-key-in-multiple-parallel-conversations/1371443)）。

## 智谱 GLM【事实】

- 官方文档：[上下文缓存 - 智谱AI开放文档](https://docs.bigmodel.cn/cn/guide/capabilities/cache)
- **自动隐式缓存**：对话中重复的系统提示词/历史上下文自动识别并复用，无需手动干预；无请求参数。

## 对 Axiom 前缀缓存计划的结论

| 结论 | 类型 | 依据 |
| --- | --- | --- |
| P0-A 解析目标字段确认：deepseek 系 `prompt_cache_hit_tokens`、OpenAI 兼容系 `prompt_tokens_details.cached_tokens`，全量防御性解析 | 事实 | 上述官方文档 |
| 三家 provider 均无缓存请求参数可注入——P1-D 原「按 provider 注入缓存参数」对当前端点全部不适用 | 事实（推论） | deepseek/zhipu 自动缓存无参数；opencode 端点为 deepseek 转发 |
| P1-D 缩窄为：usage 缓存字段全量透传落库（P0-A 覆盖）+ 未来接入 OpenAI 官方端点时才注入 `prompt_cache_key`（届时需重新核查该端点文档） | 判断 | 本文件证据 |
| 前缀稳定性（P1-C：静态前缀分层 + CACHE_BOUNDARY 确定性 + 工具稳定排序 + 易变内容后置）是提升命中率的唯一可施工杠杆 | 判断 | 三家均为前缀匹配自动缓存，命中与否取决于前缀字节级稳定 |
| sensenova（deepseek-v4-flash-sensenova）转发端点遵循 deepseek 缓存语义、usage 返回命中字段 | 推测 | deepseek 官方语义 + 端点为 deepseek 系；待 P0-A 真机冒烟证实 |
