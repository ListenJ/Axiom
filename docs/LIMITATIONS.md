# 系统边界与已知限制（Limitations）

> 摘要：本文档披露当前实现中因简化估算、外部依赖缺失或待校准数值导致的边界行为，供审计与运维参考。首个条目为 `src/dre/system-resource.ts` 的 VRAM 估算校准（审计报告 Critical 05）。

---

## 1. VRAM / KV-Cache 估算边界（Critical 05 已校准）

> 归一注（2026-09-26）：ku 线曾于 2026-09-18 将本子系统整体归档移除（含 `system-resource.ts`、`system-resource-probe.ts`、6 个单测 + rigorous 测试、`resource_status`/`vram_status` 工具，工具数 189→188）；主干归一按「当前线为基」裁决**未采纳该移除**，相关文件与工具已全部恢复，本节恢复为现役边界。ku 线移除记录见 `docs/superpowers/plans/2026-09-18-cut-local-inference-and-vram.md` 与 `docs/AXIOM-ARCHITECTURE.md` §2.15。

### 1.1 问题溯源

- **审计定位**：`src/dre/system-resource.ts` 中 `ResourceBudgetManager.bytesPerToken` 旧值为 `2`，导致 114688 倍误差：`2200 MB` 预算下旧公式 `2200*1024/2 = 1_126_400` tokens（受 `maxTokensCap=4096` 截断为 4096），实际仅约 9 tokens。原始逐行定位见 `docs/reviews/2026-08-20-full-audit-strong-constraint.md` 的 Critical 05 条目（历史证据件，行号以该文件为准）。
- **修复提交**：`141608c4`，subject 为 `fix(core): 校准 bytesPerToken 114688倍误差` 加审计报告当时给出的路径锚点。注意该锚点沿用了 `src/core` 前缀，而仓库中从未追踪过对应文件（`git log --all -- src/core/system-resource.ts` 空命中；本文件由 `944a7222` 作为 `src/dre/system-resource.ts` 新增，无重命名记录），故 subject 里的路径不可当作变更目标读。

### 1.2 校准推导

- **模型**：Qwen3-1.7B，28 层 × 2048 隐维度
- **KV-Cache 单 token 估算（FP16）**：
  ```
  bytesPerToken = layers × hidden × 2(K/V) × 2B(FP16)
                = 28 × 2048 × 2 × 2
                = 229376 bytes
                ≈ 224 KB (÷1024) / 229 KB (÷1000)
  ```
  源码：`src/dre/system-resource.ts`（`bytesPerToken` 字段声明与其构造函数默认值 `28 * 2048 * 2 * 2`）；测试锁定：`tests/unit/system-resource.test.ts`（`229376` 推导断言 + "2200MB KV 预算 ≈ 10057 tokens（封顶前）" 用例）。
- **推荐 token 公式**：
  ```ts
  availableForKV = availableMemory - modelMemoryMB; // MB
  recommendedMaxTokens = floor( min(availableForKV, kvCacheMaxMB) * 1024 * 1024 / bytesPerToken )
  // 上限：min(..., maxTokensCap=4096)
  ```
  示例：默认 `availableMemory=4000, modelMemoryMB=1100, kvCacheMaxMB=2200` → `min(2900,2200)*1048576/229376 ≈ 10057` tokens（受 cap 截断为 4096）。
  （H2 审计修复：旧式 `*1024` 为 MB→KB 错配，结果偏小 1024 倍，已于本次修正并同步测试。）

### 1.3 当前边界与待校准项

