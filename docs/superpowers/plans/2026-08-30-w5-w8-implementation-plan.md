# W5/W8 实施计划 — 2026-08-30（基于落地形态审核）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/knowledge/w5-w8-landing-form-audit-2026-08-30.md` 审核结论落地 W5（KAL queryKG FTS5 trigram 优化）与 W8（dre SearchPort 端口分层 + 闭合 M13 / architecture-integrity 盲区），TDD 红→绿，终验全绿后提交推送。

**Architecture:**

- **W5**：`src/kg/schema.ts` 新增 `KG_FTS_DDL`（独立 fts5 trigram 虚拟表 + `IF NOT EXISTS` rowid 触发器）+ `ensureKgFts(db)` 幂等助手（建表 + 存量回填 + try/catch 降级）。`enhanced.ts` / `kg-writer.ts` 在 `db.exec(KG_SCHEMA_DDL)` 后各调一次。`queryKG`（`src/kal/knowledge-access-layer.ts`）改为：`kg_nodes_fts` 存在时走 MATCH 主腿（`sanitizeFTS5(q,3)`）+ `<3 字 CJK LIKE 兜底腿` + 并集去重；不存在/失败回退现有纯 LIKE。**排序恒为 `ORDER BY n.importance DESC, n.id ASC`**（保 M1/M3 红线）。
- **W8**：新建 `src/dre/pipeline/search-port.ts`（`SearchPort` 接口 + `SearchOptions`/`SearchEngineResult` 类型 re-export + `defaultSearchPort()`）。`pipeline.ts` 移除 crawl import，类型字段/构造 `opts.searchAgg?` 换为 `SearchPort`，默认值走端口文件惰性解析（保留 `opts.searchFetch?` 分支）。`engine.ts` 组合根不破坏。architecture-integrity L1 追加 dre→crawl 禁令（豁免仅 `search-port.ts`）。

**Tech Stack:** Bun 1.3.14 / TypeScript strict / bun:sqlite / bun:test。

**Spec:** `docs/knowledge/w5-w8-landing-form-audit-2026-08-30.md`（§2 W5 最优形态、§3 W8 最优形态、§4 结论）。

**审计红线（D1 回滚教训，`docs/superpowers/specs/2026-08-28-next-iteration-debate-decision-design.md` §D1）：** 前次在途实现 3 处缺陷必须避免——①W8 静默绕过 searchAgg mock 打真实网络（本计划端口默认值惰性解析 + 注入优先，test 注入的 agg 恒生效）；②kg_nodes_fts 全库无建表死路径（本计划 DDL 入 schema.ts 单源，enhanced/kg-writer 双处 exec，绝不成为死路径）；③FTS 无回填 + 提前 return 漏查存量行（本计划 `ensureKgFts` 幂等回填 + queryKG 并集腿在 FTS 存在但未命中时仍查 LIKE，不漏存量）。

## Global Constraints

