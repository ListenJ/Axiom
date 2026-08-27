# 审计薄弱点优化 & GitHub 发布设计 — 2026-08-28

> **来源**：2026-08-28 独立审计（`muse-spark`）Stage 1-6 报告；`LIMITATIONS.md` / `README` 审计与整改状态；现场扫描 `src 398 + frontend 157 + runtime-go 114 + docs 113 + tests 326`
> **目标**：以垂直切片 TDD + 多角色审查修复审计全部 High/Critical 薄弱点，并完成 GitHub 私有→公开发布（先扫描再定）
> **分支**：`codex/self-evolving-agent`（当前）→ 推送 `origin` (`ListenJ/Axiom`) 与 `internal211`（按 AGENTS 规则3）

## 1. 背景与问题陈述

### 1.1 已沉淀的整改
- R2 P0安全线 10/10、R3 数据正确性 8/8、R4 文档收口 6/6 已绿（`README:636`、`LIMITATIONS.md:6`）。
- 性能两轮：`DeterministicSearch 14026ms→221ms`、`Vault reindex 718ms→11ms`、`distrib raw.go Header.Clone→Content-Type` 已验证。

### 1.2 本轮审计（2026-08-28）发现的剩余薄弱点（精简）
| # | 等级 | 薄弱点 | 证据锚点 |
|---|------|--------|----------|
| W1 | High | 确定性同分 tie-break 缺失，`readdirSync` 顺序非确定 | `src/memory/deterministic-search.ts:113,396` / `src/dre/retrieval/deterministic-retrieval-engine.ts:493,777` |
| W2 | High | `executeDAG` 失败仍 `completed.add()`，下游静默脏数据 | `src/agents/orchestrator.ts:560-632` |
| W3 | High | MCP "懒加载"不节省 token，全量注册 | `src/mcp/tool-registry.ts:123-145` + `src/mcp/scene-router.ts:379` |
| W4 | High | 无 KV-Cache 换入换出，文档残留 | `src/dre/system-resource.ts` + `src/local-llm/edge-client.ts` |
| W5 | High | `KAL` `LIKE %query%` 全扫 + `relevance` 硬编码 | `src/kal/knowledge-access-layer.ts:159-272` |
| W6 | Medium | `KAL.getReferences` 依赖先 `queryVault` 填充 `vaultNodeIdToPath` | `src/kal/knowledge-access-layer.ts:359-376` |
| W7 | Medium | DIP 媒体分支无开关直调 `glm-4.6v` | `src/knowledge/pipeline.ts` `structureWithGLM` 内媒体分支 |
| W8 | Medium | `DRE` 反向依赖 `crawl/search-engines` 分层破坏 | `src/dre/pipeline/pipeline.ts:16` |
| W9 | Medium | 新文件 `write` 跳过 `realpathSync` 逃逸检查 | `src/mcp/tools/filesystem.ts:isPathSafe` |
| W10 | Medium | `KG` 内容级去重缺失（同内容不同 id 重复） | `src/kg/enhanced.ts:205,277` `INSERT OR REPLACE` 仅 id 级 |
| W11 | Low | 架构文档未覆盖 `context-manager/thompson-router/hallucination-detector/self-evolve` | `docs/AXIOM-ARCHITECTURE.md` 全文检索零命中 |

**薄弱点本质**：确定性/分层/幂等/安全四类，非性能瓶颈（性能已两轮优化至热路径 <50ms）。

## 2. 设计目标与成功标准

- **确定性**：同分查询跨 OS/跨 `reload` 顺序稳定（N≥5 次重复实验方差 0），用 `path.localeCompare` 次级键 + `readdirSync` 结果排序保证。
- **正确性**：`executeDAG` 失败任务不向下游传播；`KAL` 大库 `LIKE` 改 `FTS` 或加 `GIN` 索引回退；`KG` 内容哈希去重。
- **分层**：`DRE` 不直接 import `crawl`，改为 `ports/search-port` 注入。
- **安全**：新文件写入走父目录 `realpathSync`；媒体 LLM 受 `KNOWLEDGE_USE_LLM` 同款开关控制。
- **发布**：`gh repo view` 确认 `PRIVATE→PUBLIC` 前完成高熵密钥扫描（`sk-*/AKIA*/ghp_*/PRIVATE KEY/ZHIPU/DEEPSEEK/SILICONFLOW` 仅命中占位符/测试夹具/patterns），`.env` 保持 `.gitignore` 忽略，内网占位符保持 `${LAN_*}`。
- **可发布性**：`bunx tsc --noEmit 0` + `bun test` 相关 203+ 用例绿 + `gh repo edit --visibility public` 幂等。

