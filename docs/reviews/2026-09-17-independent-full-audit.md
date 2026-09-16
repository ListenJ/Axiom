# 独立第三方代码与架构审计报告

- **审核日期**：2026-09-17
- **仓库**：openclaw-fusion @ `codex/audit-2026-09-17`（自 `codex/node22-decommission-n2-swap` @ 81cb54b 分出）
- **审核方**：独立第三方审计（主审计 + 5 个只读审计子代理并行）
- **性质**：只读诊断，未修改任何业务代码（仅产出本报告 + ops log）
- **执行环境**：Bun 1.4.2, Linux x64

---

## 〇、审核完成度声明（先给结论，再给细节）

**本次审核尚未完成。** 按审核任务书第七节"审核完成判定标准"，三条判定条件中：

| 判定条件 | 状态 | 说明 |
| --- | --- | --- |
| 文件覆盖率 = 100% | ❌ **未达成** | 深度逐行审核约 170/873 个核心源文件（≈19.5%）；但全量静态分析覆盖 100%（见第一节） |
| 模块 7 核心承诺给出明确结论 | ✅ **达成** | 见第二节：**部分矛盾**（非"看起来符合预期"） |
| Critical/High 均附可复现代码证据 | ✅ **达成** | 每条均附 `文件:行号` + ≤15 行代码片段；关键项已实证运行 |

**阻塞项**（未达 100% 覆盖的原因）：

1. 未深度审核的目录：`src/routes`(36)、`src/router`(20，除 task-orchestrator/model-router)、`src/eval`(7)、`src/memory`(16，除已审 6 个)、`src/core`(6)、`src/services`(9，除 knowledge.ts)、`src/dre`(53，除已审 9 个)、`src/components`(9)、`src/tui`(2)、`src/cli`(7)、`src/db`(6)、`src/skills`(3)、`src/testing`(14，除 tool-count)、`src/codeindex`(1)、`src/context`(3，除 context-manager)、`src/terminal`(2)、`frontend/`、`runtime-go/`、`native/`(仅依赖树+关键词扫描)。
2. 这些目录已受**全量静态扫描**覆盖（import 环检测、向量化/LLM/MinerU 关键字扫描、依赖清单核查），但**未逐行审核**，因此不能声称"全量审核完成"。
3. 本报告所有结论均限定在**已审核范围内**，未审核项见第五节。

---

## 一、审核覆盖率

### 1.1 Phase 0 文件清单

排除范围：`node_modules`、`.git`、`dist`、`vendor`、`playwright-report`、`test-results`、`__pycache__`、`target`、`.tmp`、`openclaw-memory`、`axiom-memory`（生成态记忆数据，6.7 万 json）、二进制/模型文件。

| 范围 | 文件数 | 说明 |
| --- | --- | --- |
| 源码（核心逻辑，非测试） | 873 | `src/`(408 非 test) + `native/`(16 rs) + `runtime-go/`(111 go) + `mcp/` + `scripts/` + `plugins/` + `frontend/src` + … |
| 测试 | 220 | `tests/` 418 项中 220 个 .ts（含 .test.ts） |
| 文档（关键声明类） | ~60 | README、AGENTS.md、docs/ 下架构/限制/知识库类（3707 md 中与声明相关的子集） |

**预计需要审核的文件总数（深度审核分母）**：873 个核心源文件。

### 1.2 实际覆盖

| 覆盖层级 | 数量 | 方法 |
| --- | --- | --- |
| A. 深度逐行/逐段审核 | **≈170 文件** | 主审计 + 5 子代理，每文件给出"已审核-无问题/发现问题/跳过-原因"状态 |
| B. 全量静态分析 | **411/411 src 模块（100%）** | 自写 Tarjan SCC 环检测：**0 个循环依赖**；全 src/+native/ 关键字扫描（向量化/embedding/LLM/MinerU/KV/VRAM/随机数） |
| C. 依赖清单核查 | 100% | `package.json`、`native/Cargo.toml`、`runtime-go/go.mod`、`bun.lock` |
| D. 运行时实证 | 6 组 | 确定性 N=10 重复实验、KG 幂等实验、blackboard 冲突复现、工具计数实测、确定性测试套件运行 |

**深度覆盖率 = 170/873 ≈ 19.5%。** 未达 100%，故不声称"全量审核完成"。

### 1.3 各模块覆盖状态

| 模块 | 范围内文件 | 深度审核 | 覆盖率 |
| --- | --- | --- | --- |
| 1 架构一致性 | 全 src | 静态全量（环检测+目录核对+依赖方向） | 特殊：100% 静态 |
| 2 Agent 编排 | 54 | 54 | 100% |
| 3 MCP 工具层 | 41 | 39（2 个纯类型跳过） | 100% |
| 4 网络搜索 | 13 | 13 | 100% |
| 5 KAL | 24 | 24 | 100% |
| 6 摄取管线 | 7(+2 文档) | 7(+2) | 100% |
| 7 确定性/非向量化 | 全 src 关键路径 | 主审计亲自 + 实证 | 100%（专项） |
| 8 本地推理 | 9 | 9 | 100% |
| 9 VRAM 预算 | 3 | 3 | 100% |
| 10 安全/错误处理 | 6(+10 关联) | 6(+10) | 100% |
| 11 性能/资源 | 关键路径 | 随各模块附带 | 部分 |
| 12 代码质量 | 关键路径 | 随各模块附带 + 测试覆盖核查 | 部分 |
| 13 声明一致性 | 60 文档 | 逐条对照 | 100%（声明侧） |

---

## 二、核心技术承诺核查结果（模块 7 专项，置顶）

### 2.1「不使用向量化 / 非向量化本地语义搜索」

**结论：部分矛盾。默认检索路径确实非向量化；但向量化代码真实存在，且其中一条在默认配置下即被启用。**

**(a) 依赖侧——一致（无任何向量检索库）**

`package.json` 依赖仅 8 项（`@modelcontextprotocol/sdk`、`blessed`、`mammoth`、`tesseract.js`、`typescript`、`unpdf`、`yaml`、`zod`）。全仓 grep `faiss|chromadb|qdrant|annoy|hnswlib|sentence-transformers|onnx|tensorflow|torch`：

- `src/`、`native/`、`runtime-go/`：**0 命中**（唯一命中在 `.tmp-e2e/omini/` 第三方测试夹具，非本仓库代码）。
- `native/Cargo.toml` 依赖：tokio/serde/rusqlite/redis/deadpool-postgres/aho-corasick/lru —— 无向量库。
- `runtime-go/go.mod`：prometheus/go-redis —— 无向量库。

**(b) 代码侧——存在 3 处真实运行时 cosine 调用（与"不使用向量化"表述矛盾）**

`src/utils/math.ts:7` 提供共享 `cosineSimilarity`，真实调用点：

| 位置 | 代码证据 | 是否默认启用 |
| --- | --- | --- |
| `src/core/settings-search.ts:129-166` | `defaultEmbedder` → `getEdgeEmbeddings`（本地 bge-m3）失败回落 `modelRouter.embeddings`（**远端 API**）；`cosineSimilarity(qv, vectors[i+1])` 打分 | ⚠️ **默认启用**：`EDGE_SETTINGS_SEARCH` 默认 `"1"`（`edge-embeddings.ts:34`），且 `searchSettings` 未传 embedder 时走 `defaultEmbedder` |
| `src/dre/consciousness/stream.ts:127,188` | `EpisodicMemory.search`：`score: item.embedding ? this.cosineSimilarity(queryEmbedding, item.embedding) : 0`；`consolidate()` 用 cosine>0.7 聚类 | 休眠：全仓**无任何调用方传入 `embedding`**（`consciousnessStep`/`step` 的 4 个生产调用点均只传 observation） |
| `src/context/context-manager.ts:265,458` | `retrieveFromMemory` 用 cosine 排序，`generateEmbedding` 失败回落 128 维字符频率哈希 | 死路径：`contextManager` 单例仅 `routes/audit.ts:41` 调 `getMemoryStats()`，`retrieveFromMemory`/`processChunk` 零外部调用方 |

