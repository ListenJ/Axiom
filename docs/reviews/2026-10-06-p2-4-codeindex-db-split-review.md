# P2-4 — codeindex 独立 DB 迁移评估（2026-10-06）

> 来源：`docs/superpowers/plans/2026-09-28-architecture-refresh-and-optimization.md` P2-4。
> 问题：codeindex 产物占 agent.db 大头，是否迁独立 `codegraph.db` 使 agent.db 回归业务库。

## 一、当前事实

- `src/codeindex/local-index.ts` 的 `dbPath()` 当前显式指向 `DATABASE_PATH`（默认 `./data/agent.db`），代码注释明确“单一知识库：代码索引直接并入主库，不再使用独立 code-index.db”。
- 2026-08-20 已有一次性数据合并决策与迁移记录：code-index.db → agent.db；这次 P2-4 若默认拆回独立库，属于**架构反转**，必须有新的 ADR/用户裁决。
- 当前只读快照：
  - `code_symbols` 16,615 行；
  - `code_calls` 75,479 行；
  - `code_index_meta` 1 行；
  - `memory_notes` 184 行、`conversations` 13 行、`kg_nodes`/`kg_edges` 0 行；
  - `data/agent.db` 152MB，`page_count=38,783`、`freelist_count=11,744`（约 45.9MB 空闲页，随最近全量测试增长；不是稳定生产基线）。
- 代码查询面集中在 `src/codeindex/local-index.ts` 与 `src/memory/codegraph-index.ts` 包装层；未发现 KAL 直接对 `code_symbols` 做跨表 join，因此拆库的主要成本在连接/迁移/测试，不是跨库 join。

## 二、方案比较

| 方案 | 优点 | 成本/风险 |
|---|---|---|
| 保持单库（现状） | 一个连接/Schema/备份面；事务与部署简单；2026-08-20 已验证 | agent.db 体积与 freelist 受 codeindex 影响；重建代码索引时业务库也可能需要备份 |
| 默认拆 `codegraph.db` | agent.db 回归业务数据；代码索引可独立删除/重建；可单独 VACUUM | 反转既有决策需 ADR；新增 DB 生命周期/备份/WAL/健康检查；`DATABASE_PATH` 语义变化会破坏测试与部署假设 |
| 兼容式拆库（推荐候选） | 默认行为不变，部署方显式 `CODEINDEX_DB_PATH` 才走独立库；可渐进迁移 | 需要新增路径解析、双连接/健康检查、迁移脚本与回滚验证；默认仍是单库，不立即减小 agent.db |

## 三、建议

**本轮不直接默认拆库。** 推荐路线：

1. 先写 ADR，明确“单库 vs 双库”的最终口径与迁移责任；
2. 若选择双库，先实现 opt-in `CODEINDEX_DB_PATH`，默认仍回落 `DATABASE_PATH`，保证现有部署零变化；
3. 提供一次性 `VACUUM INTO`/表复制脚本，校验 `code_symbols`、`code_calls`、`code_index_meta` 行数与抽样查询；
4. 双库模式跑 codeindex/代码工具/KG 构建/健康检查回归后，再决定是否切换默认；
5. 若继续单库，则例行执行 `VACUUM`/freelist 告警，不把 45.9MB 空闲页永久保留。

**当前状态**：`evaluated; default change requires ADR/user decision`。本轮不迁移 `data/agent.db`，不修改 `DATABASE_PATH` 语义。
