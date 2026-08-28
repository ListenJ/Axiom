# 独立全量审计报告 — 2026-08-28

> 审计员立场：独立第三方，怀疑优先于信任；声称与实现分别核实。本报告只诊断不修复。
> 方法：Phase 0 全量文件清单 → 全量机械扫描（声明相关模式，覆盖 100% 文件）→ 5 组核心模块深读（并行审计子代理，逐文件定位证据）→ 关键论断主会话独立抽验 + 双验证方式交叉 → 模块 7 专项 N≥5 外环实测（5/5 全绿）。
> 分支基线：codex/self-evolving-agent @ a5861c8。

## 1. 审核覆盖率

- **分母**：git 跟踪文件 1470（src 401 / tests 330 / frontend 170 / runtime-go 122 / docs 109 / plugins 63 / scripts 51 / openclaw-memory 41 / src-tauri 23 / native 21 / eval-results 21 / skills 19 / harmonyos 17 / e2e 14 / knowledge-base 10 / config 等其余 ~70）。
- **清单覆盖**：1470/1470（100%，全部归类并进入扫描口径）。
- **机械扫描覆盖（100%）**：src/ 全部 401 文件过 向量库/向量模式/Math.random/时间排序/空 catch/第三方 import 六类模式；向量库与 embedding/cosine 声明扫描另覆盖 runtime-go、frontend/src、native、scripts、openclaw-memory（第二验证方式，全树零命中）。
- **深读覆盖**：src 约 150/401 文件（37%）——13 模块的核心承诺路径（kal、knowledge、kg、dre 核心、agents 编排核心、mcp 核心、crawl、local-llm、router 核心、memory 核心、context、core、self-evolve）由 5 组审计逐文件定位证据；tests 深读 15 个验证文件；docs 深读 3 个声明源。
- **未深读项及原因**（不隐藏，见第 5 节）：src 其余 ~250 文件仅机械扫描；frontend/runtime-go/src-tauri/native/plugins/harmonyos/openclaw-memory/skills/e2e/scripts 等外围树未做内容深审（13 模块声明均锚定 src/，外围树已完成声明相关机械扫描）。
- **覆盖率口径结论**：清单与声明扫描 100%；内容级深审未达 src 100%，本报告不声称"全内容深审完成"。

## 2. 核心技术承诺核查（模块 7，置顶）

### 2.1 "非向量化主路径" ——【一致】（双方式交叉验证）
- 方式一（依赖清单+全树 import）：package.json/bun.lock 及 go/py/rs/ts 全树 **零** faiss/chromadb/qdrant/hnswlib/sentence-transformers/pinecone/milvus 等；`grep A1/A2` 零命中。
- 方式二（主检索链逐文件追踪）：KAL.query → queryStore（kal/knowledge-access-layer.ts:146-150）→ queryVault=FTS5（vault-manager.ts:177）/queryKG/queryDRE=SQL LIKE（:261-267）；dre/storage/knowledge-store.ts:241 FTS5；deterministic-search.ts、deterministic-retrieval-engine.ts、hybrid-fusion.ts 零 cosine/embedding。**主检索链逐文件零向量计算。**
- 存在的 3 处非主路径向量层（不影响"主路径"声明，但影响"仅可选语义层"措辞【部分一致】）：
  1. `src/core/settings-search.ts:5-12,120-129,158-175`：设置页搜索（唯一调用方 routes/settings.ts:28），embedding 链为 **默认尝试**（EDGE_SETTINGS_SEARCH 默认 "1"，edge-embeddings.ts:22-24）三级兜底（本地 127.0.0.1:9001 → 模型路由 bge-m3 → 关键词），非显式 opt-in；
  2. `src/context/context-manager.ts:15,265,534`：上下文压缩辅助（retrieveFromMemory 仅 :305 内部调用）；
  3. `src/dre/consciousness/stream.ts:127`：EpisodicMemory.search **零调用方=死代码**。

