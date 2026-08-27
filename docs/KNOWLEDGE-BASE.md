# Agent 知识库框架（2026-08-17 彻底更新）

> 多级框架 + 最新研究论文原文 + 当前项目数据。知识库本体位于 `axiom-memory/`（运行时数据，git-ignored）；本文件为框架与复现说明。

## 多级结构（Domain → Framework → Subdomain → Notes）

| Domain | Framework | Subdomains |
| --- | --- | --- |
| `AI-Agents` | Agent 架构与方法论 | agent-architectures / tool-use / multi-agent |
| `LLM-Context` | 上下文与推理 | context-engineering / reasoning-models |
| `RAG-Memory` | 检索与记忆 | retrieval-augmented-generation / memory-systems / knowledge-graphs |
| `Document-Intelligence` | 文档智能 | ocr-layout / pdf-parsing |
| `MCP-Interop` | 协议互操作 | mcp-protocol |
| `Systems-Infra` | 系统与基础设施 | llm-serving / vector-search |
| `Project-Data` | 当前项目核心模块 | dre-runtime / document-ingest / memory-vault / model-router / mcp-server / search-crawl / self-evolve / knowledge-graph |

## 数据现状

- 论文原文 PDF：52 篇 → `axiom-memory/03-Resources/papers/<Domain>/<Subdomain>/<arxiv-id>.pdf`
- 结构化笔记：52 篇（frontmatter：title/arxiv_id/date/domain/framework/subdomain/tags/authors/pdf + Abstract + unpdf 全文提取）+ 8 篇项目模块笔记 + 1 篇清单 → `axiom-memory/00-Knowledge/<Domain>/<Subdomain>/`
- 来源：arxiv API（2026-08 最新研究，`cat:cs.AI/CL/CV/LG/DC` 分类 + `abs:` 字段精确检索）
- 同步：本地与 docker 服务器（192.168.0.10 容器挂载卷）均已就位；docker VaultManager notes=149

## 复现（采集脚本）

```bash
# 1) 论文采集（arxiv 多级框架 → PDF + 笔记）
bun .tmp/kb-build.ts
# 2) 项目模块笔记（从代码库生成）
bun .tmp/kb-project-data.ts
# 3) 重新建知识图谱索引（让 DRE/KG 可检索）
curl -X POST http://127.0.0.1:18789/kg/build -d '{"scope":"vault"}'
```

脚本按需调整 `.tmp/kb-build.ts` 中 `FRAMEWORK` 的 domain/subdomain/query。

## 检索入口

- Vault 确定性搜索（关键词/PARA/标签）— `/vault/stats` 可见笔记数
- DRE `/dre/run`（认知管线：classify→knowledge→reasoning→constraint→action→reflection）
- 知识图谱 `/kg/search`（pgvector 语义检索）
- Chat 内 `web_search`/`web_fetch` 工具（可继续拉取新资料入库）

## MinerU 与 零LLM 口径（Task8 澄清）

- **零LLM = 零生成式LLM**（无 Chat/Completion 调用）：检索/整理/DRE 证据链默认不调用生成式模型，`KNOWLEDGE_USE_LLM=false` 时走 TF-IDF 回退。
- **MinerU 本地判别式网络属于允许范围**：PP-DocLayoutV2 布局检测、Unimernet 公式识别、印章 OCR（`from_pretrained` + HF/ModelScope `snapshot_download`，依赖 70 包，wheel 3.4.5）。此类为本地判别式推理，非生成式 LLM。
- **边界声明**：若“零LLM”指“一切神经推理（含判别式）”则本路径不满足，已显式声明；若指“零生成式 LLM”则满足。mineru 3.4.5 依赖已在 `docs/LIMITATIONS.md` 同步披露。

## DRE 下一迭代：知识整理→证据链优化（2026-08-27）

- **整理策略**：`DeterministicSearchEngine` 有界扫描 `CONTENT_SCAN_MAX=200` + Vault 去重（`dedupByTask`）+ 截断 3000 + 噪声过滤（PyMuPDF/mineru）已落地；`src/kal/knowledge-access-layer.ts` 经 `getWikiBacklinks` 与 KG 出入边 UNION 实现跨存储闭环。
- **证据链**：`HypothesisManager` 净证据占优（`s≥3 && s>c → confirmed; c≥3 && c>s → refuted`）+ 按行 `JSON.parse` 容错已落地；`src/dre/storage/knowledge-store.ts` 支持混合证据驳斥可达。
- **资源联动**：`ResourceBudgetManager`（`modelMemoryMB=1100 + safety 200 + kvCache 2200`）经 `clampMaxTokens` 与 `VRAM probe`（`nvidia-smi` 60s 轮询）联动，`RTX 3050 Ti 4096MiB` 下推荐 `4096` tokens，`1000MB` 时 `canRun=false` 触发降级（`DRE→vault.search` 保守放行）。
- **双端探针**：`scripts/audit/dual-probe.ts` 7 探针（health/cron/MCP/重绑定/WS/mineru/DRE）本地 6 PASS + 远端 7 SKIP（`192.168.0.150` 不可达容错），`scripts/audit/oom-probe.ts` 5 探针（`clamp/OOM/nvidia/llama`）0 FAIL。
