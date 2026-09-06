# 模型前缀缓存优化计划（2026-09-06）

> **状态**：已立项（用户指令 D8），P0 子项随批复清单同日施工。
> **定位依据**：用户决策——最终形态是 **runtime**（生态位低于现有 Agent 的基础设施层），针对模型的前缀缓存优化是 runtime 的核心能力（上层 Agent/宿主的每一次模型调用都经过本 runtime 的调用面，缓存命中率直接决定其成本与延迟）。
> **关联**：决策文档 `2026-09-06-next-iteration-debate-decision-design.md` §8 D8/D9；EXTERNAL-AGENTS-CACHE-OPTIMIZATION-2026-08-09（差距表：无请求层缓存参数、无 cached token 采集）。

## 现状审计（2026-09-06 深探结论，锚点核实）

| 现状 | 证据 |
| --- | --- |
| 多层缓存已有（L1 内存 LRU / L2 Redis / L3 SQLite WAL），llmCache 实例 TTL 1h、`data/llm-cache.db` | `src/utils/cache.ts:420-426` |
| llmCacheKey = sha256(provider+model+system+全部 messages+temp)，命中条件 temperature===0 且消息逐字节相同 | `src/utils/cache.ts:458-475` |
| L3 写入为去抖异步 flush（pendingL3 + setTimeout(0)），测试 E 组在 flush 前同步关库 → 存量失败「写入 L3 后新实例可读取」 | `src/utils/cache.ts:227-263`；`tests/llm-cache.test.ts:204-220`（已复现 1 fail） |
| destroy() flush 后 **DELETE 整个 namespace L3**——销毁实例语义被实现成清库 | `src/utils/cache.ts:307-326` |
| 请求体只有 model/messages/temperature/max_tokens/reasoning/tools——**全仓无 cache_control / prompt_cache_key 等 provider 缓存参数** | `src/router/provider-caller.ts:107-114` |
| prompt-pool 已实现静态前缀分层（system+工具表+约束+CACHE_BOUNDARY+动态后缀），但 **marker 每次构建随机 UUID** 且**未接入 router 主路径** | `src/router/prompt-pool.ts:445-476,538-579` |
| 评测直连路径 parseProviderUsage **丢弃 prompt_cache_hit_tokens / cached_tokens**；内部路径 token-tracker 已记录 deepseek 缓存命中字段 | `src/agent-evals/runner.ts:183-190` vs `src/router/token-tracker.ts:39-44,464-466` |
| 三 provider 语义：deepseek/sensenova（deepseek-v4）上下文缓存自动、按命中计费；zhipu glm-4.7-flash 隐式前缀缓存——**但前缀不稳定（技能注入逐轮可变、无稳定排序）时全部落空** | `src/agent-evals/runner.ts:283-285,347-390` |

## 目标

建立「可度量 → 前缀稳定 → 请求面适配 → 效果验证」的最小闭环：让三个评测 provider 与 router 主路径的模型调用具备**稳定前缀**，命中 provider 端自动前缀缓存，并以 `cacheHitTokens` 指标闭环验证。

## 子项与顺序

| # | 子项 | 内容 | 成本 | 状态 |
| --- | --- | --- | --- | --- |
| P0-A | **缓存命中度量先行** | `TokenUsage` 加 `cacheHitTokens`；`parseProviderUsage` 解析 `prompt_cache_hit_tokens`（deepseek 系）/`cached_tokens`/`prompt_tokens_details`；metrics summarize 聚合 + 报告展示；TDD | S | 本轮施工 |
| P0-B | **llm-cache E 组修复 + destroy 语义修正** | E 组红→绿：测试显式等待 flush（暴露真实异步语义）或 set 提供 flush 钩子——以实现语义为准，禁止测试里 sleep 猜时序；`destroy()` 只 flush+关库、不 DELETE L3 数据（清数据是 `clear()` 的职责）；补 destroy 不清库回归测试 | S | 本轮施工 |
| P1-C | **prompt 前缀纪律接入主路径** | prompt-pool 静态前缀（system+工具表+约束）接入 router 主路径；CACHE_BOUNDARY marker 去随机化（确定性内容 hash）；工具列表稳定排序；易变内容（技能注入/时间戳/动态计数）全部移到边界之后 | M | P0 落地后 |
| P1-D | **请求层 provider 缓存适配（缩窄）** | 2026-09-06 官方文档核查（`docs/knowledge/prefix-cache-provider-api-2026-09-06.md`）：三家 provider 均为自动隐式缓存、无缓存请求参数可注入——本子项缩窄为 usage 缓存字段全量透传落库（P0-A 合并即视为完成）；仅当未来接入 OpenAI 官方端点时才注入 `prompt_cache_key`（届时重新核查该端点文档） | S | P0-A 合并即完成 |
| P2-E | **llmCache 前缀级 key** | 现全串 sha256 使多轮对话历史每轮增长即永不命中——需增量前缀 key 设计 | L | 押后：C/D 落地后若 provider 端命中率已达标则重估必要性 |

## 验证策略

- P0-A：TDD 红→绿；真机一轮 `--rerun-each=1` 冒烟确认 deepseek 系响应含 `prompt_cache_hit_tokens` 且落库。
- P0-B：`bun test tests/llm-cache.test.ts` 10/10 绿；`destroy` 后新实例仍可读（回归测试锁定）。
- P1-C/D：`cache:baseline` 思路扩展——同一任务连续 3 轮调用，第 2/3 轮 `cacheHitTokens/promptTokens` 比率 ≥ 目标（基线首跑后定，暂定 ≥50%）；`bun test tests/agent-evals` 无回归；`bunx tsc --noEmit` 0。

## 红线

- 规则 1：P0 只动 `cache.ts`/`runner.ts`/`metrics.ts` 及对应测试；不改既有任务断言语义。
- 规则 7：垂直切片 TDD，每片红→绿。
- 规则 11：密钥只从本地 `.env` 读取；报告不落密钥。
- provider 缓存行为属外部事实——每个参数注入都必须有官方文档依据（规则 10.2），不得凭记忆猜测字段名。