**(c) 矛盾判定**

- README:165/244 与 LIMITATIONS.md:55 已把口径调整为"FTS5+关键词打分为确定性检索；cosineSimilarity 仅在启用 embedding 的可选语义层使用"——**这个调整后的表述仍与代码不符**：`settings-search` 的语义层由 `EDGE_SETTINGS_SEARCH` 默认 `"1"` 守卫，**不是"启用 embedding 时"而是"默认启用，需显式关闭"**；且其 embedding 来源是**远端 API**（`modelRouter.embeddings`），"本地语义搜索"在边缘模型不可用时实际是**远端向量搜索**。
- `hallucination-detector.ts`（Jaccard×BM25，注释自述"无 embedding / 向量 / 神经网络依赖"）与 `deterministic-search.ts`（手写倒排索引，零向量）——**核实属实，确实非向量化**。

**→ 评级：Critical（C-02）。** "不使用向量化"作为核心承诺，在 settings 搜索路径上被默认违反；在 DRE 核心引擎中存在休眠的向量路径（embedding 字段端到端可达，缺的只是调用方传参）。

### 2.2「确定性推理 / 同输入同输出」

**结论：检索层确定性已实证通过；但"同输入同输出"在最外层被默认启用的 LLM 改写打破。**

**(a) 检索层——实证确定性（✅）**

自写 harness（`.tmp/det-harness2.ts`，已运行）：

| 实验 | 结果 |
| --- | --- |
| `DeterministicSearchEngine` 同实例重复查询 10 次 | 去重签名数 = **1**，DETERMINISTIC |
| `DeterministicSearchEngine` 跨新建实例 10 次（含 readdir 逆序创建 vault） | 去重签名数 = **1**，DETERMINISTIC；逆序目录仍按 path 字典序返回 |
| `KAL.query(targetStore:"kg")` 跨实例 10 次 | 去重签名数 = **1**，DETERMINISTIC |
| `KAL.query(targetStore:"dre")` 跨实例 10 次 | 去重签名数 = **1**，DETERMINISTIC |
| 既有确定性测试套件（kal-deterministic-order / deterministic-search-tie / dre-retrieval-tie） | **6 pass / 0 fail** |

确定性保障证据：`KAL` 三条腿 ORDER BY 均带次级键（`importance DESC, id ASC` / `confidence DESC, node_id ASC` / `mn.id ASC`）；`scanDirectory` 对 readdir 做 `localeCompare` 排序；`Date.now()`/`performance.now()` 仅用于缓存 TTL 与延迟统计，**不参与打分或排序**。

**(b) 确定性被打破的两处（❌）**

1. **查询入口默认 LLM 改写**（`src/services/knowledge.ts:88-97`）：`rewriteKnowledgeQueryWithEdge(req.query)` 成功时覆盖检索键。守卫是 `EDGE_KNOWLEDGE_ASSIST`（默认 `"1"`），非 `KNOWLEDGE_USE_LLM`。同一自然语言查询每次改写结果可能不同 → 检索键漂移。
2. **采集质量裁决默认走 LLM**（`src/knowledge/collector.ts:86`）：`judgeKnowledgeQualityWithEdge` 决定内容是否入池（**检索决策路径**）；同受 `EDGE_KNOWLEDGE_ASSIST` 默认启用守卫。

**→ 评级：Critical（C-01）。** 这也是"zero LLM in path"承诺在采集链上的破口（见 2.3）。

**(c) 已声明的非确定区（Info，非缺陷）**

`docs/AXIOM-ARCHITECTURE.md:1308` 明确："采样使用 `Math.random`，路由层非确定属设计——不在系统'同输入同输出'的确定性承诺范围内"。DRE LLM 侧 `temperature=0.0`、`seed=42`（`dre/llm/client.ts:110-112`）。

### 2.3「摄取管线 zero LLM in path」

**结论：部分一致。document-ingest 全路径成立；采集管线（collector）不成立。**

| 路径 | 结论 | 证据 |
| --- | --- | --- |
| `src/knowledge/document-ingest.ts` 全分支（web/text/docx/pdf/image） | ✅ **零生成式 LLM** | 逐分支核实：web/text→readDocument+organizeDocument；pdf→unpdf→外部 pdf-worker→降级说明；image→Tesseract→postProcessOCR；所有失败返回 `error` 字段，无 LLM 兜底 |
| `KNOWLEDGE_USE_LLM` 开关 | ✅ 默认 `false` 属实 | `pipeline.ts:121,281` 均 `readBool("KNOWLEDGE_USE_LLM", false)`；`false` 时走 `fallbackTFIDF` |
| `src/knowledge/collector.ts` 采集链 | ❌ **默认调用 4 个边缘 LLM** | `judgeKnowledgeQualityWithEdge`(质量裁决)、`isNearDuplicateWithEdge`、`summarizeKnowledgeWithEdge`、`generateTagsWithEdge`；守卫 `EDGE_KNOWLEDGE_ASSIST` 默认启用，**完全不读 `KNOWLEDGE_USE_LLM`**（`edge-assist.ts:45,88,119,149,174` 交叉验证） |
| `src/knowledge/vision.ts` | ⚠️ 函数自身无守卫 | `describeMediaInMarkdown` 是唯一无 `KNOWLEDGE_USE_LLM` 自身守卫的生成式入口（守卫在调用方 `pipeline.ts:120-122`），且含 GLM→opencode 视觉模型**双 LLM 回退链**（`vision.ts:137,203`） |
| MinerU（PP-DocLayoutV2/Unimernet/印章 OCR） | ⚠️ 无法验证 | `rg -i mineru src/` **0 命中**——不在本仓库 TS 运行时，属外部 Python pdf-worker 组件；"零生成式 LLM"口径在 `KNOWLEDGE-BASE.md:44-48` 与 `LIMITATIONS.md:89-95` 双处披露且自洽（判别式 vs 生成式口径） |

**→ 评级：High（H-06 的一部分）。** "异常兜底路径偷偷调用 LLM"这一排查点在 collector 上命中（主流程即调用，非仅异常分支）。


---

## 三、声明 vs 实际对照总表（模块 13）

