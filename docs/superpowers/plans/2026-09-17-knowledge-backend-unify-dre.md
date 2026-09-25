# T3 计划：知识库后端收敛进 DRE 确定性引擎

- **日期**：2026-09-17
- **分支**：`codex/knowledge-unify-2026-09-17`
- **状态**：**已完成（方案 A，5 个垂直切片全部 GREEN）** —— 2026-09-17，全量 4084 pass / 0 fail
- **任务级别**：T3（架构重构 / 存储层接口变更）
- **来源**：用户指令④「知识库后端全部统一到一起作为 DRE 确定性搜索引擎的一部分。当前内部有太多的重复后端」+ 独立审计报告（docs/reviews/2026-09-17-independent-full-audit.md）模块 5
- **勘察方法**：主审计亲自读取 + 只读子代理（存储 schema 清单）+ 直接核查查询/写入路径。全部结论附 文件:行号。

---

## 一、现状（事实，非推测）

### 1.1 物理库文件分散（3+1）

| 库文件 | 内容 | 证据 |
| --- | --- | --- |
| `data/agent.db` | 主库：几乎所有表 | `sqlite-memory.ts:30`（默认 `./data/agent.db`） |
| `axiom-memory.db` | 仅 `memory_notes` + FTS | 实体库导出 |
| `data/knowledge.db` | 仅 `knowledge_sources`/`dictionary` + FTS | 实体库导出 |
| 独立 `dre.db` | `synapses`/`synapse_traces`/`synapse_meta`（突触层，不在本任务范围） | `dre/synapse/store.ts:56` |

### 1.2 表级重复与孤儿（行数为实测）

| 重复对 | 表 A | 表 B | 实测行数 | 判定 |
| --- | --- | --- | --- | --- |
| 图谱边 | `kg_edge`（`dre/storage/sqlite-backend.ts:124`，列 `src_node,dst_node,relation,weight,evidence`） | `kg_edges`（`kg/schema.ts:32`，列 `id,source,target,type,weight,description,evidence,created_at` + FK） | **双双 0 行** | **真重复**：同一概念两份实现，KAL `getReferences`（`kal/knowledge-access-layer.ts:432-450`）用 `UNION ALL` + try/catch 缝合，注释自称"历史单数表" |
| 图谱节点 | `knowledge_node`（`sqlite-backend.ts:57`，列含 `domain,paradigm,behavior,prediction,hypothesis`） | `kg_nodes`（`kg/schema.ts:15`，列含 `file_path,line_number,signature,community,importance`） | **双双 0 行** | **非同概念**：前者是通用知识节点（领域/范式/行为预测），后者是代码符号节点（文件/行号/签名）。字段集几乎不重叠 |
| 笔记 vs 抓取源 | `memory_notes`（`sqlite-memory.ts:193`，**184 行**，FTS trigram） | `knowledge_sources`（`knowledge/store.ts:23`，**280 行**） | 有数据 | **非同概念**：用户笔记 vs 网络抓取源登记；语义不同，不宜强行合并 |

孤儿表（无写入或无读取，可安全丢弃）：`relationships`（`db/migrate.ts:137`，1 行旧数据，src 零读写）、`notes_fts`（:246，0 行）、`notes_fts_cjk`（:254，0 行）、`documents`（实体库存在但全仓无 DDL 无读写，来源不明）、`entities`/`knowledge`（仅 `routes/memory-api.ts:180,191` 只读，0/2 行旧数据）。

### 1.3 写入路径重复

存在**两个 KGWriter 类**，都写 `kg_nodes`/`kg_edges`：
- `src/kg/enhanced.ts:224`（INSERT OR REPLACE kg_nodes）、`:303`（INSERT OR REPLACE kg_edges）
- `src/crawl/processor/kg-writer.ts:236`（INSERT OR REPLACE kg_nodes）、`:263`（INSERT OR IGNORE kg_edges，sha1 内容寻址 edgeId）

DRE 侧写入：`dre/storage/knowledge-store.ts:171`（knowledge_node INSERT）、`:321`（addEdge → `kg_edge`，INSERT OR REPLACE）。

