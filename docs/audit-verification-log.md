# 审计独立复核实验记录（audit-verification-log）

> 本文件为两段式存档：**第一部分**为工具故障会话的原始实验记录（原文存档，未改动）；**第二部分**为工具恢复后的补验结果（2026-09-07，独立会话，全部结论附 file:line 证据）。两部分均为实际工具输出，不含虚构。

---

## 第一部分：原始实验记录（2026-09-06 会话，工具故障中断）

状态：工具接口故障，无法由该会话直接写入文件。以下为该会话已核验内容的完整文本。

### 实验信息

- 实验对象：openclaw-fusion 仓库（Axiom Runtime v4.0.0）
- 实验性质：独立第三方架构/代码审计 —— 未验证项独立复核
- 工作区 commit 基准：7b644a0
- 完成度：部分完成（约 40%）。已核验 3 项（高置信，含 file:line）；其余 6 项因工具调用接口故障未核验。

### 一、实验环境与能力约束（诚实记录）

该会话中后期，几乎全部工具调用（read / bash / glob / task / todowrite / write）被系统注入的异常 arguments 包裹层破坏，导致 schema 校验失败，报错形如 `SchemaError: Missing key at ["command"] / ["pattern"] / ["filePath"] / ["description"] / ["content"]`。共尝试约 30 次，仅该会话极早期约 4 次调用成功。这是调用合成/传输层的故障（非内容或命令错误）。

成功使用的工具：3 次命令（目录列示、`rg -l "dre/retrieval/" src`、`rg -n "include_recency" …`）+ 2 个成功派发的审计子代理（返回 file:line 证据）。
失败：其后的全部写入/读取/子代理/环代调用。

### 二、已核验项（CONFIRMED / RESOLVED）

**V1｜Rust SearchOptions.include_recency 生产默认值**
结论：CONFIRMED —— 生产中默认为 false，引擎默认确定性成立。
证据：
- 字段定义 + 注释 `native/crates/shared/src/types.rs:45-47`：`include_recency: bool`，`#[serde(default)]`，注释「M9：是否启用时间衰减新近度加分（默认关闭以保严格确定性）」。
- 无 `impl Default for SearchOptions`（全文 108 行已通读）；构造为显式 struct 字面量。
- 生产调用点 1（真实搜索请求 /search）：`native/crates/local/src/main.rs:122-130`，`include_recency: false`（:129）。
- 生产调用点 2（POST /native/search）：`native/crates/local/src/main.rs:166-174`，`include_recency: false`（:173）。
- 引擎读取处：`native/crates/search/src/engine.rs:213`（`compute_score(..., opts.include_recency, now)`）。
对原审计的修正：Rust 引擎确定性从「部分（条件性）」上调为「生产默认成立」。仅余一个残余不确定源：`engine.rs:44` 的 `.take(opts.limit)` 在并列分带内截断时结果集可能随并列排序变化（非主路径，量级低）。

**V2｜src/kg/enhanced.ts:761 的 intent="similarity"**
结论：CONFIRMED —— 行为上死标签，不与非向量化承诺矛盾。
证据：
- searchNodes（`src/kg/enhanced.ts:268-285`）为纯 SQL LIKE（name / description / semantic），无 cosine / embedding / 向量。
- intent 字段在 :752-761 赋值后，仅 `interpretQuery` 返回结构描述字符串（:775）；唯一消费者 queryNL（:704-740）使用 interpretation.keywords 与 interpretation.description，从不按 intent 做控制流分支。
- 定性：标签有误导性但功能无害，与非向量化声明一致。

**V3｜检索 limit 常量**
结论：RESOLVED。
证据：
- SearchOptions 字段：`native/crates/shared/src/types.rs:38-48`：limit:usize（:39）、types（:40）、tags（:41）、para_category（:42）、date_range（:43）、include_reasons:bool（:44）、include_recency:bool（:46-47）。
- 无共享命名常量；默认 limit = 10 由 `native/crates/local/src/main.rs:52` `default_limit() -> usize { 10 }` 提供，经 `#[serde(default = "default_limit")]` 用于 SearchParams.limit（:45）与 NativeSearchReq.limit（:159）。
- 引擎应用 `engine.rs:44` `.take(opts.limit)`，无额外 max-results 常量。

### 三、未核验项（工具故障阻断，原记录如实列出）

