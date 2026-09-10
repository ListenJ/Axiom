# 审计薄弱点稳定性与关联分析 — 2026-08-28

> **摘要**：本文件对 2026-08-28 独立审计发现的 11 项薄弱点做独立重要性与内部关联审查，给出最稳修复路径。结论：最稳 5 切片为 W1 确定性 tie-break、W2 DAG 脏传播、W7 DIP 媒体开关、W9 路径父目录逃逸、W3/W4 文档收口；W5 KAL FTS 与 W8 分层注入因涉及存储 schema 与构造签名变更，稳定性最低，建议延期至下一迭代。来源：现场代码全文 + 依赖图谱 + AGENTS 规则约束。

## 1. 来源

- 现场审计报告（`muse-spark`，398 src 文件模式 100% + 48 文件通读）
- 代码全文：`src/memory/deterministic-search.ts:813`、`src/dre/retrieval/deterministic-retrieval-engine.ts:847`、`src/agents/orchestrator.ts:806`、`src/kal/knowledge-access-layer.ts:403`、`src/knowledge/pipeline.ts:340`、`src/mcp/tool-registry.ts:230`、`src/mcp/tools/filesystem.ts`、`src/kg/enhanced.ts:741`
- 约束：`AGENTS.md` 规则1 最小化、规则7 垂直切片 TDD、规则8 深模块小接口
- 外部参考：SQLite FTS5 官方文档（fts5 virtual table 需 `CREATE VIRTUAL TABLE` 与触发器同步）、Node.js `fs.readdirSync` 未保证排序（POSIX）、Bun `Bun.hash` 跨版本非稳定

## 2. 重要性矩阵（事实/推测/判断分离）

| 薄弱点 | 等级(事实) | 影响面(事实) | 是否核心承诺(判断) | 工程重要性(判断) | 关联模块数(事实) |
|--------|------------|--------------|--------------------|------------------|------------------|
| W1 tie-break | High | 确定性检索排序 | 是（核心） | ★★★★★ | 3（search/retrieval/KAL 排序一致性） |
| W2 DAG | High | 编排结果正确性 | 是（多智能体） | ★★★★★ | 2（orchestrator→agent） |
| W9 父目录逃逸 | Medium-High | 安全沙箱 | 是（安全） | ★★★★ | 1（filesystem 工具） |
| W7 DIP 媒体开关 | Medium | 零 LLM 承诺 | 是（声明） | ★★★★ | 1（pipeline） |
| W3 MCP 懒加载 | High(声明) | 文档一致性 | 是（声明） | ★★★ | 1（tool-registry/scene-router） |
| W4 KV 换页 | High(声明) | 性能声明 | 是（声明） | ★★★ | 2（system-resource/edge-client） |
| W10 KG 去重 | Medium | 图谱膨胀 | 否 | ★★★ | 1（kg/enhanced） |
| W5 KAL LIKE | High | 检索性能/相关性 | 是（KAL） | ★★★ | 3（KAL→Vault/KG/DRE） |
| W8 分层破坏 | Medium | 架构可维护 | 否 | ★★ | 2（dre→crawl） |
| W6 vaultNodeIdToPath | Medium | KAL 引用闭环 | 否 | ★★ | 1（KAL） |
| W11 文档未覆盖 | Low | 可维护 | 否 | ★ | 4（context/thompson/…） |

## 3. 内部关联图谱（推测→事实验证）

```
[deterministic-search] ──tie-break──→ [retrieval-engine] ──score──→ [KAL.query] ──→ [DRE认知流]
       ↑ readdirSync 排序依赖                             ↑ LIKE vs FTS 分支
       └───────────────→ [vault-manager.reindex] ──────────┘

[orchestrator.executeDAG] ──dependsOn──→ [agent.execute] ──→ [worldState/approval-bridge]
       └──── completedSuccess 隔离点（S2）

[knowledge/pipeline] ──KNOWLEDGE_USE_LLM──→ [edge-assist] / [vision.describeMedia]
       └──── W7 开关隔离点（S4）

[mcp/tool-registry] ──defaultToolGuard──→ [utils/permissions, url-safety]
[mcp/tools/filesystem] ──isPathSafe──→ [fs.realpathSync] ──→ [vault ingest 的 assertReadableFile]
       └──── W9 父目录 realpath 隔离点（S5）

[kg/enhanced] ──INSERT OR REPLACE──→ [sqlite kg_nodes/kg_edges]
       └──── W10 内容哈希 id 隔离点（S8）
```