| 维度 | 现状 | 影响 | 后续校准 |
|---|---|---|---|
| **单位换算** | ~~公式用 `*1024`（MB→KB）~~ 已修复：现为 `*1024*1024`（MB→B），2200MB 对应 ≈10057 tokens（cap 后 4096），物理量纲正确 | 估算仍为理论推导，未含注意力/量化开销 | 待 `nvidia-smi` / `torch.cuda.memory` 实测校准收敛偏差 <20% |
| **静态默认值** | `maxMemory=4000, availableMemory=4000` 为纯 CPU 保守默认值，无 `nvidia-smi` 动态探测；`modelMemoryMB=1100, safetyMarginMB=200, kvCacheMaxMB=2200` 均为静态配置 | 在无插件注入真实显存时，推荐值仅为**估算值**，偏差 <20% 未经实机验证 | 引入硬件插件后 `ResourceBudgetManager.updateResource()` 注入真实可用显存，偏差待实测收敛 |
| **精度声明** | 当前 `bytesPerToken=229376` 为基于 Qwen3-1.7B 架构的理论公式推导，未含注意力实现、量化方式、序列并行等开销 | 跨模型（非 Qwen3-1.7B）或 INT8/INT4 量化场景误差更大 | 标注为**估算值**，待接 `nvidia-smi` 后做回归校准，目标偏差 <20% |
| **防抖+滞回已落地** | 5% 方向感知防抖（同向缓变 ≥3 次强制逃逸，修复永久漂移失明；交替抖动持续过滤，tests/unit/resource-debounce.test.ts + tests/unit/resource-hysteresis.test.ts 锁定）；`canRun()` 双阈值滞回：跌破 1300MB 降级后需回升 ≥1800MB 才恢复 | 恢复带内（1300-1800）保持降级为设计行为 | 如需不同恢复裕度调整 `RECOVERY_MARGIN_MB` |

### 1.4 使用建议

- 将 `getResourceBudgetManager().getStatus().recommendedMaxTokens` 视为**上限建议**，非硬性保证；生产侧应结合 `canRunLocal` 与前端流控。
- 如需精确调度，请通过 `updateResource({ availableMemory, maxMemory, source: "plugin" })` 注入 `nvidia-smi` 实测值。
- 测试覆盖：`tests/unit/system-resource.test.ts` 已锁定 2200MB→10057 tokens（cap 4096）与 229376 推导；`npx tsc --noEmit` 与 `bun test` 为回归门禁。

---

## 2. 检索与文档一致性边界（Task16 校准）

### 2.1 问题溯源

- **审计定位**：`docs/ARCHITECTURE.md` 与 `docs/PROJECT-GUIDE.md` 等旧宣称“零-向量、零-概率、零-embedding”“零-向量全文搜索”（修复前原文用 `git show` 反查），与实现（`src/memory/deterministic-search.ts` 关键词权重 + `src/dre/consciousness/stream.ts` 共享 `cosineSimilarity` 余弦归一化）不一致；`PG-已移除` 旧宣称曾与实际“PG vector 可选（历史能力，默认 SQLite FTS5）”不一致；但该“可选”口径自 H-M1-03（PG 客户端已删，38966d12）起也已废止 —— PG 当前不可启用，现状见 §2.3；`zero-LLM` 旧宣称与实际“`KNOWLEDGE_USE_LLM=false` 默认关闭的可选 LLM（`src/knowledge/pipeline.ts` 的 `readBool("KNOWLEDGE_USE_LLM", false)`）”不一致；工具数旧宣称在多篇文档间各执一词（历史曾见 133/150/172/173），与动态实测去重值不一致。
- **修复提交**：`docs: 同步架构声明 docs/ARCHITECTURE.md README.md 6.1/6.2`（Task16），`grep 零-向量` 0 命中（active docs 排除 archive/reviews/superpowers/operations-log，旧值以连字符断开避免命中），`grep 133/150/173 MCP` 0 命中。工具数权威计数已升级为动态统计：唯一事实源是 `src/testing/tool-count.ts` 的 `countMcpTools()`，`bun run scripts/count-tools.mjs` 由它生成供文档引用的片段（该脚本自身不计数，只委托），`tests/unit/docs-consistency.test.ts` 对 README、`AXIOM-ARCHITECTURE.md`、`ARCHITECTURE.md`、`MCP_TOOLS_GUIDE.md` 做"声明值 == 实测值"的精确相等断言（受控文件清单以该测试为准，本文与 `docs/PROJECT-GUIDE.md` 不在其内）；本文不复制该数值。
- **ku 线 2026-09-20 变更（归一后修正披露）**：ku 线曾删除 `src/local-llm/edge-embeddings.ts`（硬编码 `127.0.0.1:9001` 的本地 embedding 客户端）并改写 `src/core/settings-search.ts` 为纯关键词。**归一后事实**：该客户端文件已随资源子系统恢复入树，但 settings-search 的改写已并入 —— **设置项搜索仍为纯关键词**（不再消费内置 embedding；语义召回在该路径上丢失，响应延迟不变或略降）。`searchSettings({ embedder })` 注入接缝保留，待接入用户自配 embedding 模型。