| # | 声明（来源） | 实际（代码证据） | 判定 |
| --- | --- | --- | --- |
| 1 | "不使用向量化 / 零-向量、零-embedding"（旧宣称，`docs/ARCHITECTURE.md:10` 等） | `settings-search.ts:166` 默认启用 cosine+embedding（边缘→**远端 API** 回落）；`stream.ts:127` 休眠向量路径；`context-manager.ts:265` 死路径 | **不一致**（旧）→ **部分不一致**（W3/W4 调整后口径仍与默认配置不符） |
| 2 | "确定性推理 / 同输入同输出"（README:3） | 检索层实证 N=10 完全一致 ✅；但 `services/knowledge.ts:88` 默认 LLM 查询改写 + `collector.ts:86` 默认 LLM 质量裁决打破同输入同输出 | **部分不一致** |
| 3 | "zero LLM in path"（摄取管线） | `document-ingest.ts` 全路径零 LLM ✅；`collector.ts` 默认 4 个边缘 LLM；`vision.ts` 无自身守卫 | **部分不一致** |
| 4 | "189 个去重工具，零重复"（README:244） | 实测 `countMcpTools()` total=189, duplicates=[] ✅（静态字面量扫描口径） | **一致**（口径为静态扫描，非运行时实测） |
| 5 | "工具懒加载，未调用前不占用上下文 token"（任务书口径 / `server.ts:354` 注释） | `registerWithMcp` 启动时（HTTP 模式每请求）全量注册 189 个完整 schema 进 `tools/list`；`scene_suggest_tools` 仅建议不改变枚举；`ToolDef.tags` 零消费方 | **不一致** |
| 6 | "KV Cache 卸载到系统内存 + 换入换出"（早期声明） | 全 src/+native/ **0 行换页实现**；实为 `clampMaxTokens` 纯数字钳制 | **不一致**（项目自身已在 README:46/161 澄清，并有回归断言 `architecture-integrity.test.ts:594`） |
| 7 | "VRAM 预算管理 / 主动降级" | `ResourceBudgetManager` 有防抖(5%)+滞回(500MB)+上限(4096) ✅；但默认 `availableMemory=4000` 硬编码、`AXIOM_VRAM_PROBE` 默认关 → 钳制退化为常量 | **部分一致** |
| 8 | "KAL 统一三个碎片化后端" | 读侧统一（单一 `query()` 门面）✅；写侧分裂（无统一写入接口，`kg_edges`/`kg_edge` 双边表无同步，三套后端类在 8 处被直接实例化） | **部分一致** |
| 9 | "MinerU → AST 解析器 → KG Writer" | MinerU 不在 TS 运行时（外部 Python 组件）；AST(`doc-ast.ts`/`markdown-ast.ts`)+KG Writer 在仓库内 ✅ | **无法验证**（MinerU 环节） |
| 10 | "本地模型 Qwen3-1.7B"（任务书） | `dre/config.ts:59` `qwen3-1.7b-instruct` @ :8080 ✅；边缘链路为 `MiniCPM5-1B` @ :9001（代码注释明确为预期设计） | **一致**（主推理链路） |
| 11 | "SQLite 为唯一数据库（PG 已移除 H-M1-03）" | TS 侧无 pg 依赖 ✅；但 `native/Cargo.toml` 仍保留 `deadpool-postgres`/`tokio-postgres` workspace 依赖 | **部分一致**（Rust 侧依赖未清理） |
| 12 | "21 场景 SceneRouter"（README:30 架构图） | `DEFAULT_SCENES` 实际 **23** 个场景 | **不一致**（轻微） |
| 13 | "8 Persona modes"（README:5） | `src/dre/persona/` 存在，`mode-tools.ts` 注册模式工具 | **一致**（未逐项深核） |
| 14 | "LLM 仅作为 Cognitive Accelerator，确定性推理为核心"（README:3） | DRE 6 步确定性闭环 + 4 级 LLM 降级链（`engine.ts:517-556` L1 本地→L2 云→L3 规则）✅；但降级链为 catch 驱动的被动故障切换 | **一致**（设计事实） |
| 15 | "zero-向量全文搜索"（`docs/PROJECT-GUIDE.md:27` 旧宣称） | `deterministic-search.ts` 确为手写倒排索引零向量 ✅；但 settings 搜索与 DRE 意识流存在向量路径 | **部分不一致**（LIMITATIONS.md:55 已自披露） |

---

## 四、分模块问题清单

级别定义：Critical（核心承诺矛盾/数据损坏/安全漏洞）｜High（特定条件下失效或错误结果）｜Medium（明显风险，迟早触发）｜Low（可维护性）｜Info（设计取舍记录）。

### 模块 1｜整体架构一致性

| 编号 | 级别 | 文件:行号 | 问题 | 缓解 |
| --- | --- | --- | --- | --- |
| A1-1 | Info | 全 src（Tarjan SCC，411 模块） | **正面结论**：循环依赖 SCC 数 = **0**。模块间依赖方向无环；knowledge/crawl 层不反向依赖 agents 层（grep 确认 0 命中） | — |
| A1-2 | Low | README:30 vs `src/mcp/scene-router.ts:186-379` | 架构图称"21 场景"，`DEFAULT_SCENES` 实际 23 个 | 文档数字漂移 |
| A1-3 | Info | `src/mcp/scene-router.ts` vs `src/router/` | SceneRouter 位于 `src/mcp/` 而非 `src/router/`，与"场景路由层"在架构图中的层级位置不符（功能归属：MCP 服务层） | 无实际影响 |
| A1-4 | Info | `src/context/context-manager.ts:537` | `contextManager` 单例的 embedding/cosine 检索路径（251-305）零生产调用方，仅 `routes/audit.ts:41` 用 `getMemoryStats()` → 废弃代码路径未清理 | 无 |
| A1-5 | Info | `native/Cargo.toml` | Rust 侧保留 `deadpool-postgres`/`tokio-postgres`/`redis` 依赖，与 TS 侧"PG 已移除，SQLite 唯一数据库"口径不一致（`local`/`cloud` crate 为部署形态网关） | 需确认是否仍支持 PG 部署 |

### 模块 2｜Agent 编排 / 多智能体协作（子代理：Bernoulli，54/54）

| 编号 | 级别 | 文件:行号 | 问题（证据已由主审计交叉验证） | 缓解 |
| --- | --- | --- | --- | --- |
| A2-1 | **Critical→High** | `state-store.ts:38-45` + `blackboard.ts:165-181` | StateStore 第 2/4/6… 次写入触发 conflict 被拒，累积型自我状态（tokensSpentThisSession/recentInsights/mood/goals）**隔次清空**。**主审计已实证复现**：`1st write verified({tokens:10}) → 2nd write conflict(值停留 10) → 3rd write verified({tokens:30})` | 无。`tests/consciousness.test.ts` beforeEach clear() 恰好绕过该路径 |
| A2-2 | High | `blackboard.ts:622-638` | `readOrCompute` 无互斥：await 间隙并发 miss→全部 compute→全部 write，第二个 write 必落 conflict，缓存变持续 miss 毒丸 | 无 in-flight 去重 |
| A2-3 | Medium | `blackboard.ts:252` | 跨进程版本号并列时双向静默忽略，同 key 同版本不同值永久分叉 | Redis 同步可选 |
| A2-4 | Medium | `blackboard.ts:240-275` | `applyRemoteUpdate` 不发布 `blackboard:write:<key>` 事件，订阅方感知不到跨进程更新 | 无 |
| A2-5 | Medium | `dre/runtime/scheduler.ts:234-240,272-292` | 无依赖环检测（成环永久 pending 且无日志）、无默认 deadline（挂死任务永久占用并发槽） | `fail()` 指数退避；preemptOne 代数守卫正确 |
| A2-6 | Medium | `agents/orchestrator.ts:421-448,592-607` | 超时为可选项（不传则完全无超时），失败步骤无重试无降级；DAG 模式的 `findDagCycle` 环检测做得最好 | fireEvolve 异步回流教训 |
| A2-7 | Medium | `dre/actor/system.ts:195-224` | `queryState` 收 NACK 不 resolve，固定多等 5s 超时 | 有超时兜底 |
| A2-8 | Medium | `dre/actor/system.ts:174-227` | Actor 消息无跳数/环检测，互发可活锁；有界邮箱(256)溢出丢最旧 | O4 有界邮箱；processing 标志防自重入 |
| A2-9 | Medium | `agents/computer-use-agent.ts:289,299-306` | `runTask` 只执行首个非 done 动作，却把全部动作计入 history → 模型认知与实际系统性脱节 | maxSteps 上限 |
| A2-10 | Medium | `agents/project-analyzer.ts:251-286` | `walkDir` 无 maxDepth、无 symlink 环保护（`depth` 参数从未用于截断） | EXCLUDED_DIRS |
| A2-11 | Medium | `agents/consciousness/index.ts:69-86` | `start()` 非幂等（注释声称 Idempotent），重复调用泄漏 setInterval | ReflectionLoop.running 标志防并发 |
| A2-12 | Low | `pi-agent/pi-code-tools.ts:219-253` | `executeBatch` 串行实现，与"并行"文档及从未消费的 `useParallel` 选项不符 | — |
| A2-13 | Low | `pi-agent/pi-code-engine.ts:279-288` | `usageSearch` 结果解构后从未使用（无用 IO + 注释声称的"并行搜索调用链"未兑现） | — |
| A2-14 | Low | `agents/hermes-agent.ts:155-192` | 子进程 stdout 内存无界累积（默认 10 分钟超时期间全量驻留） | 有超时 kill |
| A2-15 | Low | `router/task-orchestrator.ts:288-312` | 单角色失败把错误文本塞进 `content` 返回，无独立失败信号字段 | verifyAndCorrect fail-closed |
| A2-16 | Low | `self-evolve/skill-quality.ts:51-62,96-122` | 多进程全量重写 skill-quality.json 无文件锁（原子写只防半截崩溃） | 单进程部署不触发 |
| A2-17 | Info | `agents/prompt-pool.ts:574-584` | `release()` 零调用方（死代码）；evict 内层 O(n²) 重复计算 | — |
| A2-18 | Info | `dre/actor/system.ts:284` | 消息 id 仅 4 位随机后缀（≈1.67M 空间），同毫秒碰撞可能 | — |