### 2.2 "确定性推理" ——【部分一致】
- **真确定**：主检索链零 Math.random（52 处 Math.random/29 文件均在 DRE 非承诺子系统：ID 生成/重试 jitter——actor/system.ts:178、mental-model/pool.ts:270、pipeline/task-graph.ts:303、port/knowledge-port.ts:260、port/types.ts:172、llm/client.ts:207、event-bus.ts:105、knowledge-network.ts:163、rule-engine.ts:90；practice-manual.ts:47 为字符串字面量）；ThompsonRouter 采样（thompson-router.ts:143-168）为**声明豁免**（AXIOM-ARCHITECTURE.md:1308）。
- **未声明残留（确定性缺口）**：
  1. `src/dre/retrieval/deterministic-retrieval-engine.ts:777` `sort((a,b)=>b.score-a.score)` 无次级键——W1 修复了 :493 漏了 :777，同分顺序靠 Map 插入序兜底；
  2. localeCompare 无显式 locale（deterministic-search.ts:113,396,652,664,762；dre-engine:493）——依赖宿主 ICU，跨平台非 ASCII 路径 tie-break 可能漂移；
  3. KAL queryKG `ORDER BY importance DESC`（:219）、queryDRE `ORDER BY confidence DESC`（:263）无次级键——同分顺序由 SQLite 返回序决定。
- **N≥5 外环实测**：deterministic-search-tie + vault-reindex + deterministic-search 测试组 5 次重复运行全部 0 fail（2026-08-28 实测）。
- **交叉验证矛盾（如实报告）**：静态追踪确认 dre-engine 同分无测试覆盖；tests/dre-retrieval-engine.test.ts:185 仅断言分数降序、无同输入同输出重复断言——测试覆盖不对称（vault 有强 tie 断言，DRE 引擎没有）。

### 2.3 "zero-LLM 默认路径" ——【一致】
`pipeline.ts:264-267` `readBool("KNOWLEDGE_USE_LLM", false)` 外层三元 + W7 媒体分支 `pipeline.ts:120-121` 双守卫，默认关；fallbackTFIDF（:49-116）纯正则/Map 零 fetch 零 import、16KB 钳制（:50）；vision.ts glm-4.6v 唯一入口 describeMediaInMarkdown 仅 useLLM=true 可达（vision.ts:100,318 ← pipeline.ts:123）。

## 3. 声明 vs 实际对照总表（模块 13）

| # | 声明 | 出处 | 结论 | 证据 |
|---|------|------|------|------|
| 1 | 确定性认知运行时 | README:3,5 | 部分一致 | 主链一致；dre-engine:777/localeCompare/KAL 同分为缺口（见 2.2） |
| 2 | 188 MCP 工具 | README:5,24,244 | 一致 | 实跑 count-tools.mjs=188；grep name 字面量去重 188 |
| 3 | 8 Persona 模式 | README:5 | 一致 | types.ts 3 + loader.ts 5 个 id |
| 4 | 非向量化主路径 | README:176 | 一致 | 见 2.1 双方式验证 |
| 5 | zero-LLM（默认） | README:176 | 一致 | 见 2.3 双守卫 |
| 6 | 懒加载（已收口为"场景建议"） | README:46 | 一致 | server.ts:418-422 全量注册 188；SceneRouter 仅 scene_suggest_tools 建议制（server.ts:355-390） |
| 7 | KV 卸载换入换出（已收口为"无实现，仅 token 钳制"） | README:161 | 一致 | 仅 clampMaxTokens（system-resource.ts:23-26）；无换页代码 |
| 8 | VRAM 预算 | README:161 | 部分一致 | 钳制公式存在，但预算数虚构（H1，见模块 9） |
| 9 | SQLite 唯一数据库 | README:609 | 一致 | src 无 pg import |
| 10 | 隐私保护：指纹随机化+代理轮换+反追踪 | README:40,612 | **不一致** | src/crawl 全树 fingerprint/rotate 零命中；UA 固定串（data-pipeline.ts:262、search-engines.ts:340）；代理单一静态 env（search-engines.ts:71） |
| 11 | 模型路由链 硅基流动→OfoxAI→DeepSeek→OpenRouter | README:41 | 部分一致 | 4 家均注册（router/models/providers.ts:12-17）但注册序不符声明，实际动态路由 |
| 12 | MinerU→AST→KG Writer 管线 | 审计委托前提 | 部分一致 | MinerU 仅外部 worker（scripts/pdf-worker/app.py:1,122）；AST 存在（doc-ast.ts/document-ingest.ts:183）；runPipeline 产 JSONL，文档→KG 仅经 MCP dip_ingest_document 手动触发（kg-tools.ts:69-108） |
| 13 | llama.cpp + Qwen3-1.7B + KV 卸载到系统内存 | 审计委托前提 | 部分一致 | llama.cpp 仅 HTTP 客户端（dre/llm/client.ts:47,58）；config.ts:57 配置 qwen3-1.7b-instruct 但 edge-client.ts:27 默认 MiniCPM5-1B（名不一致）；KV 卸载无实现 |