| 项 | 目标 | 原状态 |
|---|---|---|
| item 4 | 网络搜索：结果截断/内容清洗、来源可信度/去重、网络失败/超时/限流的降级路径 | 未核验 |
| item 5 | 注入防护：isPathSafe 路径穿越；ssrfGuard 默认/opt-in 与未传调用方；web 内容进 LLM 前消毒 | 未核验 |
| item 6 | 模块 11：RTX 3050 4GB 下 Qwen3-1.7B 峰值显存/内存一致性 | 部分（已核出 system-resource.ts:178-181 缺 activation 项；未做端到端测算） |
| item 7 | 模块 12：自研 vs 隐藏三方；dre/retrieval/ 死代码；测试覆盖 | 部分（已核出 dre/retrieval/{hybrid-fusion,verification-chain,knowledge-wiki,observability} 无生产消费方） |
| item 6b | 模块 6：AST 解析器畸形容错；KG writer 幂等性；MinerU 衔接 | 未核验 |
| item 8 | 工具总数 189 / config/mcp-servers.yaml 对账 | 未核验 |

（原记录第四节待补命令已在本部分第二节执行完毕，命令文本从略，见 git 历史。）

### 五、原始结论

该次为部分核验实验，未达到「100% 全量覆盖」判定标准。已核验 3 项均给出具 file:line 的确定性结论；其中 V1 将「Rust 确定性」定性由条件性上调为「生产默认成立」。剩余 6 项因工具接口故障未出具结论，未臆测、未编造。

---

## 第二部分：补验结果（2026-09-07，工具恢复后独立会话）

- 会话基线：commit 7b644a0，分支 `codex/self-evolving-agent`，工作区干净（仅无关 CLAUDE.md 未跟踪）。
- 性质：对第一部分 6 个未核验项的逐项补验 + 对 V1-V3 的交叉复核 + 新发现定性。
- 完成度：**6/6 未验证项全部出具结论**。仍非全量文件清单审核（Phase 0 清单未建立），不构成「审核完成」。

### 〇、V1-V3 交叉复核（多轮独立验证）

- **V1 复核 = 成立且加强**：`rg -n include_recency native` 全量 9 处命中——构造点全部为 `false`：local/main.rs:129、:173，cloud/main.rs:202、:246，engine.rs:333（测试）；gate 于 engine.rs:366 `if include_recency {`。无任何 `true` 构造点。Rust 引擎生产确定性结论升级为「全部调用方默认关」。
- **V2 复核 = 成立**：`interpretQuery` 全文件仅 2 处命中（定义 :745、调用 :706）；queryNL :706-740 仅消费 `.keywords`（:709）与 `.description`（:735）；`\.intent\b` 无任何消费者。死标签定性不变。
- **V3 复核 = 成立**：main.rs:52 `default_limit(){10}`、:44/:158 serde 默认挂载、engine.rs:44 `.take(opts.limit)`，与原记录一致。

### 一、item 8｜工具总数 189 对账 — RESOLVED

