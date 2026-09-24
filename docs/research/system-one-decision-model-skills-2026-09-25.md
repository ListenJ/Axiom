# System-1 决策模型的 skill 扫描：Jev 指南 → Laya 适配（2026-09-25）

> 摘要：按任务要求对"类似决策模型的 skill"做了网络检索。目标模型 Laya（convaiinnovations 开源，421M ModernBERT 判别式决策头）与 TypeSafe AI 2026-09-15 发布的闭源 **Jev** 同属 "System One Model" 一类：输入 state + typed questions，输出 typed decisions + 概率，永不生成自由文本。Jev 生态已有一批使用指南/技能（TypeSafe 官方博客、LangChain、Hugging Face、dev.to、Fly.io、Beam.ai、AIHubMix、greennode），其可迁移的纪律共 5 条，已逐一映射进本仓库 Laya 链（`src/decision/`、`skills/laya-local-decision-model/`）；Laya 实测的三项硬缺陷（不做数值推理、不处理否定、措辞敏感）与 checkpoint 自带的 confidence 告警，正好是 Jev 指南里"confidence 须经校准才可引用、阈值写死在代码"两条纪律的实证。本文是知识文件（规则 10.3），不承载可跑证据；可跑证据在 `docs/reviews/2026-09-25-auto-audit-chain-report.md`。

## 1. 检索面与对象身份（事实）

| 对象 | 身份 | 来源 |
| --- | --- | --- |
| Laya | Convai Innovations 开源 421M ModernBERT 决策头，Apache-2.0，choice/score/yes-no 三类问题，三个 checkpoint（含多语） | Hugging Face（Laya Demo Space）；AI Weekly、AI/TLDR 报道 |
| Jev | TypeSafe AI 首个 "System One Model"，2026-09-15 发布：state + typed questions → typed answers + calibrated probabilities，面向 agent 路由 / 工具选择 / 单步决策 | TypeSafe AI 博客；Sanity.io（"answers typed questions with structured values only — never free text"）；you.com 摘要 |
| 两者的关系 | 同一类模型（判别式 System-1、RL/RLCD 校准训练、typed decisions），Laya 是其中开源可自部署的一支；Jev 指南中的使用纪律因此可迁移 | 本仓库存档判断（判断，非事实）：基于双方公开的接口形状与训练方式描述 |

## 2. Jev 指南可迁移的纪律 → 本仓库落点（判断 + 落点）

| # | Jev 生态指南的纪律 | 本仓库落点 | 状态 |
| --- | --- | --- | --- |
| 1 | state 只放结构化/可复算信息，问题以 key 索引、按类型声明 | `docs/decisions/laya/README.md` "state 的写法：只放可复算事实"；`laya-triage.ts` 类型（对象非数组） | 已有 + 已入库 skill 强调 |
| 2 | confidence 未经校准不得当置信度引用 | checkpoint 自带告警 ⇒ `confidence` 不可引用；裁定只认登记表 + margin | 已有（ADR-008 更正节） |
| 3 | 用阈值划"自治执行 vs 交人"的线，阈值在代码里组合决策 | 三条闸门写死 `laya-triage.ts`：半径登记 + margin<0.15 + 领域封杀；模型无降警觉路径 | 已有 + skill 收录 |
| 4 | 决策模型放 agent 回路的**单步有界决策**（路由/分诊），不放多步推理 | ADR-008：Laya 只做 CLI 闸的任务分诊；接进运行时派发热路径属 T3 待裁决（未开工） | 边界保持，未越界 |
| 5 | 决策模型输出要**可验证**（typed、可断言），不可验证的理由不可采信 | `chia-repo-audit` 实测：Laya 判对模拟器逃逸用例但 margin 0.010、理由无验证器可识别 ⇒ 不当审计标注者 | 已实测入库（skill §8） |

Jev 指南**没有**提供的、Laya 实测独有的：noul 头与爆炸半径不可分（Spearman +0.41）——
这条反例已反向写进 skill（§6），是本仓库对这类模型的独有贡献面。

## 3. 对"全自动审计链"的落地含义

- 链的每个 stage 都是**单步有界、typed 输出、可字节比对**的只读动作 —— 正是纪律 4 允许交给
  决策模型分诊的形状；分诊结果（AUTO/ESCALATE）是 typed decision，闸门语义有 19+N 条单测锁住。
- 模型侧确定性按 13.5 口径实测：同 spec 跨进程 N=5，输出逐字节比对（`audit:laya-determinism`），
  不以"代码看起来没有随机性"替代实测。
- Jev 指南的"代码里组合多个决策"对应本链：**裁定集中在 TS 层一处**（深模块，规则 8），
  Python 侧零阈值，杜绝两份口径漂移。

## 4. 未决 / 边界

- Jev 为闭源早享产品，公开页未给权重级技术报告；本文只取其**公开指南层面的使用纪律**，
  不对两模型做基准对比（无同等算力/数据的公平对比面，属 13.1 铁律 3 的"不做新颖性判断"）。
- 检索摘要级别为搜索引擎摘要 + 官网 hero 文案；未逐篇精读付费墙/登录墙内的全文。
  后续若要把纪律 4（agent 回路集成模式）再细化，需补读 LangChain/HF 指南全文。

## 来源

1. TypeSafe AI — Introducing System One Models & Jev（官方博客，2026-09-15）：https://typesafe.ai
2. LangChain — What Is Jev? A Guide to TypeSafe AI's System One Model：https://www.langchain.com
3. Hugging Face — What Is Jev AI? A Practical Guide：https://huggingface.co
4. dev.to — Jev & System One Models: Fast Decision Making for AI：https://dev.to
5. Sanity.io — What is Jev?（2026-09-15 发布，structured values only）：https://www.sanity.io
6. Fly.io — Jev on Fly.io Sprites；Beam.ai — Jev by TypeSafe；AIHubMix — fast typed decisions；greennode.ai — benchmarks 概览
7. Convai Innovations — Laya（模型卡与 Demo Space）：https://huggingface.co/convaiinnovations/laya
8. AI Weekly — Convai ships Laya, a 421M ModernBERT decision model；AI/TLDR — typed-decisions zero-shot 0.362 报道
9. 本仓库：`docs/decisions/ADR-008-laya-decision-chain.md`；用户级 skill `~/.qoder/skills/laya-local-decision-model/SKILL.md`（本轮扫描后入库为 `skills/laya-local-decision-model/SKILL.md`）
