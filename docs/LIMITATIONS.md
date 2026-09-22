# 系统边界与已知限制（Limitations）

> 摘要：本文档披露当前实现中因简化估算、外部依赖缺失或待校准数值导致的边界行为，供审计与运维参考。首个条目为 `src/dre/system-resource.ts` 的 VRAM 估算校准（审计报告 Critical 05）。

---

## 1. VRAM / KV-Cache 估算边界（Critical 05 已校准）

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

### 2.2 校准后声明

- **检索**：默认确定性检索（`src/memory/sqlite-memory.ts` 的 SQLite FTS5 为主索引，`src/memory/deterministic-search.ts` 的关键词按匹配次数线性加分为补（优先级 标题 > 标签 > 路径 > 内容，各设上限；加权常量以该文件 `search()` 为唯一事实源，本文不复制数值），二者由 `src/memory/vault-manager.ts` 的 `search()` 串接；共享 `cosineSimilarity`（`src/utils/math.ts`）仅在有 embedding 的可选语义层使用，`consolidate(0.7)` 阈值聚类）；PG vector 当前不可启用（H-M1-03 已删客户端，无启用路径，见 §2.3），非历史旧宣称。
- **LLM**：`src/knowledge/pipeline.ts` 的 `KNOWLEDGE_USE_LLM` 开关（`readBool("KNOWLEDGE_USE_LLM", false)` 共两处读取：图/视频自动理解分支与内容结构化分支各一处）默认 `false` 走 `fallbackTFIDF`（TF-IDF 回退），仅 `true` 时走 `structureKnowledgeWithEdge`/`structureWithGLM`，非历史旧宣称。
- **PG**：`src/db/pg-client.ts` 已删（38966d12），`src/db/pg-schema.sql` 仍在仓库但无运行时消费者；`sqlite-memory.ts`/`kg/enhanced.ts`/`codegraph-sync.ts` 为默认；PG 当前不可启用 —— `package.json` 依赖与 `bun.lock` 均无 PG 驱动，`src/` 下无客户端、无开关、无入口，恢复需先重建客户端与索引迁移（口径见 §2.3）。 <!-- doc-caliber:absent: src/db/pg-client.ts -->
- **工具数**：口径以 `src/testing/tool-count.ts` 的 `countMcpTools()` 实测值为准（零重复断言同在 `docs-consistency`）；引用该数值的文档以 `bun run scripts/count-tools.mjs` 生成，禁止手抄。历史 133/150/172/173 与本文旧版"权威 172"均为已腐烂快照，一律废止。

### 2.3 当前边界与待校准项

| 维度 | 现状 | 影响 | 后续校准 |
|---|---|---|---|
| 余弦阈值精度 | `cosineSimilarity`（`src/utils/math.ts` 共享实现）为 FP64 归一化，未含向量归一化预处理差异，阈值 0.7 为经验值 | 跨域检索召回率依赖阈值，极短文本余弦抖动 | 待 `docs/LIMITATIONS.md` 中补充 PBT 用例校准 0.7 阈值 |
| PG vector 切换 | PG 客户端已随 H-M1-03 删除（`src/db/pg-client.ts`），当前 `src/` 下无任何可调用的 PG 入口（本节旧口径给出的 `isPgAvailable`/`getPG()` 已无宿主，仅存一条说明其已移除的注释） | 默认 FTS5 无向量语义召回；"手动启用"这条路今天不存在，需 PG 时必须重建客户端与索引迁移 | 按规则 4 先裁决 `src/db/pg-schema.sql` 存废（仍在仓库、无运行时消费者），再决定是否恢复该能力；在此之前文档不得给出可调用 PG 符号 <!-- doc-caliber:absent: src/db/pg-client.ts --> |
| LLM 可选性 | `KNOWLEDGE_USE_LLM=false` 时全走 TF-IDF，无法利用 LLM 结构化 | 长文本结构化召回率低于 LLM 模式 | 待评估 TF-IDF vs LLM 质量对比并披露 |
| 工具数漂移 | 权威计数与文档声明的相等断言已落地（`tests/unit/docs-consistency.test.ts` 对受控文件清单内的文档做"声明值 == `countMcpTools()` 实测值"精确相等 + 零重复），新增工具后跑生成器取数即可 | 受控清单是测试里硬编码的文件名数组 ⇒ 清单外的规范件（含本文旧版"权威 172"）仍可能各说各话，且这类"手抄公式/代码块/数值"形态本身无门覆盖 | 把受控清单扩到 `caliberDocs` 全量，或规定非权威件不得出现数值；与"手抄件漏拦"合并裁决 |

### 2.4 使用建议

- Vault 检索的默认入口是 `src/memory/vault-manager.ts` 的 `search()`（FTS5 主索引 + 确定性关键词加分为补）；PG vector 当前不可启用（客户端已删，见 §2.3），需语义检索时只有 embedding 可选语义层一条路；`cosineSimilarity` 阈值 0.7 是 `consolidate()` 的默认参数，调用方可覆盖。
- 知识库 keep `KNOWLEDGE_USE_LLM=false` 以满足确定性承诺，需 LLM 结构化时显式开启并接受 `structureKnowledgeWithEdge` 失败回退 TF-IDF。
- 工具数以 `src/testing/tool-count.ts` 的 `countMcpTools()` 为权威（`src/mcp/tool-registry.ts` 的 `size` 是运行时注册表大小，口径不同，不作为文档数值来源）；新增工具后跑 `bun run scripts/count-tools.mjs` 取生成片段，再跑 `bun test ./tests/unit/docs-consistency.test.ts` 复验。

---

## 3. 其他已知限制（占位）

- 本文档随审计修复任务增量更新；后续任务将补充 Native 稳定性、编排竞态等边界章节。
- 涉及 `Date.now()/Math.random()/Map` 遍历的模块，其确定性边界将在对应章节按 G-04 披露。

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

*最后更新：2026-08-27（Task8: 澄清 mineru 零LLM 边界：判别式 PP-DocLayoutV2/Unimernet/印章 OCR，依赖 70 包 wheel 3.4.5，零生成式 vs 零神经推理双口径；检索口径 FTS5+关键词为默认、共享 cosineSimilarity 仅可选语义层；工具数以 `src/testing/tool-count.ts` 实测为准（数值不手抄））*