**正面结论**：orchestrator DAG 失败归因、CrossValidator fail-closed 仲裁、risk-monitor 双层复核、codegen 信号量恰好一次释放、ReflectionLoop 并发隔离——均为高质量实现。

### 模块 3｜MCP 工具层（子代理：Copernicus，39/39）

| 编号 | 级别 | 文件:行号 | 问题（主审计已交叉验证 F1/F5/F6） | 缓解 |
| --- | --- | --- | --- | --- |
| A3-1 | **Critical** | `plugins/plugin-registry.ts:191-197,295-301,336` + `routes/plugin-routes.ts:125-135` | **插件 manifest.id 无路径段校验 → 任意目录删除/写入；默认 auto-enable + 动态 import → 默认开启的任意代码执行**。`join(pluginDir, "../../x")` 跳出插件目录后先 `removeDirectory` 递归删再拷贝；uninstall 以同路径 `rm -rf`；`enable: body.enable ?? true` 立即 `await import(entryPath)` | 网关 `checkApiKey` fail-closed + 默认仅绑回环；`install()` 重载注释自称"default: disabled for security"（两入口默认值相反） |
| A3-2 | **Critical** | `mcp/tool-registry.ts:138-146` + `mcp/server.ts:354,424` | **"懒加载"不成立**：启动时（HTTP 模式每请求）把全部 189 个工具 + 完整 inputSchema 注册给 SDK，`tools/list` 全量返回（正是进入 LLM 上下文、按 token 计费的内容）；`scene_suggest_tools` 仅建议不减枚举；`ToolDef.tags`（注释"用于懒加载"）零消费方 | `AXIOM-ARCHITECTURE.md:1394` 已澄清"SceneRouter 为建议，不减少 list_tools 计费"；`architecture-integrity.test.ts:591-595` 断言文档不得出现"懒加载.*节省.*token"。**但代码注释与字段注释仍误导，且无按需注册实现** |
| A3-3 | Medium | `tools/read-tool.ts:75-83` | `read` 工具 web 分支用**原生 fetch**，无协议白名单/私网/元数据拦截/重定向逐跳校验，绕过同仓库完备的 `url-safety.ts`（可拉取 `169.254.169.254/latest/meta-data/`） | `defaultToolGuard` 子串黑名单拦 `/etc`/`.ssh`/`.env`；默认 internal exposure |
| A3-4 | Medium | `mcp/tools/terminal.ts:55-69` + `utils/command-safety.ts:16-45` | `terminal_exec` 黑名单只匹配 `rm` 短选项组合：`rm --recursive --force` 不命中（`\w` 不含 `-`）；`python3 -c "import os;os.system(...)"` 不被结构模式拦截 | `AXIOM_TERMINAL_WHITELIST` 白名单可彻底收敛但默认关；args 数组通道不经 shell；cwd 围栏 |
| A3-5 | Medium | `mcp/tools/workspace-snapshot.ts:195-205` | `snapshot_revert` 恢复目标路径 `path.join(cwd, file)` **不经 `isPathSafe`**；快照仓可被 fs_write 篡改后植入 `../../../etc/cron.d/x` 树路径 → 任意文件写 | snapshotId 白名单(6-64 hex)；create 只从 `git ls-files` 取真实文件 |
| A3-6 | Medium | `mcp/client-connector.ts:171-179` + `config/mcp-servers.yaml` | 网关侧把 6 个外部 server 工具以前缀全量注册；其中 `obsidian`/`opencode` 条目指向 `src/mcp/server.ts` 自身 = 内部工具集以不同名重复注册一遍（动态名对 tool-count.ts 不可见） | MCP 服务器侧 189 计数仍准确；同名跳过防崩溃 |
| A3-7 | Medium | `testing/tool-count.ts:17,60-105` | "权威计数"是静态字面量行正则扫描，非运行时 registry 实测；动态名漏计 + 非工具 `name:` 字面量误计风险；无运行时 `registry.size===189` 断言 | docs-consistency 测试防文档漂移（实测 9 pass） |
| A3-8 | Low | `tools/write-tool.ts:47-62` | 写前 `isPathSafe` 后 mkdir，**无 TOCTOU 二次校验**（与自身注释声称的"与 filesystem.ts 同一守卫"不符，后者有 postSafety 重校验） | symlink realpath 检查含父目录回退 |
| A3-9 | Low | `mcp/tool-registry.ts:66-78` + `utils/permissions.ts:56-78` | 守卫层路径校验为子串匹配：`config/etc/app.conf` 误拒 + 非常规字段名携带路径可绕过；与权威的段级 `isPathSafe` 形成两套并行语义 | isPathSafe 最终兜底 |
| A3-10 | Low | `mcp/server/db-tools.ts:67-77` | `db_query` 只读判定 `startsWith("select")` 过严，拒 `WITH...SELECT`/`PRAGMA` | bun:sqlite 单语句语义兜底，无注入风险 |
| A3-11 | Low | `main.ts:410-412` + `routes/scene-routes.ts:18-20` | 网关 `pluginToolRegistry` 从不注册内置工具，但 `DEFAULT_SCENES` 引用 `git_status`/`fs_read` 等内置名 → `POST /mcp/scene` 对所有默认场景必然 "Tool X not found" | MCP 服务器进程内 SceneRouter 正常 |

**正面结论**：`mcp/tools/filesystem.ts`（cwd 围栏 + 敏感段 + symlink realpath + TOCTOU 重校验 + 原子 rename + 进程内串行化）是本仓最扎实的实现；`web_fetch`/`web_search` 的 SSRF 守卫完备；github/git/code-analysis 工具全部数组通道+参数化。