- 权威计数实测：`bun run scripts/count-tools.mjs` → **total: 189，duplicates: []**，breakdown 覆盖 27 个文件（server/** 22 文件 + server.ts 内联 10 + register-external-tools 22 + read/write/query 各 1）。声明「189」精确成立。
- 计数器实现：`src/testing/tool-count.ts:48-90`（字面 name 行正则 :25，去重 :77-83）。
- `config/mcp-servers.yaml` 为**外部 MCP 服务器**清单（context7/free-search/freeweb/filesystem/obsidian/opencode…），与 189 内部注册工具属不同统计轴，无对账冲突。
- 文档口径同步核验：`docs/LIMITATIONS.md:56` 记录了工具数历史口径修正（133/150/173 → 动态计数）。

### 二、item 5｜注入防护 — CONFIRMED

1. **isPathSafe 路径穿越抗性**（`src/utils/path-safety.ts:22-93`）：
   - resolve 后 relative 检查：`..` 前缀 + Windows 跨盘绝对路径双检（:28-37）。
   - 敏感段拒绝：.env/.git/运行时 db/模型密钥配置（:42-52）。
   - symlink 逃逸：目标 realpath + 父目录 realpath 双校验（:54-76）。
   - fail-open 窗口仅限「目标与其父目录均无法 realpath」（新建文件场景，:77-86），且 writeFile/moveFile 在 mkdir 后有 isPathSafe TOCTOU 重校验兜底（:80-81 注释；`src/mcp/tools/filesystem.ts:101,335-340` postSafety 实码）。
   - 结论：静态分析未发现可穿越 cwd 的路径；残余风险（父链 symlink 竞态）已文档化并有写后重校验缓解。
2. **ssrfGuard 默认 opt-in**（`src/utils/proxy-fetch.ts:48-58,461-467`）：
   - 默认关（`ssrfGuard?: boolean`，:58）；:48-57 为完整决策记录——全量调用方排查发现合法回环目标（CDP 127.0.0.1:9222、本地边缘 LLM/embeddings），默认开启会破坏本地链路。
   - 强制点：`src/crawl/data-pipeline.ts:341` `ssrfGuard: true`，覆盖用户可控 URL 入口（MCP web_fetch / /web-fetch / collector）。
   - 校验强度：初始 URL + 每跳重定向（:461-463）+ DNS 解析后 rebinding 二次校验（:464-467）；TOCTOU 残窗已在 :464 注释披露。
3. **web 内容进上下文前消毒**：
   - web_search → `sanitizeSearchResultsForContext`（`src/mcp/server/web-tools.ts:39-43`；实现 `src/crawl/search-engines.ts:41-49`：≤30 条、title≤200、snippet≤上限；deepLinks ≤5×≤200，:51-58）。
   - web_fetch → 仅返回结构化计数摘要（headings/tables/codeBlocks/images 数量），不回吐全文（web-tools.ts:21-25）。
   - vault 读回 → content 截断 5000（`src/mcp/server/vault-tools.ts:39`）。

### 三、item 4｜网络搜索 — CONFIRMED

- **截断/清洗**：M6 常量组 + sanitize/clamp 函数（search-engines.ts:26-35,41-58，见 item 5 第 3 条）。
- **去重/来源质量**：URL 规范化去重（剥 hash/utm_*/fbclid/gclid，同键保留更长 snippet 并合并 engine 标签，`src/crawl/unified-search.ts:343-367`）；域名多样性上限默认 3/域、env 可配（search-engines.ts:470-472）；聚合层 mergeAndDeduplicate（:502+）。
- **失败/超时/降级**（全链路无静默挂起）：
  - 引擎级隔离：单引擎 catch → 空数组 + warn（search-engines.ts:461-464）。
  - 无 key 兜底：bing-html 强制追加（:452-453）。
  - 代理降级：代理失败回退直连（:89-99）。
  - 进程级预算：curl 总预算 45s + kill 30s + grace 5s（:31-35）；fetch 15s abort + withRetry + requestDelay（`src/crawl/data-pipeline.ts:325-331,346`）。
  - 查询级隔离：concurrentSearch 逐查询 try/catch → 空结果 + 报告（`src/crawl/concurrent-search.ts:104-126,139-180`）。
  - 路由层：DRE 段超时 race（`src/routes/search.ts:37-40`）、limit 钳制 ≤100（:93-94）。
- **缺口（Info）**：无主动 per-engine rate limiter，以「总预算 + 重试上限 + 请求间隔」替代；对恶意 429 风暴场景为被动退避。

### 四、item 6｜显存测算一致性 — RESOLVED（静态一致性完成；端到端实测仍缺）

- 默认值链（`src/dre/system-resource.ts:85-89`）：modelMemoryMB=1100、safetyMarginMB=200、kvCacheMaxMB=2200、bytesPerToken=28×2048×2×2=229,376（Qwen3-1.7B 28 层 × 2048 隐 × 2(K/V) × 2B FP16，公式正确）、maxTokensCap=4096。
- 单位修复在位：H2 注释 + ×1024×1024（:179-181）。
- 滞回/防抖确认（补强模块 9）：M12 双阈值（required=1300MB 降级 / +500MB 恢复，:152-176）；<5% 抖动过滤 + 同向缓变逃逸 ≥3 次（:96-145）。
- **自洽测算**：cap 4096 tokens × 229,376B ≈ 906MB KV（< kvCacheMax 2200MB，cap 先生效）；峰值 ≈ 1100 + 906 + 200 ≈ 2206MB < 4000MB（DEFAULT maxMemory，:51-57）→ 4GB 内自洽，无溢出路径。
- **确认缺口（沿用原发现）**：:178 `availableForKV = availableMemory − modelMemoryMB`，预算仅覆盖权重 + KV 两维，**无 activation/scratch 项**（静态测算下因余量 ~1.8GB 暂不触发，但属模型性缺失）。
- 未做：llama.cpp 端到端实机测算（如实标注，未验证）。

### 五、item 6b｜KG 幂等 / AST 容错 / MinerU 衔接 — RESOLVED

1. **KG Writer 幂等性 = 成立**：
   - 节点稳定 id：空/tmp- 前缀 → sha256(type:name)（`src/kg/enhanced.ts:214-217`）。
   - INSERT OR REPLACE + created_at 溯源保留（REPLACE 前查旧行，:219-243）。
   - 边稳定 id：sha256(source:target:type)（:294-296）+ 邻接表去重（:319-323）。
   - kg-writer：F-3 审计修复后 sha1 内容寻址边 id + INSERT OR IGNORE（`src/crawl/processor/kg-writer.ts:254-266`）。
   - FTS 同步：独立 fts5 表 + IF NOT EXISTS 触发器，DDL 幂等（`src/kg/schema.ts:53-57`）。
   - 结论：重复摄取同一文档 → 同 id REPLACE/IGNORE，不产生重复节点/边。
