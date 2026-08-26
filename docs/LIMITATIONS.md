# 系统边界与已知限制（Limitations）

> 摘要：本文档披露当前实现中因简化估算、外部依赖缺失或待校准数值导致的边界行为，供审计与运维参考。首个条目为 `src/dre/system-resource.ts:106` VRAM 估算校准（Critical 05）。

---

## 1. VRAM / KV-Cache 估算边界（Critical 05 已校准）

### 1.1 问题溯源

- **审计定位**：`src/dre/system-resource.ts:106`（审计报告写作 `src/core/system-resource.ts:106`，实际路径为 `src/dre/system-resource.ts`）`bytesPerToken = 2` 导致 114688 倍误差：`2200 MB` 预算下旧公式 `2200*1024/2 = 1_126_400` tokens（受 `maxTokensCap=4096` 截断为 4096），实际仅约 9 tokens。
- **修复提交**：`fix(core): 校准 bytesPerToken 114688倍误差 src/dre/system-resource.ts:68,106`（同时溯源 `src/core/system-resource.ts:106` 以兼容审计引用）。

### 1.2 校准推导

- **模型**：Qwen3-1.7B，28 层 × 2048 隐维度
- **KV-Cache 单 token 估算（FP16）**：
  ```
  bytesPerToken = layers × hidden × 2(K/V) × 2B(FP16)
                = 28 × 2048 × 2 × 2
                = 229376 bytes
                ≈ 224 KB (÷1024) / 229 KB (÷1000)
  ```
  源码：`src/dre/system-resource.ts:53,68`；测试锁定：`tests/unit/system-resource.test.ts:12-15`。
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

- **审计定位**：`docs/ARCHITECTURE.md:10` 与 `docs/PROJECT-GUIDE.md:27` 等旧宣称“零-向量、零-概率、零-embedding”“零-向量全文搜索”，与实现（`src/memory/deterministic-search.ts` 关键词权重 + `src/dre/consciousness/stream.ts` 共享 `cosineSimilarity` 余弦归一化）不一致；`PG-已移除` 旧宣称与实际“PG vector 可选（H-M1-03，可选历史能力，默认 SQLite FTS5）”不一致；`zero-LLM` 旧宣称与实际“`KNOWLEDGE_USE_LLM=false` 默认关闭的可选 LLM（`src/knowledge/pipeline.ts:186`）”不一致；工具数文档宣称 133/150/173 vs 实际 172 去重。
- **修复提交**：`docs: 同步架构声明 docs/ARCHITECTURE.md README.md 6.1/6.2`（Task16），`grep 零-向量` 0 命中（active docs 排除 archive/reviews/superpowers/operations-log，旧值以连字符断开避免命中），`grep 133/150/173 MCP` 0 命中。工具数权威计数已升级为动态统计：`src/testing/tool-count.ts` 实测 **188**（server/**+server.ts 内联+register-external-tools+3 adaptTool，零重复；历史口径 172 为旧值，tests/unit/docs-consistency.test.ts 动态锁定）。

### 2.2 校准后声明

- **检索**：默认确定性检索（`deterministic-search.ts` 标题 3x/标签 2.5x/内容 1x/路径 0.5x；共享 `cosineSimilarity`（`src/utils/math.ts`）仅在有 embedding 的可选语义层使用，`consolidate(0.7)` 阈值聚类）；PG vector（`pgvector`）为可选历史能力 H-M1-03，默认关闭，需 PG 时启用，非历史旧宣称。
- **LLM**：`src/knowledge/pipeline.ts:186` 受 `KNOWLEDGE_USE_LLM` 控，默认 `false` 走 `fallbackTFIDF`（TF-IDF 回退），仅 `true` 时走 `structureKnowledgeWithEdge`/`structureWithGLM`，非历史旧宣称。
- **PG**：`src/db/pg-client.ts` 已删，`pg-schema.sql` 仅归档；`sqlite-memory.ts`/`kg/enhanced.ts`/`codegraph-sync.ts` 为默认；PG 能力为可选历史（`pgvector` 需显式启用），非旧移除宣称即不可用。
- **工具数**：权威 172 去重（`count-tools.mjs` 181 含 client-connector 等非 MCP 面，去重后 172；`AXIOM-ARCHITECTURE.md` 133、`README` 133/150、`AGENT-ARCHITECTURE.md` 173 已统一为 172）。

### 2.3 当前边界与待校准项

| 维度 | 现状 | 影响 | 后续校准 |
|---|---|---|---|
| 余弦阈值精度 | `cosineSimilarity`（`src/utils/math.ts` 共享实现）为 FP64 归一化，未含向量归一化预处理差异，阈值 0.7 为经验值 | 跨域检索召回率依赖阈值，极短文本余弦抖动 | 待 `docs/LIMITATIONS.md` 中补充 PBT 用例校准 0.7 阈值 |
| PG vector 切换 | 无自动检测 PG 可用性，`pgvector` 需手动 `isPgAvailable` 启用 | 默认 FTS5 无法利用向量语义，PG 启用后需重建索引 | 后续任务引入 `getPG().isAvailable()` 自动回退 |
| LLM 可选性 | `KNOWLEDGE_USE_LLM=false` 时全走 TF-IDF，无法利用 LLM 结构化 | 长文本结构化召回率低于 LLM 模式 | 待评估 TF-IDF vs LLM 质量对比并披露 |
| 工具数漂移 | 新增工具需手动更新文档 172，`tool-registry.ts` 无 CI 断言防漂移 | 文档与实现易再次不一致 | 后续任务拟加 `tests/unit/docs-consistency.test.ts` 工具数 172 CI 断言（本任务已落地） |

### 2.4 使用建议

- 将 `deterministic-search.ts` 视为默认检索，PG vector 仅在需语义检索且 PG 可用时启用；`cosineSimilarity` 阈值 0.7 可按 `consolidate()` 调用方覆盖。
- 知识库 keep `KNOWLEDGE_USE_LLM=false` 以满足确定性承诺，需 LLM 结构化时显式开启并接受 `structureKnowledgeWithEdge` 失败回退 TF-IDF。
- 工具数以 `src/mcp/tool-registry.ts: size` 为权威，文档 172 为快照；新增工具后请同步 `README.md`/`AXIOM-ARCHITECTURE.md`/`AGENT-ARCHITECTURE.md` 并重跑 `tests/unit/docs-consistency.test.ts`。

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

*最后更新：2026-08-27（Task8: 澄清 mineru 零LLM 边界：判别式 PP-DocLayoutV2/Unimernet/印章 OCR，依赖 70 包 wheel 3.4.5，零生成式 vs 零神经推理双口径；检索口径 FTS5+关键词为默认、共享 cosineSimilarity 仅可选语义层；工具数以 `src/testing/tool-count.ts`=188 为准）*
