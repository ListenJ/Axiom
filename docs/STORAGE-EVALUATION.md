# 存储方案评估报告

> 评估对象：Axiom Runtime v4.0 知识搜集与记忆系统的存储选型
> 评估日期：2026-07-23
> 评估范围：纯 Markdown 文档存储 vs 结构化数据库存储（SQLite / PostgreSQL）
> 评估依据：项目现有实现 — `src/knowledge/store.ts` / `src/memory/sqlite-memory.ts` / `src/db/pg-schema.sql`

---

## 1. 项目现状

Axiom Runtime v4.0 已实际落地三种存储形态，本评估并非"从零选型"，而是基于现有能力的**职责划分与场景推荐**。

| 存储层 | 实现文件 | 角色 | 当前状态 |
| --- | --- | --- | --- |
| 纯 Markdown 文档 | `src/memory/vault-manager.ts` + `src/knowledge/store.ts`（`storeAsVaultNote`） | 原件归档 / 人类可读 / Git 版本控制 | 已启用，Vault 目录组织（00-Knowledge / 01-Projects / ...） |
| SQLite（FTS5） | `src/memory/sqlite-memory.ts` + `src/knowledge/store.ts`（`KnowledgeStore`） | 快速全文检索索引 / 元数据 / 字典 | 已启用，WAL 模式，FTS5 + 触发器同步 |
| PostgreSQL（pgvector） | `src/db/pg-schema.sql` + `src/db/pg-client.ts` | 代码图谱 / 知识图谱 / 语义向量 / 多用户协作 | Schema 完整，但 `pg-client.ts` 当前显式禁用（`isPgAvailable()` 返回 `false`），运行时仅用 SQLite |

关键事实：
- `pg-client.ts:3-5` 明确注释 `"PostgreSQL is not available — Axiom uses SQLite exclusively"`，说明 PostgreSQL 是**为未来生产部署预留的能力**，当前运行时实际不连接 PG。
- `KnowledgeStore` 采用**双写策略**：Vault 写原件（Markdown），SQLite 写索引（`knowledge_sources` 表 + `dictionary_fts` 虚拟表）。
- `SQLiteMemory` 同样是双写：Vault 是原件备份，SQLite FTS5 是查询入口，需原文时回读 Vault（防 AI 幻觉）。

---

## 2. 对比表格

| 评估维度 | 纯 Markdown 文档 | SQLite（FTS5） | PostgreSQL（pgvector） |
| --- | --- | --- | --- |
| **查询效率** | 低。只能 grep / 字符串扫描，无索引；千文件级开始明显变慢 | 高。FTS5 倒排索引 + BM25 排序；万级记录毫秒级响应 | 极高。HNSW 向量索引 + GIN trigram + tsvector 三引擎混合搜索 |
| **扩展性** | 文件数线性增长后 IO 与扫描成本陡升；分布式几乎不可能 | 单机为主；通过附加只读副本可读扩展，但写仍单点 | 水平扩展成熟（读写分离 / 分片 / 连接池）；原生支持多实例并发 |
| **维护成本** | 极低。零依赖、零进程、零运维；Git 即备份 | 低。单文件 `*.db`，WAL 模式下并发安全；需定期 `VACUUM` 与备份 | 高。需独立进程、连接串配置、扩展安装（`vector` / `pg_trgm`）、版本升级、监控告警 |
| **版本控制能力** | 极强。文本即源码，Git diff / branch / blame 原生可用 | 无。二进制 `.db` 文件无法有意义地 diff；只能整体版本化 | 无。同 SQLite，且 schema 迁移需专门工具（`src/db/migrate.ts`） |
| **全文搜索能力** | 弱。需借助 ripgrep / fzf 等外部工具，无相关性排序 | 强。FTS5 支持 BM25、前缀匹配、中文 `unicode61` 分词 | 极强。tsvector + GIN + ts_rank 加权排序（A/B/C/D 权重） |
| **事务支持** | 无。文件系统操作非原子；并发写需外部锁 | 完整 ACID。WAL 模式支持并发读 + 单写 | 完整 ACID。多版本并发控制（MVCC），高并发读写表现优秀 |
| **并发写入** | 差。多进程同时写同一文件会损坏；需文件锁 | 中。单写多读，写串行化（WAL 下读不阻塞） | 强。MVCC 支持大量并发写事务 |
| **语义检索（向量）** | 不支持 | 不原生（需外挂 embedding 表 + 手写相似度计算） | 原生支持。pgvector HNSW 索引，cosine / L2 距离 |
| **图遍历（KG）** | 不支持 | 需多次 JOIN 模拟，深度受限 | 递归 CTE + `kg_traverse` 函数，原生支持 N 度关系展开 |
| **初始部署成本** | 零 | 零（Bun 内置 `bun:sqlite`） | 高（需独立 PG 实例 + pgvector 扩展） |
| **人类可读性** | 极高。纯文本，任何编辑器可读可改 | 低。需 SQL 客户端或自建 UI | 低。同 SQLite |
| **数据完整性约束** | 无。靠格式约定（frontmatter / 链接语法） | 中。外键 / UNIQUE / CHECK / 触发器 | 强。外键 + CHECK + 触发器 + 约束 + 事务回滚 |
| **离线可用性** | 完全离线 | 完全离线 | 需 PG 服务在线 |