## 3. 非目标

- 不引入向量库（faiss/chromadb/qdrant/hnswlib/sentence-transformers）——保持"非向量化主路径"一致。
- 不做 KV-Cache 真实显存换页（缺 `llama.cpp` 侧 `slot` 控制面），W4 改为文档修正 + `clampMaxTokens` 已有预算的显式化，非真实换页实现。
- 不重写 `ThompsonRouter` 的 `Math.random`（路由层非确定属设计，不在确定性承诺内）。

## 4. 架构与数据流

```
[Vault: Obsidian .md] —readdirSync→ DeterministicSearchEngine —FTS5+关键词→ KAL.queryVault
                                    ↑ tie-break: score↓, path↑ (新增)
[KG: kg_nodes/kg_edges] —FTS5→ KAL.queryKG ─┐
[DRE: knowledge_node] —FTS5→ KAL.queryDRE  ─┤→ KAL.query(fan-out Promise.all) → maxByStore归一 → sort(relevance↓) → limit
                                              （W5：KG/DRE 由 LIKE%→FTS，缺表时回退 LIKE）
Orchestrator.executeDAG: ready = dependsOn ⊆ completedSuccess (W2)
DRE pipeline: SearchPort注入 (W8)  ←  crawl/search-engines 由调用方注入，不再直接 import
DIP: fallbackTFIDF(默认) ←[KNOWLEDGE_USE_LLM=false]→ edge→GLM→TFIDF；媒体分支同开关 (W7)
KG Writer: id = contentHash(title+content) 去重 (W10)
MCP: registry.registerWithMcp(filterByExposure) + SceneRouter 为"场景建议"非 token 节省 (W3 文档修正)
Security: filesystem.isPathSafe(parentRealpath) (W9)
```

## 5. 垂直切片与 TDD 契约（对应 AGENTS 规则7）

每薄弱点 = 1 个垂直切片 = 1 测试 → 1 实现 → 1 重构 → 3 角色审查。

| 切片 | 测试锚点（红） | 实现锚点（绿） | 角色审查分工 |
|------|---------------|---------------|-------------|
| S1 W1 确定性 | `tests/memory/vault-reindex.test.ts` 新增 `tie-break sort stability`：构造两笔记同分，多次 `new Engine + search` 比对顺序 | `deterministic-search.ts:113 sort + :396 tie-break`、`deterministic-retrieval-engine.ts:493,777` | Builder: 引擎 / Reviewer: 确定性语义 / Tester: 跨平台 |
| S2 W2 DAG | `tests/orchestrator-v2.test.ts` 新增 `failed task blocks dependents`：DAG 3步中第1失败，断言下游未执行 | `orchestrator.ts:executeDAG` 引入 `completedSuccess` 集合 | Builder: 编排 / Reviewer: 并发 / Tester: 死锁 |
| S3 W5 KAL FTS | `tests/kal-filter-sorting.test.ts` 新增 `fts vs like fallback`：大库 `LIKE` 超阈时走 FTS 回退 | `knowledge-access-layer.ts:queryKG/queryDRE` 优先 FTS5，缺表 catch 回退 LIKE | Builder: 存储 / Reviewer: SQL / Tester: 性能 |
| S4 W7 DIP 媒体开关 | `tests/document-ingest.test.ts` 新增 `KNOWLEDGE_USE_LLM=false skips vision` | `knowledge/pipeline.ts` 媒体分支加 `readBool("KNOWLEDGE_USE_LLM",false)` 守卫 | Builder: 管线 / Reviewer: 偏环 / Tester: 边界 |
| S5 W9 路径逃逸 | `tests/security-fixes.test.ts` 新增 `write new file symlink escape` | `filesystem.ts:isPathSafe` 对父目录 `realpathSync` | Builder: 安全 / Reviewer: 路径 / Tester: TOCTOU |
| S6 W8 分层 | `tests/architecture-integrity.test.ts` 新增 `dre not import crawl` | `dre/ports/search-port.ts` 抽象 + `pipeline.ts:16` 改注入 | Builder: 架构 / Reviewer: 依赖 / Tester: 集成 |
| S7 W3/W4 文档收口 | `tests/architecture-integrity.test.ts` 工具数 + 懒加载声明断言 | `README/AXIOM-ARCHITECTURE.md` 修正懒加载与 KV 描述 | Builder: 文档 / Reviewer: 一致性 / Tester: 计数 |
| S8 W10 KG 去重 | `tests/kg-enhanced.test.ts` 新增 `duplicate content id dedup` | `kg/enhanced.ts` contentHash 生成 id，无则 `REPLACE` 去重 | Builder: 图谱 / Reviewer: 幂等 / Tester: 并发 |

