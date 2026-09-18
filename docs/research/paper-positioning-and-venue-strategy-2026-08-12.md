---
type: research-note
created: 2026-08-12
tags: [research, ccf, paper, venue-strategy, positioning, literature]
---

# 论文定位与投稿策略综合评估（2026-08-12）

## 摘要

针对「全部投入冲 CCF-A、被拒后转投是否合理」与「我们当前工作是工程论文还是研究论文」两个问题，基于 12+ 篇核心文献、5 份官方投稿政策与 3 份并行子代理调研综合判断：

1. **冲 A 被拒转投合法且普遍，但前提苛刻**：顺序投递（拒稿后才投下一家）、实质修改、时间充裕、novelty 足够。IJCAI 要求 12 个月内被拒重投必须声明并上传拒稿版+审稿意见；arXiv 预印本不触一稿多投红线但会泄匿名。
2. **当前系统定位为工程原型**：属于 239 篇综述中 68% 的 scaffold 更新路线，机制与 Reflexion / MARS / AgentRR / Voyager 高度重叠；三个工程特征（统计门控归纳、幂等技能注册、MCP 可调用闭环）有潜在新意但未经实验验证，尚不能宣称研究贡献。
3. **原课题 A 的「held-out 空白」已被 2026-06 的 SEAGym / RSEA 大幅抢占**（RSEA 的三层 NL 状态与我们的轨迹/教训/技能惊人相似）；「<30%」是二手报道失真，正确口径约 12%。差异化空间收窄为「评估偏差归因 + 跨任务族 held-out 迁移矩阵 + 污染量化」三位一体的评测协议研究，且必须先回应 matched-budget 公平基线质疑。

## 一、投稿策略事实（官方）

- **一稿多投红线**：AAAI / IJCAI-ECAI / NeurIPS / ICML / ACL-ARR 官方 CFP 全部禁止「同一稿件同时投多个 archival venue」，审稿期内不得他投；违规 desk reject 并可能跨会通报。arXiv 预印本不算 archival，不触红线。
- **拒稿重投**：IJCAI-ECAI 2026 要求声明过去 12 个月内的被拒经历，上传最新被拒版（可匿名）+ 审稿意见，cover letter 可选；材料仅在评审提交后（讨论阶段）对审稿人可见，审稿人被鼓励核对旧意见是否已修复。ARR 要求链接旧稿逐条回应，meta 低分禁投。
- **Findings / journal track**：ACL 主会未入选**自动**考虑进 Findings；EMNLP Findings 走 ARR commitment；AAAI journal track 是「已发表期刊论文到 AAAI 报告」，AIJ / JAIR 为邀请制——这些都不是「被拒后转投」机制。
- **时间账**：AAAI≈3.5 个月、IJCAI≈3.5 个月、NeurIPS≈4.5 个月、ICML≈4 个月审稿周期，一年最多 2–3 轮。
- **双盲**：六个场所全部 double-blind，泄露身份 desk reject。

## 二、判断：冲 A 被拒转投是否合理

**合理但有前提（判断）**：顺序投递 + 实质修改（IJCAI 会核对旧意见）+ 时间充裕 + novelty 足够。**不合理场景**：deadline 紧（毕业/考核）、novelty 弱只碰运气、同领域审稿人池重叠（论文越投越旧）、无时间大改。

**替代方案**：① demo/workshop（NeurIPS/ICML 允许无 proceedings 版本）；② Findings；③ 期刊 TMLR / JAIR / AIJ / TACL（需大改，TMLR 不收会议扩展版）；④ arXiv 占位（保持匿名）。

**时间线（判断）**：IJCAI 2027（约 2027-01 截稿、4 月拒）→ 可赶 NeurIPS 2027（约 5 月初）、EMNLP 2027（ARR 5 月 cycle）、AAAI-28（2027 年 7–8 月）；期刊滚动可随时投。

## 三、文献定位：工程论文还是研究论文

### 文献表（核心 12 篇）

| 论文 | 会议/年份 | 类型 | 与我们的关系 |
| --- | --- | --- | --- |
| Frontis-MA1 / OpenMLE（2607.28568，清华 OpenRSI） | 2026-07 arXiv | 训练型 RSI（35B SFT+RL + 程序进化算子） | 训练路线上界参照；已内置数据去重 + held-out NatureBench 转移验证 |
| RISE（2407.18219） | NeurIPS 2024 | 训练型递归自省 | 与 selfThink/selfImprove 功能对齐，但能力内化进权重 |
| Reflexion（2303.11366） | NeurIPS 2023 | 无训练语言反思+episodic memory | selfImprove + 轨迹记忆的鼻祖 |
| Self-Refine（2303.17651） | NeurIPS 2023 | 无训练单轮自反馈 | selfThink 基础；我们是跨会话持久化 |
| OpenR（2410.09671） | 2024 arXiv | test-time 搜索 + PRM/RL | selfThink 置信度精算同属 test-time，但无 PRM |
| Voyager（2305.16291） | NeurIPS 2023 | 无训练技能库（代码+环境验证） | 技能化最像；差异：文本技能+统计门槛+可调用 |
| ADAS（2408.08435） | ICLR 2025 | 元 agent 演化 agent 程序 | 演化对象是架构，我们是记忆/技能 |
| EvoAgent（2406.14228） | NAACL 2025 | 进化生成多 agent 种群 | 我们生成可复用技能而非角色 |
| MARS（2601.11974） | 2026-01 arXiv | 原则+流程双提取反思 | 教训蒸馏最近亲；我们多统计归纳+技能注册 |
| AgentRR（2505.17716） | 2025-05 arXiv | 双粒度 record & replay | 轨迹+策略双层对应；我们加第三层技能 |
| Self-Evolving Agents 综述（2507.21046） | TMLR 2026-01 | 三维分类框架 | 我们属 inter-test-time、无训练、记忆/工具层 |
| Self-Improvements in Modern Agentic Systems（2607.13104） | 2026-07 arXiv（239 篇） | 系统级综述；68% 走 scaffold 更新 | 我们正落在这条主流路线，最大风险是评估 |

