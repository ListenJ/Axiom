# 知识库统一 + 可选语义（向量）层 —— T3 计划与决策请求

- **日期**：2026-09-19
- **分支**：`codex/knowledge-unify-2026-09-17`
- **级别**：**T3**（模块重构 + 接口变更 + 技术承诺变更）—— 依据总则 0.3
- **状态**：**计划草案，未施工**。按总则 0.3，T3 必须「书面计划 + 用户确认关键决策」后方可动工；本文即该书面计划，第二节列出待确认决策。
- **关系**：本文**取代** `docs/superpowers/plans/2026-09-14-knowledge-backend-convergence.md` 中未完成步骤的**范围定义**；该文中已完成的记录仍然有效（见第一节）。

---

## 一、现状更正（实测，先纠正本文档的前置叙述）

> 动机：我在上一轮把「知识库后端统一」列为**完全未做**，这是**不准确**的。以下是实测更正。

### 1.1 收敛已经发生（比 2026-09-14 计划的复选框进度更靠前）

- KAL 现在只用**一个** SQLite 句柄 `this.db`；三个「后端」实为**同一库内的三组表**：
  `memory_notes(+memory_notes_fts)`、`kg_nodes(+kg_nodes_fts)`、`knowledge_node(+knowledge_node_fts)`、`kg_edges`。
  证据：`src/kal/knowledge-access-layer.ts:170-172`（vault 腿）、`:287`（kg 腿）、`:405-406`（dre 腿）、`:473`（唯一 `kg_edges` 边表）。
- 旧边表 `kg_edge` 已并入 `kg_edges`，UNION 缝合与回退腿已移除。
  证据：`src/kal/knowledge-access-layer.ts:470` 注释「2026-09-17 后端收敛：唯一边表 kg_edges（旧表 kg_edge 已并入，缝合 UNION 与回退腿移除）」。
- 存在守卫测试：`tests/unit/kg-backend-unification.test.ts:27-41` 断言存在 `kg_edges`、**不存在** `kg_edge`。

**结论修订**：`src/kal/knowledge-access-layer.ts:151-158` 的 `switch(store)` **不是**"多后端未统一"，而是**同一库内的表级 fan-out**。
因此剩余工作不是"把四套后端合并"，而是：**在已统一的库之上加一层可选语义（向量）检索**。

### 1.2 向量设施已部分存在（不是从零开始）

| 设施 | 位置 | 现状 |
|---|---|---|
| 余弦函数 | `src/utils/math.ts:7` `cosineSimilarity` | 存在，被多处复用 |
| **本地** embedding 服务 | `src/local-llm/edge-embeddings.ts:34`（OpenAI 兼容 `/v1/embeddings`） | 存在；失败/超时/非 2xx **返回 null 不抛错** |
| 本地 embedding 消费者 | `src/core/settings-search.ts:12` | **当前唯一消费者** |
| **远端** embedding | `src/db/codegraph-sync.ts:143` → `api.siliconflow.cn/v1/embeddings` | 仍存在（此前计划要砍的正是它） |
| 休眠向量路径 | `src/dre/consciousness/stream.ts:127,188`、`src/dre/pipeline/pipeline.ts:161` | 有 embedding 字段与 cosine 调用，**无调用方传参** |
| 向量库依赖 | `package.json` | **零命中**（faiss/chromadb/qdrant/annoy/hnswlib/sentence-transformers/onnxruntime） |

---

## 二、待用户确认的关键决策（阻塞施工）

> 这四项决定后续所有切片的实现形态；未确认前不动代码。

| # | 决策 | 选项 | 我的建议与理由 |
|---|---|---|---|
| **D1** | embedding 来源 | (a) 仅本地 (b) 仅远端 (c) 本地优先+远端可选回落 | **(a) 仅本地**。理由：`codegraph-sync.ts:143` 的远端调用**不在**当前默认路径上；本地路径失败时 `getEdgeEmbeddings` 已返回 `null`（`edge-embeddings.ts:34`），天然降级，成本可控。若选 (c)，需单独定义"何时回落"的判据，否则等于恢复你此前要砍的链路。 |
| **D2** | 语义层默认开关 | (a) 默认关闭、显式开启 (b) 默认开启 | **(a)**。与本仓库已有先例一致：`AXIOM_MCP_LAZY_TOOLS` 默认 `"0"`（`src/mcp/server.ts:79`）、辅助 LLM 默认关闭。默认关闭同时让 CI 能在无 embedding 服务的环境跑绿。 |
| **D3** | 确定性边界 | (a) 语义层参与后仍要求"同输入同输出" (b) 只在词法路径要求 | **(a)**。你说"主要目的是用确定性完成 runtime 构建"，故：向量只用于**候选召回**，最终排序必须带**稳定 tie-breaker**（同分按 node_id 升序），且不得依赖 `Map` 遍历顺序。浮点相似度需固定比较容差。 |
| **D4** | 向量存放位置 | (a) 同一个 SQLite（新增 embedding 表） (b) 引入独立向量库 | **(a)**。保持"单一真相源"（`tests/unit/kg-backend-unification.test.ts` 已把单一性机器化）；且 `package.json` 目前零向量库，选 (b) 会引入新依赖（规则 12"新增依赖"属过度施工红线）。 |