### 2.2 校准后声明

- **检索**：默认确定性检索（`src/memory/sqlite-memory.ts` 的 SQLite FTS5 为主索引，`src/memory/deterministic-search.ts` 的关键词按匹配次数线性加分为补（优先级 标题 > 标签 > 路径 > 内容，各设上限；加权常量以该文件 `search()` 为唯一事实源，本文不复制数值），二者由 `src/memory/vault-manager.ts` 的 `search()` 串接；共享 `cosineSimilarity`（`src/utils/math.ts`）仅在有 embedding 的可选语义层使用，`consolidate(0.7)` 阈值聚类）；PG vector 当前不可启用（H-M1-03 已删客户端，无启用路径，见 §2.3），非历史旧宣称。
- **LLM**：`src/knowledge/pipeline.ts` 的 `KNOWLEDGE_USE_LLM` 开关（`readBool("KNOWLEDGE_USE_LLM", false)` 共两处读取：图/视频自动理解分支与内容结构化分支各一处）默认 `false` 走 `fallbackTFIDF`（TF-IDF 回退），仅 `true` 时走 `structureKnowledgeWithEdge`/`structureWithGLM`，非历史旧宣称。
- **PG**：`src/db/pg-client.ts` 已删（38966d12），`src/db/pg-schema.sql` 仍在仓库但无运行时消费者；`sqlite-memory.ts`/`kg/enhanced.ts`/`codegraph-sync.ts` 为默认；PG 数据面能力在 TS 运行时不可启用 —— `package.json` 依赖与 `bun.lock` 均无 PG 驱动，`src/` 下无客户端、无开关、无入口，恢复需先重建客户端与索引迁移（口径见 §2.3）。 <!-- doc-caliber:absent: src/db/pg-client.ts -->
- **工具数**：口径以 `src/testing/tool-count.ts` 的 `countMcpTools()` 实测值为准（零重复断言同在 `docs-consistency`）；引用该数值的文档以 `bun run scripts/count-tools.mjs` 生成，禁止手抄。历史 133/150/172/173 与本文旧版"权威 172"均为已腐烂快照，一律废止。

### 2.3 当前边界与待校准项

| 维度 | 现状 | 影响 | 后续校准 |
|---|---|---|---|
| 余弦阈值精度 | `cosineSimilarity`（`src/utils/math.ts` 共享实现）为 FP64 归一化，未含向量归一化预处理差异，阈值 0.7 为经验值 | 跨域检索召回率依赖阈值，极短文本余弦抖动 | 待 `docs/LIMITATIONS.md` 中补充 PBT 用例校准 0.7 阈值 |
| PG vector 切换 | PG 客户端已随 H-M1-03 删除（`src/db/pg-client.ts`），当前 `src/` 下无任何可调用的 PG 入口（本节旧口径给出的 `isPgAvailable`/`getPG()` 已无宿主，仅存一条说明其已移除的注释） | 默认 FTS5 无向量语义召回；"手动启用"这条路今天不存在，需 PG 时必须重建客户端与索引迁移 | 按规则 4 先裁决 `src/db/pg-schema.sql` 存废（仍在仓库、无运行时消费者），再决定是否恢复该能力；在此之前文档不得给出可调用 PG 符号 <!-- doc-caliber:absent: src/db/pg-client.ts --> |
| native 云端件的 PG 例外 | `native/crates/cloud`（二进制 `axiom-cloud`，由 `src/native-bridge.ts` 按 edition 选择、经 `package.json` 的 native:build:cloud 构建）在给出 DATABASE_URL 时会 `create_pool` 建 deadpool-postgres 池，但其全部消费点都是存活探针（health 与 cluster_status 只判 connected/error），crate 内 PG 语句执行点实测 0 ⇒ 它不是 PG 数据面，也不改变"TS 运行时无 PG 数据面入口"的口径 | 读者若按"仓库里没有任何 PG 代码"去读 native，会立刻读到矛盾 —— 例外不点名就等于制造口径冲突 | D11 锁死本条与代码同源：该池一旦长出 SQL 执行面，门即红，口径须同步改写 |
| LLM 可选性 | `KNOWLEDGE_USE_LLM=false` 时全走 TF-IDF，无法利用 LLM 结构化 | 长文本结构化召回率低于 LLM 模式 | 待评估 TF-IDF vs LLM 质量对比并披露 |
| 工具数漂移 | 权威计数与文档声明的相等断言已落地（`tests/unit/docs-consistency.test.ts` 对受控文件清单内的文档做"声明值 == `countMcpTools()` 实测值"精确相等 + 零重复），新增工具后跑生成器取数即可 | 受控清单是测试里硬编码的文件名数组 ⇒ 清单外的规范件（含本文旧版"权威 172"）仍可能各说各话，且这类"手抄公式/代码块/数值"形态本身无门覆盖 | 把受控清单扩到 `caliberDocs` 全量，或规定非权威件不得出现数值；与"手抄件漏拦"合并裁决 |

