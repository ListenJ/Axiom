# W5 / W8 落地形态审核 — 2026-08-30

> **摘要**：审核 KAL FTS 索引优化（W5）与 SearchPort 分层（W8）两个已立项排期项的最优落地形态。结论：W5 用"独立 fts5 trigram 虚拟表 + rowid 同步触发器 + queryKG MATCH 主腿 + <3 字 CJK LIKE 兜底腿"，**不能**复用 memory 侧的 external-content 形态（kg_nodes 无 INTEGER 主键且 REPLACE 改 rowid，实测验证）；W8 用"dre 侧端口接口 + crawl 适配器 + 组合根默认注入"，同时消除 M13 反向依赖并补 architecture-integrity 盲区。排序语义保持 importance DESC, id ASC 不变（审计 M3 红线）。来源：现场代码全文 + 基准实跑 + 磁盘行为实测 + 审计报告。

## 一、背景与范围

- 输入：`docs/knowledge/kal-benchmark-2026-08-30.md`（p95 中位增益 2.07/2.11/2.27x ≥2x → W5/W8 立项排期）；`docs/reviews/2026-08-28-independent-full-audit.md`（M13、H6、M3）；`docs/superpowers/plans/2026-08-28-plan-amendment-most-stable.md`（W8 缩窄版方向）。
- 范围：仅审核落地形态（接口/建表/迁移/接线），不含排期与工作量评估。

## 二、W5：KAL queryKG FTS 落地形态

### 2.1 现状事实（事实）

| 项 | 代码证据 |
|---|---|
| queryKG 现为三列 `%q%` LIKE + `ORDER BY importance DESC, id ASC LIMIT` | `src/kal/knowledge-access-layer.ts:259-266` |
| queryVault 已有 FTS5 trigram + `<3 字 CJK LIKE 兜底腿` + 并集去重 + `sanitizeFTS5`（仓库内已投产模板） | `src/kal/knowledge-access-layer.ts:166-252, 482-490` |
| memory_notes_fts 用 **external content**（`content=memory_notes, content_rowid=id`），因 `memory_notes.id` 为 `INTEGER PRIMARY KEY AUTOINCREMENT` | `src/memory/sqlite-memory.ts:193-218` |
| kg_nodes.id 为 **TEXT PRIMARY KEY**（无 INTEGER rowid 别名）；表未声明 WITHOUT ROWID，故有隐式 rowid | `src/kg/schema.ts:12` |
| `INSERT OR REPLACE` 写 kg_nodes，REPLACE 语义 = DELETE+INSERT，**隐式 rowid 会改变**（实测 DELETE+INSERT 后 rowid 1→3） | `src/kg/enhanced.ts:221-242`、`src/crawl/processor/kg-writer.ts:233-237` |
| bench 脚本 B 组为**独立 fts5 trigram 表 + 3 个 rowid 触发器**（非 external content），查询 JOIN rowid + `ORDER BY n.importance DESC, n.id ASC` | `scripts/bench-kal-retrieval.ts:126-145, 327-334` |
| KG 建表单源 | `src/kg/schema.ts`（enhanced.ts:196 / kg-writer.ts:48 共用 exec） |

### 2.2 形态阻断点（判断，含实测证据）

**不可用 external-content 形态。** memory 侧 external-content 依赖 `content_rowid=id` 指向稳定 INTEGER 主键；kg_nodes 无此主键，若退而用 `content_rowid=rowid`，则 `INSERT OR REPLACE` 改变 rowid 后 external-content 的关联会失联/错乱（FTS 按 rowid 对应源行）。实测确认 TEXT PK 表存在隐式 rowid 且 REPLACE 会重分配。因此 **必须用独立（非 external-content）fts5 表**：FTS 表自带 rowid，触发器以 `new.rowid/old.rowid` 同步源行变更，查询 `JOIN kg_nodes n ON n.rowid = fts.rowid`——即 bench 已验证形态，可 1:1 复用。

### 2.3 最优形态（判断）

1. **DDL**：`KG_SCHEMA_DDL`（schema.ts 单源）追加
   - `CREATE VIRTUAL TABLE IF NOT EXISTS kg_nodes_fts USING fts5(name, description, semantic, tokenize='trigram')`
   - 3 个 rowid 触发器（`kg_nodes_fts_ai/ad/au`，照抄 bench `KG_FTS_DDL`，基准脚本已验证等价性）。
