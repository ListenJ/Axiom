# 2026 年 Agent 评测基准与方法学调研 — 2026-09-05

> 委托：真实评测 + 真实场景测试集 + 基准标定任务（2026-09-05 计划 Phase D）的最新研究完善。方法：arxiv API 直检索（WebSearch/WebFetch 因后端摘要模型不可用而绕行），按 2026-08~09 提交排序取相关论文并读摘要；结论标注 事实（论文原文）/ 判断（本项目落地判断）。

## 摘要

2026 年的 agent 评测呈现三个明确转向：(1) **从"只看最终答案"转向"轨迹级（trace-aware）评测"**——ClawProBench 在 OpenClaw 运行时上实测证明 final-answer 排行榜会掩盖原生工具面弱点与单次偶然成功；(2) **从"LLM judge 泛化"转向"确定性/可验证验证器 + Agent-as-a-Judge"**——LLM-as-a-Judge 的偏差、浅层单次推理与无法核对真实观测已被多篇论文量化（跨骨干一致性 κ≤0.231），HVTB 证明人类检查与 LLM judge 都不可靠，可嵌入的确定性 hack 检测才可靠；(3) **从"单次静态增益"转向"持续学习 + 回归控制"**——"优化增益只在把回归控制内建进循环时才复合"直接印证本项目 S5 的 autoCheckRegression 设计。三路 provider 同模型不同 harness 结果不同的实测（Same Model, Different Harness）为本项目三路全铺基准提供直接依据。

## 来源

| arXiv | 标题（2026） | 与本项目的关系 |
| --- | --- | --- |
| 2608.22510 | ClawProBench: Trace-Aware Evaluation with Runtime Coverage and Frozen Holdouts | 强对标：frozen holdout + JSON 输出契约 + 安全门打分 + 轨迹评分 |
| 2608.26218 | Same Model, Different Harness: Different Coding-Agent Results | 直接依据：三路 provider 全铺的必要性 |
| 2609.02783 | EarlyEval: Cheaper Agent Evaluation via Early Outcome Prediction | 成本优化：提前终止预测，省 13-26% 步 / 44% 输入 token |
| 2601.05111 | Agent-as-a-Judge（survey） | LLM-as-a-Judge 局限 → agentic judge 转向 |
| 2604.04532 | Multilingual Prompt Localization for Agent-as-a-Judge | 跨骨干 judge 一致性 κ≤0.231；语言可翻转排行 |
| 2608.22103 | Hack-Verifiable Terminal Bench (HVTB) | 人类检查/LLM judge 不可靠 → 可嵌入确定性 hack 检测 |
| 2607.14004 | Do Agent Optimizers Compound? (Terminal-Bench 2.0) | 回归控制内建才复合 → 印证 S5 autoCheckRegression |
| 2608.15089 | StateM: Harness Scaling (Terminal-Bench 2.1, 95.3%) | 长程失败 = 丢状态/不重激活经验 → 印证 self-evolve |
| 2607.08964 | Long-Horizon-Terminal-Bench | 只看最终结果漏中间进展；dense reward / 部分分 |
| 2606.29537 | OSWorld 2.0 | 专业级 computer-use 仍远（top 20.6%）；丢约束/漏信息/猜而非问 |
| 2608.28641 | Terminal-Bench-LILT | 非英语编码能力独立轴；最强模型仅 63.1% |
| 2604.18240 | AJ-Bench | 规则验证器/LLM judge 泛化差 → Agent-as-a-Judge 互动取证据 |

## 关键结论

### 1. 轨迹级评测是主流方向（事实）
ClawProBench 定义「模型 + 运行时」为评测单元，失败可发生在证据获取、运行时路由、安全边界、重复执行四类；用安全门公式（正确性 + 过程质量 + 效率）从轨迹评分。实测：原生运行时任务（0.5238）明显低于 workspace-live（0.6415）；full/holdout 排行 Spearman 仅 0.13 → **holdout 衡量的是另一种泛化**。final-answer 排行榜会隐藏原生表面弱点与一次偶然成功。
**对本项目**（判断）：我们的 6 族 AssertionSpec 是"输出契约级"确定性验证，方向与 ClawProBench 的 closed-world JSON 输出契约一致；但要声明局限——我们没有测运行时真实多步轨迹，未来可沿 ClawProBench 的 trace 评分扩展。

