# P2-2 — Vault wiki_links 持久化闭环（2026-10-06）

> 来源：`docs/superpowers/plans/2026-09-28-architecture-refresh-and-optimization.md` P2-2。
> 目标：把 Vault Markdown 中已有的 wiki-link 图持久化到 SQLite 可重建索引，补齐 KAL `getReferences` 的跨存储引用腿；Vault 文件仍是唯一事实来源。

## 0. 冻结任务契约

**任务**：新增 `vault_wiki_links` SQLite 索引表，在 Vault 增量重扫/写入时同步出链，在删除时清理；KAL 对 vault node 的 `getReferences` 优先查该表，保留注入引擎回退。

**验收标准**：

1. `SQLiteMemory` 幂等创建 `vault_wiki_links` 及 source/target 索引；表损坏/缺失时可重建，不影响笔记主表。
2. `replaceWikiLinks(sourcePath, links)` 在事务内全量替换该 source 的出链；`getWikiBacklinks(targetPath)` 确定性返回 source path/title。
3. `DeterministicSearchEngine` 暴露“已解析的 wiki 出链”（targetText + 可解析 targetPath），不改变现有关键词/排序语义。
4. `VaultManager.writeNote` 与 `reindexAll` 同步当前笔记的 wiki 出链；`deleteNote` 删除该笔记的出链。
5. KAL `getReferences` 对 `vault:` node：优先查 `vault_wiki_links`，无表/无行时回退现有注入 `vault.getWikiBacklinks`；不重复返回同一 source。
6. 定向测试与全量 `bun test --timeout 15000 ./tests` 全绿；`bunx tsc --noEmit` rc=0。

**不做项**：

- 不改 Markdown wiki-link 解析规则或搜索打分。
- 不新增依赖，不改 KAL 的 KG/DRE 引用语义。
- 不做路径重命名的历史迁移；重扫/写入负责收敛，旧行由 `replaceWikiLinks`/`deleteNote` 清理。
- 不把 Vault 文件复制进 SQLite；SQLite 只是可重建索引。

**回滚**：各 Step 独立提交，可 `git revert`；表可留待下次重建，不影响 Vault 原件。

## 1. Step P2-2a — SQLite schema 与出链/入链 API

**改动**：`src/memory/sqlite-memory.ts`、`tests/unit/sqlite-memory-wiki-links.test.ts`。

**RED**：临时 DB 上 `replaceWikiLinks`/`getWikiBacklinks` 不存在或表未创建。
**GREEN**：创建 `vault_wiki_links(source_path, target_path, target_text, updated_at)`，`source_path` + `target_text` 唯一；source/target 索引；方法事务内替换并返回确定性 backlinks。
**验证**：`bun test tests/unit/sqlite-memory-wiki-links.test.ts`。

## 2. Step P2-2b — DeterministicSearchEngine 解析出链

**改动**：`src/memory/deterministic-search.ts`、`tests/deterministic-search.test.ts`。

**RED**：当前只能取入链/网络，不能拿 source 的出链及其解析目标。
**GREEN**：新增 `getWikiOutgoingLinks(notePath)`：按现有 `normalizeLink` + `linkToPath` 解析，返回去重、按 targetText/targetPath 稳定的数组；未解析目标保留 targetPath=null。
**验证**：新增解析/未解析/乱序稳定用例；既有 wiki-link 搜索用例不变。

## 3. Step P2-2c — VaultManager 同步与删除清理

**改动**：`src/memory/vault-manager.ts`、`tests/vault-wiki-links.test.ts`（或既有 vault 测试）。

**RED**：writeNote 后 SQLite 无出链；reindexAll 不写入；deleteNote 残留。
**GREEN**：writeNote 在文件落定后刷新引擎并写当前出链；reindexAll 对 upsert 笔记写链接、对删除笔记清链接；失败只降级日志，不阻断 Vault 写。
**验证**：临时 vault 写 A→B、写 B、删除 B 路径的确定性用例。

## 4. Step P2-2d — KAL 跨存储引用查询

**改动**：`src/kal/knowledge-access-layer.ts`、`tests/kal-references.test.ts`。

**RED**：只有注入 vault 引擎时才能拿到 wiki backlinks。
**GREEN**：对 `parsed.store === "vault"` 先按 nodeId→path 映射/枚举，再用 `vault_wiki_links` 查入链；结果去重并保留 `metadata.sourcePath`；无表时回退注入引擎。
**验证**：无注入但 DB 有表 → 可返回；注入 + DB 同时存在 → 不重复。

## 5. Step P2-2e — 收口

**验证**：定向测试、`bunx tsc --noEmit`、全量 `bun test --timeout 15000 ./tests`、doc-contract/docs-consistency。
**产物**：本计划执行记录、ops log、必要时更新 `docs/LIMITATIONS.md` 的 wiki-link 边界说明。

## 6. 变更协议

任何超出上述文件的改动必须先回写本计划并说明原因；不得借 P2-2 重写记忆检索/KAL 架构。
