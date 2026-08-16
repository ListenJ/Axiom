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
