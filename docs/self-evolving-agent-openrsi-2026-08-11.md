---
type: research-note
created: 2026-08-11
tags: [self-evolution, openrsi, rise, research, design]
---

# 自我进化 Agent —— OpenRSI / RISE 思想拆解与 Axiom 简约落地设计（2026-08-11）

## 摘要

本文件记录对清华大学相关开源项目 **OpenRSI**（Frontis.AI × 清华，项目页 frontisai.github.io/OpenRSI，GitHub FrontisAI/OpenRSI，论文 arXiv 2607.28568）与清华 **RISE**（Recursive IntroSpEction，arXiv 2407.18219）的调研结论，并给出 Axiom（本地优先、轻量、简单为主基调）可落地的**测试时自我进化**设计。核心判断：OpenRSI 的训练级自我进化（35B 模型 SFT+RL+进化搜索，非商用许可）不适合直接照搬；我们借鉴其**原子算子（Draft/Improve/Debug/Crossover）+ 执行反馈回路**的思想，但降级为**提示词级算子 + 确定性评估**，用 1 个小模块实现"针对性自我思考 / 自觉检索强背书资料 / 基于知识库的自推理归纳"三件事，无需训练、无需额外基础设施。

## 来源（事实）

| 来源 | 链接 | 关键结论 |
| --- | --- | --- |
| OpenRSI GitHub | https://github.com/FrontisAI/OpenRSI | 自我进化机制阶梯 L1 进化 → L2 自我进化 → L3 元进化 → L4 RSI |
| OpenRSI 项目页 | https://frontisai.github.io/OpenRSI/ | 原子操作算子 Draft/Improve/Debug/Crossover；OpenMLE 栈 Gym/ERL/Evo/Frontis-MA1 |
| OpenRSI 论文 | arXiv 2607.28568 | MLE-Bench Lite 39.39%→60.61%（post-training）→71.21%（Evo-Max）；NatureBench 模型迁移 50→70%、框架迁移 20→50% |
| RISE 论文 | arXiv 2407.18219（Yuxiao Qu 等） | 迭代微调教模型在错误尝试后递归修改回答；单轮 prompt 微调建模为多轮 MDP；数学推理逐轮提升 |

## OpenRSI 核心机制（事实）

1. **机制阶梯（L1→L4）**：
   - L1 Evolution：冻结改进器（improver）固定 prompt，只改进目标答案；
   - L2 Self-Evolution：经验回流搜索，改进器基于历史经验自我调整；
   - L3 Meta-Evolution：训练改进器本身（SFT + RL）；
   - L4 RSI（Recursive Self-Improvement）：改进器改进自身，形成递归回路。
2. **四个原子操作算子**（事实）：
   - Draft：生成初始方案；
   - Improve：根据执行反馈改进方案；
   - Debug：对失败轨迹定位与修复；
   - Crossover：重组多个成功方案/片段。
3. **单位训练 = 单位搜索**：改进器由沙箱执行反馈（Gym）驱动的 SFT+RL 训练，再组合成长程搜索（OpenMLE-Evo）。这是"用训练换搜索能力"的范式。
4. **许可**：CC BY-NC 4.0（非商用）——直接复制其训练流程/权重到商业/本地产品有许可与算力双重门槛。

## RISE 核心思想（事实）

- 核心命题：**测试时自我改进**（test-time self-improvement）比推理时直接想更有效——让模型先尝试、失败、再递归地修正自己的回答。
- 方法：把"单轮 prompt 的微调"建模为多轮 MDP（markov decision process），用错误尝试作为训练信号，迭代微调。
- 对 Axiom 的启发：不需要等下一次"训练"，在**当次任务内**即可用"尝试 → 反馈 → 修正"的回路改进执行质量。

## 独立判断（判断）

