# 已知局限与审计结论（Limitations & Audit Summary）

> 本文件与 `README.md`「审计与整改状态」双向同步，记录本轮（2026-08-25）三阶段安全/正确性整改的结论与已知局限。
> 操作留痕详见 `docs/operations-log.md`；任务计划见 `docs/superpowers/plans/2026-08-24-audit-remediation-plan.md`。

## 整改完成情况

- **Phase R2（P0 安全线）**：10/10 任务全绿（git 注入白名单、kb 守卫路径、沙箱密钥剥离、SSRF/URL 守卫、密钥 env 隔离等）。
- **Phase R3（功能死路 / 数据正确性）**：8/8 任务完成（搜索结果钳制、stats 真实数据、kg-writer 内容寻址 edgeId + CJK 节点归一化、pdf-worker 摄取终态、kb 同库单一解析源、curlFetch 异步化、maxTokens 预算钳制、kal_references KG 出入边 UNION）。
- **Phase R4（文档与声明收口）**：6/6 任务完成（工具数单一事实源、行数快照治理、测试口径统一、检索注释更正、内网信息脱敏、本摘要同步）。

## 已知局限

1. **wiki-link 跨存储引用未闭环**：`kal_references` 仅覆盖知识图谱出入边 UNION。Vault wiki-link 图由 `DeterministicSearchEngine` 在内存中从 Markdown 构建，本仓库 SQLite 未持久化 `wiki_links` 表，跨存储引用需后续引入持久化表或注入 vault 引擎。
2. **内网信息已脱敏**：真实内网地址/主机账号/硬件仅存于本地非仓库凭据目录 `~/.axiom/axiom-secrets/`，仓库内一律以 `${LAN_NODE_N1}`/`${LAN_NODE_N2}`/`${LAN_NODE_W1}` 等占位符表示（AGENTS.md 规则 11）。`runtime-go/modelclient` 默认端点为 `${LAN_MODEL_SERVICE}`，须由 `MODEL_SERVICE_URL` 显式配置。
3. **工具总数单一事实源**：以 `src/testing/tool-count.ts` 为准，当前 **189**；CI 与文档均引用此值，不再硬编码静态数字。
4. **辅助 LLM 默认关闭带来的安全取舍（2026-09-18，ku 线并入）**：`EDGE_RISK_MONITOR` 默认关闭后，高风险工具的**灰区**负载不再经边缘小模型初筛，仅由 `permissions.ts` 的正则硬底线与双层复核的第二层把关。硬底线始终生效（`tests/unit/risk-monitor-degraded.test.ts` 的 HardFloor 用例），但灰区（正则未命中）检测强度低于默认开启时。需要该保护时显式设 `EDGE_RISK_MONITOR=1`（`EDGE_RISK_FAIL_CLOSED=1` 可进一步把初筛降级改为 fail-closed）。
5. **知识库向量语义层：写入侧推送 + 采集收尾扫描，两条腿都已接线（2026-09-21 更新，ku 线并入）**：
   向量表（`knowledge_embeddings`，与知识表**同库**）、授权门、写入腿、查询腿、候选融合与**跨存储物化**
   （`KnowledgeAccessLayer.query()` 合并语义候选）均已实现并有测试；组合根
   （`src/mcp/server/kg-tools.ts` 的 `getKAL`）已注入端口。
   - **推送腿（写入即索引）**：`VaultManager.writeNote`（单条）、`VaultManager.reindexAll`（批量重建，事务提交后一次性推送）、
     `KnowledgeStore.write`、MCP `kg_write` 四条写入路径都会把刚写的单元推给钩子
     （`services/knowledge-index-hook.ts`，由组合根 `enableKnowledgeEmbeddingIndex(db)` 装配）。
     **内容被修改**（nodeId 不变）同样会重新嵌入（覆盖式 upsert）。未装配/未授权时该钩子是**空操作**（不读库、不触网）；
   - **扫描腿（兜底）**：采集管线（`knowledge:pipeline` → `runPipeline`）收尾调用 `runIncrementalIndex()`，
     只索引**还没有向量**的节点（幂等）；另有全量脚本 `scripts/index-knowledge-embeddings.ts`；
   - **删除同步（2026-09-21 已做）**：①推送 —— `SQLiteMemory.deleteNote` 删行成功后立即清掉同 nodeId 的向量；
     ②扫描 —— `runIncrementalIndex({pruneOrphans:true})`（索引脚本默认开启、采集管线默认开启、`--no-prune-orphans` 可关）
     在同一次语料扫描里清掉"nodeId 已不存在于任何知识表"的向量行。**两道安全闸**：语料被截断（触顶）或**任一存储读取失败**时
     **拒绝清理** —— 那时"不在语料里"无法证明"已被删除"，误删会静默丢向量（该跳过原因会出现在 `pruneSkipped` 里，不静默）。
     删除同步是**纯本地 DB 操作，不调模型、不耗 token**（已实测：无 embedding 调用即可 prune）。
   - **仍未接**：**其它直接调用 `sqliteMemory.upsertNote` 的写入方**（批量重建 `vault-manager.reindexAll` 已接：
     事务提交后**一次性批量推送**，见 `tests/unit/vault-reindex-push.test.ts`）；
     同步写入方（`KnowledgeStore.write` / `SQLiteMemory.deleteNote`）的通知是 **fire-and-forget**（尽力而为），漏掉的由幂等扫描腿补齐；
   - 语料上限 5000 行/表（触顶会报 `truncated`，不自动续跑）；vault/dre 物化在缓存未命中时是 O(N) 短列枚举。
   ⇒ 端到端能力**已实测跑通**（真实 `bge-m3`：英文查询召回零 token 重叠的中文笔记，`relevance=0.585` 且 `source=semantic`）；
   扫描腿实测：新插入 1 条 ⇒ `attempted=1 / indexed=1`（已有 2 条跳过），随后召回该新文档（0.588）；
   推送腿实测：`VaultManager.writeNote` 一次写入即产生向量行（dim=1024），随后英文查询召回该笔记（0.537, `source=semantic`）。
   量化收益见 `eval-results/lexical-vs-semantic-recall-2026-09-20.md`
   （语义三类 Recall@5 **0.0% → 45.5%**；语料 12 条 / 用例 14 条，**不可外推为线上召回率**）。