## 4. 分模块问题清单

**Critical：未发现。**（核心技术承诺"非向量化主路径/zero-LLM 默认"经双方式验证成立）

### High（6 项）
| # | 位置 | 证据/问题 | 影响 | 缓解 |
|---|------|----------|------|------|
| H1 | src/dre/system-resource-probe.ts:45 + system-resource.ts:52 | `startVramProbe` 全仓零调用点（grep 实证）；availableMemory 恒为 default 4000MB 硬编码 | canRun/recommendedMaxTokens 基于虚构值，VRAM 预算全链路失真 | fail-fast 抛错不静默（client.ts:234-247） |
| H2 | src/mcp/server/kg-tools.ts:276,302 | `node-${Date.now()}-${Math.random()...}` 随机 id 绕过 enhanced.ts:202-206 内容哈希去重 | MCP kg_add_node/kg_add_edge 手工写入同内容必重复（W10 仅覆盖自动路径） | dip_ingest 自动路径有哈希 |
| H3 | src/mcp/server/orchestrator-tools.ts:40-47 + agents/orchestrator.ts:419-430,616 | step schema 无 timeout 字段；executeDAG 仅 task.timeout 存在才 race | 经 orchestrator_execute_plan 的 DAG 步骤默认无超时，Promise.all 可永久挂起 | 无 |
| H4 | README:40,612 vs src/crawl 全树 | 隐私三声明零实现（见对照表 #10） | 虚假宣传面；GitHub PUBLIC 状态下声誉风险 | 无 |
| H5 | src/agents/kg-research-agent.ts:234 | 搜索 snippet 原样拼 prompt（仅 200 字符截断，无消毒） | 间接提示注入可操纵研究结论并回写 KG（:127） | 长度钳制仅 |
| H6 | src/mcp/server/kg-tools.ts:16 | `new KnowledgeAccessLayer(db)` 未注入 vault 适配器 | getReferences vault 腿生产不可达（W6 修复空转），跨存储引用功能缺失 | 代码路径正确（kal:361-369） |
| H7 | src/kg/enhanced.ts:152-155,321 | 内存 adjacency 不从 DB 恢复 | 进程重启后 subgraph/paths 图查询空转 | 基础 SQL 查询仍可用 |

### Medium（12 项）
M1 KAL queryKG/DRE 同分无次级键（knowledge-access-layer.ts:219,263）；M2 dre-engine:777 无 tie-break（W1 半边遗漏）；M3 localeCompare 无显式 locale 跨平台漂移（deterministic-search.ts:113 等 5 处）；M4 空文档仍产 KG 节点且 success:true（markdown-ast.ts:60-65 + kg-writer.ts:84-90 + pipeline.ts:277-293 quality 0.5≥0.4）；M5 addNode 哈希含 description→描述变更生新 id 旧节点残留（enhanced.ts:204）；M6 DAG 环检测缺失，环与依赖失败混报 "Deadlock detected" 且剩余任务不列名（orchestrator.ts:597-600）；M7 timeout 输 race 后孤儿任务无 abort 后台续跑（orchestrator.ts:420-431）；M8 每任务结束同步 selfImprove LLM 调用放大吞吐（orchestrator.ts:433,454,466）；M9 代理 curl 路径无 AbortController，单查询最坏 ~92s 有界阻塞（search-engines.ts:117,171-179）；M10 云端降级只发 observation 丢本地工作记忆（engine.ts:746-750）；M11 routes/chat.ts:22 请求体零校验直接解构；M12 filesystem.ts:98 symlink 守卫内空 catch 吞错后继续执行（另有 kal 6 处/knowledge 11 处/dre 26 处/mcp-tools 18 处空或仅注释 catch，全无 logger；src 全树空 catch 分母 341，纯空 35）；M13 dre→crawl 反向依赖仍在（pipeline.ts:16）且架构测试 L1（:551）仅禁 dre→router 未覆盖 crawl、文档无豁免声明；M14 nodeId 双体系不一致——KAL:239 产出 `kg:function:kg_xxx` 而 getReferences:344 用原样 id。