- 分支 `codex/self-evolving-agent`；每任务 `git add <仅本任务文件>` → commit → `git push internal211 codex/self-evolving-agent`（AGENTS 规则 3）。
- 每任务修改前备份 `.tmp/backups/<相对路径>` → 通读全文 → 最小改动 → 验证通过 → 删备份（规则 2）。
- 每提交前 `docs/operations-log.md` 追加条目，规则 5（一次一条，hash 先待填后回填，回填走 bun 脚本唯一锚点，禁止 sed）。
- `data/real-usage-traces.jsonl`、`.serena/*`、`scripts/pdf-worker/*`、`docs/superpowers/plans/2026-08-28-plan-amendment-most-stable.md`、`CLAUDE.md` 与本任务无关，**不得暂存**（stat 缓存噪音，内容与 HEAD 逐字节一致）。
- 终验基线：`bun run test:full` 全绿（现 3220 pass/0 fail，本任务后只增不减）+ `bunx tsc --noEmit` 0（src/** tests/**）。

---

### Task 1: W5 前置 — 失败测试（红）

**Files:**
- Add: `tests/kal-kg-fts.test.ts`
- Add: `tests/kg-fts-backfill.test.ts`

**Interfaces:** 无生产改动；纯测试断言期望行为（TDD 红态）。

- [ ] **Step 1: 写 queryKG FTS 主腿测试（红）**

新建 `tests/kal-kg-fts.test.ts`：
- `new KGWriter(db)`（创建 kg_nodes + FTS 表，触发回填路径）后按非字典序插入 3 节点（description 含长词 `semanticentity`），`kal.query({query:"semanticentity", targetStore:"kg"})` 应命中全部 3 条且按 `importance DESC, id ASC`。
- 插入含 `<3 字 CJK`（如 `图谱`）在 description 的节点，`kal.query({query:"图谱", targetStore:"kg"})` 应命中（LIKE 兜底腿）。

Run: `bun test tests/kal-kg-fts.test.ts`（改造前 queryKG 无 FTS 腿，先确认 LIKE 基线可跑；改造后断言 FTS 命中 + 排序）。

- [ ] **Step 2: 写 ensureKgFts 回填测试（红）**

新建 `tests/kg-fts-backfill.test.ts`：先 `db.exec(KG_SCHEMA_DDL)` + 手工 `db.run INSERT` 3 行存量（不建 FTS），再调 `ensureKgFts(db)`，断言 `SELECT COUNT(*) FROM kg_nodes_fts` == 3（存量回填）且二次调用幂等（行数不变、无报错）。

Run: `bun test tests/kg-fts-backfill.test.ts` → 红（`ensureKgFts` 未导出）。

---

### Task 2: W5 实施 — schema.ts FTS DDL + ensureKgFts + 双处接线 + queryKG 改造（TDD 绿）

**Files:**
- Modify: `src/kg/schema.ts`（新增 `KG_FTS_DDL` + `ensureKgFts(db)`）
- Modify: `src/kg/enhanced.ts`（initializeDatabase 追加 ensureKgFts）
- Modify: `src/crawl/processor/kg-writer.ts`（ensureTables 追加 ensureKgFts）
- Modify: `src/kal/knowledge-access-layer.ts`（queryKG 改 FTS + LIKE 并集 + 降级）
- Tests: `tests/kal-kg-fts.test.ts`、`tests/kg-fts-backfill.test.ts`（Task 1 已建）

**Interfaces:**
- `KG_FTS_DDL: string`（导出常量）
- `ensureKgFts(db: Database): void`（导出；幂等建表+回填+try/catch 降级，FTS 失败不抛、不阻断主表）
- `queryKG` 内部：`kgFtsUsable()` 探测缓存 + MATCH 主腿 + `<3 字 CJK LIKE 兜底腿` + 并集去重 + `ORDER BY importance DESC, id ASC`；FTS 表不存在/异常 → 纯 LIKE。

- [ ] **Step 1: 备份 + 通读**

```powershell
Copy-Item src/kg/schema.ts .tmp\backups\src\kg\schema.ts -Force
Copy-Item src/kg/enhanced.ts .tmp\backups\src\kg\enhanced.ts -Force
Copy-Item src/crawl/processor/kg-writer.ts .tmp\backups\src\crawl\processor\kg-writer.ts -Force
Copy-Item src/kal/knowledge-access-layer.ts .tmp\backups\src\kal\knowledge-access-layer.ts -Force
```

- [ ] **Step 2: schema.ts 新增 KG_FTS_DDL + ensureKgFts**

在 `src/kg/schema.ts` 末尾追加：

```ts
import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

/**
 * KG 节点 FTS5 trigram 虚拟表 DDL（W5，落地形态审核 §2）。
 * 独立（非 external-content）fts5 表：kg_nodes.id 为 TEXT PK 无 INTEGER rowid 别名，
 * INSERT OR REPLACE 会重分配隐式 rowid，external-content 关联会失联——故用独立表 +
 * rowid 同步触发器（bench-kal-retrieval.ts KG_FTS_DDL 已验证等价性）。
 * 触发器用 IF NOT EXISTS：enhanced.ts / kg-writer.ts 可对同一 db 重复 exec，幂等。
 */
export const KG_FTS_DDL = `
      CREATE VIRTUAL TABLE IF NOT EXISTS kg_nodes_fts USING fts5(
        name, description, semantic,
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS kg_nodes_fts_ai AFTER INSERT ON kg_nodes BEGIN
        INSERT INTO kg_nodes_fts(rowid, name, description, semantic)
        VALUES (new.rowid, new.name, new.description, new.semantic);
      END;
      CREATE TRIGGER IF NOT EXISTS kg_nodes_fts_ad AFTER DELETE ON kg_nodes BEGIN
        INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, name, description, semantic)
        VALUES('delete', old.rowid, old.name, old.description, old.semantic);
      END;
      CREATE TRIGGER IF NOT EXISTS kg_nodes_fts_au AFTER UPDATE ON kg_nodes BEGIN
        INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, name, description, semantic)
        VALUES('delete', old.rowid, old.name, old.description, old.semantic);
        INSERT INTO kg_nodes_fts(rowid, name, description, semantic)
        VALUES (new.rowid, new.name, new.description, new.semantic);
      END;
    `;