2. **存量回填**：新增 `ensureKgFtsBackfill(db)`——幂等：检测 `kg_nodes_fts` 行数 < `kg_nodes` 行数时执行 `INSERT INTO kg_nodes_fts(rowid,name,description,semantic) SELECT rowid,name,description,semantic FROM kg_nodes`；enhanced.ts / kg-writer.ts init 处各调一次（两者均已 exec KG_SCHEMA_DDL）。
3. **queryKG 改造**：MATCH 主腿（`sanitizeFTS5(q, 3)`，>=3 字符词）+ `<3 字 CJK 词 LIKE 兜底腿` + 并集去重（复用 queryVault 同款逻辑），**排序仍 `ORDER BY n.importance DESC, n.id ASC`**（FTS MATCH 仅作候选召回，不用 rank——保 M3 确定性/语义红线，与 bench `FTS_SQL` 一致）。
4. **降级**：`kg_nodes_fts` 不存在或查询失败 → 回退现有纯 LIKE（queryKG 既有 try/catch 静默降级保持）。FTS 表建表失败不阻断主表写入（IF NOT EXISTS + try/catch 与 memory 侧同款）。

### 2.4 一致性影响（判断）

- 排序键（importance DESC, id ASC）与现状逐字节一致 → 不触发 M3 localeCompare 翻转风险；确定性承诺（`ORDER BY ... id ASC` 为确定次级键）维持。
- typeFilter 参数继续作用于 kg_nodes 侧（FTS 腿 JOIN 后过滤），不改接口签名。

## 三、W8：SearchPort 分层落地形态

### 3.1 现状事实（事实）

| 项 | 代码证据 |
|---|---|
| M13 反向依赖：`dre/pipeline/pipeline.ts:16` 静态 import crawl 的 `SearchAggregator / searchAggregator / SearchEngineResult / SearchFetch` | `src/dre/pipeline/pipeline.ts:16` |
| Pipeline 构造已支持注入：`opts.searchAgg? / opts.searchFetch?`，默认模块单例 `searchAggregator` | `src/dre/pipeline/pipeline.ts:81-89` |
| 组合根：`new Pipeline(store, mainLLM)`（未传 searchAgg） | `src/dre/engine.ts:224` |
| architecture-integrity 仅禁 dre→router（L1），**未禁 dre→crawl（盲区）** | `tests/architecture-integrity.test.ts:551` |
| 既定方向：W8 缩窄版——"增加端口抽象文件但不改构造，调用方逐步迁移" / "以端口适配器替代构造签名破坏" | `plan-amendment` / `audit-stability-analysis` |

### 3.2 最优形态（判断）

1. **新建端口文件** `src/dre/pipeline/search-port.ts`（dre 自有端口，避免新上层）：
   - `export interface SearchPort { searchMulti(opts: SearchOptions): Promise<SearchEngineResult[]> }`
   - 类型 `SearchOptions/SearchEngineResult` 由 crawl `search-engines.ts` **re-export 或迁移到端口文件**（dr e 只依赖端口，不再直接引 crawl 路径）。
2. **crawl 适配**：`SearchAggregator` 已满足该接口（其 `searchMulti(opts)` 签名一致）——结构类型兼容，零改动即可作为实现；提供 `src/dre/pipeline/search-port.ts` 内默认 `defaultSearchPort()` 惰性返回 `searchAggregator` 的适配（或组合根注入）。
3. **pipeline.ts**：类型字段/构造参数改为 `SearchPort`，移除 `pipeline.ts:16` 的 crawl import；默认值在端口文件内解析（lazy import 或组合根传入），**构造签名保持**（`opts.searchAgg?` 语义保留，类型换为 SearchPort），engine.ts:224 组合根不破坏。
4. **architecture-integrity 收口**：L1 追加 dre→crawl 禁令（豁免仅端口文件 `search-port.ts`），补 M13 盲区。

### 3.3 一致性影响（判断）

- `SearchAggregator` 结构类型满足 `SearchPort`，不破坏 crawl 侧既有测试；`pipeline.ts` 内部调用点（`this.searchAgg.searchMulti`）签名不变。
- M13 一并消除（pipeline.ts:16 反向 import 移除）——审计报告将其随 W5/W8 重立项处理，此处顺带闭合。

## 四、审核结论（判断）

1. **W5 采用"独立 fts5 trigram + rowid 触发器 + MATCH 主腿/LIKE 兜底腿"形态**；禁止在 kg_nodes 上复用 memory 的 external-content 形态（形态阻断点见 2.2，实测支撑）。DDL 入 schema.ts 单源，存量回填用幂等 `ensureKgFtsBackfill`。
2. **W8 采用"dre 侧 SearchPort 端口接口 + crawl 结构兼容适配 + 组合根/端口默认值注入"形态**，构造签名不变，同时闭合 M13 与 architecture-integrity 盲区。
3. 两形态均保持既有排序/降级/确定性语义不变，符合 AGENTS 规则 1（最小施工）与规则 8（小接口、依赖注入不内建 new）。

## 五、遗留待决策（判断）

- W5 回填时机：建表后立即回填 vs 惰性首次查询回填——建议建表即回填（确定性启动成本可控，kg 行数 ≤ 现有规模）。
- W8 端口文件落点：`src/dre/pipeline/search-port.ts`（随 Pipeline 同层）为当前最小改动方案；若后续有第二个消费方再提升到 `src/ports/`（规则 8：两个适配器才升级，当前不投机）。
