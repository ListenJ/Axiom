# 记忆树展开与使用场景处理（2026-09-25）

> 任务：检查并展开记忆树、按使用场景处理记忆书、处理记忆遗忘。口径：每条结论给到可重跑命令或文件:行号；用户数据一律只登记不擅自处置。
> 本文档是骨架树（`2026-09-25-skeleton-architecture-tree.md` §三 P7）的记忆专项展开。

## 一、记忆资产全景（展开树）

```
记忆资产（三载体 + 一旁库）
│
├─ 【活体 Vault】axiom-memory/（未跟踪，运行时 OBSIDIAN_VAULT_PATH 默认指向此）
│   ├─ 00-Knowledge/        122 md（GitHub trending、Books 等爬取知识）
│   ├─ 00-Meta/             16 md（consciousness、self-evolve 元数据）
│   ├─ 03-Resources/        44 md（atomic-notes、code-index、skills/*.json；111M 大头是附件）
│   │   └─ search-results/  0 md（44 篇已按遗忘规则移入 05-Archives，见 §四）
│   ├─ memory/              0 md（daily-notes 槽位，空）
│   ├─ projects/            1 md（axiom-dsh；PARA 正名应为 01-Projects/）
│   └─ 05-Archives/         44 md（2026-09-25 遗忘执行产物，结构原样保留）
│
├─ 【活体索引】data/agent.db（SQLite，DATABASE_PATH 默认，单源 config-center.ts:81）
│   └─ memory_notes 184 行 = 183 篇 vault 全量 + 1 条孤儿（§五）
│       ├─ FTS5 trigram 索引（memory_notes_fts）
│       ├─ 分类分布: meta 16 / resources 168（00-Knowledge 被兜底记为 resources，见 §五）
│       └─ vault:search 确定性检索的直接数据面
│
├─ 【孤儿树】openclaw-memory/（git 跟踪 41 文件，零代码引用）
│   ├─ 03-Resources/code-index/ 21 md —— code-indexer 实际写 axiom-memory/03-Resources/code-index/
│   │   （code-indexer.ts:59-60 默认 vaultRoot=./axiom-memory），此处是被取代的陈旧副本
│   ├─ memory/ 2026-05/06 的 daily notes —— 四个月前的一次性导入内容
│   └─ Templates/ USER.md TOOLS.md —— vault 模板与说明
│
└─ 【旁库】axiom-memory.db（4 行，2026-09-23 测试/手动运行产物，非运行时数据面）
```

## 二、使用场景矩阵（谁在读/写哪个载体）