**全局门槛**：`bunx tsc --noEmit 0` + `bun test tests/memory/vault-reindex.test.ts tests/kal-* tests/security-fixes.test.ts tests/orchestrator-* tests/document-ingest.test.ts tests/kg-enhanced.test.ts` 全绿 + `gh repo view --json visibility` 复核。

## 6. GitHub 发布（先扫描再定）

1. 扫描：`sk-*/AKIA*/ghp_*/PRIVATE KEY/ZHIPU*/DEEPSEEK*/SILICONFLOW*` — 已扫，仅命中 `dist/ SECRET_VALUE_RE` 正则、`docs/CONFIGURATION` 文档、`tests/logger-redact` 夹具、`.env.example` 占位符 `sk-your-*`，无真实密钥落库。
2. 校验：`.env` 在 `.gitignore`，`AGENTS.md` 规则11 内网占位符 `${LAN_*}` 已脱敏，`archive/` 在 `.gitignore` 不进入提交。
3. 执行：`gh repo edit ListenJ/Axiom --visibility public --accept-visibility-change-conformance`（幂等，需 `repo` scope，已验证 `gh auth status ✓`）。
4. 推送：`git push origin codex/self-evolving-agent`（当前分支）+ 可选 `main` 同步（若在 main）。
5. 回退：若组织策略禁止 public，提供 `gh repo edit --visibility private` 回退指令。

## 7. 风险与回滚

- **确定性 tie-break** 接入面小（仅两处 sort），回滚：移除次级键。
- **DAG** 改动面：`completedSuccess` 与 `completed` 并存，回滚：恢复单集合。
- **KAL FTS** 依赖 `memory_notes_fts` 存在性，回滚：catch 回退 LIKE 已保留。
- **分层注入** 需改 `DRE` 构造签名，提供默认 `searchPort` 兼容旧调用，回滚：保留直接 import 分支。
- 发布回滚：`gh repo edit --visibility private`。

## 8. 操作留痕与分支策略

- 按 `AGENTS.md` 规则2：每文件先备份 `.tmp/backups/<rel>` → 读全文 → 最小改 → `tsc --noEmit`/`bun test` 验证 → 删备份。
- 按规则3：`git add <仅本任务相关>` → `commit` → `push internal211 <分支>` + `origin <分支>`。
- 按规则5：每次提交前在 `docs/operations-log.md` 追加一条（含时间/任务/工具/文件级操作/验证/hash，未知先占位）。
- 单分支 `codex/self-evolving-agent` 串行切片，避免多分支并发冲突。

## 9. 验收清单

- [ ] S1-S8 8 个切片各有 `红→绿` 测试对，且 `bunx tsc --noEmit 0`
- [ ] `gh repo view --json visibility` = `PUBLIC`（或用户最终确认保持 PRIVATE）
- [ ] `docs/operations-log.md` 追加 1 条总记录 + `LIMITATIONS.md`/`README` 同步 1.3 的闭环声明
- [ ] `LIMITATIONS.md` 已知局限新增 W11 的架构文档补齐说明
- [ ] 所有新增测试在 CI 口径 `bun test` 下通过（`tests/architecture-integrity.test.ts` 含工具数 188 断言）