### 模块 4｜网络搜索（子代理：Franklin，13/13）

| 编号 | 级别 | 文件:行号 | 问题 | 缓解 |
| --- | --- | --- | --- | --- |
| A4-1 | Medium | `crawl/data-pipeline.ts:364-417` | 网页正文 markdown **无任何长度上限**进 vault（`saveRaw` 只截 raw HTML 副本 50000）；单页 10MB markdown 原样进 RAG 检索源 | fetch 层 10MB 体上限（`proxy-fetch.ts:443`）；snippet 侧 300 字符截断 |
| A4-2 | Medium | `crawl/data-pipeline.ts:274-290` / `search-engines.ts:449-474` | 聚合层出口不做 sanitize，`routes/tools.ts:71-73` 已有漏网实例（结果直接回 LLM） | 4 个主要调用方已清洗 |
| A4-3 | Medium | `crawl/data-pipeline.ts:918-924` | 串行 crawl 链路无总预算，最坏 ≈8-9 分钟挂起 | 单页 15s abort + 3 次重试 |
| A4-4 | Low | `crawl/data-pipeline.ts:252,321-322` | `visited` 集合跨调用累积不清理，重复爬取静默跳过 | 实例多为按需创建 |
| A4-5 | Low | `crawl/unified-search.ts:416-420` / `data-pipeline.ts:914-916` | 明文查询落 SQLite/日志，与同文件 `sanitizeQueryForLog` 脱敏策略不一致 | 搜索路径日志已脱敏 |
| A4-6 | Low | `proxy-fetch.ts:903-906` / `serpapi-client.ts:212` | 429 不识别不退避，`Retry-After` 未读 | 5xx 指数退避；DDG/Bing 202/502 有重试 |
| A4-7 | Low | `search-engines.ts:41-49` | sanitize 不钳制 `richSnippets`（deepLinks 已钳制） | 条数上限 30 |

**正面结论**：搜索侧截断（snippet 300/title 200/items 30/deepLinks 5×200）、去重三实现、TLD 可信度评分、域名多样性、超时预算体系完整。

### 模块 5｜KAL（子代理：Carson，24/24）

| 编号 | 级别 | 文件:行号 | 问题 | 缓解 |
| --- | --- | --- | --- | --- |
| A5-1 | Medium | `mcp/server/kg-tools.ts:14-16` vs `kal/knowledge-access-layer.ts:82-84` | KAL 构造支持可选 vault 适配器（`getWikiBacklinks`+`listNotePaths`），但唯一消费者从不传入 → **vault 节点的入链引用在生产环境恒为空**，仅 debug 日志静默降级 | W6 保留注入点与降级逻辑，补一行即恢复 |
| A5-2 | Medium | `kg/schema.ts:32` vs `dre/storage/sqlite-backend.ts:124`；贴合 `kal:436-446` | KG 双边表分裂：`kg_edges`(source/target/type) 与 `kg_edge`(src_node/dst_node/relation) schema 不同、无 FK、无同步；KAL 用 `UNION ALL`（不去重）贴合，可返回重复引用/悬空边 | KAL 对缺失有整体降级 |
| A5-3 | Medium | `memory/vault-manager.ts:101-107` + `deterministic-search.ts:198-226` | 外部编辑子目录笔记不改变 vault 根 mtime → `engine.reload` 被跳过 → contentCache（LRU 200、**无 TTL**）返回旧内容 → 旧内容回填进 FTS = 脏读窗口 | file-watcher 防抖 reload；启动 reindexAll；手动 reload 路由 |
| A5-4 | Low | `dre/retrieval/deterministic-retrieval-engine.ts:217-218,540-562` | queryCache 仅 TTL 失效，知识写入不主动失效（最长 5 分钟旧结果） | LRU+5min TTL；key 含参数 |
| A5-5 | Low | `kal/knowledge-access-layer.ts:536-565` | trigram/FTS 探测结果进程内一次性缓存，不刷新 | 两腿均能正确返回，错误探测降级为 false |
| A5-6 | Info | `kal/knowledge-access-layer.ts:88-100` | `storesQueried` 顺序依赖 promise 完成序（当前同步实现下实测确定） | 仅影响展示字段 |

### 模块 6｜文档摄取管线（子代理：Carson，7+2/9）

| 编号 | 级别 | 文件:行号 | 问题（主审计已交叉验证 F1/F2） | 缓解 |
| --- | --- | --- | --- | --- |
| A6-1 | **Critical** | `ocr/post-processor.ts:53-64` | **OCR 全局字符腐蚀**：`correctText`（`textCorrection` 默认 true）对全部 OCR 文本执行 `{pattern:/[O]/g, replacement:"0"}` 与 `{pattern:/[l]/g, replacement:"1"}`，而非仅数字上下文 → `Open→0pen`、`Model→Mode1`、`list→1ist`。错误内容静默写入 vault/FTS/KG，无告警。代码注释自承需要 "smarter logic" 但从未实现 | `minConfidence=30` 过滤低置信块，不检测字符级腐蚀。**无对应测试**（`find tests -name "*post-process*"` = 0） |
| A6-2 | High | `knowledge/collector.ts:86,99,107-108` + `edge-assist.ts:45,88,119,149,174` | 采集管线 4 个边缘 LLM（含**质量裁决这一检索决策**）由默认启用的 `EDGE_KNOWLEDGE_ASSIST` 守卫，完全不读 `KNOWLEDGE_USE_LLM`；与 `pipeline.ts` 的严格守卫形成双重标准 | 全部函数可空返回+try/catch，模型不可用时回退规则结果 |
| A6-3 | High | `knowledge/store.ts:228-241,290-296` | `storeAsVaultNote` 未传 `overwrite` → 同名笔记抛 `Note already exists`（重摄失败被 collector catch 吞为警告）；`slugify` 剔除全部非 ASCII → **中文标题塌缩为空路径互相覆盖** | `isCollected(url)` 去重拦同 URL 重摄；`pipeline.ts:271` 书籍路径显式传 overwrite（说明此为遗漏） |
| A6-4 | Medium | `knowledge/vision.ts:92-160,137,203` | `describeMediaInMarkdown` 是唯一无 `KNOWLEDGE_USE_LLM` 自身守卫的生成式入口（守卫在调用方）；含 GLM→opencode 视觉（kimi-k2.6）双 LLM 回退链，后者文档未披露 | `structureWithGLM` 内部二次校验 useLLM（纵深防御）；失败均降级不阻塞 |
| A6-5 | Low | `knowledge/index.ts:8-11` | 桶文件重导出 `./github-trending.js`、`./z-library.js` 路径不存在（实际在 `sources/`）→ `discoverBooks` 等经 index 导入运行时 undefined | 无内部消费者（pipeline 直接从 sources 导入） |
| A6-6 | Low | `crawl/processor/kg-writer.ts:115,125,215` | 节点 id 取内容前缀（50/80/100 字符）而非全文哈希 → 前缀相同的不同内容静默合并 | `createNodeId` 对非 ASCII 追加 sha1；enhanced.ts 用全名哈希不受影响 |
| A6-7 | Low | `ocr/engine.ts:257-264` | `getOCREngine` 全局单例按语言 reinitialize，多语言图片并发摄取时后者重置前者 worker → 结果错语言静默不报错 | document-ingest 允许注入 ocrEngine 绕开单例 |