| 场景 | 读 | 写 | 证据 |
| --- | --- | --- | --- |
| 服务启动/健康检查 | axiom-memory.db 存在性 | — | `main.ts:63,242`（vaultPath 默认 `./axiom-memory`；dbPath 必传，注释注明 docker 只读根目录坑） |
| 聊天记忆检索 | data/agent.db FTS5 + vault 确定性引擎 | — | `vault-manager.ts` search() 串接两路；`sqlite-memory.ts:29-30` 解析 DB 路径 |
| 笔记写入（API/手动） | — | vault md + data/agent.db upsert | vault-manager 写路径 → `getSqliteMemory()` |
| 爬取知识入库 | — | axiom-memory/00-Knowledge/ | `knowledge/pipeline.ts:126` |
| 代码索引 | src/ 源码 | axiom-memory/03-Resources/code-index/ | `code-indexer.ts:59-60` |
| 技能晋升 | — | axiom-memory/03-Resources/skills/*.json | `skill-promoter.ts:39` |
| 记忆遗忘（PARA 归档） | axiom-memory/ 全树 | → 05-Archives/（移动非删除） | `archiver.ts` 规则表 + `memory-curator.ts`（"Distill, then archive. Never delete"） |
| 索引回填 | axiom-memory/ 全树 | data/agent.db upsert | `sqlite-memory.ts:601 syncFromVault`（本轮接出 CLI） |
| 蒸馏（原子笔记） | 会话/爬取原始内容 | 03-Resources/atomic-notes/ | `distiller.ts` + CLI `distill` |

## 三、遗忘机制：现状与本轮处置

**规则面**（`archiver.ts`，全部只移动、永不删除，`permanent: true` 永不过期）：

| 规则 | 对象 | 阈值 |
| --- | --- | --- |
| conversations | 04-Conversations/ | >30 天 |
| daily-logs | memory/ | >60 天 |
| web-clips | 03-Resources/web-clips/ | >90 天 |
| search-results | 03-Resources/search-results/ | >14 天 |
| completed-projects | 01-Projects/ frontmatter status | 状态驱动 |

**缺口（本轮已补）**：
1. 规则与 curator 都在，但**没有任何人工触发面**（consciousness curator 需 agent 运行期才跑，本机从未触发——树里连 05-Archives/ 都不存在）⇒ 新增 CLI **`vault:archive`**（默认 dry-run 只报告，`--apply` 执行；MemoryArchiver 增 `dryRun` 选项，单测锁定"dry-run 不动盘、不建目录"）。
2. 索引回填能力（`syncFromVault`）同样没有 CLI 面 ⇒ 新增 **`vault:reindex`**（按 path 幂等 upsert，可重复跑）。

**执行记录（2026-09-25 03:14 实跑）**：
- dry-run 报告：将归档 **44 篇**，全部为 `03-Resources/search-results/*`（8 月爬取产物，>14 天阈值命中）——构成核验后 `--apply` 执行。
- 结果：44 篇移入 `axiom-memory/05-Archives/03-Resources/search-results/`（源目录清零，**0 删除**）；live 区 139 + 归档区 44 = 183 篇自洽。
- `vault:reindex` 复核：183 篇同步、索引 184→184 幂等无漂移。

## 四、双库与双树澄清（P7 的答案——**已按建议执行，2026-09-25 04:05**）

1. ~~**`axiom-memory.db`（根目录 4 行）不是运行时数据面**~~ **✅ 已处置**：核验零消费者（`VaultManager` 缺省经 `resolveSqliteMemoryDbPath` 落 `data/agent.db`，`main.ts:242` 注释所指"默认"是陈旧口径）后，三个文件移入 `archive/side-db-2026-09-25/`（未删除）。
2. ~~**`openclaw-memory/` 整树是孤儿**~~ **✅ 已处置**：`git rm -r`（41 文件退跟踪）；归档分支 `codex/archive-2026-09-25`（c916de27 含全量）+ 本分支历史可达；ARCHIVE-LOG 已留痕。
3. 两份残留均不在 vault 路径与 DB 路径上，处置前后的 `vault:reindex`/`vault:search` 行为不受影响。

## 五、遗留清单（2026-09-25 04:05 更新：2 项已修，2 项仍开放）

1. ~~**索引孤儿 1 行**~~ **✅ 已清**：`deleteNote` 移除 09-23 测试残留行，索引 184→183。
2. ~~**00-Knowledge 的 PARA 归类缺口**~~ **✅ 已修**：`syncFromVault`（sqlite-memory.ts）与引擎 `getParaCategory`（deterministic-search.ts）两侧都补 `00-Knowledge → knowledge` 分支；reindex 后两侧一致——SQLite `byCategory = {archives:44, knowledge:122, meta:16, resources:1}`，引擎 PARA 分布同值（此前 123 uncategorized 清零）。
3. **`projects/` 不合 PARA 正名**（应为 `01-Projects/`）：重命名会动运行时写入路径（skill-promoter/distiller 等引用面前后一致后才能动），登记待裁。现状：那 1 篇笔记兜底为 `resources`。
4. **wiki-link 仅 2 条**：Zettelkasten 关联面几乎为零，蒸馏器（distill）从未在真实流量上跑过——属"记忆生长"侧的后续课题，与遗忘（已闭环）相对。

## 六、验证

- 单测：`tests/memory/archiver-dry-run.test.ts` 3 条（dry-run 不动盘不建目录 / apply 真移动且幂等 / permanent 豁免）+ 既有 archiver-safe-move 6 条 = **9 pass / 0 fail**。
- 实跑：`vault:reindex` 183 同步 0 错、184→184；`vault:archive` dry-run 44 → `--apply` 44 移动 0 删除 → reindex 复核 184→184。
- 门：tsc 零错；audit:runtime、doc-contract、architecture-integrity、env 门全绿（数字见 ops log）。
