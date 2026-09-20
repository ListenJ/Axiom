# 词法 vs 词法+语义 召回对拍（A8 对照一半）

- **日期**：2026-09-20
- **语料/用例**：与基线 `lexical-recall-baseline-2026-09-20.md` **同一份夹具**
  （`scripts/eval-fixtures/recall-corpus.ts`：12 条语料 / 14 条用例，含 3 条对照组）。
- **词法腿**：`src/dre/runtime/text-rank.ts` 的 `rankDocuments()`（确定性 BM25），
  按本次查询的最高分**归一化**到 0..1（否则 BM25 量纲恒压余弦，语义腿等于白加）。
- **语义腿**：**假 embedder（离线字符 bigram 哈希）** —— 本表数字**只证明 harness 与融合逻辑可跑通**，**不代表任何语义质量**；质量数字须用真实模型模式（`--embedder=siliconflow`）复跑。
- **融合口径（D3）**：向量**只做候选召回**；最终排序 `score = max(词法, 语义)`，
  **同分按 node_id 码元升序**（`rankWithSemanticRecall`），不依赖 Map 遍历顺序。
- **索引**：与知识表同库的 `knowledge_embeddings` 表（D4，内存 SQLite）；
  写入统计 indexed=12 / failed=0 / dim=64。
- **指标**：Recall@5 / Recall@10 / MRR，格式为 `纯词法 → 词法+语义`。
- **模式标注**：⚠️ **本次为假 embedder 模式，数字不代表语义质量**（见上方 provenance）。

## 结果

| 类别 | 用例数 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|
| lexical-control | 3 | 100.0% → 100.0% | 100.0% → 100.0% | 1.000 → 1.000 |
| synonym | 4 | 0.0% → 0.0% | 0.0% → 0.0% | 0.000 → 0.000 |
| cross-lingual | 4 | 0.0% → 0.0% | 0.0% → 0.0% | 0.000 → 0.000 |
| abbreviation | 3 | 0.0% → 0.0% | 0.0% → 0.0% | 0.000 → 0.000 |

**语义三类汇总**（11 条）：Recall@5 0.0% → **0.0%**；
Recall@10 0.0% → **0.0%**。

## 逐条明细

| 类别 | 查询 | 期望文档 | 纯词法名次 | 词法+语义名次 | 该条余弦 | 语义候选数 |
|---|---|---|---|---|---|---|
| synonym | `调用链雪崩要怎样自保` | kb-breaker | **未召回** | **未召回** | - | 0 |
| synonym | `垃圾堆越积越多最后会怎样` | kb-memleak | **未召回** | **未召回** | - | 0 |
| synonym | `同样的按钮连点两下会扣两次钱吗` | kb-idem | **未召回** | **未召回** | - | 0 |
| synonym | `怎么防止流量同时涌向数据库` | kb-cache | **未召回** | **未召回** | - | 0 |
| cross-lingual | `occupancy keeps growing and never released` | kb-memleak | **未召回** | **未召回** | - | 4 |
| cross-lingual | `how to avoid a cascading failure` | kb-breaker | **未召回** | **未召回** | - | 0 |
| cross-lingual | `avoid long tail by indexing filter columns` | kb-slowq | **未召回** | **未召回** | - | 1 |
| cross-lingual | `recover after a crash` | kb-wal | **未召回** | **未召回** | - | 2 |
| abbreviation | `REST` | kb-rest | **未召回** | **未召回** | - | 0 |
| abbreviation | `CSP` | kb-csp | **未召回** | **未召回** | - | 0 |
| abbreviation | `RAG` | kb-rag | **未召回** | **未召回** | - | 0 |
| lexical-control | `连接池` | kb-pool | #1 | #1 | - | 0 |
| lexical-control | `熔断器` | kb-breaker | #1 | #1 | - | 0 |
| lexical-control | `可观测性` | kb-obs | #1 | #1 | - | 0 |

## 边界（如实声明，不得外推）

- 语料仅 **12** 条、用例仅 **14** 条，**不能**外推为线上召回率；
  它把"语义召回的收益/损失"从**定性**变成**可复现的数字**，并提供回归防护。
- 用例由本人构造，**存在选择偏差**（更贴近我设想的语义场景）；不代表真实查询分布。
- 只测**召回**，未测**延迟**与**成本**；真实模型模式的延迟/成本受网络与供应商配额影响。
- 真实模型模式下 embedding 由远程模型产出 ⇒ **模型侧变动（版本升级）会改变数字**；
  本文件记录的是**当次**实测快照，不是稳定常数。