**正面结论**：`doc-ast.ts` 容错良好（未闭合围栏收敛至 EOF、表格列数不匹配不中断、空输入返回默认 AST、无死循环）；`kg-writer` 的 `edgeId` 内容寻址 sha1（F-3 修复）与 `enhanced.ts` 的幂等写入**已实证**（重复摄取同一 AST：nodes 1→1，edges 0，零重复）。

### 模块 7｜确定性 & 非向量化（主审计亲自 + 实证）

见第二节。汇总：检索层确定性实证通过（4 组 N=10 实验 + 6 个既有测试全绿）；向量化代码存在且 settings 路径默认启用（C-02）；查询入口默认 LLM 改写打破确定性（C-01）。

### 模块 8｜本地推理管线（子代理：Banach，9/9）

| 编号 | 级别 | 文件:行号 | 问题 | 缓解 |
| --- | --- | --- | --- | --- |
| A8-1 | Info | `README.md:46,161` / `AXIOM-ARCHITECTURE.md:1206` | **"KV Cache 卸载到系统内存"声明不成立**（全仓 0 行换页实现），但项目自身已在 W3/W4 澄清并加回归断言 | `architecture-integrity.test.ts:594` 防回退 |
| A8-2 | Info | `dre/llm/client.ts:309-345` | llama.cpp 为纯 HTTP 客户端（`/v1/chat/completions` 或原生 `/completion`，`cache_prompt:true`），模型完全在进程外加载；native/ Rust 无 llama/ggml 依赖 | 非缺陷，架构事实 |
| A8-3 | Medium | `router/model-router.ts:342,363,571,584` + `models/types.ts:6-17` | `provider:"local"` 是虚位标签（ModelProvider 联合类型不含 local）：失败/降级调用被记为 provider=local，污染 token-tracker 按提供商统计 | `fallbackUsed:true` 标志存在 |
| A8-4 | Medium | `dre/llm/client.ts:80,216-228` | 500 被判可重试，无 OOM 特化识别（OOM 重试无用应立即降级，当前浪费退避窗口） | 熔断器第二层保护 |
| A8-5 | Medium | `local-llm/risk-screen.ts:89-91,125-133` | 边缘风险初筛 fail-open：任何失败（含 OOM/熔断）降级为 `risk:"low"` —— 本地推理故障时安全防线失效 | `degraded:true` 可触发上层第二层复核 |
| A8-6 | Medium | `dre/llm/client.ts:164,320,340` | 只钳 completion（`n_predict`/`max_tokens`）不钳 prompt → 长 prompt 可超 llama.cpp `--ctx-size`，行为依赖外部 server | 注释自承此缺口 |

### 模块 9｜VRAM 预算管理器（子代理：Banach，3/3）

| 编号 | 级别 | 文件:行号 | 问题 | 缓解 |
| --- | --- | --- | --- | --- |
| A9-1 | High | `dre/system-resource.ts:51-57` + `system-resource-probe.ts:46` | 默认 `availableMemory=4000` 硬编码（"纯 CPU 环境保守估计"），真实显存探测 `AXIOM_VRAM_PROBE` 默认关 → **钳制退化为常量**，既不能在显存不足时降级也不能在充裕时放宽。数值恰与 RTX3050 4GB 接近但二者无关 | `AXIOM_VRAM_PROBE=1` 可启用（探测逻辑本身正确） |
| A9-2 | Medium | `dre/system-resource.ts:152,178-181` | 预算只覆盖模型权重+KV+安全边距，**不含激活值**（隐含于 200MB 边距） | 安全边距粗略缓冲 |
| A9-3 | Low | `dre/system-resource.ts:34-36` | `maxCompute`/`availableCompute` 死字段（**主审计 grep 全 src 确认零决策消费方**） | — |
| A9-4 | Low | `dre/system-resource.ts:88` | `bytesPerToken=229376` 隐含 MHA(16 KV头)；Qwen3-1.7B 官方 GQA(8 KV头) 真实 114688 = 恰为 2 倍（已核实 HF config.json）；注释称"校准"不严谨 | 方向安全（高估→保守） |
| A9-5 | Info | 同上 `:103-176` | **正面结论**：防抖（DEBOUNCE_RATIO 0.05）+ 缓变逃逸（同向 streak≥3）+ 滞回（RECOVERY_MARGIN 500MB）+ 硬上限 4096，机制设计较完整 | — |
| A9-6 | Info | `dre/constraint/solver.ts:539-560` | `GPU_CONSTRAINTS` 已标 @deprecated，其 subject `gpu_free_vram_mb` 无数据源（与 A9-1 叠加：约束求解器要求一个永远拿不到的指标） | 已标废弃 |

### 模块 10｜安全 / 错误处理 / 边界（子代理：Franklin，6+10/16）

| 编号 | 级别 | 文件:行号 | 问题 | 缓解 |
| --- | --- | --- | --- | --- |
| A10-1 | Medium | `crawl/lightpanda-client.ts:363-368,873-876` | 渲染回退 `proxyFetch` **未开 ssrfGuard**：入口 `isSafeUrl` 只校验一次，ssrfGuard 关时最多 5 次重定向无逐跳校验 → 302 到 `169.254.169.254` 被跟随 | 主链路 `crawlStructured` 自有 fetch 传 `ssrfGuard:true` 且逐跳+DNS 二次校验；ssrfGuard 默认关是 L7 审计的有意决策 |
| A10-2 | Medium | `sandbox/process-sandbox.ts:89-95` | Docker 不可用降级到 process 沙箱时，`opts.cwd` 无 `isPathSafe` 围栏（docker 分支有 `assertMountDirAllowed`） | readOnly 显式拒绝；args 危险字符前置拒绝+引用；env 密钥剥离 |
| A10-3 | Medium | `utils/api-key-store.ts:412-437` | 密钥连通性测试用**原生 fetch** + 可控 baseURL（路由侧只校验协议不拦内网）→ 已认证用户可将 API Key 发往任意/内网主机（gemini 形式密钥入 URL） | requireAuthToken + isKnownProvider 白名单 + 8s 超时 + 返回值脱敏 |
| A10-4 | Medium | `unified-search.ts:334-339,416-421` / `lightpanda-client.ts:693-697` | 三处 `catch { /* ignore */ }` 完全无日志不上抛（缓存写/历史写/CDP 解析），故障不可观测 | 其余关键路径 catch 均有 logger.warn（项目已有规范） |
| A10-5 | Low | `utils/url-safety.ts:82,91-97` | `"localhost."` 尾点绕过主机名黑名单；IPv6 `"::"`（未指定地址）无分支命中放行 | ssrfGuard:true 时 `assertResolvedHostSafe` 拦解析后真实地址 |
| A10-6 | Low | `lightpanda-client.ts:238,493,626,733` | 模块内不对 cdpUrl 过 `assertSafeCdpUrl`（该函数存在于 url-safety.ts:150） | 调用方（routes/agents.ts、browser-tools.ts）已校验 |
| A10-7 | Info | `search-engines.ts:41-49` | 无 prompt 注入专项清洗（网页正文/摘要以原始文本进 LLM 上下文） | HTML 标签剥离 + 长度截断降低注入面 |

### 模块 11｜性能与资源约束（目标硬件：RTX 3050 4GB + 系统内存）