### 2.4 使用建议

- Vault 检索的默认入口是 `src/memory/vault-manager.ts` 的 `search()`（FTS5 主索引 + 确定性关键词加分为补）；PG vector 当前不可启用（客户端已删，见 §2.3），需语义检索时只有 embedding 可选语义层一条路；`cosineSimilarity` 阈值 0.7 是 `consolidate()` 的默认参数，调用方可覆盖。
- 知识库 keep `KNOWLEDGE_USE_LLM=false` 以满足确定性承诺，需 LLM 结构化时显式开启并接受 `structureKnowledgeWithEdge` 失败回退 TF-IDF。
- 工具数以 `src/testing/tool-count.ts` 的 `countMcpTools()` 为权威（`src/mcp/tool-registry.ts` 的 `size` 是运行时注册表大小，口径不同，不作为文档数值来源）；新增工具后跑 `bun run scripts/count-tools.mjs` 取生成片段，再跑 `bun test ./tests/unit/docs-consistency.test.ts` 复验。

---

## 3. 其他已知限制（占位）

- 本文档随审计修复任务增量更新；后续任务将补充 Native 稳定性、编排竞态等边界章节。
- 涉及 `Date.now()/Math.random()/Map` 遍历的模块，其确定性边界**已逐模块披露** —— 见本文档 §5「确定性边界逐模块披露（G-04）」（2026-09-18 补齐，此前为未兑现的占位承诺）。

---

## 5. 确定性边界逐模块披露（G-04）

> **G-04 硬约束**（`docs/superpowers/plans/2026-08-21-audit-remediation-playbook.md:16`）：
> 若代码涉及 `Date.now()/Math.random()/Map` 遍历顺序，必须在 `docs/LIMITATIONS.md` 明确披露不确定性边界；不得宣称"确定性"。
> 本节即该项披露。**本文档此前仅有"将在对应章节按 G-04 披露"的占位承诺，长期未兑现**，本节为补齐。

### 5.1 承诺的准确范围（先界定被检验的主张）

被检验的声明来自 `docs/AXIOM-ARCHITECTURE.md`：

| 行号 | 原文 | 说明 |
| --- | --- | --- |
| `:16` | 「LLM 仅作为确定性管道的补全器，不作为推理主体」 | 管道=确定性，LLM=补全 |
| `:545` | 「`run()` — **纯确定性** (6 步)」 | 最强声明 |
| `:1553` | 「`POST /dre/run`（**纯确定性** …）」 | 对外接口声明 |
| `:1293` | 「采样使用 `Math.random`，**路由层非确定属设计**——不在确定性承诺范围内」 | 明确排除项 |
| `:1521` | `DRE_LLM_SEED` 默认 `42` | LLM 分支的种子 |

**因此本节检查范围 = `src/dre/**` + `src/knowledge/**`**（承诺所声称的层）；`src/router/**` 的 Thompson 采样等已由架构文档显式排除，但其排除本身见 5.4 裁定 ④。

### 5.2 全量普查结果（非抽样，可复现）

普查覆盖 `src/dre/**` 与 `src/knowledge/**` 全部 `.ts` 文件，**先剥离 `//` 与块注释**再匹配
（首轮未剥注释时把 `knowledge-port.ts:261` 的**说明性注释**误计为调用，已修正；这也是本节数字与其它文档不一致时的口径来源）。

**计数口径**：「命中文件数」= 该模式命中过的去重文件数；「命中处数」= 命中**行数**
（同一行出现多次只计 1，例如 `context-engine.ts:240` 一行内有 2 次 `Date.now()` → 计 1 处）；
「合计」的文件数为各模式的**并集**，不逐行相加。