2. **AST 解析器畸形容错 = 成立（静态）**：`src/crawl/processor/markdown-ast.ts:60-114` 纯正则逐行解析，无未捕获异常路径；未闭合代码块以行数边界安全终止（:103）；未匹配行自然归入段落 → 畸形输入降级而非中断（未运行动态用例，如实标注）。
3. **MinerU 衔接 = 定性澄清**：`src/` 全量 `rg -i mineru` **零匹配**——MinerU 不在本仓库运行时内，属外部 Python 侧组件（`scripts/pdf-worker/app.py`，FastAPI + PyMuPDF 1.28.2 + MinerU 3.4.5 wheel，见 `docs/superpowers/plans/2026-08-27-second-round-audit-closure-dre-plan.md:9`）。口径已在两处显式披露：`docs/KNOWLEDGE-BASE.md:44-48`、`docs/LIMITATIONS.md:89-95`——MinerU 判别式网络（PP-DocLayoutV2/Unimernet/印章 OCR）≠ 生成式 LLM，边界声明完整。

### 六、item 7｜死代码与自研核查 — CONFIRMED

- **dre/retrieval 死代码（精确化）**：`rg "hybrid-fusion|verification-chain|knowledge-wiki|retrieval/observability" src` 全仓唯一命中为内部互引 `src/dre/retrieval/hybrid-fusion.ts:25`（import verification-chain 类型）。即该四文件无任何外部生产消费方；retrieval 目录的生产消费面仅为 `src/routes/search.ts`（collectDreSegment，:58-73）与 `src/memory/vault-manager.ts`，与第一部分记录一致。
- **自研 vs 隐藏三方（向量轴）**：`rg -i "faiss|chromadb|qdrant|hnswlib|annoy|sentence-transformers|onnxruntime|transformers" package.json bun.lock` **零命中** → 无向量检索库依赖，与「默认确定性检索」声明一致。

### 七、★ 新发现｜两条生产向量语义检索路径的定性（模块 7 关联，原审计未列）

**事实**（`rg cosine` 全量命中后逐链追踪）：
1. **settings 语义搜索（生产 HTTP 面，默认尝试 embedding）**：`POST /settings/search`（`src/routes/index.ts:278` 注册；`src/routes/settings.ts:28` 调用）→ `searchSettings`（`src/core/settings-search.ts:147-199`）：embedder 缺省 = `defaultEmbedder`（:158）= 边缘 embeddings 服务 → `modelRouter.embeddings`（:121-133），cosine 相似度打分（:166），engine 可为 semantic/hybrid；embedding 失败回退纯关键词（:173-175）。
2. **上下文记忆检索（内部生产路径）**：`ContextManager.getEffectiveContext` → `retrieveFromMemory`（`src/context/context-manager.ts:251-311`，:305 调用）→ `generateEmbedding`（:456-464，router.embeddings 或字符频率 fallback 向量 :466-476）+ cosine top-k（:263-269）。单例 `contextManager` 被 `src/routes/audit.ts:18` 消费；`src/core/runtime-audit.ts:211` 亦有实例化。

**文档口径**（现行声明）：`docs/ARCHITECTURE.md:10,288`、`README.md:176`、`docs/LIMITATIONS.md:55-60` —— 「确定性检索（FTS5+关键词权重）为默认；共享 cosineSimilarity 仅在有 embedding 的**可选**语义路径使用；旧『零-向量/零-embedding』宣称已在 Task16 修复」。

**定性（判断）**：**部分一致**。
- 默认检索主路径（Vault/KAL/Rust engine）确定性成立（V1 加强 + 本部分第六节）。
- 但 settings 搜索是生产路由且**默认链即尝试 embedding**（非「用户显式开启才启用」，而是「默认尝试、失败才回退」），文档「仅在可选语义层使用」对该路径覆盖不全；context-manager 向量记忆检索文档亦未点名。
- 不构成与「零生成式 LLM」的矛盾（embedding API 非生成式；MinerU 口径同理）。
- 级别：**Medium**（文档口径覆盖缺口 / 声明与实现边界模糊，非代码缺陷）。

### 八、覆盖率与判定声明（诚实边界）

- 本部分完成：第一部分全部 6 个未验证项（6/6）出具结论 + V1-V3 交叉复核。
- **整体审计仍不满足「审核完成」判定标准**：Phase 0 全量文件清单从未建立，覆盖率分母不存在；本实验性质为「未验证项补验」而非全量审核。
- 待办（如需出具全量结论）：建立 Phase 0 文件清单 → 按模块 1-13 逐文件标记 → 汇总声明 vs 实际总表。
- 端到端实机项（显存实测、AST 动态用例）仍未验证，已逐条标注。