---

## 3. 详细分析

### 3.1 纯 Markdown 文档存储

**优势**
- **可读性与可改性**：知识工作者可直接编辑 Markdown，无需 SQL 或专用工具，符合 Obsidian / VS Code 等 PKM 工具生态。
- **Git 友好**：每次知识更新都有可追溯的 diff，支持分支实验、PR 评审、blame 追溯。这是数据库存储无法替代的核心价值。
- **零运维**：无进程、无端口、无连接池、无崩溃恢复。文件即数据，复制即备份。
- **抗腐败**：纯文本格式 50 年后仍可读；数据库格式随版本迁移可能不可读。

**劣势**
- **查询能力贫弱**：无索引、无相关性排序、无聚合统计。"找出所有引用了 React 18 的笔记"这类查询需全文扫描。
- **并发写入冲突**：多 agent / 多进程同时写同一笔记会互相覆盖，需应用层文件锁（项目 `vault-manager.ts` 已实现）。
- **结构化数据丢失**：表格、列表、frontmatter 的结构在纯文本中是"约定"而非"约束"，格式错误不会被拒绝。
- **规模化瓶颈**：1 万文件以上时，文件系统目录遍历与全文检索开始显著变慢。

**项目中的角色**：原件归档层。`vault-manager.ts` 的 `writeNote` 将 Markdown 写入 PARA 分类目录，是**人类协作与版本控制的唯一入口**。

### 3.2 SQLite（FTS5）存储

**优势**
- **零部署成本**：Bun 内置 `bun:sqlite`，无独立进程，单文件 `.db` 即数据库。
- **全文检索开箱即用**：FTS5 支持 BM25 排序、前缀匹配、中文分词（`unicode61`），项目 `SQLiteMemory.search()` 已实现加权检索。
- **触发器自动同步**：`memory_notes_ai/ad/au` 触发器在 INSERT/DELETE/UPDATE 时自动维护 FTS 索引，应用层无需手动同步。
- **WAL 并发**：`PRAGMA journal_mode = WAL` 支持并发读 + 单写，读不阻塞写，适合单机多 agent 场景。
- **事务安全**：单文件原子提交，崩溃后自动恢复，无数据损坏风险。

**劣势**
- **单机限制**：不支持远程访问，分布式部署需自建同步层。
- **无向量检索**：FTS5 是关键词匹配，无法做语义相似度搜索（"意思相近但用词不同"的查询命中率为零）。
- **写并发串行化**：WAL 下写仍是单线程，高并发写场景会成为瓶颈。
- **二进制不可 diff**：`.db` 文件无法用 Git 有意义地版本化，只能整体快照。