### Low（12 项）
L1 created_at 每次 REPLACE 刷新丢溯源（enhanced.ts:229,297）；L2 vaultNodeIdToPath Map 无上界（kal:75,190）；L3 kg_nodes 双份 DDL 漂移风险（enhanced.ts:159 vs kg-writer.ts:46）；L4 ToolRegistry.add 无去重（tool-registry.ts:108-121，靠 SDK 抛错+docs-consistency 断言兜底）；L5 completed Set 死变量（orchestrator.ts:585,611）；L6 getToolsByTags/getToolsMetaFiltered 死代码（tool-registry.ts:216-226）；L7 proxyFetch ssrfGuard 为 opt-in（proxy-fetch.ts:411）；L8 HardFloor 仅检固定字段名（tool-registry.ts:64）；L9 `import ts from "typescript"` 生产代码导入 devDependency（codeindex/local-index.ts:10）；L10 kal/knowledge 静默降级无 logger 17 处；L11 edge 默认模型 MiniCPM5-1B 与 config Qwen3-1.7B 不一致（edge-client.ts:27 vs config.ts:57）；L12 richSnippets.deepLinks 未钳制（search-engines.ts:269）+ result-scorer.ts:121 每调用 new 检测器。

### Info（8 项）
I1 KAL 统一为接口层+O3-F5 归一，实现层三套独立 SQL；I2 管线结构化链实为 edge→GLM→TFIDF；I3 VRAM 预算≈整卡估算，未扣系统/其他进程占用，KV 估算无量化选项；I4 perf/stress 测试均为纯 CPU 热路径，不含推理显存峰值；I5 startVramProbe 设计为 env 开关但无调用点（与 H1 同源）；I6 tool-count.ts:5 注释称 count-tools.mjs"已不存在"实为可运行；I7 HallucinationDetector 位于 src/memory 而文档 2.19 归入引擎组语境；I8 全局 search-cache.db 在 import unified-search.ts:475 时即创建。

## 5. 未验证/无法访问项清单
1. src 其余 ~250 文件（utils/routes/cli/tui/terminal/ocr/components/services/testing/agent-evals/workers/plugins/db/computer-use/pi-agent/sandbox/codeindex 等）：仅机械扫描，未逐行深读。
2. frontend(170)/runtime-go(122)/src-tauri(23)/native(21)/plugins(63)/harmonyos(17)/openclaw-memory(41)/skills(19)/e2e(14)/scripts(51)：内容深审未做（外围树；向量库/声明机械扫描已覆盖且零命中）。runtime-go modelclient 端点配置未核。
3. MODE_CONFIGS.maxAutoRetries（execution-mode.ts:76）在编排层未见消费，其他调用方未验证。
4. bun.lock 逐包完整性核对未做（仅声明相关 grep）。
5. eval-results/ 21 个数据产物文件内容未审。
6. 第三方 vendor 代码（node_modules、@modelcontextprotocol/sdk 内部）未审——仅核对其注册去重行为（mcp.js:659 抛错）。
7. 本审计为静态代码审计+测试实跑，未做长时间运行/真实硬件 VRAM 实测（RTX 3050 硬件不在本审计环境）。