/** 幂等确保 kg_nodes_fts 就绪并回填存量（W5 §2.3）。建表失败不阻断主表；回填仅在 FTS 行数 < kg 行数时执行。 */
export function ensureKgFts(db: Database): void {
  try {
    db.exec(KG_FTS_DDL);
    const ftsCount = (db.query("SELECT COUNT(*) AS c FROM kg_nodes_fts").get() as { c: number }).c;
    const srcCount = (db.query("SELECT COUNT(*) AS c FROM kg_nodes").get() as { c: number }).c;
    if (ftsCount < srcCount) {
      db.exec(`INSERT INTO kg_nodes_fts(rowid, name, description, semantic)
               SELECT rowid, name, description, semantic FROM kg_nodes`);
    }
  } catch (err) {
    // FTS 建表/回填失败：queryKG 探测 kg_nodes_fts 缺失则回退纯 LIKE，不中断启动
    logger.warn("[kg] ensureKgFts failed; kg_nodes_fts search degrades to LIKE", {
      error: (err as Error).message,
    });
  }
}
```

> 注：schema.ts 现为纯常量零依赖模块。`ensureKgFts` 需 `Database` 类型与 `logger`——以 `import type { Database }`（仅类型，不产生运行时依赖）+ `import { logger }`（utils/logger，dre 无关，不触发 architecture-integrity）。若 tsc/architecture-integrity 报问题，以实跑为准调整。

- [ ] **Step 3: enhanced.ts / kg-writer.ts 接线**

`src/kg/enhanced.ts` import 行加 `ensureKgFts`；`initializeDatabase()` 在 `this.db.exec(KG_SCHEMA_DDL);` 后追加 `ensureKgFts(this.db);`。

`src/crawl/processor/kg-writer.ts` import 行加 `ensureKgFts`；`ensureTables()` 在 `this.db.exec(KG_SCHEMA_DDL);` 后追加 `ensureKgFts(this.db);`。

- [ ] **Step 4: queryKG 改造（FTS 主腿 + LIKE 兜底 + 并集去重 + 降级）**

`src/kal/knowledge-access-layer.ts` 的 `queryKG` 改为镜像 queryVault 并集模式。新增 `kgFtsUsable()`（sqlite_master 探测 `kg_nodes_fts` 含 trigram，缓存，失败缓存 false → 纯 LIKE）。保留：typeFilter 在 kg_nodes 侧过滤、M14 原样 id、排序 `ORDER BY importance DESC, id ASC`、外层 try/catch 静默降级。

关键片段：
```ts
private kgFtsCache: boolean | null = null;
private kgFtsUsable(): boolean {
  if (this.kgFtsCache === null) {
    try {
      const row = this.db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kg_nodes_fts'")
        .get() as { sql: string } | undefined;
      this.kgFtsCache = Boolean(row) && /trigram/i.test(row!.sql);
    } catch { this.kgFtsCache = false; }
  }
  return this.kgFtsCache;
}
```
queryKG 主体：trigram 时 `ftsQuery = this.sanitizeFTS5(intent.query, 3)`，FTS MATCH 主腿 SQL（`JOIN kg_nodes n ON n.rowid = fts.rowid` + typeFilter 于 n 侧 + `ORDER BY n.importance DESC, n.id ASC` LIMIT）；`shortCjkWords` 走 LIKE 兜底腿并集去重（镜像 queryVault）。`!trigram` 时走原纯 LIKE SQL 不变。

- [ ] **Step 5: 验证（绿）**

Run: `bun test tests/kal-kg-fts.test.ts tests/kg-fts-backfill.test.ts` → 全绿。
Run: `bun test tests/kal-deterministic-order.test.ts tests/kal-references.test.ts` → 既有 KAL 测试保持绿（M1 排序、references 不受影响）。
Run: `bunx tsc --noEmit` → 0（若 scripts/ 不在 include，脚本类型以实跑绿为准）。
Run: `bun run test:full` → 全绿且不回落（FTS 表新增影响范围仅 queryKG/回填，无存量断言表集合）。

- [ ] **Step 6: 备份清理 + ops-log 留痕 + 提交 C1**

删除 4 个备份文件。`docs/operations-log.md` 追加 W5 条目（hash 待填），提交：
```bash
git add src/kg/schema.ts src/kg/enhanced.ts src/crawl/processor/kg-writer.ts src/kal/knowledge-access-layer.ts tests/kal-kg-fts.test.ts tests/kg-fts-backfill.test.ts docs/operations-log.md
git commit -m "feat(kal): W5 KAL queryKG FTS5 trigram（独立虚拟表+rowid 触发器+幂等回填+MATCH/LIKE 并集，排序红线保持）"
git push internal211 codex/self-evolving-agent
```

---

### Task 3: W8 实施 — SearchPort 端口 + pipeline 改造 + architecture-integrity 收口（TDD 红→绿）

**Files:**
- Add: `src/dre/pipeline/search-port.ts`（SearchPort 接口 + 类型 re-export + defaultSearchPort）
- Modify: `src/dre/pipeline/pipeline.ts`（移除 :16 crawl import；类型字段/构造 searchAgg 换 SearchPort；默认值走端口文件）
- Modify: `tests/architecture-integrity.test.ts`（L1 追加 dre→crawl 禁令，豁免 search-port.ts）
- Modify: `tests/dre-search-port.test.ts`（新增：端口注入优先 + 不绕过 mock 的回归测试）

**Interfaces:**
- `SearchPort { searchMulti(opts: SearchOptions, engines?: string[]): Promise<SearchEngineResult[]> }`
- `search-port.ts` re-export `SearchOptions` / `SearchEngineResult`（自 crawl `search-engines.ts`，类型 re-export 仅类型、无运行时依赖）
- `defaultSearchPort(): SearchPort`（惰性 `import("../../crawl/search-engines.js")` 返回 `searchAggregator`——运行时才解析，避免静态 import 触发 L1；注入优先）
- `Pipeline` 构造 `opts.searchAgg?: SearchPort`（类型换）+ 保留 `opts.searchFetch?: SearchFetch` 分支

- [ ] **Step 1: 备份 + 写失败测试（红）**

```powershell
Copy-Item src/dre/pipeline/pipeline.ts .tmp\backups\src\dre\pipeline\pipeline.ts -Force
Copy-Item tests/architecture-integrity.test.ts .tmp\backups\tests\architecture-integrity.test.ts -Force
```

新建 `tests/dre-search-port.test.ts`：
- 注入 `agg = new SearchAggregator(mockFetch)`，断言 `pipeline` 调用 `agg.searchMulti`（不触发真实网络）——**D1 缺陷①回归**：spyOn `agg.searchMulti`，验证被调用且网络 fetch 未被调用。
- 断言不注入时 `defaultSearchPort()` 返回的 `searchAggregator` 具有 `searchMulti`。

Run: `bun test tests/dre-search-port.test.ts` → 红（`search-port.ts` 未建）。

- [ ] **Step 2: 新建 search-port.ts**

```ts
import type { SearchOptions, SearchEngineResult } from "../../crawl/search-engines.js";