---

## 三、0.4 统一任务契约（草案，待 D1–D4 确认后冻结）

```
任务:
  在已统一的 SQLite 知识库之上，增加一层【可选、默认关闭、可确定性复现】的语义检索层，
  用向量召回补足纯词法（FTS5/BM25）在"同义不同词"上的召回缺口；
  同时撤回"非向量化"技术主张，把文档与 CI 口径改为"确定性优先 + 可选语义层"。

验收标准:
  A1. 语义层默认关闭时，检索行为与当前**逐字节一致**（不改变既有排序与结果集）。
  A2. 语义层开启时，同一输入连续 N>=5 次跨进程运行结果完全一致（规则 13.5 实测，非代码推测）。
  A3. embedding 服务不可用时，检索**降级到词法路径**且不抛错、不挂起（有超时）。
  A4. 向量存储与知识表在**同一 SQLite**，不新增向量库依赖（package.json 不变）。
  A5. 对拍评测集量化"纯词法 vs 词法+语义"的召回差异，数字入库（不许写"效果更好"）。
  A6. 文档口径收敛：active docs 不再宣称"非向量化/零向量"；`docs-consistency` 门禁同步更新。
  A7. 全量 `bun test` 0 fail；`bunx tsc --noEmit` 通过；覆盖率不低于改动前。

改动清单（文件级）:
  待 D1–D4 确认后按第四节逐切片补全；每切片开工前补全该切片精确文件列表。

不做项:
  - 不引入向量库依赖（faiss/hnswlib/…）——D4 若选 (a)
  - 不改 `codegraph-sync.ts` 之外与语义检索无关的远端调用（D1 若选 (a) 则另立条目处理它）
  - 不动用户笔记原文（用户资产）
  - 不重构与语义层无关的 KAL 分支（规则 1）

验证命令:
  bunx tsc --noEmit -p tsconfig.json
  bun test --parallel=8 --timeout 15000 ./tests
  bun test tests/unit/knowledge-query-determinism.test.ts tests/unit/kg-backend-unification.test.ts
  语义层确定性实测（切片 3 产出，仿 scripts/determinism-repro.ts 的跨进程 N>=5 取哈希）
  对拍评测集（切片 2 产出）

风险/回滚:
  每切片一个独立提交，可逐步 git revert；
  默认关闭（D2=a）本身即回滚开关：关掉即回到当前行为（A1 保证）。
  风险 1：向量浮点在不同 CPU/后端可能非结合 ⇒ A2 的跨进程实测须**同机**进行，跨机一致性不承诺。
  风险 2：文档口径改动面较大 —— `docs/` 全子目录 + `README.md` 计 126 行含"向量"（**含** archive/reviews/superpowers/operations-log，
  其中 archive/reviews/operations-log 按 `tests/unit/docs-consistency.test.ts:7,9` 属**排除面**，不受门禁约束）；实际需改的 active 面待分类后确定。
```

---

## 四、执行顺序（垂直切片，先测量后改行为）

1. **切片 1｜口径收敛（先行，零行为风险）**
   撤回"非向量化"主张：改 `docs/ARCHITECTURE.md`、`docs/LIMITATIONS.md`、`README.md`、`docs/STORAGE-EVALUATION.md:76`、
   `docs/DRE-ARCHITECTURE.md`、`docs/AXIOM-ARCHITECTURE.md`；同步 `src/dre/runtime/text-rank.ts:26` 的"零向量"注释
   （该文件在 `src/`，**不在** `docs-consistency` 的扫描面内，需人工确认）。
   同步更新 `tests/unit/docs-consistency.test.ts:101-112` 的口径断言。
2. **切片 2｜评测集（先量化再改）**：建纯词法 vs 词法+语义的对拍集，产出**基线数字**（当前只有词法腿）。
3. **切片 3｜embedding 落地**：按 D1/D4 定来源与存储；新增表与写入路径；写失败/超时降级（A3）。
4. **切片 4｜检索接线**：语义只做候选召回，排序接稳定 tie-breaker（D3）；默认关闭（D2）。
5. **切片 5｜确定性实测**：跨进程 N>=5 取哈希（A2），比对切片 2 基线（A5）。

---

## 五、未验证 / 未覆盖（如实登记）

1. 本文引用的**行号**为 2026-09-19 实测；施工前须按规则 2 重新核对。
2. "向量"提及 **126 行**为 `grep -rn 向量 docs/ README.md` 的**原始计数**（含 archive/reviews/superpowers/operations-log），
   **未逐条分类**（"技术主张" vs "历史记录" vs "架构描述"）；切片 1 必须**先分类再改**，否则会把历史记录一起改写。
3. `tests/unit/docs-consistency.test.ts:38-41` 禁止 active docs 出现"**零向量**"字样，但**不**禁止"非向量化"；该测试**不构成**撤回主张的障碍，也**不**提供保护 —— 撤回后须新增门禁，否则口径会再次漂移。
4. 本地 embedding 服务的**真实可用性、维度、模型版本**未实测（需服务运行环境，当前不在审核面内）。
5. `src/db/codegraph-sync.ts:143` 的远端 embedding 是否仍被调用（默认路径可达性）**未核验**。