### 机制对照结论

- selfThink ≈ Self-Refine / Reflexion / RISE（经典反思范式）
- 轨迹记忆 ≈ Reflexion / AgentRR（文献成熟）
- 教训蒸馏 ≈ Reflexion → MARS 主线（**基本复刻**）
- 归纳成技能 ≈ Voyager 技能库（差异：文本技能、统计门槛、幂等注册、MCP 可调用）

**少见组合（工程空白，非原理空白）**：① 无训练 + 三层记忆完整闭环；② 支持度/成功率统计门槛归纳；③ 技能注册为具名幂等、模型可主动调用的资产（文献主流停在检索后注入上下文）。

**定位判断（判断）**：当前是「复现 + 工程集成」，三个工程特征有潜在新意但**缺验证**；若升级为研究论文需补：held-out 跨会话评测、消融（去门槛/去注册 vs 上下文注入）、漂移/遗忘与安全性分析。

## 四、评估空白复核（课题 A 是否仍成立）

### 竞争工作（2026 已出现）

- **SEAGym**（2606.17546）：harness 自进化评估环境，train/val/test/replay/ID/OOD/cost 五视图，Terminal-Bench 2.0 + HLE；结论：频繁更新未必提升 held-out、中间快照会崩溃、跨模型迁移不对称。
- **RSEA**（2606.28374）：三层 NL 状态（strategy/skills/playbook）+ held-out keep-better 门；4 基准 × 6 基线 × 单 7B backbone；消融证明去门严重过拟合。**与我们三层记忆机制惊人相似，且已做门控与消融**。
- 2607.12227：matched budget 下 harness evolution 并不稳定优于简单 test-time scaling——**直接质疑自进化增益本身**。
- EvoAgentBench（2607.05202）：4 域能力迁移（528/267 split），无自动方法全场景正增益。
- PACE（2606.08106）：贪心提交 30–42% 假编辑（接受测试空白）。
- 2608.05810：技能池污染结构性不可逆。

### 空白判定（判断）

方法级 held-out 门控（RSEA）、环境级五视图（SEAGym）、跨域能力迁移（EvoAgentBench）**均已被抢占**；剩余差异化 =「**评估偏差归因 + 跨任务族 held-out 迁移矩阵 + 污染量化**」三位一体的评测协议研究，且入场前必须先回应 2607.12227 的 matched-budget 公平基线质疑。

### 数据修正（事实）

「held-out 采用率 <30%」出自 2026-07 二手报道（gentic.news/dev.to 转述 239 篇综述），**正确口径约 12%**；239 篇综述本体（2607.13104）摘要未见 12%/30% 数字。引用时必须溯源到报道，不能当作论文统计。

## 五、综合结论（判断）

1. **当前工作 = 工程系统，不是研究论文**：可支撑 demo/system 论文（EMNLP/ACL demo）、CCF-B 期刊或 arXiv 技术报告；直接作为 A/B 类主会研究论文的依据不足。
2. **要成为投稿论文（研究类）**，需二选一做出可验证的研究问题，并用 3 个月可行性实验确认 novelty：
   - **方向甲（评测协议论文）**：「自进化评估偏差归因 + 跨任务族 held-out 迁移矩阵 + 污染量化」三位一体协议——空白部分成立，但需先回应 matched-budget 质疑，工程量大。
   - **方向乙（方法论文）**：「统计门控的经验→技能注册机制」（无训练三层记忆 + 幂等技能 + 可调用闭环）配 held-out 跨会话评测 + 消融 + 漂移/遗忘分析——与 RSEA 直接竞争，差异化在「主动可调用技能 vs 被动注入」，需先证明净增益。
3. **策略建议**：**不要现在决定「全部投入 A」**。先用 GLM 免费模型跑方向甲或乙的 3 个月可行性实验；同时用当前工程完成度写 demo/system 论文保底（两者不是并行投稿，互不冲突）。可行性数据出来后再决定冲 A（IJCAI 2027 / AAAI-28）还是稳投 B/期刊。
4. **风险**：A 类录用率 17–23%；2026 竞争密集、审稿人池重叠；IJCAI 重投声明会暴露旧稿+旧意见，实质修改是硬要求；LLM 写作检测（IJCAI 用检测工具，LLM 撰写会被 desk reject，只能润色）。

## 来源

- IJCAI-ECAI 2026 Submissions FAQ / CFP（官方）；AAAI-26 / NeurIPS 2025 / ICML 2026 / ACL Rolling Review CFP（官方）
- arXiv：2607.28568（Frontis-MA1/OpenRSI）、2407.18219（RISE）、2303.11366（Reflexion）、2303.17651（Self-Refine）、2410.09671（OpenR）、2305.16291（Voyager）、2408.08435（ADAS）、2406.14228（EvoAgent）、2601.11974（MARS）、2505.17716（AgentRR）、2507.21046（综述）、2607.13104（239 篇综述）、2606.17546（SEAGym）、2606.28374（RSEA）、2607.12227、2607.05202、2606.08106、2608.05810
- 三个并行子代理调研（投稿策略 / 文献图谱 / 评估空白），2026-08-12

*事实以官方政策与论文摘要为准；判断为作者独立判断。*
