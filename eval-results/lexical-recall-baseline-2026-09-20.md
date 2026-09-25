# 词法检索召回基线（切片 2 / A8 基线一半）

- **日期**：2026-09-20
- **被测对象**：`src/dre/runtime/text-rank.ts` 的 `rankDocuments()` —— 确定性 **BM25** 词法排序器
  （DRE 检索 atomStore.search / knowledgeNetwork.search 实际使用的词法腿）。
- **语料**：12 条内联知识条目（无网络、无 DB、可复现）。
- **用例**：14 条，分 4 类；`lexical-control` 为对照组。
- **指标**：Recall@1/5/10 与 MRR（目标文档是否出现在 Top-k）。
- **口径**：`Top-k` 由 `rankDocuments(query, corpus, 10)` 的结果顺序决定；**未召回** 记 0 分。

## 用例自我校验（防"高估词法"）

语义三类用例**必须与目标文档零 token 重叠**（否则它其实是词法题）；对照组**必须共享 token**。
本脚本在评测前逐条断言，**不满足即退出**。本次 0 条违规 ⇒ **全部通过**。

## 结果（基线 = 纯词法）

| 类别 | 用例数 | Recall@1 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
| lexical-control | 3 | 100.0% | 100.0% | 100.0% | 1.000 |
| synonym | 4 | 0.0% | 0.0% | 0.0% | 0.000 |
| cross-lingual | 4 | 0.0% | 0.0% | 0.0% | 0.000 |
| abbreviation | 3 | 0.0% | 0.0% | 0.0% | 0.000 |

**汇总**：语义三类合计 **11** 条，Recall@5 = **0.0%**，Recall@10 = **0.0%**。
对照组合计 **3** 条，Recall@5 = **100.0%**。

## 逐条明细

| 类别 | 查询 | 期望文档 | 名次 | 分数 |
|---|---|---|---|---|
| synonym | `调用链雪崩要怎样自保` | kb-breaker | **未召回** | - |
| synonym | `垃圾堆越积越多最后会怎样` | kb-memleak | **未召回** | - |
| synonym | `同样的按钮连点两下会扣两次钱吗` | kb-idem | **未召回** | - |
| synonym | `怎么防止流量同时涌向数据库` | kb-cache | **未召回** | - |
| cross-lingual | `occupancy keeps growing and never released` | kb-memleak | **未召回** | - |
| cross-lingual | `how to avoid a cascading failure` | kb-breaker | **未召回** | - |
| cross-lingual | `avoid long tail by indexing filter columns` | kb-slowq | **未召回** | - |
| cross-lingual | `recover after a crash` | kb-wal | **未召回** | - |
| abbreviation | `REST` | kb-rest | **未召回** | - |
| abbreviation | `CSP` | kb-csp | **未召回** | - |
| abbreviation | `RAG` | kb-rag | **未召回** | - |
| lexical-control | `连接池` | kb-pool | #1 | 6.328 |
| lexical-control | `熔断器` | kb-breaker | #1 | 5.136 |
| lexical-control | `可观测性` | kb-obs | #1 | 6.494 |

## 结论（只陈述本次实测）

1. **对照组成立**：词法能命中共享 token 的查询 ⇒ 本 harness 确实能测到"命中"，不是恒 0 的空跑。
2. **语义三类基线**：见上表 —— 这些查询与目标文档**零 token 重叠**，
   故词法**结构上不可能命中**（不是"调参不够"，是机制边界）。
3. **该基线是"语义层收益"的分母**：切片 4/5 落地后，用**同一批用例**跑"词法+语义"，差值即 A8 要求的量化结果。

## 边界（如实声明）

- 语料仅 **12** 条、用例仅 **14** 条 —— 规模小，**不能**外推为"线上召回率"；
  它的作用是把"语义召回损失"从**定性**变成**可复现的数字**，并提供**回归防护**。
- 用例由本人构造，**存在选择偏差**（更贴近我设想的语义场景）；不代表真实用户查询分布。
- 未测**延迟**（本脚本只测召回；切片 2 范围内的延迟对比见 `scripts/bench-kal-retrieval.ts` 的既有结论）。
- 未接入真实 SQLite/KAL 路径（那是切片 4/5 的集成面）；此处测的是**排序器**本身。
