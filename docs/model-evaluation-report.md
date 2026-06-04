# OpenClaw Fusion -- LLM 模型评估报告

**生成日期**: 2026-06-04  
**数据来源**: Swfte AI Leaderboard (May 2026), LM Arena, DataLearner, Artificial Analysis, 各厂商官方发布  
**评估范围**: `src/router/models.ts` 中已注册的全部模型 + 建议新增模型

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [主流旗舰模型 Benchmark 对比](#2-主流旗舰模型-benchmark-对比)
3. [已注册模型逐项评估](#3-已注册模型逐项评估)
4. [六维能力评分矩阵](#4-六维能力评分矩阵)
5. [Agent 角色最优模型分配方案](#5-agent-角色最优模型分配方案)
6. [Fallback 链设计](#6-fallback-链设计)
7. [models.ts 更新建议 (代码)](#7-modelsts-更新建议代码)
8. [成本估算](#8-成本估算)
9. [风险与注意事项](#9-风险与注意事项)

---

## 1. 执行摘要

### 核心发现

1. **国产开源模型集体崛起**: DeepSeek V4 Pro、GLM 5.1、Kimi K2.6、Qwen3.7 Max 在编码基准上已逼近甚至超越闭源旗舰 (Claude Opus 4.8, GPT-5.5)，且成本低 10-70 倍。

2. **编码能力排名** (SWE-Bench Pro, 2026年6月):
   - Claude Opus 4.8: ~62% (闭源第一)
   - MiniMax M3: 59.0% (超越 GPT-5.5)
   - Kimi K2.6: 58.6% (开源第一)
   - GLM 5.1: 58.4% (开源第二)
   - DeepSeek V4 Pro: SWE-bench Verified 80.6% (不同基准)

3. **性价比之王**: DeepSeek V4 Pro 永久降价 75% 后 (输入 $0.035/M cache hit, 输出 $0.87/M)，成本仅为 GPT-5.5 的 1/34。

4. **当前 models.ts 关键问题**:
   - DeepSeek V3 已落后 V4 两代，建议替换
   - 缺少 Qwen3.7 Max、DeepSeek V4 Pro、MiniMax M3 等高性价比模型
   - GLM 5.1 角色分配合理但可增加 deep_research
   - 免费模型阵容强大但缺乏 tier 分层

---

## 2. 主流旗舰模型 Benchmark 对比

### 2.1 编码能力对比

| 模型 | SWE-Bench Pro | SWE-Bench Verified | LiveCodeBench | Code Arena Elo | HumanEval |
|---|---|---|---|---|---|
| Claude Opus 4.8 | ~62% | ~90% | -- | 1527 (est.) | -- |
| GPT-5.5 | ~57% | ~82% | -- | 1506 | -- |
| MiniMax M3 | 59.0% | -- | -- | -- | -- |
| Kimi K2.6 | 58.6% | -- | -- | 1529 | -- |
| GLM 5.1 | 58.4% | -- | ~90% | ~1540 | -- |
| DeepSeek V4 Pro | -- | 80.6% | 93.5% | -- | -- |
| Qwen3.7 Max | -- | -- | -- | 1541 | -- |
| Qwen 3.6 Max | -- | 73.4% | -- | -- | -- |
| Gemma 4 31B | -- | -- | 80.0% | 1452 | -- |
| GPT-OSS 120B | -- | -- | -- | -- | -- |
| GPT-4o | -- | -- | -- | ~1350 | -- |
| Gemini 2.0 Flash | -- | -- | -- | ~1380 | -- |

### 2.2 推理能力对比

| 模型 | GPQA Diamond | AIME 2025/2026 | MATH | SuperGPQA |
|---|---|---|---|---|
| DeepSeek V4 Pro | 90.1% | -- | -- | -- |
| GLM 5.1 | ~88% | 95.3% | -- | -- |
| Qwen 3.6 Max | -- | 92.7% | -- | 70.6% |
| Gemma 4 31B | -- | 89.2% | -- | -- |
| Gemma 4 26B | -- | 88.3% | -- | -- |
| GPT-5.5 | ~92% | -- | -- | -- |
| Claude Opus 4.8 | ~93% | -- | -- | -- |

### 2.3 综合排名 (Swfte AI Leaderboard, May 2026)

| Rank | Model | Quality | Arena Elo | Speed (t/s) | Price (In/Out $/1M) | Context |
|---|---|---|---|---|---|---|
| 1 | Claude Opus 4.8 | 99 | 1527 | 72 | $5 / $25 | 1M |
| 2 | GPT-5.5 Pro | 98 | 15106 | 68 | $30 / $180 | 1M |
| 3 | GPT-5.5 | 97 | 1506 | 70 | $5 / $30 | 1M |
| 7 | Claude Opus 4.7 | 96 | 1505 | 68 | $5 / $25 | 1M |
| ~15 | Gemini 3.5 Flash | 84 | -- | 快 | $1.50 / $6 | 1M |
| ~20 | DeepSeek V4 Pro | ~93 | -- | 中 | $0.035* / $0.87 | 1M |

> *DeepSeek V4 Pro 价格为缓存命中价，非缓存输入价约 $3/M

### 2.4 API 定价对比

| 模型 | 输入 ($/1M tokens) | 输出 ($/1M tokens) | 上下文 | 性价比评级 |
|---|---|---|---|---|
| **DeepSeek V4 Pro** (cache hit) | $0.035 | $0.87 | 1M | SSS |
| **DeepSeek V4 Flash** | $0.14 | $0.28 | 1M | SSS |
| **Kimi K2.6** | $0.60~0.95 | $2.50~4.00 | 256K | A |
| **GLM 5.1** (SiliconFlow) | $0.26 (cache) / $1.40 | $4.40 | 205K | A |
| **MiniMax M3** | $0.30 | $1.20 | 1M | S |
| **Qwen3.7 Max** | ~$1.00 | ~$3.00 | 128K | A |
| **Gemini 2.0 Flash** | ~$0.10 | ~$0.40 | 1M | S |
| **GPT-4o** | $2.50 | $10.00 | 128K | B |
| **Claude Opus 4.8** | $5.00 | $25.00 | 1M | C |
| **GPT-5.5** | $5.00 | $30.00 | 1M | C |
| **OpenRouter Free Models** | $0 | $0 | 32K~256K | SSS (有速率限制) |

---

## 3. 已注册模型逐项评估

### 3.1 GLM 5.1 (SiliconFlow) -- id: `glm5.1`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 9 | SWE-Bench Pro 58.4%，开源第一，Artificial Analysis 编程 SOTA |
| 推理能力 | 9 | AIME 95.3%, GPQA ~88%，深度推理能力强 |
| 中文能力 | 10 | 智谱旗舰，中文理解与生成顶尖 |
| 长上下文 | 8 | 官方 205K，SiliconFlow 配置 128K，够用但非最大 |
| 速度 | 7 | 中等速度，非 Flash 级 |
| 性价比 | 8 | $0.26 cache / $4.40 output，合理 |

**评估结论**: 当前作为主力模型完全合格。编码+推理+中文三项均为顶级，角色覆盖 decision/architecture/code-generation/code-review/research 合理。建议增加 `deep_research` 和 `math` 角色。

### 3.2 Kimi K2.6 (Kimi/Moonshot) -- id: `kimi-k2.6`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 9 | SWE-Bench Pro 58.6%，Code Arena Elo 1529，超 Opus 4.6 |
| 推理能力 | 7 | 推理弱于编码，与 GPT-5.4 有差距 |
| 中文能力 | 9 | 月之暗面出品，中文优秀 |
| 长上下文 | 10 | 256K 上下文，1T 参数 MoE |
| 速度 | 7 | 非 thinking 模式输出快 |
| 性价比 | 7 | $0.60~0.95 / $2.50~4.00，中等 |

**评估结论**: 编码能力极强，256K 上下文优势明显。当前 role 配置 (code-generation/code-review/coding) 合理，建议增加 `deep_research` 以利用长上下文优势。

### 3.3 GLM 4.7 Flash (OfoxAI) -- id: `glm4.7-flash`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 6 | Flash 级模型，编码非强项 |
| 推理能力 | 6 | 快速但深度推理有限 |
| 中文能力 | 8 | GLM 系列，中文好 |
| 长上下文 | 7 | 128K |
| 速度 | 9 | Flash 模型，响应极快 |
| 性价比 | 9 | OfoxAI 定价较低 |

**评估结论**: 作为 Agent 行为模型和快速响应模型非常合适。decision/general-chat/evaluation 角色合理。

### 3.4 Hermes-3 Llama 3.1 405B (OpenRouter) -- id: `hermes-evolution`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 5 | 405B 大模型但非编码特化 |
| 推理能力 | 7 | 大参数量带来较好推理 |
| 中文能力 | 4 | Llama 系列中文弱 |
| 长上下文 | 7 | 131K |
| 速度 | 4 | 405B 参数量导致速度慢 |
| 性价比 | 8 | 免费，但有严格速率限制 (10 RPM) |

**评估结论**: 免费但慢且中文弱。用于 RL/research 可接受，但建议将主力研究任务迁移到更强的付费模型。`deep_research` 角色建议改用 DeepSeek V4 Pro 或 GLM 5.1。

### 3.5 NVIDIA Nemotron 3 Nano (OpenRouter) -- id: `nvidia-nano`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 3 | 小模型，编码能力有限 |
| 推理能力 | 3 | 仅适合简单分类/路由 |
| 中文能力 | 4 | 中文支持有限 |
| 长上下文 | 2 | 仅 4096 tokens |
| 速度 | 10 | 极快 |
| 性价比 | 10 | 免费 |

**评估结论**: 仅适合做轻量级路由决策。4K 上下文是严重限制。如果路由 prompt 较复杂，建议升级为 GLM 4.7 Flash 或 DeepSeek V4 Flash。

### 3.6 DeepSeek V3 -- id: `deepseek-v3`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 6 | 已被 V4 大幅超越 |
| 推理能力 | 6 | 中等 |
| 中文能力 | 8 | DeepSeek 中文好 |
| 长上下文 | 5 | 仅 64K |
| 速度 | 7 | 较快 |
| 性价比 | 6 | 价格仍合理但 V4 更优 |

**评估结论**: **建议替换为 DeepSeek V4 Pro**。V4 Pro 在所有维度上全面超越 V3，且价格更低 (永久降价 75%)。上下文从 64K 升级到 1M。

### 3.7 DeepSeek Coder (Legacy) -- id: `deepseek-coder`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 5 | Legacy 模型，已落后 |
| 推理能力 | 4 | 有限 |
| 中文能力 | 7 | 可 |
| 长上下文 | 3 | 仅 32K |
| 速度 | 8 | 快 |
| 性价比 | 5 | 有更优选择 |

**评估结论**: **建议移除**。已被 Qwen3 Coder (免费)、Kimi K2.6、GLM 5.1 等全面超越。

### 3.8 OpenCode Coder -- id: `opencode-coder`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 7 | 可用 |
| 推理能力 | 5 | 中等 |
| 中文能力 | 6 | 可 |
| 长上下文 | 8 | 128K |
| 速度 | 6 | 中等 |
| 性价比 | 6 | 取决于 OpenCode 定价 |

**评估结论**: 作为编码 fallback 保留可以，但优先级应低于 Kimi K2.6 和 GLM 5.1。

### 3.9 Kimi K1.5 -- id: `kimi-coder`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 7 | K2.6 的前代，仍可 |
| 推理能力 | 6 | 中等 |
| 中文能力 | 8 | 好 |
| 长上下文 | 8 | 128K |
| 速度 | 7 | 可 |
| 性价比 | 6 | 不如直接用 K2.6 |

**评估结论**: 作为 Kimi K2.6 的 fallback 保留，但建议逐步淘汰。

### 3.10 Qwen 2.5 Coder 32B (SiliconFlow) -- id: `qwen-coder`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 6 | 32B 小模型，能力有限 |
| 推理能力 | 5 | 小模型推理弱 |
| 中文能力 | 8 | Qwen 中文好 |
| 长上下文 | 3 | 仅 32K |
| 速度 | 9 | 小模型速度快 |
| 性价比 | 7 | SiliconFlow 定价低 |

**评估结论**: 作为轻量级编码 fallback 可保留，但已被 Qwen3 Coder (免费, OpenRouter) 超越。

### 3.11 Gemini 2.0 Flash (OfoxAI-Gemini) -- id: `gemini-flash`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 7 | Flash 级中编码较好 |
| 推理能力 | 6 | 速度优先，推理中等 |
| 中文能力 | 7 | 可 |
| 长上下文 | 10 | 1M 上下文 |
| 速度 | 10 | 极快，TTFT 低 |
| 性价比 | 9 | 低价高量 |

**评估结论**: 作为通用对话和快速响应模型非常优秀。1M 上下文是巨大优势。建议保持 general-chat 主力地位。可考虑升级到 Gemini 3.5 Flash (如果 OfoxAI 支持)。

### 3.12 GPT-4o (OfoxAI) -- id: `gpt-4o`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 6 | 已被 GPT-5 系列和开源模型超越 |
| 推理能力 | 6 | 中等 |
| 中文能力 | 7 | 可 |
| 长上下文 | 7 | 128K |
| 速度 | 7 | 可 |
| 性价比 | 4 | $2.50/$10.00 每百万 token，偏贵 |

**评估结论**: 性价比差，能力已被后来者超越。建议降级为 fallback 或替换为更优模型。

### 3.13 Llama 3.3 70B (OpenRouter Free) -- id: `llama-english` / `llama-3.3-free`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 6 | 70B 开源模型中可 |
| 推理能力 | 6 | 中等 |
| 中文能力 | 3 | Llama 中文弱 |
| 长上下文 | 8 | 131K |
| 速度 | 7 | 可 |
| 性价比 | 10 | 免费 |

**评估结论**: 免费英文任务合适。注意该模型在注册表中出现两次 (`llama-english` 和 `llama-3.3-free`)，建议去重。

### 3.14 DeepSeek Researcher -- id: `deepseek-research`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 5 | 非编码模型 |
| 推理能力 | 8 | 研究推理强 |
| 中文能力 | 8 | 好 |
| 长上下文 | 5 | 仅 64K |
| 速度 | 4 | 深度研究模式慢 |
| 性价比 | 7 | 可 |

**评估结论**: 仅适合深度研究任务。64K 上下文限制了长文档研究。建议在有 V4 Pro 的情况下用 V4 Pro 替代。

### 3.15 免费模型集群 (OpenRouter)

| 模型 ID | 模型 | 编码 | 推理 | 中文 | 上下文 | 综合评级 |
|---|---|---|---|---|---|---|
| `gemma-4-free` | Gemma 4 26B | 7 | 7 | 5 | 128K | B+ |
| `gemma-4-31b-free` | Gemma 4 31B | 7 | 8 | 5 | 128K | A- |
| `qwen3-coder-free` | Qwen3 Coder | 7 | 5 | 7 | 32K | B |
| `qwen3-next-free` | Qwen3 Next 80B | 6 | 7 | 7 | 32K | B+ |
| `gpt-oss-free` | GPT-OSS 120B | 8 | 8 | 4 | 128K | A |
| `glm-air-free` | GLM 4.5 Air | 5 | 5 | 8 | 32K | C+ |
| `kimi-k2-free` | Kimi K2.6 Free | 8 | 7 | 8 | 256K | A+ |

**评估结论**: 
- **Kimi K2.6 Free** 是免费层最强模型 (256K + 强编码 + 中文好)，应作为免费编码首选
- **GPT-OSS 120B** 推理和编码均衡 (Codeforces 2622)，是免费层综合最强
- **Gemma 4 31B** 数学推理突出 (AIME 89.2%)
- 注意: 免费模型均有速率限制 (20 req/min, 200 req/day)

### 3.16 MiniMax 系列

#### MiniMax M3 -- id: `minimax-m3`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 9 | SWE-Bench Pro 59.0%，超越 GPT-5.5 |
| 推理能力 | 8 | 旗舰级推理 |
| 中文能力 | 9 | 国产模型，中文优秀 |
| 长上下文 | 10 | 1M 上下文 |
| 速度 | 8 | 官方称速度快于 Opus 4.7 |
| 性价比 | 9 | $0.30/$1.20，极低 |

**评估结论**: **当前最大发现**。M3 刚于 2026-06-01 发布，编码能力超越 GPT-5.5，1M 上下文，定价极低。建议立即将其提升为编码主力之一，并扩展 role 覆盖。

#### MiniMax M2.7 -- id: `minimax-m27`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 6 | 中等 |
| 推理能力 | 6 | 中等 |
| 中文能力 | 8 | 好 |
| 长上下文 | 8 | 128K |
| 速度 | 8 | 较快 |
| 性价比 | 8 | 合理 |

**评估结论**: 均衡模型，适合通用对话和内容分析。

#### MiniMax M2.5 -- id: `minimax-m25`

| 维度 | 评分 (1-10) | 说明 |
|---|---|---|
| 编码能力 | 5 | 轻量模型 |
| 推理能力 | 5 | 轻量 |
| 中文能力 | 8 | 好 |
| 长上下文 | 4 | 仅 32K |
| 速度 | 10 | 极快 |
| 性价比 | 9 | 极低价 |

**评估结论**: 适合高频轻量对话场景。

### 3.17 Embedding -- id: `bge-embedding`

BGE M3 是成熟的 embedding 模型，无需变更。

---

## 4. 六维能力评分矩阵

综合评分 (1-10) 矩阵，针对本项目的实际使用场景:

| 模型 | 编码 | 推理 | 中文 | 长上下文 | 速度 | 性价比 | 加权总分 |
|---|---|---|---|---|---|---|---|
| **GLM 5.1** | 9 | 9 | 10 | 8 | 7 | 8 | **8.6** |
| **Kimi K2.6** | 9 | 7 | 9 | 10 | 7 | 7 | **8.2** |
| **MiniMax M3** | 9 | 8 | 9 | 10 | 8 | 9 | **8.9** |
| **DeepSeek V4 Pro** | 9 | 10 | 9 | 10 | 6 | 10 | **9.1** |
| **DeepSeek V4 Flash** | 7 | 7 | 8 | 10 | 9 | 10 | **8.4** |
| Gemini 2.0 Flash | 7 | 6 | 7 | 10 | 10 | 9 | **8.2** |
| GPT-4o | 6 | 6 | 7 | 7 | 7 | 4 | **5.8** |
| GLM 4.7 Flash | 6 | 6 | 8 | 7 | 9 | 9 | **7.3** |
| Kimi K2.6 Free | 8 | 7 | 8 | 10 | 5 | 10 | **8.0** |
| GPT-OSS 120B Free | 8 | 8 | 4 | 8 | 5 | 10 | **7.3** |
| Gemma 4 31B Free | 7 | 8 | 5 | 8 | 6 | 10 | **7.3** |
| DeepSeek V3 (legacy) | 6 | 6 | 8 | 5 | 7 | 6 | **6.2** |
| DeepSeek Coder (legacy) | 5 | 4 | 7 | 3 | 8 | 5 | **5.0** |
| MiniMax M2.7 | 6 | 6 | 8 | 8 | 8 | 8 | **7.2** |
| MiniMax M2.5 | 5 | 5 | 8 | 4 | 10 | 9 | **6.7** |

> 加权总分 = (编码 x 0.25 + 推理 x 0.20 + 中文 x 0.15 + 长上下文 x 0.10 + 速度 x 0.10 + 性价比 x 0.20)

---

## 5. Agent 角色最优模型分配方案

### 5.1 Hermes Agent (深度研究 + 架构设计 + 心跳自动研究)

**需求**: 强推理 + 长上下文 + 编码理解 + 中文能力

| 优先级 | 模型 | 理由 |
|---|---|---|
| **主力** | **DeepSeek V4 Pro** (新增) | 推理第一 (GPQA 90.1%), 1M 上下文, 降价后性价比极高 |
| **P2** | **GLM 5.1** | 推理强 (AIME 95.3%), 中文最强, 编码亦佳 |
| **P3** | **MiniMax M3** | 1M 上下文, 编码强, 定价极低 |
| **P4** | **Kimi K2.6** | 256K 上下文, 编码强 |
| **Free** | **Kimi K2.6 Free** | 免费层最强选择 (256K + 编码) |

### 5.2 OpenCode (编码主力)

**需求**: 强代码生成 + 代码审查 + 长上下文理解仓库

| 优先级 | 模型 | 理由 |
|---|---|---|
| **主力** | **MiniMax M3** (新提升) | SWE-Bench Pro 59.0% (超 GPT-5.5), 1M ctx, $0.30/$1.20 |
| **P2** | **Kimi K2.6** | SWE-Bench Pro 58.6%, Code Arena 1529, 256K ctx |
| **P3** | **GLM 5.1** | SWE-Bench Pro 58.4%, 开源编程 SOTA |
| **P4** | **DeepSeek V4 Pro** (新增) | SWE-bench Verified 80.6%, LiveCodeBench 93.5% |
| **Free** | **Kimi K2.6 Free** | 免费编码首选 (256K) |
| **Free P2** | **Qwen3 Coder Free** | 编码专用免费模型 |

### 5.3 决策路由器 (auto-route / decision)

**需求**: 极快响应 + 低成本 + 足够准确

| 优先级 | 模型 | 理由 |
|---|---|---|
| **主力** | **DeepSeek V4 Flash** (新增) | $0.14/$0.28, 极快, 1M ctx, 质量远超 Nano |
| **P2** | **GLM 4.7 Flash** | 速度快, 成本低, 中文好 |
| **P3** | **MiniMax M2.5** | 极快 (120 RPM), 极低价, 中文好 |
| **P4** | **NVIDIA Nemotron 3 Nano** | 免费, 极快, 但 4K 上下文是硬伤 |
| **Free** | **GLM 4.5 Air Free** | 免费, 中文可 |

### 5.4 通用对话 (general-chat)

**需求**: 均衡性能 + 多语言 + 快速

| 优先级 | 模型 | 理由 |
|---|---|---|
| **主力** | **Gemini 2.0 Flash** | 1M ctx, 极快, 多模态, 低价 |
| **P2** | **MiniMax M3** | 1M ctx, 全能, 中文好, 低价 |
| **P3** | **MiniMax M2.7** | 均衡, 128K, 中文好 |
| **P4** | **GLM 5.1** | 全能旗舰 |
| **Free** | **Qwen3 Next 80B Free** | 免费通用 |

### 5.5 代码审查 (code-review)

**需求**: 深度代码理解 + 长上下文 (全仓库) + 推理

| 优先级 | 模型 | 理由 |
|---|---|---|
| **主力** | **GLM 5.1** | 编码强 + 推理强 + 中文强 |
| **P2** | **Kimi K2.6** | 256K ctx, 编码强 |
| **P3** | **MiniMax M3** | 1M ctx, 编码极强 |
| **P4** | **DeepSeek V4 Pro** (新增) | LiveCodeBench 93.5%, 1M ctx |
| **Free** | **GPT-OSS 120B Free** | 免费推理+编码最强 |

---

## 6. Fallback 链设计

### 编码任务 (main_coding / coding / code-generation)
```
MiniMax M3 → Kimi K2.6 → GLM 5.1 → DeepSeek V4 Pro → Kimi K2.6 Free → Qwen3 Coder Free
```

### 深度研究 (deep_research / research / rl)
```
DeepSeek V4 Pro → GLM 5.1 → MiniMax M3 → Kimi K2.6 → Kimi K2.6 Free
```

### 决策路由 (decision)
```
DeepSeek V4 Flash → GLM 4.7 Flash → MiniMax M2.5 → NVIDIA Nano
```

### 架构设计 (architecture)
```
GLM 5.1 → DeepSeek V4 Pro → MiniMax M3 → Kimi K2.6
```

### 通用对话 (general-chat)
```
Gemini 2.0 Flash → MiniMax M3 → MiniMax M2.7 → GLM 5.1 → Qwen3 Next Free
```

### 代码审查 (code-review / review)
```
GLM 5.1 → Kimi K2.6 → MiniMax M3 → DeepSeek V4 Pro → GPT-OSS 120B Free
```

### 评估 (evaluation)
```
GLM 5.1 → MiniMax M3 → GLM 4.7 Flash → Gemma 4 31B Free
```

---

## 7. models.ts 更新建议 (代码)

### 7.1 新增模型

```typescript
// ─── DeepSeek V4 Pro (新主力：研究/架构/编码) ───
{
  id: "deepseek-v4-pro",
  provider: "deepseek",
  model: "deepseek-v4-pro",      // 确认 DeepSeek API model name
  roles: [
    "decision",
    "architecture",
    "code-generation",
    "code-review",
    "general-chat",
    "research",
    "deep_research",
    "review",
    "math",
    "main_coding",
  ],
  contextWindow: 1000000,         // 1M context
  isFree: false,
  tags: ["paid", "main", "reasoning", "coding", "long-context", "sota"],
  rpmLimit: 60,
  concurrentLimit: 4,
  description: "DeepSeek V4 Pro — 综合最强模型 (推理/编码/长上下文，永久降价后性价比极高)",
  priority: 1,
  maxRetries: 3,
  timeout: 180000,
},

// ─── DeepSeek V4 Flash (快速决策路由) ───
{
  id: "deepseek-v4-flash",
  provider: "deepseek",
  model: "deepseek-v4-flash",     // 确认 API model name
  roles: ["decision", "general-chat", "general-tool", "evaluation"],
  contextWindow: 1000000,         // 1M context
  isFree: false,
  tags: ["paid", "fast", "cheap", "long-context"],
  rpmLimit: 120,
  concurrentLimit: 8,
  description: "DeepSeek V4 Flash — 极速低价路由 ($0.14/$0.28 per 1M)",
  priority: 1,
  maxRetries: 2,
  timeout: 60000,
},
```

### 7.2 更新现有模型

```typescript
// ─── GLM 5.1: 增加 deep_research 和 math 角色 ───
// 修改 roles:
roles: [
  "decision",
  "architecture",
  "code-generation",
  "code-review",
  "general-chat",
  "research",
  "deep_research",    // 新增
  "review",
  "general-tool",
  "math",             // 新增
  "main_coding",      // 新增
],

// ─── Kimi K2.6: 增加 deep_research 和 main_coding ───
roles: [
  "code-generation",
  "code-review",
  "coding",
  "general-tool",
  "review",
  "deep_research",    // 新增 (利用 256K 上下文)
  "main_coding",      // 新增
],

// ─── MiniMax M3: 扩展为核心编码模型 ───
roles: [
  "general-chat",
  "architecture",
  "decision",
  "research",
  "deep_research",    // 新增
  "review",
  "general-tool",
  "code-generation",  // 新增
  "code-review",      // 新增
  "coding",           // 新增
  "main_coding",      // 新增
],
// 更新 contextWindow 为 1000000 (M3 支持 1M)
contextWindow: 1000000,

// ─── MiniMax M3: 更新描述 ───
description: "MiniMax M3 — 编码旗舰 (SWE-Bench Pro 59.0% 超 GPT-5.5，1M context，$0.30/$1.20)",

// ─── Decision 路由: NVIDIA Nano 降级为 fallback ───
// 将 nvidia-nano priority 改为 4 (最低)
priority: 4,

// ─── DeepSeek V3: 标记为 deprecated ───
// 将 deepseek-v3 的 priority 改为 10, 并添加 deprecated tag
tags: ["deprecated", "reasoning", "coding"],
priority: 10,
description: "DeepSeek V3 — DEPRECATED: 请迁移到 DeepSeek V4 Pro",

// ─── DeepSeek Coder: 标记为 deprecated ───
tags: ["deprecated", "coding"],
priority: 10,
description: "DeepSeek Coder — DEPRECATED: 请使用 Kimi K2.6 / GLM 5.1",

// ─── Hermes Evolution: 降级为 free fallback ───
// 移除 deep_research role (改用 DeepSeek V4 Pro)
roles: ["rl", "research", "evaluation"],
priority: 3,

// ─── GPT-4o: 降级 ───
priority: 5,
description: "GPT-4o — 性价比差，仅作 fallback",

// ─── Qwen3 Coder Free: 提升为免费编码首选之一 ───
// (无需修改，仅确认优先级)

// ─── Kimi K2.6 Free: 确认为免费层最强 ───
// 增加 coding 和 code-review role
roles: ["coding", "code-generation", "code-review", "general-tool"],
```

### 7.3 去重

```typescript
// 移除重复的 llama-3.3-free (与 llama-english 完全相同)
// 保留 llama-english 并更新其 roles
{
  id: "llama-english",
  provider: "openrouter",
  model: "meta-llama/llama-3.3-70b-instruct:free",
  roles: ["english", "general-tool"],  // 合并两个条目的 roles
  contextWindow: 131072,
  isFree: true,
  tags: ["free", "english"],
  rpmLimit: 60,
  concurrentLimit: 2,
  description: "Llama 3.3 70B — free English & general tasks",
},
// 删除 llama-3.3-free 条目
```

### 7.4 Provider Config 更新

```typescript
// 如果 OfoxAI 支持 Gemini 3.5 Flash，更新 gemini-flash 模型名:
{
  id: "gemini-flash",
  provider: "ofoxai-gemini",
  model: "gemini-3.5-flash",    // 从 gemini-2.0-flash 升级 (如可用)
  // ... 其余不变
}
```

---

## 8. 成本估算

### 8.1 场景假设

假设日均使用量:
- 编码任务: 500K input + 200K output tokens/天
- 研究任务: 300K input + 100K output tokens/天
- 决策路由: 200K input + 50K output tokens/天
- 通用对话: 400K input + 200K output tokens/天
- 代码审查: 200K input + 80K output tokens/天

**日均总量**: ~1.6M input + ~630K output tokens

### 8.2 当前配置月度成本

| 任务 | 模型 | 月 Input 成本 | 月 Output 成本 | 月总计 |
|---|---|---|---|---|
| 编码 | GLM 5.1 | $0.52 | $26.40 | $26.92 |
| 研究 | Hermes 405B | $0 (免费) | $0 (免费) | $0 |
| 决策 | Nemotron Nano | $0 (免费) | $0 (免费) | $0 |
| 通用 | Gemini 2.0 Flash | $0.36 | $2.40 | $2.76 |
| 审查 | GLM 5.1 | $0.21 | $10.56 | $10.77 |
| **月度总计** | | | | **~$40.45** |

### 8.3 推荐配置月度成本

| 任务 | 模型 | 月 Input 成本 | 月 Output 成本 | 月总计 |
|---|---|---|---|---|
| 编码 | MiniMax M3 | $0.14 | $3.60 | $3.74 |
| 研究 | DeepSeek V4 Pro | $0.32 | $2.61 | $2.93 |
| 决策 | DeepSeek V4 Flash | $0.84 | $0.42 | $1.26 |
| 通用 | Gemini 2.0 Flash | $0.36 | $2.40 | $2.76 |
| 审查 | GLM 5.1 | $0.21 | $10.56 | $10.77 |
| **月度总计** | | | | **~$21.46** |

### 8.4 成本节省

- **月度节省**: ~$18.99 (47% 降低)
- **年度节省**: ~$227.88
- **质量提升**: 编码 SWE-Bench Pro 58.4% → 59.0%，推理 GPQA ~88% → 90.1%

> 注: 以上为估算，实际成本取决于缓存命中率、实际 token 使用量、各提供商计费方式差异。
> 免费模型 (Kimi K2.6 Free, Qwen3 Coder Free) 作为 fallback 可进一步降低成本。

### 8.5 全免费方案 (极限省钱)

如果全部使用免费模型 (承受速率限制):

| 任务 | 模型 | 月成本 | 质量影响 |
|---|---|---|---|
| 编码 | Kimi K2.6 Free | $0 | 编码能力接近付费主力 |
| 研究 | Kimi K2.6 Free | $0 | 256K 上下文够用 |
| 决策 | GLM 4.5 Air Free | $0 | 够用 |
| 通用 | Qwen3 Next 80B Free | $0 | 可用 |
| 审查 | GPT-OSS 120B Free | $0 | 推理好但中文弱 |
| **月度总计** | | **$0** | |

**代价**: 速率限制 (20 RPM / 200 RPD)，中文能力下降，高峰期可能排队。

---

## 9. 风险与注意事项

### 9.1 API 兼容性风险

- **DeepSeek V4 Pro/Flash**: 需确认 `deepseek` provider 的 `baseURL` 是否支持 V4 系列 API。可能需要更新 model name 为 `deepseek-v4-pro` / `deepseek-v4-flash`。
- **Gemini 3.5 Flash**: 需确认 OfoxAI Gemini 代理是否已上线 3.5 Flash。
- **MiniMax M3**: 刚发布 (2026-06-01)，API 稳定性待验证。10 天内开源。

### 9.2 速率限制

- 免费模型: 20 req/min, 200 req/day (OpenRouter)
- 付费模型: 注意各 provider 的 RPM 限制，高并发场景需合理配置 `concurrentLimit`
- 建议: 为免费模型实现 token bucket 或 sliding window 限流

### 9.3 中文能力

- Llama 系列、Gemma 系列、GPT-OSS 中文能力弱，不适合中文密集任务
- 中文任务优先: GLM 5.1 > MiniMax M3 > Kimi K2.6 > DeepSeek V4 > Qwen3

### 9.4 模型时效性

- GPT-4o (2024年模型) 已严重落后，建议 2026 Q3 前淘汰
- DeepSeek V3 (2024年模型) 已被 V4 替代
- DeepSeek Coder (legacy) 应立即标记 deprecated
- Gemini 2.0 Flash 可能被 3.5 Flash 替代

### 9.5 数据隐私

- 国产模型 (DeepSeek, GLM, Kimi, MiniMax) 数据在国内，合规性好
- OpenRouter 免费模型数据经美国，敏感项目慎用
- OfoxAI 为代理平台，需确认数据路由路径

### 9.6 下一步行动

1. **立即**: 将 MiniMax M3 提升为编码主力 (已注册，仅需更新 roles)
2. **本周**: 新增 DeepSeek V4 Pro / V4 Flash 到注册表
3. **本周**: 更新 Fallback 链优先级
4. **下周**: 实测各模型在 OpenClaw 实际任务中的表现，验证评分
5. **月度**: 跟踪 benchmark 更新，每季度重新评估

---

## 附录 A: 数据来源

| 来源 | URL | 数据时间 |
|---|---|---|
| Swfte AI Leaderboard | swfte.com/ai/leaderboard | 2026-05 |
| LM Arena (原 LMSYS) | lmarena.ai | 2026-05 |
| DataLearner | datalearner.com | 2026-06 |
| Artificial Analysis Coding Agent | artificialanalysis.ai | 2026-05-12 |
| DeepSeek 官方 | deepseek.com | 2026-05-22 |
| 智谱 AI 官方 | zhipuai.cn | 2026-04-08 |
| MiniMax 官方 | minimax.chat | 2026-06-01 |
| Moonshot/Kimi 官方 | moonshot.cn | 2026-04-20 |
| SiliconFlow | siliconflow.com | 2026-06 |
| OpenRouter | openrouter.ai | 2026-06 |

## 附录 B: Benchmark 说明

| Benchmark | 衡量维度 | 满分 | 说明 |
|---|---|---|---|
| SWE-Bench Verified | 真实软件工程 | 100% | 2,294 个 GitHub issue 修复 |
| SWE-Bench Pro | 高难度软件工程 | 100% | 更难的子集 |
| LiveCodeBench | 实时编程 | 100% | 竞赛级编程题 |
| GPQA Diamond | 科学推理 | 100% | PhD 级科学问答 |
| AIME 2025/2026 | 数学竞赛 | 100% | 高中数学竞赛 |
| Code Arena Elo | 综合编程 | 无上限 | 真实开发者盲评对战 |
| HumanEval | 代码生成 | 100% | 164 个 Python 函数 |
| Codeforces | 竞赛编程 | 无上限 | 在线竞赛评分 |