**项目中的角色**：快速查询索引层。`SQLiteMemory` 与 `KnowledgeStore` 都采用"Vault 写原件 + SQLite 写索引"双写模式，SQLite 是查询入口，Vault 是原件备份（防 AI 幻觉）。

### 3.3 PostgreSQL（pgvector）存储

**优势**
- **三引擎混合搜索**：`hybrid_search_memory()` 函数同时执行 tsvector 全文检索 + pgvector HNSW 向量相似度，按权重融合排序（默认 text 0.4 + vector 0.6），这是 SQLite 无法企举的能力。
- **知识图谱原生支持**：`kg_entities` / `kg_relationships` + `kg_traverse()` 递归 CTE 函数支持 N 度关系展开，图遍历性能远优于 SQLite 的多 JOIN。
- **代码图谱**：`code_nodes.embedding` + `search_code_nodes()` 支持按语义查找代码（"找处理重试的函数"），是代码理解系统的核心。
- **MVCC 高并发**：多版本并发控制，大量并发读写互不阻塞，适合团队 / 多 agent 场景。
- **扩展性**：读写分离、分片、连接池、流复制等成熟方案，可支撑生产级负载。

**劣势**
- **运维成本最高**：需独立进程、连接串配置、扩展安装（`CREATE EXTENSION vector`）、版本升级、备份策略、监控告警。
- **当前未启用**：`pg-client.ts` 显式禁用，说明项目尚未准备好承担 PG 运维成本。
- **不可 Git 版本化**：schema 迁移需专门工具（项目 `src/db/migrate.ts`），数据本身无法 diff。
- **离线不可用**：依赖 PG 服务在线，断网即失效。

**项目中的角色**：未来生产部署层。Schema 已完整设计（L0 代码图谱 / L1 知识图谱 / L2 语义记忆 / L3 运行状态），是 SQLite 的升级路径。

---

## 4. 分场景推荐方案

### 4.1 个人使用（单用户 / 单机 / 离线优先）

**推荐：Markdown + SQLite 双写（当前默认）**

- Vault Markdown 作为原件归档与人类编辑入口，享受 Git 版本控制。
- SQLite 作为查询索引，提供 FTS5 全文检索与元数据管理。
- 不启用 PostgreSQL：单机场景下 PG 运维成本远超收益。
- 配置：`KNOWLEDGE_DB_PATH=./data/knowledge.db`，`SQLITE_MEMORY_DB=./axiom-memory.db`，Vault 路径默认。

**理由**：项目当前架构已是此模式，`KnowledgeStore` 与 `SQLiteMemory` 的双写设计完美匹配个人使用。零额外部署成本，离线可用，Git 可追溯。

### 4.2 团队协作（多用户 / 局域网 / 共享知识库）

**推荐：Markdown（Git 仓库） + SQLite（个人副本） + PostgreSQL（共享索引）**

- Markdown 笔记通过 Git 仓库共享：每人本地有完整 Vault 副本，提交 / 推送 / 合并实现知识协作。
- 每人本地保留 SQLite 作为个人快速检索（缓存最近访问的笔记）。
- 引入 PostgreSQL 作为**团队共享索引层**：
  - 所有人的笔记写入后同步到 PG（通过 `src/db/migrate.ts` 或定时同步任务）。
  - PG 提供跨成员的全文检索 + 向量语义检索 + 知识图谱查询。
  - `kg_entities` / `kg_relationships` 支持团队级知识图谱共建。
- 启用步骤：将 `pg-client.ts` 的 `isPgAvailable()` 改为真实探测，配置 `DATABASE_URL`，运行 `bun run db:init` 初始化 schema。

**理由**：Git 解决版本协作，PG 解决共享检索与图谱。SQLite 保留个人副本确保离线可用。三层各司其职，无单点故障。

### 4.3 生产部署（多 agent / 高并发 / 服务化）

**推荐：PostgreSQL 为主 + Markdown 仅作归档**