| 编号 | 级别 | 依据 | 结论 |
| --- | --- | --- | --- |
| A11-1 | Medium | `system-resource.ts:51-57`（A9-1） | 默认配置下预算门禁是常量 4000MB，**不反映真实显存**：4GB VRAM 场景的"主动降级"在默认部署下不生效 |
| A11-2 | Medium | `data-pipeline.ts:918-924`（A4-3） | 串行 crawl 链路最坏 8-9 分钟，可拖住上游任务链 |
| A11-3 | Medium | `data-pipeline.ts:364-417`（A4-1） | 10MB 网页正文无界进 vault → RAG 检索上下文可被击穿 |
| A11-4 | Low | `client.ts:164`（A8-6） | 长 prompt 可超 `--ctx-size`，4GB 显存下更易触发，行为依赖外部 server 截断策略 |
| A11-5 | Info | `deterministic-search.ts`（CONTENT_SCAN_MAX=200、LRU 200、tokenize/para 缓存 FIFO 上限）；`unified-search.ts`（sha256 缓存键）；`dre/retrieval`（LRU 128+TTL 5min） | 缓存与扫描上限设计有界，无内存无界增长风险（除 A2-14 hermes stdout 与 A4-4 visited 集合） |

### 模块 12｜代码质量与可维护性

| 编号 | 级别 | 依据 | 结论 |
| --- | --- | --- | --- |
| A12-1 | Low | `utils/math.ts:7` 注释"L9 审计修复：收敛三处重复的手写余弦实现" | 历史重复实现已收敛，**当前无重复的搜索引擎实现**（5 个 web 引擎 + vault 手写索引 + DRE FTS + CodeRetrievalRouter 各有明确分工） |
| A12-2 | Low | A1-4（context-manager 向量路径零调用方）、A2-17（prompt-pool.release 零调用方）、A9-3（maxCompute 死字段）、A3-2（ToolDef.tags 零消费方） | 存在多处废弃/死代码路径未清理 |
| A12-3 | Low | A6-5（knowledge/index.ts 重导出路径不存在） | 桶文件失效但无消费者，"错误但未报错"典型 |
| A12-4 | Low | 测试覆盖核查 | 核心模块测试覆盖良好（kal 3、deterministic-search 2、dre-retrieval 3、orchestrator 6、blackboard 3、hallucination 4、document-ingest 3+SSRF+path-safety、ocr 3、system-resource 1）；**缺口**：`ocr/post-processor`（A6-1 腐蚀 bug 无测试）、`tool-count` 运行时断言（A3-7）、`kg-writer`（仅 edgeId 1 个） |
| A12-5 | Info | `deterministic-search.ts` 仅 import `fs`/`path`，手写倒排索引+关键词打分 | "从零实现而非依赖第三方库"的检索引擎**核实属实**（零第三方依赖） |
| A12-6 | Info | `tests/architecture-integrity.test.ts:591-595` 断言文档不得出现"懒加载.*节省.*token"；`:594` 断言不得出现"KV.*卸载到系统内存.*换入换出" | 项目已用回归测试锁定声明口径，防止文档回退——良好实践 |


---

## 五、未验证 / 无法访问项清单（如实列出，不得隐藏）

| # | 项目 | 原因 | 影响的结论 |
| --- | --- | --- | --- |
| U-1 | MinerU 外部 Python 组件（PP-DocLayoutV2/Unimernet/印章 OCR，wheel 3.4.5，70 包） | 不在本仓库 TS 运行时（`rg -i mineru src/` 零命中），位于外部 pdf-worker；本次审核未获取其源码 | 模块 6 "MinerU → AST → KG Writer" 中 MinerU 一环**无法验证**；其判别式网络性质与"零 LLM"的关系以文档声明（KNOWLEDGE-BASE.md:44-48 / LIMITATIONS.md:89-95）为准 |
| U-2 | llama.cpp server 实际启动参数（`--ctx-size`/`--n-gpu-layers`/KV 量化类型） | 不在仓库内，属运行时环境配置 | A8-6（prompt 超 ctx-size 的真实影响）、A9-4（bytesPerToken 与实跑 Q4_K_M 量化的偏差）无法在本仓库内闭环验证 |
| U-3 | `src/crawl/processor/markdown-ast.ts` 畸形文档容错深审 | 仅做 LLM 关键字 grep（零命中），未做逐行容错分析（doc-ast.ts 已深审） | 模块 6 要点 2 的 AST 容错结论仅覆盖 `knowledge/doc-ast.ts` |
| U-4 | `src/cli.ts` 非 kg/摄取区段 | 1364 行，仅审 1030-1130 命令区 + 命令映射 + 全文关键字扫描 | CLI 其余命令未深核 |
| U-5 | OCR O→0/l→1 腐蚀的样本级输出比对 | 本次为代码逻辑判定（正则确为全局替换），未做真实 OCR 样本比对 | A6-1 的"系统性失真"为逻辑推断（正则全局性确证），失真量为推测 |
| U-6 | 前端 `frontend/`、`harmonyos/`、`src-tauri/` | 不在本次审核范围 | 未审核 |
| U-7 | `runtime-go/`（111 个 .go） | 不在本次审核范围（仅确认 go.mod 依赖无向量库） | 未审核 |
| U-8 | `native/` Rust 源码 | 仅依赖树核查 + 关键字扫描（0 命中 llama/ggml/kv-cache/vram/offload），确认与本地推理无关后跳过 | native 侧业务逻辑未深核 |
| U-9 | 第一节"阻塞项"列出的未深度审核目录（routes/router/eval/memory/core/services/dre 大部分等） | 范围与时间约束；已受全量静态扫描覆盖但未逐行审核 | 这些目录的问题**未在本报告中列出**，不构成"无问题"的结论 |
| U-10 | `pgvector` 可选历史能力是否仍可通过 native Rust 侧启用 | TS 侧无 pg；但 `native/Cargo.toml` 保留 deadpool-postgres/tokio-postgres（A1-5） | "PG 已移除"口径在 Rust 侧未确证 |
| U-11 | `docs/services.md` 历史敏感文件 | 规则 11 要求：已移出仓库至本地凭据目录，本次审核**未尝试访问** | 不适用 |

---

## 六、总体结论

**前置声明**：深度文件覆盖率 ≈19.5%（170/873），未达 100%，因此按任务书第七节标准，**本次审核尚未完成**——以上是当前进度与发现，未覆盖项见第五节。以下总体结论**仅基于已审核范围**。

### 6.1 核心技术承诺裁决（明确的"矛盾/一致/部分矛盾"结论，非"看起来符合预期"）

| 承诺 | 裁决 |
| --- | --- |
| 不使用向量化 | **部分矛盾**：依赖清单 100% 无向量库（一致）；默认检索路径（FTS5/关键词/手写倒排）非向量化（一致）；但 `settings-search.ts` 的语义层**默认启用**且回落**远端 API** embedding（矛盾），DRE 核心引擎存在休眠向量路径（矛盾，当前无调用方激活） |
| 确定性（同输入同输出） | **部分矛盾**：检索层 4 组 N=10 实验全部完全一致 + 6 个既有确定性测试全绿（一致）；但查询入口的 LLM 改写与采集侧 LLM 质量裁决**默认启用**（矛盾，C-01） |
| zero LLM in path（摄取） | **部分一致**：document-ingest 全路径零生成式 LLM（一致）；采集链路默认 4 个边缘 LLM 且质量裁决参与检索决策（矛盾，A6-2） |
| 189 工具零重复 | **一致**（静态扫描口径；运行时计数未断言） |
| 工具懒加载 | **不一致**（全量注册，schema 全量进 tools/list；C-03 级） |
| KV Cache 卸载到系统内存 | **不一致**（0 行实现；项目自身已澄清并加回归断言） |
| KAL 统一三后端 | **部分一致**（读侧统一门面；写侧分裂，双边表无同步） |