1. **直接照搬不现实**（判断，依据：许可 CC BY-NC、35B 模型训练成本、12h/任务级长程搜索、Axiom 本地优先轻量定位）：OpenRSI 是"重训练换能力"，Axiom 应走 **RISE 式测试时改进 + OpenRSI 式算子编排** 的轻量路线。
2. **算子可降级**（判断）：Draft/Improve/Debug/Crossover 是通用编排模式，不依赖模型权重。用提示词模板实现同一套算子，复用现有 router（模型动态分配、fallback、熔断），即可获得 80% 的编排收益、接近 0 的工程成本。
3. **确定性评估优于黑盒强化**（判断）：对本地 Agent，"置信度精算"用**可解释的确定性公式**（证据数量 × 相关性 × 权威性 → 0-1 置信度），"归纳"用**可验证的模式统计**（术语共现 + 成功率），比 RL 奖励函数更简单、可测试、可审计。RL 训练留作远期可选增强（见下）。
4. **用户三需求的对应**（判断）：
   - 需求 1（针对性自我思考）→ `selfThink`：输入 = 用户输入 + 当前项目上下文 + 检索到的证据，输出 = 目标/假设/计划/风险/置信度 的结构化思考；
   - 需求 2（自觉检索强背书资料 + 知识库自推理精算/归纳）→ `retrieve`（默认从黑板/库中取高置信度经验，可注入 web/向量检索）+ `estimateConfidence`（精算）+ `selfInduce`（归纳）+ `selfImprove` 成功后把教训写回知识库；
   - 需求 3（简单主基调）→ 整个模块 = 1 个深模块（小接口：selfThink / selfImprove / selfInduce / estimateConfidence），纯依赖注入、无新增基础设施。

## Axiom 落地设计（与 OpenRSI 算子对照）

| OpenRSI 原子算子 | Axiom 提示词级算子 | 落点 |
| --- | --- | --- |
| Draft | 初始计划（selfThink 生成 plan） | `src/self-evolve/engine.ts` |
| Improve | 成功轨迹 → 提炼教训 + 收紧计划 | `selfImprove(success=true)` |
| Debug | 失败轨迹 → 定位错误 + 修订计划 | `selfImprove(success=false)` |
| Crossover | 历史成功教训注入（store.list → 上下文重组） | `selfImprove` 的 priorLessons 参数 |
| 沙箱执行反馈（Gym） | 调用方提供 `{action, outcome, success}` 反馈 | `ImproveFeedback` 接口 |
| SFT+RL 训练改进器 | 教训写回知识库（vault 原子笔记 + 黑板），下次检索复用 | `store.write` / 黑板 |

### 模块接口（小接口，大实现）

- `selfThink({ input, project?, priorLessons? }) → SelfThought`
  - 检索证据 → 组装"目标-依据-自检"提示 → LLM 输出结构化思考 → 确定性置信度精算 → JSON 解析 + 降级兜底。
- `selfImprove({ task, feedback, priorLessons? }) → Improvement`
  - 成功 → Improve 算子（提炼教训，写回知识库）；失败 → Debug 算子（修订计划，不写教训）。
- `selfInduce(traces[]) → Induction[]`
  - 对历史轨迹做术语共现 + 成功率统计，输出"高支持度 + 高成功率"的可复用模式（确定性，无 LLM）。
- `estimateConfidence(evidence[]) → number`
  - 精算：base 0.4 + 强证据加成，封顶 0.95，可解释、单调、可测试。

### 默认依赖（不写死，全部可注入）

- `think`：默认 `router.executeWithRole("general-chat", ...)`（模型/密钥由用户配置，无硬编码）。
- `retrieve`：默认从黑板读取 `self-evolve` 标签下的高置信度经验；调用方可注入知识库/向量/web 检索器。
- `store`：默认写入 vault `00-Meta/self-evolve/lessons/` + 黑板事实（带 `self-evolve` 标签）；调用方可替换。

## 远期增强（明确不做，避免投机）

- RL 级自我进化（对齐 OpenRSI L3/L4）：需要训练基建与算力，暂不作为本次范围；接口已预留 `think`/`store` 替换点，未来可无缝升级。
- 多模态/长程搜索（OpenMLE-Evo）：等检索器与算力成熟后再接。

---
*研究完成：2026-08-11。事实部分以官方仓库/论文为准，判断部分已标注。*