## 6. 总体结论
1. **核心技术承诺成立**：非向量化主路径（双方式交叉验证一致，第 2.1 节）与 zero-LLM 默认路径（双守卫，第 2.3 节）经查属实；确定性承诺**部分成立**——主检索链确定，但存在 3 处未声明残留（M1/M2/M3）且 DRE 引擎测试覆盖弱于 Vault（第 2.2 节交叉矛盾）。
2. **声明面最大风险是 H4**：README 隐私三声明（指纹随机化+代理轮换+反追踪）零实现，GitHub PUBLIC 状态下为虚假宣传面，建议最高优先收口（改文档或补实现，二选一）。
3. **功能面最大风险是 H1+H7+H6**：VRAM 预算全链路失真（探测未挂载）、KG 图内存态重启丢失、vault 适配器未注入——三者共同特征是"组件已写好但未接线"，与 H2（随机 id 击穿去重）、H3（DAG 无超时）合计构成下一迭代"接线与收口"清单。
4. **工程质量面**：空 catch 分母 341（纯空 35）且关键路径全部无 logger（M12）；架构测试存在 dre→crawl 盲区（M13）；入库杂物（.server-pid.txt、tmp-toctou-target、eval-results）与幽灵依赖声明（@earendil-works/pi-ai）属低风险卫生问题。
5. 本报告全部结论附代码锚点，7 项 Critical 级未发现；所有 High/Medium 均可在现有接缝上以小切片修复，无需架构级重构。

---

## 7. 修复状态回写（2026-08-28 优化迭代，同日完成）

| 项 | 状态 | Commit | 说明 |
|----|------|--------|------|
| H4 隐私声明失实 | ✅ 改文档收口 | 328bcdd | README 声明改为实际实现（固定 UA+可选静态代理+SSRF），路由措辞同步改动态路由 |
| H1 VRAM 探测未挂载 | ✅ 已接线 | 3fd26ca | main.ts 启动链挂载 startVramProbe（AXIOM_VRAM_PROBE=1 门控）+ 关停钩；tests/vram-probe-wiring.test.ts 锁定 |
| H2 kg-tools 随机 id | ✅ 已修 | 3e7182c | 两 handler 改走 enhanced.ts sha256 内容哈希；tests/kg-tools-dedup.test.ts 行为级锁定 |
| H7 图内存态不恢复 | ✅ 已修 | 3e7182c | enhanced.ts 构造时 restoreGraphFromDb() 全量重建；tests/kg-restore-adjacency.test.ts |
| H3 DAG 无超时 | ✅ 已修 | 2514c71 | MCP 计划步骤默认 120s 超时（DEFAULT_STEP_TIMEOUT_MS，步骤级可覆盖）；tests/orchestrator-plan-timeout.test.ts |
| H5 snippet 注入面 | ✅ 最小收敛 | 37b96f8 | kg-research-agent 注入点加 UNTRUSTED 边界标记；tests/kg-research-agent-untrusted.test.ts |
| M12 filesystem 空 catch | ✅ 补日志 | 37b96f8 | 三处 catch 补 logger.debug（:98 fail-open 语义保留并注释残余风险） |
| M1 KAL 同分次级键 | ✅ 已修 | be6f271 | queryKG/queryDRE ORDER BY 加 id/node_id ASC；tests/kal-deterministic-order.test.ts |
| M2 dre-engine:777 tie-break | ✅ 已修 | be6f271 | 与 :493 W1 修法对齐；tests/dre-retrieval-tie.test.ts |
| 杂物入库（.server-pid/tmp-toctou-target） | ✅ 已出库 | 151ff6b | 归档 archive/runtime-junk-2026-08-28 + gitignore 防再入 |
| H6 vault 适配器未注入 | ⏸ 延期 | — | 接线需改 VaultManager 公共 API 且给 MCP 进程拉起整个 vault 栈，成本/收益不成立；随 W5/W8 重立项一并评估 |
| M3 localeCompare 显式 locale | ⏸ 延期 | — | 改动会翻转现有排序语义，随 W5/W8 重立项一并处理 |
| M4-M11/M13/M14 + 全部 Low | 📋 待排期 | — | 见第 4 节，均为接缝级小切片 |

**回归验证（2026-08-28）**：`bun run test:full` 473 pass / 0 fail（含本迭代 8 个新测试文件）；`bunx tsc --noEmit` 0。
