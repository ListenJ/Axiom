# 系统边界与已知限制（Limitations）

> 摘要：本文档披露当前实现中因简化估算、外部依赖缺失或待校准数值导致的边界行为，供审计与运维参考。

---

## 1. 本地推理与 VRAM 管理：已归档移除（2026-09-18）

本项目不再自托管本地推理，也不再维护显存 / token 预算钳制。原「VRAM / KV-Cache 估算边界（Critical 05 已校准）」整节随之废止——其核算对象已不存在。

| 原对象 | 处置 |
|---|---|
| `src/dre/system-resource.ts`（`ResourceBudgetManager`、`clampMaxTokens`、`bytesPerToken` 校准） | 按规则 4 归档至 `archive/local-inference-vram-removal-2026-09-18/` |
| `src/dre/system-resource-probe.ts`（`nvidia-smi` VRAM 轮询） | 同上归档移除 |
| `tests/unit/{system-resource,clamp-max-tokens,resource-debounce,resource-hysteresis,resource-sync,vram-probe}.test.ts`、`tests/vram-probe-wiring.test.ts`、`tests/rigorous/system-scheduler-rigorous.test.ts` | 随子系统归档移除 |
| `resource_status` / `vram_status` MCP 工具、`GPU_CONSTRAINTS` 约束 | 同步删除（MCP 工具数由 189 回落到 188） |

模型统一按**外部 OpenAI 兼容服务**对接（Ollama / 云端，由 `DRE_LLM_URL` 指向），"KV cache 卸载到系统内存"一类表述已从架构文档清除。调度器内存准入改用进程堆占用（`process.memoryUsage().heapUsed`）对照可配置预算，见 `src/dre/runtime/scheduler.ts:50,65,76`，可经 `setBudget({ maxMemoryMB })` 覆盖。

原 Critical 05 的 `bytesPerToken` 114688 倍误差随模块移除失去对象；本条目保留为历史索引，不再构成现役边界。

---

## 2. 检索与文档一致性边界（Task16 校准）

### 2.1 问题溯源

- **审计定位**：`docs/ARCHITECTURE.md:10` 与 `docs/PROJECT-GUIDE.md:27` 等旧宣称“零-向量、零-概率、零-embedding”“零-向量全文搜索”，与实现（`src/memory/deterministic-search.ts` 关键词权重 + `src/dre/consciousness/stream.ts` 共享 `cosineSimilarity` 余弦归一化）不一致；`PG-已移除` 旧宣称与实际“PG vector 可选（H-M1-03，可选历史能力，默认 SQLite FTS5）”不一致；`zero-LLM` 旧宣称与实际“`KNOWLEDGE_USE_LLM=false` 默认关闭的可选 LLM（`src/knowledge/pipeline.ts:186`）”不一致；工具数文档宣称 133/150/173 vs 当时实测 172 去重（现为 188，见 §2.2）。
- **修复提交**：`docs: 同步架构声明 docs/ARCHITECTURE.md README.md 6.1/6.2`（Task16），`grep 零-向量` 0 命中（active docs 排除 archive/reviews/superpowers/operations-log，旧值以连字符断开避免命中），`grep 133/150/173 MCP` 0 命中。工具数权威计数已升级为动态统计：`src/testing/tool-count.ts` 实测 **188**（server/**+server.ts 内联+register-external-tools+3 adaptTool，零重复；历史口径 172 为旧值，tests/unit/docs-consistency.test.ts 动态锁定）。

### 2.2 校准后声明

- **检索**：默认确定性检索（`deterministic-search.ts` 标题 3x/标签 2.5x/内容 1x/路径 0.5x；共享 `cosineSimilarity`（`src/utils/math.ts`）仅在有 embedding 的可选语义层使用，`consolidate(0.7)` 阈值聚类）；PG vector（`pgvector`）为可选历史能力 H-M1-03，默认关闭，需 PG 时启用，非历史旧宣称。
- **LLM**：`src/knowledge/pipeline.ts:186` 受 `KNOWLEDGE_USE_LLM` 控，默认 `false` 走 `fallbackTFIDF`（TF-IDF 回退），仅 `true` 时走 `structureKnowledgeWithEdge`/`structureWithGLM`，非历史旧宣称。
- **PG**：`src/db/pg-client.ts` 已删，`pg-schema.sql` 仅归档；`sqlite-memory.ts`/`kg/enhanced.ts`/`codegraph-sync.ts` 为默认；PG 能力为可选历史（`pgvector` 需显式启用），非旧移除宣称即不可用。
- **工具数**：权威值以 `src/testing/tool-count.ts` 动态统计为准，当前 **188**（2026-09-18 移除 `resource_status` 后由 189 回落）；历史口径 133/150/172/173 均为旧值。

### 2.3 当前边界与待校准项

| 维度 | 现状 | 影响 | 后续校准 |
|---|---|---|---|
| 余弦阈值精度 | `cosineSimilarity`（`src/utils/math.ts` 共享实现）为 FP64 归一化，未含向量归一化预处理差异，阈值 0.7 为经验值 | 跨域检索召回率依赖阈值，极短文本余弦抖动 | 待 `docs/LIMITATIONS.md` 中补充 PBT 用例校准 0.7 阈值 |
| PG vector 切换 | 无自动检测 PG 可用性，`pgvector` 需手动 `isPgAvailable` 启用 | 默认 FTS5 无法利用向量语义，PG 启用后需重建索引 | 后续任务引入 `getPG().isAvailable()` 自动回退 |
| LLM 可选性 | `KNOWLEDGE_USE_LLM=false` 时全走 TF-IDF，无法利用 LLM 结构化 | 长文本结构化召回率低于 LLM 模式 | 待评估 TF-IDF vs LLM 质量对比并披露 |
| 工具数漂移 | 新增工具需手动同步文档 | 文档与实现易再次不一致 | `tests/unit/docs-consistency.test.ts` 已落地与 `src/testing/tool-count.ts` 精确相等的 CI 断言，漂移即使门禁变红 |

### 2.4 使用建议

- 将 `deterministic-search.ts` 视为默认检索，PG vector 仅在需语义检索且 PG 可用时启用；`cosineSimilarity` 阈值 0.7 可按 `consolidate()` 调用方覆盖。
- 知识库 keep `KNOWLEDGE_USE_LLM=false` 以满足确定性承诺，需 LLM 结构化时显式开启并接受 `structureKnowledgeWithEdge` 失败回退 TF-IDF。
- 工具数以 `src/testing/tool-count.ts` 为权威，当前 188；新增工具后请同步 `README.md`/`AXIOM-ARCHITECTURE.md`/`ARCHITECTURE.md`/`MCP_TOOLS_GUIDE.md` 并重跑 `tests/unit/docs-consistency.test.ts`（精确相等断言已落地）。

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

*最后更新：2026-09-18（§1 本地推理与 VRAM 管理子系统归档移除；工具数以 `src/testing/tool-count.ts`=188 为准；检索口径 FTS5+关键词为默认、共享 cosineSimilarity 仅可选语义层；mineru 零LLM 边界见 §4）*