| 不确定源 | 命中文件数 | 命中处数（= 命中行数） |
| --- | --- | --- |
| `Date.now()` | 34 | 179 |
| `performance.now()` / `process.hrtime` | 5 | 39 |
| `Math.random()` | 10 | 20 |
| `randomUUID()` | 3 | 7 |
| `localeCompare()` | 5 | 6 |
| `new Date()` | 3 | 5 |
| **合计** | **36 个文件（并集）** | **256 处** |

CI 侧由 `tests/unit/determinism-disclosure.test.ts` 持续校验本节是否覆盖全部命中文件（防止再次漂移）。

#### 5.2.1 逐文件清单

| 文件（范围：dre / knowledge） | 命中类别与处数 | 命中行号（前 6 处） |
| --- | --- | --- |
| `src/dre/actor/system.ts` | Math.random ×5 / Date.now ×31 | Math.random@184,198,300,373,447 Date.now@159,165,184,190,198,218… |
| `src/dre/consciousness/stream.ts` | Date.now ×5 | Date.now@117,141,210,403,446 |
| `src/dre/constraint/solver.ts` | Date.now ×8 / new Date ×1 | Date.now@519,531,547,559,575,591… new Date@459 |
| `src/dre/engine.ts` | Date.now ×3 | Date.now@399,404,730 |
| `src/dre/kernel.ts` | Date.now ×5 | Date.now@44,68,84,175,191 |
| `src/dre/llm/client.ts` | Math.random ×1 / Date.now ×5 | Math.random@200 Date.now@131,183,239,389,465 |
| `src/dre/mental-model/pool.ts` | Math.random ×2 / Date.now ×11 | Math.random@270,323 Date.now@187,270,323,328,368,384… |
| `src/dre/persona/loader.ts` | Date.now ×4 | Date.now@68,97,111,150 |
| `src/dre/pipeline/cognitive-pipeline.ts` | Date.now ×3 / perf/hrtime ×12 | Date.now@229,365,561 perf/hrtime@185,193,214,219,244,256… |
| `src/dre/pipeline/task-graph.ts` | Math.random ×1 / Date.now ×5 | Math.random@303 Date.now@85,126,215,219,303 |
| `src/dre/port/knowledge-port.ts` | Date.now ×4 / perf/hrtime ×3 | Date.now@132,140,152,182 perf/hrtime@361,367,372 |
| `src/dre/port/types.ts` | Math.random ×1 / randomUUID ×1 | Math.random@172 randomUUID@183 |
| `src/dre/reasoning/graph.ts` | Date.now ×10 / randomUUID ×5 | Date.now@104,109,120,125,148,153… randomUUID@104,120,148,176,319 |
| `src/dre/retrieval/deterministic-retrieval-engine.ts` | Date.now ×2 / perf/hrtime ×16 / localeCompare ×2 | Date.now@545,562 perf/hrtime@260,266,287,301,303,306… localeCompare@493,778 |
| `src/dre/retrieval/hybrid-fusion.ts` | perf/hrtime ×3 / localeCompare ×1 | perf/hrtime@137,151,189 localeCompare@181 |
| `src/dre/retrieval/knowledge-wiki.ts` | Date.now ×1 | Date.now@180 |
| `src/dre/retrieval/observability.ts` | Date.now ×2 | Date.now@158,169 |
| `src/dre/runtime/atom-engine.ts` | Date.now ×5 / randomUUID ×1 / localeCompare ×1 | Date.now@90,91,151,211,218 randomUUID@90 localeCompare@286 |
| `src/dre/runtime/capability-registry.ts` | Date.now ×2 | Date.now@108,189 |
| `src/dre/runtime/context-engine.ts` | Date.now ×4 | Date.now@171,177,240,362 |
| `src/dre/runtime/event-bus.ts` | Math.random ×2 / Date.now ×3 | Math.random@105,112 Date.now@51,105,112 |
| `src/dre/runtime/knowledge-network.ts` | Math.random ×5 / Date.now ×22 / localeCompare ×1 | Math.random@164,338,368,397,605 Date.now@164,165,243,251,257,279… localeCompare@491 |
| `src/dre/runtime/rule-engine.ts` | Math.random ×1 / Date.now ×3 | Math.random@90 Date.now@90,95,156 |
| `src/dre/runtime/scheduler.ts` | Math.random ×1 / Date.now ×11 / new Date ×1 | Math.random@118 Date.now@118,120,168,225,235,263… new Date@201 |
| `src/dre/runtime/verification-engine.ts` | Date.now ×3 | Date.now@191,292,313 |
| `src/dre/runtime/world-state.ts` | Date.now ×5 / localeCompare ×1 | Date.now@142,159,188,198,242 localeCompare@224 |
| `src/dre/storage/knowledge-store.ts` | Date.now ×3 | Date.now@140,335,703 |
| `src/dre/storage/sqlite-backend.ts` | Date.now ×3 | Date.now@157,279,286 |
| `src/dre/synapse/engine.ts` | Date.now ×4 | Date.now@68,84,131,179 |
| `src/dre/synapse/store.ts` | Date.now ×1 | Date.now@284 |
| `src/knowledge/auto-updater.ts` | Date.now ×3 | Date.now@141,155,181 |
| `src/knowledge/collector.ts` | Date.now ×2 / perf/hrtime ×5 | Date.now@126,190 perf/hrtime@31,56,138,160,204 |
| `src/knowledge/document-ingest.ts` | Date.now ×1 | Date.now@193 |
| `src/knowledge/pipeline.ts` | Date.now ×2 / new Date ×3 | Date.now@214,333 new Date@225,229,249 |
| `src/knowledge/store.ts` | Date.now ×2 | Date.now@108,130 |
| `src/knowledge/vision.ts` | Math.random ×1 / Date.now ×1 | Math.random@197 Date.now@197 |