### 6.2 Critical 级问题汇总（4 项，均附可复现证据）

| 编号 | 问题 | 证据强度 |
| --- | --- | --- |
| **C-01** | 确定性/zero-LLM 承诺被默认启用的边缘 LLM 打破（查询改写 + 采集质量裁决；守卫 `EDGE_KNOWLEDGE_ASSIST` 默认 `"1"`，不读 `KNOWLEDGE_USE_LLM`） | 代码证据 `edge-assist.ts:45,88,119,149,174` + `collector.ts:86,99,107-108` + `services/knowledge.ts:88-97` + `edge-client.ts:47-50`（主审计已 grep 交叉验证） |
| **C-02** | "不使用向量化"在默认配置下被违反（settings 语义搜索默认启用 cosine，embedding 回落远端 API） | 代码证据 `settings-search.ts:129-166` + `edge-embeddings.ts:34` + `math.ts:7`（主审计亲自读取） |
| **C-03** | 插件系统默认 auto-enable + manifest.id 无路径段校验 → 默认开启的任意代码执行 / 任意目录递归删除 | 代码证据 `plugin-registry.ts:191-197,295-301,336` + `plugin-routes.ts:125-135`（主审计亲自读取；触发路径为已认证 HTTP） |
| **C-04** | OCR 后处理全局 `O→0`/`l→1` 替换系统性腐蚀所有图片摄取内容，静默写入知识库 | 代码证据 `post-processor.ts:53-64`（主审计亲自读取；注释自承需"smarter logic"从未实现；无对应测试） |

### 6.3 High 级问题汇总（6 项）

A2-1（StateStore 隔次状态丢失，**已实证复现**）、A2-2（readOrCompute cache stampede）、A6-2（采集管线默认 LLM）、A6-3（中文标题塌缩 + 重摄不幂等）、A9-1（VRAM 预算默认为常量）、A3-1 插件 RCE（已列 Critical）。

### 6.4 工程成熟度评估（基于证据，非笼统总评）

**强项**（均已核实）：
- 零循环依赖（411 模块 Tarjan SCC = 0），分层方向干净（knowledge/crawl 不反向依赖 agents）。
- 检索确定性的工程化程度高：三条腿均有次级键 tie-break、readdir 排序、LRU+TTL 有界缓存、并有专门的同分确定性测试。
- `mcp/tools/filesystem.ts` 的路径围栏（cwd 限制 + 敏感段 + symlink realpath + TOCTOU 重校验 + 原子 rename）与 `url-safety.ts` 的 SSRF 防护（协议白名单/RFC1918/元数据/IP 混淆/DNS 二次校验/逐跳）达到生产级。
- 项目已建立"声明-实现一致性"的自我治理：`LIMITATIONS.md` 主动披露 5 处历史声明偏差，`architecture-integrity.test.ts` 用回归断言锁口径防回退。这在同类项目中罕见。

**系统性问题**（跨模块复现的模式，比单点更值得治理）：
1. **"守卫/清洗只覆盖部分出口"**：snippet 有钳制而 crawl 正文没有；聚合层不清洗而 unified 层清洗；主链路有 ssrfGuard 而渲染回退没有；docker 分支有路径围栏而 process 分支没有；pipeline 有 `KNOWLEDGE_USE_LLM` 守卫而 collector 没有。防护是逐次审计事件叠加的，缺少全局收口。
2. **"开关语义错配"**：`EDGE_KNOWLEDGE_ASSIST` 默认启用却承担了 `KNOWLEDGE_USE_LLM` 应当承担的语义；`provider:"local"` 是不存在的提供商的虚位标签；`bun run src/testing/tool-count.ts` 无输出却被称为"动态统计"。
3. **静默失败**：A2-1（状态隔次清空）、A6-1（OCR 腐蚀）、A6-3（中文标题丢失）、A10-4（三处 catch 无日志）——共同特征是"不崩溃、不报错、数据错了"，且现有测试恰好绕过这些路径（beforeEach clear()、无 post-processor 测试、无中文标题夹具）。

### 6.5 建议的下一步（仅诊断建议，本次未做任何修复）

1. 治理"开关语义错配"：让 `EDGE_KNOWLEDGE_ASSIST` 的默认值与 `KNOWLEDGE_USE_LLM` 口径对齐，或显式在文档中声明采集链路的 LLM 边界。
2. 收口清洗/守卫到共享函数（`sanitizeSearchResultsForContext`/`isPathSafe`/`proxyFetch(ssrfGuard)` 的统一调用），而非依赖各出口"记得调用"。
3. 为 A6-1（OCR 腐蚀）加数字上下文限定与对应测试；为 A2-1 的 blackboard 冲突豁免同源（sourceId 相同）写入。
4. 补齐运行时工具计数断言（`registry.size`）与 `post-processor` 测试。
5. 若"非向量化"是硬承诺，则 `settings-search` 的默认 embedding 链应默认关闭，并把 `EDGE_SETTINGS_SEARCH` 的默认值与文档口径对齐。

---

## 附录 A：本次审核执行的命令与结果（可复现）

| 命令 | 结果 |
| --- | --- |
| `bun test tests/kal-deterministic-order.test.ts tests/deterministic-search-tie.test.ts tests/dre-retrieval-tie.test.ts` | 6 pass / 0 fail |
| `bun test tests/module-exports.test.ts tests/registry-validation.test.ts` | 13 pass / 0 fail |
| `bun test tests/unit/docs-consistency.test.ts`（子代理执行） | 9 pass / 0 fail |
| `bun test tests/tools-v3.test.ts tests/review-deep.test.ts` | 34 pass / 0 fail |
| `bun -e 'countMcpTools()'` | total=189, literal=189, duplicates=[] |
| `bun .tmp/det-harness2.ts`（确定性 N=10，自写） | 4 组实验全部 distinct-signature=1 |
| `bun .tmp/kg-idem.ts`（KG 幂等，自写） | 重复摄取同一 AST：nodes 1→1，IDEMPOTENT |
| `bun -e`（blackboard 同源写入复现，自写） | 1st verified({tokens:10}) → 2nd conflict(停留 10) → 3rd verified({tokens:30}) |
| `bun .tmp/depcheck.ts`（Tarjan SCC，自写） | 411 模块，循环依赖 SCC 数 = 0 |
| `grep -rniE 'faiss\|chromadb\|qdrant\|...' src/ native/ runtime-go/` | 0 命中（仅 .tmp-e2e/omini 第三方夹具命中 torch） |
| `grep -rniE 'kv.?cache\|vram\|offload\|swap' src/ native/` | 仅注释/文档/纯算式命中，0 行换页实现 |

## 附录 B：审核组织

| 角色 | 范围 | 覆盖率 |
| --- | --- | --- |
| 主审计（本人） | 模块 1/7/12/13 + 全部交叉验证 + 实证 harness + 报告整合 | — |
| Bernoulli | 模块 2（Agent 编排） | 54/54 |
| Copernicus | 模块 3（MCP 工具层） | 39/39 |
| Franklin | 模块 4（网络搜索）+ 模块 10（安全） | 19/19 |
| Carson | 模块 5（KAL）+ 模块 6（摄取管线） | 31/31 |
| Banach | 模块 8（本地推理）+ 模块 9（VRAM 预算） | 12/12 |

所有子代理均为只读审核，未修改任何文件。关键 Critical/High 结论已由主审计独立交叉验证（C-01/C-02/A6-1/A6-2/A2-1/A3-1/A9-1）。