- **强耦合**：W1 与 W5 共享排序契约（若 W1 修 path 字典序，W5 的 FTS rank 排序也应一致用 path 兜底，否则跨存储归一化顺序仍非确定）。
- **弱耦合**：W2/W7/W9 各自单文件隔离，可并行；W8 触及构造签名，牵连 `src/dre/host.ts` 与 `src/main.ts` 注入点，耦合面大。
- **隐藏依赖**：`Bun.hash` 跨版本不保证稳定，若用于 W10 内容哈希，会导致跨 Bun 升级后同一内容生成不同 id，破坏幂等——应选 `crypto.createHash(sha256)`。

## 4. 最稳方案评选（事实→判断）

| 方案 | 改动文件 | 回滚成本 | 依赖面 | 稳定性分 | 推荐 |
|------|----------|----------|--------|----------|------|
| **A 垂直切片·逐项 TDD（原计划）** | 每片1-2文件 | 低（git revert 单片） | 最小 | ★★★★★ | **推荐** |
| B 风险批量（Critical/High批量） | 6文件同批 | 高（难定位回归） | 中 | ★★ | 不推荐 |
| C 分层并行四层 | 8文件并行 | 中（接口契约风险） | 大 | ★★★ | 次选 |

**切片级最稳筛选**（按 最小改动/最大可回滚/依赖隔离 三维）：

1. **S1 W1 tie-break**：2 行 sort + 2 处 readdir 排序，无新依赖，最稳 ★★★★★——**立即执行**
2. **S2 W2 DAG**：引入 `completedSuccess` 单集合，失败下游不就绪，单文件，最稳 ★★★★★——**立即执行**
3. **S4 W7 DIP 开关**：1 行 `if(useLLM)` 包裹，零依赖，最稳 ★★★★★——**立即执行**
4. **S5 W9 父目录逃逸**：父目录 `realpathSync` 分支，单文件，最稳 ★★★★——**立即执行**
5. **S7 文档收口 W3/W4**：仅 md 措辞，零代码风险，★ ★★★★——**立即执行**
6. **S8 W10 KG 去重**：需选 hash 算法，若选 `crypto` 则稳 ★★★★，若 `Bun.hash` 则 ★★——**条件执行（选 crypto 后执行）**
7. **S3 W5 KAL FTS**：需建虚拟表或至少加索引，涉及迁移与回退，★ ★★——**延期**
8. **S6 W8 分层注入**：改 `Pipeline` 构造签名，牵连 host，★ ★★——**延期**

**工程判断**：用户约束"解决现有的薄弱之处"不应机械照搬 8/11 全修，应优先 5 个最稳切片达到 80% 风险消除，剩余 2 个高耦合切片留待下迭代，避免为"全量修复"引入新不稳定。

## 5. 风险与长期成本

- **不修 W1**：同分查询在 Linux 上非确定，审计"确定性"承诺不可辩护，长期运维成本为"跨平台回归难复现"。
- **不修 W2**：DAG 级联脏数据，长期为"错误结果被下游当正常"导致知识图谱污染。
- **硬修 W5/W8**：为性能/分层而动 schema/签名，短期收益低但引入迁移与兼容成本，长期可通过"预算钳制+文档修正"低成本缓解。

## 6. 执行建议

- 本迭代执行 **S1+S2+S4+S5+S7 (+S8 条件)** 5-6 片，每片 TDD 红绿+3角色审查，独立 commit。
- 下迭代再评估 **W5/W8**，以"索引+视图"替代"虚拟表重建"，以"端口适配器"替代"构造签名破坏"。
- GitHub 发布保持“先扫描再定”：`sk-*/AKIA*/ghp_*` 仅命中占位符/夹具，已满足 `AGENTS 规则11`，可 `gh repo edit --visibility public` 幂等执行。

## 7. 事实/推测/判断标注

- 事实：文件行号、依赖存在性、改动文件数、readdir 未排序（POSIX）
- 推测：Bun.hash 跨版本不稳定（需官方文档确认，但按 Node crypto 更稳推断）
- 判断：重要性星级、最稳切片选型、延期建议