### 5.3 已核实的确定性边界（逐条，附 `文件:行号` 证据）

**① 排序路径普遍显式补齐 tie-breaker，Map 插入序未泄漏进排序结果 —— 这是做得对的部分。**

`src/dre/retrieval/deterministic-retrieval-engine.ts:493`、`:778`、`src/dre/runtime/atom-engine.ts:286`、
`src/dre/runtime/knowledge-network.ts:491`、`src/dre/runtime/world-state.ts:224` 五处均为
`sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))`，且代码注释显式写明
「使顺序不依赖 Map 插入历史（同一输入两次调用顺序完全一致 —— 确定性底线）」。

**② 上述 tie-breaker 用 `localeCompare`，因此确定性只在"同一 locale / 同一 ICU 版本"内成立。**

`localeCompare` 的结果取决于运行环境 locale 与 ICU 数据版本（Node/Bun 版本差异即可能改变序）。
**跨机器、跨 locale、跨运行时版本的"同输入同输出"不成立**；同机同配置下成立。

**③ 原为唯一缺 tie-breaker 的排序点 —— 已于 2026-09-18 修复（提交 `1411cd9` 之后的本轮）。**

修复前为 `.sort((a, b) => b.fusionScore - a.fusionScore)`（无次级排序键）；
其输入经由 `groups`（`Map`，`:204`）按 `results` 数组插入序展开（`:166`、`:205`），
而 `Array.prototype.sort` 在现代 JS 中稳定，故**同分项的相对顺序取决于调用方传入的 `results` 顺序** ——
与 ① 中的 5 处相比属**实现不一致**而非设计取舍。

现为（`:181`）：

```ts
.sort((a, b) => b.fusionScore - a.fusionScore || a.id.localeCompare(b.id))
```

**TDD 复现**：`tests/dre-hybrid-fusion.test.ts`「同分序确定性」2 例 ——
修复前 **2 fail**（同分项顺序随输入排列变化：`[a,b,c,d]` 与 `[d,c,b,a]` 输出不同），修复后 **23 pass / 0 fail**。

修复后，本节省查范围内**全部已知排序点均带 tie-breaker**：① 的 5 处 + 本处 = **6 处**。
（注意：本处 tie-breaker 与 ① 一样是 `localeCompare`，同样受 ② 的 locale/ICU 限制。）

**④ 响应体普遍内嵌耗时字段，字节级"同输入同输出"不成立。**

`deterministic-retrieval-engine.ts:266,287,322,621`（`latencyMs`）、`src/dre/port/knowledge-port.ts:367,372`
（`latencyMs`）、`src/dre/pipeline/cognitive-pipeline.ts:33`（`durationMs`）。
即使语义结果完全一致，两次调用的字节序列也不同。