### 1.4 查询路径（KAL 统一读层）

`src/kal/knowledge-access-layer.ts:92` `query()` fan-out 三路后按 store 归一化取 max 再排序：
- `queryVault`（:167）→ `memory_notes_fts` MATCH，降级腿 `memory_notes` LIKE
- `queryKG`（:313）→ `kg_nodes_fts` MATCH，降级腿 `kg_nodes` LIKE
- `queryDRE`（:373）→ **`knowledge_node` 纯 LIKE，无 FTS 腿**（检索质量最弱的一路）

**审计结论（模块 5）**：KAL 是"接口包装 + 内部分裂调用"——它确实统一了*读接口*，但三个后端的 schema、检索能力（FTS vs LIKE）、库文件都未统一，`getReferences` 还要用 UNION 缝合双边表。

---

## 二、范围认定（关键决策点，需用户确认）

用户说"统一到 DRE"。但勘察显示：真正重复的只有**边表**一对；两个节点表**是不同领域概念**，不是重复。因此"统一"有两种边界，影响面差异很大：

### 方案 A（推荐，最小且正确）：消除真重复 + DRE 存储收口

- 边表合一：以 `kg_edges`（schema 更完备：有 id/描述/创建时间/FK 约束）为唯一边表，**托管进 DRE 的 `SqliteBackend`**（DDL 收归 `sqlite-backend.ts`，`kg/schema.ts` 引用同一 DDL 单源，不再各自建表）。
- DRE 的 `knowledge-store.ts` `addEdge`/出边/入边查询改写 `kg_edges`（列名映射 `src_node→source` 等），删除 `kg_edge` 表（0 行，无数据迁移）。
- KAL `getReferences` 删除 `UNION ALL` + try/catch 缝合逻辑（:432-444），直接查 `kg_edges`。
- 两个 KGWriter 收一：`crawl/processor/kg-writer.ts` 与 `kg/enhanced.ts` 合并为单一写入实现（保留 sha1 内容寻址 edgeId 的更稳实现）。
- 清理孤儿表与其残留读取（`routes/memory-api.ts` 的 entities/knowledge 只读腿降级为明确"遗留数据"标注或删除）。
- `knowledge_node` 与 `kg_nodes` **保留为两张表**，但在 DRE 存储层提供统一节点注册/查询适配，KAL 的 `queryDRE` 补 FTS 腿（用已有 `knowledge_node_fts`，目前只建表未被 KAL 使用），使三路检索能力对齐为"FTS 优先 + LIKE 降级"。

**影响面**：约 8-10 文件（sqlite-backend.ts、kg/schema.ts、knowledge-store.ts、kal/knowledge-access-layer.ts、enhanced.ts、kg-writer.ts、routes/memory-api.ts、db/migrate.ts、相关测试）。**零数据迁移**（重复表均 0 行）。

### 方案 B（重，符合字面"全部统一"）：再合并节点表与库文件

- 把 `knowledge_node` 并入 `kg_nodes`（需扩展列集覆盖 domain/paradigm/behavior/prediction/hypothesis），或反之。
- 把 `axiom-memory.db`（184 行笔记）与 `knowledge.db`（280 行源）并入 `data/agent.db`。
- **风险**：这是真实数据迁移（464 行活跃数据），且 memory_notes 与 knowledge_sources 语义不同（笔记 vs 抓取源登记），强行同表会造成概念混淆；库文件合并涉及 `SQLiteMemory`/`KnowledgeStore` 的库路由改造与迁移脚本。审计未发现这两对的合并有**功能必要性**（它们没有重复写入同一数据，只是各自独立）。

### 我的工程判断（规则 10）

方案 A 才是"消除重复后端"的正确解：重复的客观事实是边表 + 双 KGWriter + 孤儿表 + KAL 缝合逻辑；节点表与笔记/源表是**不同领域的独立存储**，不是"重复"，把它们强行合并会把"接口统一"做成"概念混淆"——这正是审计 module 5 警告的"仅做接口包装、内部仍分裂"的反面：我们要消除分裂，而不是制造一个更大的分裂表。