### 2. 确定性验证器 > LLM judge（事实 + 判断）
Agent-as-a-Judge survey：LLM-as-a-Judge 受偏差、浅层单次推理、无法核对真实观测约束。跨语言/骨干实测：无单一骨干全胜，需求级判罚互一致性 κ≤0.231，judge 侧指令本地化可翻转排行。HVTB：人类检查与 LLM judge 对 reward hacking 的检测都不可靠，嵌入可检测 hack 的确定性环境才可靠。
**对本项目**（判断）：S4「确定性规则验证器优先 + LLM judge 兜底留接口」的取舍被 2026 研究正面支持；新 12 任务全走 AssertionSpec 正是此路线的延续。

### 3. 回归控制是持续进化的前提（事实）
Do Agent Optimizers Compound：三种优化法在静态单阶段全优于基线，但引入新任务后分化——GEPA 迁移后低于未优化基线，Meta Harness 可迁移但二轮不再提升，唯一持续复合的 RELAI-VCL 把回归控制内建进优化循环（防捷径解不泛化）。
**对本项目**（判断）：S5 的 autoCheckRegression + 分级退出码（回归 2 > 能力失败 1 > 正常 0）与 RELAI-VCL 结论同构——我们已在机制层做了正确的事；evolve 闭环（train 归纳 → held-out 注入 → 回归检测）正是"复合增益"的评测实现。

### 4. 三路 provider 基准的必要性（事实）
Same Model, Different Harness：同模型同任务，只换 harness（看什么/工具/续做方式）结果就不同。
**对本项目**（判断）：三路 provider 全铺（opencode / zhipu / sensenova 三个不同端点即三个不同 harness）是正确基线设计——模型相同但端点/harness 不同，能力表现可差异。

### 5. 长程/过程性能力是未开发空间（事实）
Long-Horizon-Terminal-Bench：最强模型仅 15.2% pass@1（0.95 部分分阈值）；只按最终结果评分会漏掉中间进展，dense reward / 部分分更完整。StateM：长程失败源于丢可变状态、不重激活先前经验、跳过已知流程、过早停止。OSWorld 2.0：top 代理仅 20.6%，失败模式=丢约束、错过任务中途信息、猜而不问用户、跳过验证。
**对本项目**（判断）：我们的自进化（evolve 归纳经验并注入）直接对应 StateM 的"重激活经验"杠杆；本套件暂无长程多步真实执行任务（外部 HumanEval/MBPP docker 沙箱是单步补偿），Phase C 定位中如实声明。

## 对 Phase B 任务设计的落点（判断）

- KNOW/TOOL 族"Agent 本体知识 + 真实工具 schema"类任务：2026 基准普遍承认 final-answer 会掩盖工具面弱点 → 本体知识/工具参数构造类任务有独立评测价值。
- EVOLVE 族"从失败提炼教训 / 先反馈回路再假设"：对应 StateM 的重激活经验与 Long-Horizon 的调试能力轴。
- 确定性 AssertionSpec：正面支撑见结论 2；未来若加 LLM judge 兜底，须先做跨骨干一致性校准（见 Multilingual Localization 教训）。

## 局限与下一步（判断）

- WebSearch/WebFetch 后端摘要模型不可用（sensenova-u1.5-lite），本次改走 arxiv API 直检索；来源为 arxiv 摘要级，未深读全文。
- 下一步可选：① 对齐 ClawProBench 增加一条"真实运行时多步轨迹"评测轨；② 引入 EarlyEval 式提前终止降本（对长超时 provider 尤有价值）；③ 长程任务族（long-horizon）作为第 7 族候选（本次按用户选定未新增）。