- PostgreSQL 作为**唯一权威存储**：所有读写走 PG，享受 MVCC 高并发、ACID 事务、向量检索、图遍历。
- Markdown 降级为**归档备份**：定期从 PG 导出 Markdown 快照到 Vault，用于离线阅读与灾难恢复，不再作为主存储。
- SQLite 退役：生产环境不混用 SQLite 与 PG，避免双写一致性问题。
- 启用 PG 全部能力：
  - L0 代码图谱：`code_nodes` + `search_code_nodes()` 支持语义代码检索。
  - L1 知识图谱：`kg_entities` + `kg_relationships` + `kg_traverse()` 支持图遍历推理。
  - L2 语义记忆：`memory_notes` + `hybrid_search_memory()` 支持混合检索。
  - L3 运行状态：`conversations` / `tasks` / `model_usage` 支持运行时可观测。
- 部署要求：PG 15+ with pgvector 0.5+，连接池（如 PgBouncer），定时备份（pg_dump），监控（Prometheus + postgres_exporter）。

**理由**：生产环境的并发、可用性、可观测性要求远超 SQLite 能力边界。PG 的混合搜索与图遍历是 agent 智能化的基础设施。Markdown 归档保留人类可读性与合规审计能力。

---

## 5. 推荐结论与迁移路径

### 5.1 核心结论

> **Axiom Runtime v4.0 应采用"三存储分层"架构，而非二选一。**

三种存储不是竞争关系，而是**职责分层**：
- **Markdown**：人类协作层（版本控制、可读性、抗腐败）
- **SQLite**：单机查询层（快速检索、零运维、离线可用）
- **PostgreSQL**：生产协作层（语义检索、图谱推理、高并发）

当前个人使用阶段，Markdown + SQLite 双写已足够；团队协作阶段引入 PG 共享索引；生产部署阶段 PG 为主、Markdown 归档。

### 5.2 迁移路径（按阶段）

| 阶段 | 触发条件 | 操作 | 风险 |
| --- | --- | --- | --- |
| **阶段 0（当前）** | 单用户 | 维持 Markdown + SQLite 双写 | 无 |
| **阶段 1** | 团队 ≥3 人 或 需跨成员检索 | 启用 PG，将 SQLite 数据迁移至 PG（`src/db/migrate.ts`），保留双写过渡期 | 数据一致性需应用层保障；PG 运维引入 |
| **阶段 2** | 多 agent 并发 或 需语义检索 | PG 启用 pgvector + 混合搜索；Markdown 降为归档；SQLite 退役 | 需 embedding 生成链路；离线不可用 |
| **阶段 3** | 生产服务化 | PG 为主存储；Markdown 定时快照归档；引入监控与备份 | 全面运维成本 |

### 5.3 反模式警告

- ❌ **不要用 Markdown 做主查询存储**：千文件级后检索性能不可接受，且无事务保护。
- ❌ **不要在生产混用 SQLite 与 PG 双写**：一致性难以保障，调试成本极高。
- ❌ **不要为个人使用强制启用 PG**：运维成本远超收益，SQLite FTS5 已覆盖 95% 检索需求。
- ❌ **不要丢弃 Markdown 归档**：PG 数据损坏或格式迁移时，Markdown 是最后的确定性备份。

---

## 6. 相关文件索引

| 文件 | 作用 |
| --- | --- |
| `src/memory/vault-manager.ts` | Vault Markdown 写入与目录管理 |
| `src/knowledge/store.ts` | `KnowledgeStore` — SQLite 索引 + Vault 双写 |
| `src/memory/sqlite-memory.ts` | `SQLiteMemory` — FTS5 全文检索 + Vault 双写 |
| `src/db/pg-schema.sql` | PostgreSQL 完整 schema（L0-L3 四层） |
| `src/db/pg-client.ts` | PG 客户端（当前禁用，预留启用入口） |
| `src/db/pg-init.ts` | PG schema 初始化脚本 |
| `src/db/migrate.ts` | 数据库迁移工具 |
| `src/crawl/concurrent-search.ts` | 并发搜索模块（任务 2.1 新增） |
| `src/crawl/html-to-markdown.ts` | HTML→Markdown 转换器（任务 2.2 新增） |