方案 B 的库文件合并（3→1）在运维上确实有收益（单库备份/锁管理），但它是独立于"重复后端"的运维项，建议作为后续项单独评估，不与本次架构变更混入同一提交（规则 12 过度施工红线：同一提交混入多个不相关任务）。

---

## 三、任务契约（按方案 A 冻结）

```
任务: 知识库后端收敛进 DRE —— 边表合一、双 KGWriter 收一、孤儿表清理、KAL 检索腿对齐
验收标准:
  1. 物理上只剩一张图谱边表（kg_edges），kg_edge 的 DDL 与所有读写出入口消失
  2. 只剩一个 KGWriter 实现；kg-writer/enhanced 的写入语义（幂等 + sha1 edgeId）保留
  3. KAL getReferences 不再含 UNION ALL 缝合与 try/catch 回退腿
  4. queryDRE 具备 FTS 优先 + LIKE 降级腿（与 queryVault/queryKG 对齐）
  5. 孤儿表（relationships/notes_fts/notes_fts_cjk/documents）的 DDL 与残留读取清除
  6. knowledge_node 与 kg_nodes 保留（不同领域），在 DRE 存储层有统一适配
  7. tsc --noEmit exit 0；全量 bun test 零回归；新增/改造测试覆盖边表合一与 KAL 单腿查询
改动清单（文件级，预登记）:
  - src/dre/storage/sqlite-backend.ts（边表 DDL 收口 + 适配）
  - src/kg/schema.ts（DDL 单源引用，删除独立建表）
  - src/dre/storage/knowledge-store.ts（addEdge/出边/入边改 kg_edges 列名）
  - src/kal/knowledge-access-layer.ts（getReferences 去缝合；queryDRE 补 FTS 腿）
  - src/kg/enhanced.ts 与 src/crawl/processor/kg-writer.ts（合一，保留 sha1 edgeId）
  - src/routes/memory-api.ts（孤儿表只读腿处置）
  - src/db/migrate.ts（孤儿表 DDL 清理）
  - 相关测试文件
不做项:
  - 不合并 knowledge_node 与 kg_nodes（不同领域）
  - 不合并 memory_notes 与 knowledge_sources（不同语义）
  - 不做库文件 3→1 合并（运维项，后续单独评估）
  - 不动 DRE 突触层（dre.db）
  - 不改采集管线其余 LLM 能力（edge-assist 其余 4 能力，见 2026-09-17 砍链条目偏差记录）
验证命令:
  - ./node_modules/typescript/bin/tsc --noEmit
  - bun test --parallel=8 --timeout 15000 ./tests
  - 针对性：bun test tests/unit/knowledge-query-determinism.test.ts tests/knowledge-edge.test.ts 及 KAL/KG 相关既有测试
风险/回滚:
  - 风险：重复表均 0 行，无数据迁移风险；主要风险是遗漏某个读写出入口导致运行时表缺失
    → 缓解：全量 grep `kg_edge`（单词边界）确保零残留 + 测试套件守卫
  - 回滚：本分支为 codex/knowledge-unify-2026-09-17，未推送前可整体丢弃；已推送则追加回滚提交
    （规则 9：禁止 force/reset，只追加）
```

---

## 四、执行顺序（垂直切片，规则 7）

1. 切片 1：边表 DDL 收口（sqlite-backend.ts 托管 kg_edges DDL，kg/schema.ts 引用单源）+ 测试
2. 切片 2：knowledge-store.ts addEdge/出边/入边改写 kg_edges + 测试
3. 切片 3：KAL getReferences 去缝合 + queryDRE 补 FTS 腿 + 测试
4. 切片 4：双 KGWriter 合一 + 测试
5. 切片 5：孤儿表与残留读取清理 + 全量回归

每个切片：RED（测试断言新结构）→ GREEN（实现）→ 回归，禁止水平切片批量写实现。