6. **SiliconFlow 仅 dev/test ⇒ 发布默认下无任何 embedding 候选（2026-09-20，ku 线并入）**：用户裁定 SiliconFlow 只作开发测试、不作为发布的一部分，
   落地为 `devOnly` 闸门（`findModelsForRole` 默认过滤该 provider 的 10 条模型条目；dev/test 设 `AXIOM_ALLOW_DEV_MODELS=1` 放行）。
   连带影响（**可验证**）：发布默认下 `ModelRouter.embeddings()` 抛 `No embedding route configured`，调用方降级到词法/哈希路径；
   **语义召回（同义不同词 / 跨语言 / 缩写）不可用**，而**响应延迟不变或略降**（无网络往返）。
   要启用向量语义检索，须**用户自配** embedding 模型（自填 base_url / key / 协议）。视觉/computer-use 仍有非 SiliconFlow 候选，该能力不丢失。
7. **"未 unref 的 setInterval 钉死短命进程"已系统性收口（2026-09-21，ku 线并入）**：该类缺陷被实测抓到**两次**
   （`TokenTracker` 自动刷盘、`AdaptiveProxy` 健康检查 ⇒ 评测脚本/索引脚本干完活不退出，挂到 `timeout` 才被杀）。
   现状：**后台维护类定时器全部 `unref`**（本轮补 `memory/blackboard`、`utils/resilience`、`router/dynamic-model-assigner`），
   并把判定固化成**门禁测试** `tests/unit/timer-unref-guard.test.ts`：
   - 规则：`src/` 下凡有 `setInterval(` 的文件**必须**真实调用 `unref()`（正则匹配**调用**；
     首版用子串匹配，实测被自己的注释蒙混过关 ⇒ 已收紧，并把经过写进测试注释）；
   - 例外**逐条登记理由**（6 条：服务心跳、TUI 主循环、常驻更新器、DRE 内核 keep-alive、意识层轮询、SSE 请求级心跳），
     且**双向校验**（陈旧登记同样失败）+ 行为级子进程退出断言（可证伪：删掉任一 `unref` 即失败）。
   - 已知未决：**未**逐一评估这些例外之外的运行时行为差异（它们本就是有意长驻）。

   > 归一裁决注（2026-09-26）：ku 线原第 5 条「本地推理定位与 VRAM 管理移除」**未并入** —— 主线（当前基线）
   > 保留 `src/dre/system-resource.ts` 与 `resource_status` 工具（capability 门控），该条描述与归一树事实相反；
   > 详见 `docs/reviews/2026-09-26-trunk-unification.md` 裁决表。

## 不在本轮整改范围（明确排除）

- `AGENTS.md` 的 git remote（推送工作流必需）、`docs/operations-log.md`（审计留痕不可篡改）、`scripts/runtime-go/deploy.sh`（真实部署脚本须拨真实主机）保留内网地址；其真实值已在本地凭据目录归档。
- 测试夹具（`tests/security-fixes.test.ts`、`tests/unit/cdp-url-guard.test.ts`、`runtime-go/internal/distrib/node_test.go`）以 `192.168.0.150` 作 SSRF/解析负例，改动将破坏安全测试语义，保留。