**⑤ 自动生成的实体 ID 含时间戳与随机片段，逐次运行不同。**

`src/dre/reasoning/graph.ts:104,120,148,176,319`（`前缀-Date.now()-randomUUID().slice(0,8)`）、
`src/dre/runtime/scheduler.ts:118`、`src/dre/runtime/event-bus.ts:105,112`、
`src/dre/runtime/knowledge-network.ts:164,338,368,397,605`、`src/dre/runtime/rule-engine.ts:90`、
`src/dre/mental-model/pool.ts:270,323`、`src/dre/actor/system.ts:184,198,300,373,447`、
`src/dre/pipeline/task-graph.ts:303`、`src/dre/runtime/atom-engine.ts:90`、`src/dre/port/types.ts:183`。
这些 ID 会进入各自模块的输出。

**⑥ 重试时序非确定（有意为之）。**

`src/dre/port/types.ts:172`：`computeBackoff` 的抖动 `(Math.random() * 2 - 1) * jitterDelta`。
目的是防惊群，但意味着**重试发生时刻逐次不同**，可观测的时间序列不可复现。

**⑦ 检索结果的缓存新鲜度依赖墙上时钟。**

`src/dre/retrieval/deterministic-retrieval-engine.ts:545,562`：`queryCache` 以 `Date.now()` 计 TTL。
同一 query 在数据变更后的短时间内可能返回缓存（旧）或重算（新）结果 —— 与**时间**相关而非与输入相关。

**⑧ 已修复 1 处（本轮）：知识节点 ID 改为内容寻址。**

`src/dre/port/knowledge-port.ts:261` 原为时间戳+随机，现为 `deriveNodeId()`
（`sha256(标题 + content + domain)` 前 16 hex）。同内容恒得同 ID，并同时修复了重复摄取产生重复节点的问题。
该处已从 §5.2 的命中中消失（普查可复核）。

### 5.4 结论：声明 vs 实际的一致性裁定

| # | 声明 | 裁定 | 依据 |
| --- | --- | --- | --- |
| ① | `run()` 与 `POST /dre/run` 为"**纯确定性**" | **部分一致** | 检索/排序/合并的**语义结果**在同一 locale 下可复现（5.3①），但响应内嵌耗时（5.3④）、实体 ID 随机（5.3⑤）、重试时序随机（5.3⑥）、缓存与时间相关（5.3⑦）；`hybrid-fusion` 缺 tie-breaker 已于本轮修复（5.3③，TDD 复现 2 fail → 0 fail） |
| ② | 「LLM 仅作为确定性管道的补全器」 | **部分一致** | 结构上成立（LLM 分支带 `DRE_LLM_SEED=42`，`AXIOM-ARCHITECTURE.md:1521`），但 LLM 补全分支的输出**不保证**同输入同输出（模型侧无确定性保证），仅管道侧确定 |
| ③ | 本项目"确定性"定位（README/DRE） | **部分一致** | 成立范围：**入参 → 语义结果**（排序/合并/打分）在同机同 locale 下可复现。不成立范围：**字节级响应**、**跨 locale/ICU/运行时版本**、**实体 ID**、**重试时序**、**缓存新鲜度**、**任何含 LLM 的分支** |
| ④ | 路由层非确定"属设计" | **一致** | `docs/AXIOM-ARCHITECTURE.md:1293` 已显式排除，且 `src/router/thompson-router.ts:157-182` 确为采样实现 —— 声明与实现方向一致 |

**给使用者的可操作口径**：本项目可承诺的是
「**给定同一份已入库数据、同一运行环境（locale/ICU/运行时版本一致）、忽略响应中的时间戳与随机 ID 字段时，
检索与排序的语义结果可复现**」；不可承诺「两次调用的响应逐字节相同」或「跨环境完全一致」。
该口径已有**有限实测**支撑（见 5.5 第 2 条：7 进程 1 hash），但实测只覆盖注入固定依赖的检索路径。

### 5.5 未覆盖项（如实登记）

