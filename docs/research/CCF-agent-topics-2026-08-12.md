---
type: research-note
created: 2026-08-12
tags: [research, ccf, paper, agent, topic-selection]
---

# CCF 论文课题筛选（2027 年 3 月前可完成）

## 摘要

基于 2025–2026 年 LLM Agent 领域最新综述与论文（web 检索，来源见下），结合本项目已实现的基建（self-evolving agent、工具循环与幻觉拦截雏形、知识库图/视频理解、记忆蒸馏/归档），筛选 3 个"当下空白 + 约 7 个月（至 2027.03）可完成"的候选课题，并给出推荐排序、目标会议与时间线。判断部分已标注。

## 来源与关键结论（事实）

| 来源 | 关键结论 |
| --- | --- |
| Self-Evolving Agents 综述（Stanford/Scale, 2026-01） | 自我进化按 what/when/how 三维组织，含 intra-/inter-test-time 维度；是系统化首篇综述 |
| 239-paper 自进化调查（2026-07） | **68% 的自进化方法走 scaffold 更新而非重训练**；**评估质量担忧：held-out benchmark 采用率 <30%**——泛化/污染是明显空白 |
| "I Don't Know Filter"（2026-07） | 函数调用可靠性：显式"不知道"过滤可提升 agentic reliability——工具循环的可靠性仍是开放问题 |
| Auditing Tool-Using Agents（2026-08） | 运行时拦截（runtime interception）在所有被测模型上降低幻觉（最高 -23pp）——**拦截策略的系统化比较是空白** |
| Memory for Autonomous LLM Agents 综述（2026-03） | 开放挑战：**continual consolidation、causally grounded retrieval、trustworthy reflection、learned forgetting、multimodal embodied memory**；瓶颈是检索质量而非存储 |
| StructMemEval / Incremental Memory（2026） | retrieval-only 无法解决结构记忆问题；增量多轮交互下记忆系统评估是新基准方向 |
| Agent-X / Grounded Reasoning 综述（ICLR 2026） | 视觉中心 agentic 推理缺统一评估基准；weak spatial understanding、unreliable action grounding、limited feedback utilization |

## CCF 目标会议时间窗（事实，至 2027.03）

- **AAAI 2027**：abstract 2026-08-08 / full 2026-08-15（已临近，除非有扩展窗口，否则赶不上）
- **IJCAI 2027**：约 2027-01 截稿（✅ 时间最合适）
- **ACL 2027**：约 2026-12 截稿（✅ 时间合适）
- 备选：EMNLP 2027（更晚）、SIGIR/ACM MM（领域相关）

## 候选课题（结合本项目积累）

### 课题 A：自进化 Agent 的评估偏差与跨域泛化（推荐 ★★★★★）
- **空白**：239-paper 调查指出 scaffold 自进化普遍在"分布内基准"上评估，held-out 泛化采用率 <30%——污染/过拟合风险未被系统性量化。
- **我们已有**：`src/self-evolve`（轨迹→教训→skill 提升）、eval 体系、MLE-Bench 类评测入口。
- **研究问题**：scaffold 自进化在 held-out 任务族上的泛化如何？演进轨迹是否过拟合种子分布？提出"held-out 演进评估协议"（种子任务训练演进 → 未见过任务测试）。
- **工作量**：中（需多任务族 × 多轮演进实验；~4-5 个月实验 + 2 个月写作）。目标：IJCAI 2027 / AAAI（若赶上）或 ACL Findings。
- **风险**：依赖较强算力/多个模型 key；可用免费模型（GLM）降成本。

### 课题 B：工具调用循环的运行时幻觉拦截框架（推荐 ★★★★）
- **空白**：已有工作证明拦截有效（-23pp），但**拦截策略（预执行校验/后执行校验/自省重试）缺乏统一框架与跨模型系统比较**。
- **我们已有**：`tool-loop`（有界工具循环）、`risk-monitor`（双层复核）、`prompt-optimizer` 忠实度闸门、hallucination-detector。
- **研究问题**：提出统一拦截器（三层：参数校验 → 结果事实核查 → 自省重试），在 5+ 模型 × 多工具基准上比较幻觉下降与任务成功率，给出"何时拦截、何时放行"的决策规则。
- **工作量**：中（复用现有模块 + 基准采集；~4 个月）。目标：ACL 2027 / IJCAI 2027。
- **优势**：与 agent 可靠性主题（当下热门）契合度高，投稿接受面广。

### 课题 C：媒体记忆 —— 图/视频理解注入 Agent 知识库（推荐 ★★★）
- **空白**：multimodal embodied memory 是 Memory 综述列出的开放挑战；视觉中心 agentic 评估缺统一基准。
- **我们已有**：`src/knowledge/vision.ts`（glm-4.6v-flash 图/视频多帧理解 → 视觉描述注入知识管线）。
- **研究问题**：多帧视频理解 → 结构化媒体记忆 → 检索增强问答；提出"媒体记忆检索"评估协议（含图/视频混合知识库），对比 RAG-only 与媒体增强。
- **工作量**：中高（需构建图/视频知识数据集；~5-6 个月）。目标：ACM MM / ACL。
- **优势**：差异化强（视觉+知识库交叉）；风险：数据集构建成本。

## 推荐结论（判断）

1. **首选课题 A**：空白最明确（自进化评估泛化）、与 OpenRSI 线（用户关注）强相关、我们 self-evolve 基建直接可复用；投稿窗口 IJCAI 2027（2027-01）完全可行。
2. **次选课题 B**：若想提高命中率（可靠性方向竞争更热但可复现性好），可与 A 并行准备（B 工作量大，二选一优先 A）。
3. **课题 C 作为 A/B 落选后的备用或第二篇**：利用刚完成的视觉分支，差异化强。
4. **时间线建议（2026-08 → 2027-01）**：8-9 月定题+复现基线 → 10-12 月主实验 → 12 月底初稿 → 1 月投稿 IJCAI 2027；若投 ACL（12 月截稿）则压缩 9-10 月出主结果。

## 决策点（需用户确认）

- 课题 A 需要选定"任务族"（推荐：代码/知识/研究 3 族，各 5-10 种子任务）与评测模型（推荐 GLM 免费 + 1 付费对照）。
- 是否投入完整论文周期（7 个月）还是先做 3 个月可行性实验再定稿。

---
*研究完成：2026-08-12。事实以来源为准；推荐为判断。*