/** dre 自有端口（W8，落地形态审核 §3）：dr e 只依赖本端口，不再直接引 crawl 路径。 */
export interface SearchPort {
  searchMulti(opts: SearchOptions, engines?: string[]): Promise<SearchEngineResult[]>;
}
export type { SearchOptions, SearchEngineResult };

/** 默认端口实现：惰性解析 crawl 单例（避免静态 import 触发 L1 dre→crawl 禁令）。 */
export function defaultSearchPort(): SearchPort {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return import("../../crawl/search-engines.js").then((m) => m.searchAggregator);
}
```

> 注：`defaultSearchPort` 返回 Promise 型或同步？Pipeline 构造是同步的。为保持构造签名同步，改用**同步惰性 require**：`const { searchAggregator } = require("../../crawl/search-engines.js")`——Bun 支持 CJS require。若仓库纯 ESM 禁用 require，则改为在端口文件内**静态 import crawl 但豁免该文件**于 L1 禁令（architecture-integrity L1 的 walk 豁免 `search-port.ts`）。以实跑为准，二选一：①L1 豁免 search-port.ts + 静态 import；②同步 require。**核心是 pipeline.ts 不再静态引 crawl，L1 收口以"非端口文件零 dre→crawl 引用"为绿态。**

- [ ] **Step 3: pipeline.ts 改造**

- 移除 `import { SearchAggregator, searchAggregator, type SearchEngineResult, type SearchFetch } from "../../crawl/search-engines.js"`（:16）。
- 改为 `import { defaultSearchPort, type SearchPort, type SearchEngineResult, type SearchFetch } from "./search-port.js"`（SearchFetch 类型从 crawl re-export 或端口文件转引——端口文件需 re-export `SearchFetch` 类型）。
- 字段 `private readonly searchAgg: SearchPort;`
- 构造 `opts: { searchAgg?: SearchPort; searchFetch?: SearchFetch; webVerifyEnabled?: boolean } = {}`，赋值 `this.searchAgg = opts.searchAgg ?? (opts.searchFetch ? new SearchAggregator(opts.searchFetch) : defaultSearchPort());`——但 `SearchAggregator` 已在 pipeline 移除 import，故 `searchFetch` 分支需在端口文件提供 `searchAggregatorFromFetch(fetch: SearchFetch): SearchPort`（内部构造 SearchAggregator）。若 `defaultSearchPort()` 异步，则构造不能同步调用——**因此走同步 require / 端口文件静态构造**，保证构造同步。
- `stage2WebVerify` 内 `this.searchAgg.searchMulti({...}, [...])` 调用点签名不变（SearchPort 结构兼容 SearchAggregator）。

- [ ] **Step 4: architecture-integrity 收口**

`tests/architecture-integrity.test.ts` L1（:550-567）追加断言：`src/dre` 除 `search-port.ts` 外不得引用 `crawl/`（`from "..../crawl/` 或 `import(".../crawl/`），豁免端口文件；同时保留既有 dre→router 断言。

- [ ] **Step 5: 验证（绿）**

Run: `bun test tests/dre-search-port.test.ts tests/dre-stage2-webverify.test.ts tests/dre-pipeline-conflict.test.ts tests/data-pipeline.test.ts tests/architecture-integrity.test.ts` → 全绿（注入 mock 恒生效，D1 缺陷①回归绿）。
Run: `bunx tsc --noEmit` → 0。
Run: `bun run test:full` → 全绿。

- [ ] **Step 6: 备份清理 + ops-log 留痕 + 提交 C2**

删除备份。`docs/operations-log.md` 追加 W8 条目（hash 待填），提交：
```bash
git add src/dre/pipeline/search-port.ts src/dre/pipeline/pipeline.ts tests/dre-search-port.test.ts tests/architecture-integrity.test.ts docs/operations-log.md
git commit -m "refactor(dre): W8 SearchPort 端口分层（pipeline 去 crawl 静态依赖，M13 闭合 + L1 盲区收口，注入优先防 mock 绕过）"
git push internal211 codex/self-evolving-agent
```

---

### Task 4: 终验 + 收口 + hash 回填

- [ ] **Step 1: 全量终验**

Run: `bun run test:full` → 全绿 0 fail（现 3220 pass，W5/W8 新增测试后只增不减）。
Run: `bunx tsc --noEmit` → 0。

- [ ] **Step 2: 残存检查**

Run: `rg "W5|W8|hash 待回填" docs/operations-log.md` → 无残留占位符；`git status --short` 仅剩与本任务无关的 stat-噪音 M 与未跟踪 traces/__pycache__——不得暂存。

- [ ] **Step 3: 回填 hash + 收口**

用 bun 脚本唯一锚点回填 C1/C2 与 ops-log 占位 hash（禁 sed）。若无新改动则无需新提交（C1/C2 已逐提交推送）；终验属纯验证，不额外入 log（避免记录维护递归）。若需修正则以最小提交推送。

---

## Self-Review（writing-plans 强制自检）

- **Spec 覆盖**：W5 审核 §2（DDL 独立表/触发器/回填/queryKG 并集/降级）→ T1+T2；W8 审核 §3（端口/默认注入/构造不变/M13/L1 盲区）→ T3；终验 → T4。D1 三缺陷逐条映射到回归测试（T1/T2 ②③、T3 ①）。无缺漏。
- **占位符扫描**：唯一占位符为 ops-log 的 `hash 待回填`（有意为之，T4 Step 3 回填，符合 AGENTS 规则 5）；无 TBD/TODO 施工占位。
- **类型一致**：`SearchPort` 接口签名全计划一致；`SearchAggregator` 结构兼容（多一可选 engines 参，可赋值）；`ensureKgFts(db)` 签名 T1/T2 一致。
- **红线保持**：queryKG 排序恒 `importance DESC, id ASC`（M1/M3）；W8 注入 mock 恒生效（D1①）；kg_nodes_fts 绝不成死路径（D1②）；不漏存量（D1③）。