1. **本节分类按模块与代码证据给出，未对全部 253 处逐点判定**其是否进入输出。已逐点核实的仅 §5.3 列出的那些；
   其余（如 `constraint/solver.ts`、`synapse/*`、`kernel.ts`、`persona/loader.ts`、`context-engine.ts` 等的时间戳）
   仅登记命中，**未判定**其是否影响确定性输出。按 5.4 的口径，此类未判定项**一律不得被引用为"确定性"的正面证据**。
2. **N≥5 次跨进程实测 —— 已补做（2026-09-18），但覆盖面有限，结论不得外推。**
   `scripts/determinism-repro.ts` 以**固定夹具**（注入 `KeywordSearcher` + 图 mock，全部内联常量，不含时间戳/随机）
   驱动 `retrieve()` 与 `retrieveWithPaths()`，丢弃已披露的易变耗时字段（`latencyMs`/各阶段 ms）后做规范序列化取 sha256：
   **7 个独立进程 → 1 个不同 hash**（`277565320fdd6b44…`）。CI 侧 `tests/rigorous/determinism-repro.test.ts`
   以 **N=5** 常态化把守。该测试的可证伪性已用负向对照确认：往 payload 注入 `Date.now()` → **5 个不同 hash、测试失败**；
   移除后恢复 1 个 hash（非恒真断言）。
   **本条实测未覆盖**：真实 SQLite 后端、任何 LLM 分支、跨机器/locale/ICU 版本、并发调用。
3. **`Map`/`Set` 遍历顺序**未做机器可判定的静态分析：全仓 81 个文件使用 `.values()/.entries()/.keys()`，
   本节只对 §5.3① 的 5 个排序点做了人工核实（确认有 tie-breaker），**其余未逐一核实**。
4. **未覆盖 `src/` 其余目录**（`agents`/`routes`/`memory`/`router` 等）。这些目录不在"确定性承诺"的声称范围内，
   但其自身若有确定性宣称则不在本节检验面内。
5. 普查逻辑已固化为 `tests/unit/determinism-disclosure.test.ts`（剥离注释 → 逐文件逐模式统计命中行 → 与 §5.2.1 表格集合双向比对）。
   该测试**只保证披露不漂移**（文档与代码文件集一致），**不代表**已对每处命中判定其是否影响输出（见本节第 1 条）。

---

## 4. MinerU 零LLM 边界澄清（Task8）

### 4.1 口径定义

- **零LLM = 零生成式LLM**：无 Chat/Completion 调用；检索/整理/DRE 默认不依赖生成式模型（`KNOWLEDGE_USE_LLM=false` 走 TF-IDF）。
- **MinerU 本地判别式网络属于允许范围**：PP-DocLayoutV2 布局检测、Unimernet 公式识别、印章 OCR，均 via `from_pretrained` + HF/ModelScope `snapshot_download` 加载本地权重，依赖 70 包，wheel 3.4.5。此类为判别式神经网络，非生成式 LLM，已显式声明为允许。
- **边界**：若“零LLM”指“一切神经推理（含判别式）”则本路径不满足；本仓库将 MinerU 归为非生成式判别式，已文档化。

### 4.2 已知与待校准

| 维度 | 现状 | 影响 | 后续校准 |
|---|---|---|---|
| 权重来源 | `from_pretrained` 本地权重（HF/ModelScope snapshot_download），非远程生成 | 离线可用，需显式声明为判别式 | 按需披露权重版本 |
| 依赖体积 | mineru 3.4.5，依赖 70 包（含 PP-DocLayoutV2 / Unimernet / 印章 OCR 模型） | 安装体积较大 | 待按需裁剪仅保留判别式子集 |
| 口径一致性 | KNOWLEDGE-BASE 与本节双向同步，零LLM 口径为“零生成式” | 若需“零一切神经网络”口径则不满足，需显式声明 | 已同步 |

---

*最后更新：2026-09-26（主干归一：ku 线并入 —— §1 VRAM 子系统恢复为现役边界并附归一注、§2.1 补 settings-search 修正披露；此前 2026-08-27 Task8: 澄清 mineru 零LLM 边界：判别式 PP-DocLayoutV2/Unimernet/印章 OCR，依赖 70 包 wheel 3.4.5，零生成式 vs 零神经推理双口径；检索口径 FTS5+关键词为默认、共享 cosineSimilarity 仅可选语义层；工具数以 `src/testing/tool-count.ts` 实测为准（数值不手抄））*
