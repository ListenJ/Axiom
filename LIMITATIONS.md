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
3. **工具总数单一事实源**：以 `src/testing/tool-count.ts` 为准，当前 **188**（2026-09-18 移除 `resource_status` 后由 189 回落）；CI 与文档均引用此值，不再硬编码静态数字。
4. **辅助 LLM 默认关闭带来的安全取舍（2026-09-18）**：`EDGE_RISK_MONITOR` 默认关闭后，高风险工具的**灰区**负载不再经边缘小模型初筛，仅由 `permissions.ts` 的正则硬底线与双层复核的第二层把关。硬底线始终生效（`tests/unit/risk-monitor-degraded.test.ts` 的 HardFloor 用例），但灰区（正则未命中）检测强度低于默认开启时。需要该保护时显式设 `EDGE_RISK_MONITOR=1`（`EDGE_RISK_FAIL_CLOSED=1` 可进一步把初筛降级改为 fail-closed）。
5. **本地推理定位与 VRAM 管理移除（2026-09-18）**：本项目不再自托管本地推理，也不再维护 VRAM / token 预算钳制。`src/dre/system-resource.ts`（ResourceBudgetManager、clampMaxTokens）与 `src/dre/system-resource-probe.ts`（nvidia-smi VRAM 轮询）已按规则 4 归档移除；`resource_status` / `vram_status` 工具与 `GPU_CONSTRAINTS` 同步删除。模型统一按**外部 OpenAI 兼容服务**对接（Ollama 或云端，由 `DRE_LLM_URL` 指向），因此"KV cache 卸载到系统内存"一类表述在架构文档中已全部清除；调度器内存准入改用进程堆占用 + 可配置预算（`setBudget({ maxMemoryMB })`）。
6. **知识库向量语义层：已接线，但索引是"手动/显式"触发（2026-09-21 更新）**：向量表（`knowledge_embeddings`，与知识表**同库**）、
   授权门、写入腿、查询腿、候选融合与**跨存储物化**（`KnowledgeAccessLayer.query()` 合并语义候选）均已实现并有测试；
   组合根（`src/mcp/server/kg-tools.ts` 的 `getKAL`）已注入端口；写入腿入口是
   `scripts/index-knowledge-embeddings.ts`（**须显式运行**）。
   **仍未做的**：索引**没有**接入采集/摄取管线 ⇒ **新文档入库后不会自动产生向量**，须重跑该脚本；
   语料上限 5000 行/表（触顶会报 `truncated`，但不会自动续跑）；vault/dre 物化在缓存未命中时是 O(N) 短列枚举。
   ⇒ 端到端能力**已实测跑通**（真实 `bge-m3`：英文查询召回零 token 重叠的中文笔记，`relevance=0.585` 且 `source=semantic`）；
   量化收益见 `eval-results/lexical-vs-semantic-recall-2026-09-20.md`
   （语义三类 Recall@5 **0.0% → 45.5%**；语料 12 条 / 用例 14 条，**不可外推为线上召回率**）。
7. **SiliconFlow 仅 dev/test ⇒ 发布默认下无任何 embedding 候选（2026-09-20）**：用户裁定 SiliconFlow 只作开发测试、不作为发布的一部分，
   落地为 `devOnly` 闸门（`findModelsForRole` 默认过滤该 provider 的 10 条模型条目；dev/test 设 `AXIOM_ALLOW_DEV_MODELS=1` 放行）。
   连带影响（**可验证**）：发布默认下 `ModelRouter.embeddings()` 抛 `No embedding route configured`，调用方降级到词法/哈希路径；
   **语义召回（同义不同词 / 跨语言 / 缩写）不可用**，而**响应延迟不变或略降**（无网络往返）。
   要启用向量语义检索，须**用户自配** embedding 模型（自填 base_url / key / 协议）。视觉/computer-use 仍有非 SiliconFlow 候选，该能力不丢失。
8. **两处"未 unref 的 setInterval 钉死短命进程"已修（2026-09-21）**：`TokenTracker` 自动刷盘与 `AdaptiveProxy` 健康检查
   两处定时器此前未 `unref()`，导致**任何记过用量或走过 `proxyFetch` 的 CLI/脚本干完活也不退出**（两次均由实测发现：
   评测脚本 / 索引脚本打印完结果后挂到 `timeout` 才被杀）。两处均已修 + 各自有**可证伪**的进程退出守卫测试。
   **同模式审计（未逐一处理）**：全仓另有 16 处 `setInterval(`，其中 6 个文件已带 `unref`；剩余（如 `memory/blackboard`、
   `utils/resilience`、`knowledge/auto-updater`、`router/dynamic-model-assigner`、`agents/consciousness` 等）
   **未逐处判定"是否应当 unref"** —— 部分定时器（如 `main.ts` 的心跳）本身就是长驻语义，属**已知未决项**。

## 不在本轮整改范围（明确排除）

- `AGENTS.md` 的 git remote（推送工作流必需）、`docs/operations-log.md`（审计留痕不可篡改）、`scripts/runtime-go/deploy.sh`（真实部署脚本须拨真实主机）保留内网地址；其真实值已在本地凭据目录归档。
- 测试夹具（`tests/security-fixes.test.ts`、`tests/unit/cdp-url-guard.test.ts`、`runtime-go/internal/distrib/node_test.go`）以 `192.168.0.150` 作 SSRF/解析负例，改动将破坏安全测试语义，保留。
