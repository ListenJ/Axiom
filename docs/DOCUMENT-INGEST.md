# 文档/网页摄取管线（Document Ingest）

> 日期：2026-08-15 ｜ 位置：`src/knowledge/document-ingest.ts` ｜ MCP：`knowledge_ingest_document`

## 摘要

DRE 获取**文档和网页内容**并处理的统一入口：按类型路由到不同处理链，最终产出规范化 Markdown（可入库 / DRE 检索）：

```
来源(URL / 本地文件 / Buffer) → 探测类型 → 路由 →
  HTML   → htmlToMarkdown（网页 → Markdown）
  PDF    → 外部 pdf-worker（若配置 AXIOM_PDF_WORKER_URL）→ Markdown（未配置则优雅降级并说明）
  图片   → OCR（Tesseract）→ 文档识别排版框架 postProcessOCR
           （布局分析：标题/段落/代码/表格/多列 → StructuredDocument → Markdown）
  TEXT   → 直接解码为 Markdown
```

## 能力清单

| 能力 | 实现 | 验证 |
|------|------|------|
| 网页获取 → Markdown | `htmlToMarkdown`（零依赖正则转换） | 真实抓取 example.com ✅；mock 测试 |
| 本地文件 / Buffer | 扩展名 + 魔数（%PDF / PNG / JPEG）探测 | 测试 |
| PDF → Markdown | 外部 pdf-worker（可注入 mock）；未配置优雅降级 | 测试 |
| 图片 → OCR | Tesseract.js（本地 `eng.traineddata`，离线可用） | 真实 OCR 样例 ✅（v7 blocks 修复后） |
| 文档识别排版框架 | `postProcessOCR`：布局分析（sections/heading/code/table/多列）+ 结构提取 + Markdown | 布局信息（columns/blocks/avgConfidence）✅ |
| 体积/网络防护 | `maxBytes` 上限、fetch 15s 超时、失败优雅降级 | 测试 |
| MCP 暴露 | `knowledge_ingest_document`（微内核插件化） | 注册于 ToolRegistry |

## 修复的坑（本次审计）

1. **OCR 引擎 tesseract.js v7 API 漂移**：`data.lines` 不再存在、`data.blocks` 默认不生成 →
   `recognize(img, {}, { blocks: true })` 显式请求，从 `blocks→paragraphs→lines` 提取（兼容旧版 `data.lines`）。
   修复前 OCR 静默返回空文本。
2. **OCR 语言数据路径**：未配置 `langPath` → 离线环境静默空文本 →
   默认指向仓库根（本地 `eng.traineddata`），`TESSERACT_LANG_PATH` 可覆盖。修复后离线 OCR 可用。
3. **`getOCREngine(undefined)` 导致 worker 初始化挂起** → 默认 `["eng"]`。

## 配置

```bash
# Tesseract 语言数据目录（默认仓库根，含 eng.traineddata，离线可用）
# TESSERACT_LANG_PATH=./
# 外部 PDF worker 地址（PDF→Markdown，可选）
# AXIOM_PDF_WORKER_URL=
```

## 测试

- `tests/document-ingest.test.ts`（11）：web/text/image/pdf/未知/体积/本地文件/魔数
- `tests/ocr-v7.test.ts`（2）：blocks 请求 + v7 分层提取 + 旧版兼容
- 真实端到端（手动验证）：`ingestDocument({file: 样例图})` → `kind=image, via=ocr-layout`，
  8 sections、layout{columns:1,blocks:8,avgConfidence:93}，Markdown 完整

## 轻量化升级（2026-08-15 追加）— 本地 PDF/DOCX 读取 + 自研文档 AST 整理

### 轻量化框架部署
| 格式 | 框架 | 说明 |
|------|------|------|
| PDF | **unpdf@1.8.1**（基于 pdf.js 的轻量 ESM 封装） | 文字型 PDF **本地毫秒级提取**，无需外部 pdf-worker 服务 / 重型 OCR |
| DOCX | **mammoth@1.12.1**（纯 JS） | convertToHtml 保留 h1-h6 → htmlToMarkdown → AST |
| Markdown/TXT | 自研解码 | 直通解码 |
| HTML | 既有 htmlToMarkdown | 零依赖正则 |

PDF 摄取策略（`ingestPdf`）：**本地 unpdf 优先**（via=pdf-local）→ 无文本层（扫描型）才走外部 pdf-worker → 否则降级说明走 OCR。

### 自研文档 AST 算法（`src/knowledge/doc-ast.ts`）
- 行级确定性解析：heading/paragraph/list/code/table/quote/hr
- **大纲整理** `buildOutline`：标题层级树 + 章节路径 + 正文归属
- 独立提取：表格（headers+rows）、代码块（lang+content）、统计（chars/words/paragraphs/headings…）
- 归一化 Markdown 回写（供 DRE 入库/检索）
- 纯函数、零依赖、完全可测试

### 文件
- `src/knowledge/doc-ast.ts`（AST 算法）、`src/knowledge/document-reader.ts`（统一读取）
- `src/knowledge/document-ingest.ts`（接入：docx 类型 + PDF 本地优先 + AST 输出 `ast` 字段）
- `package.json`（unpdf、mammoth）

### 验证
- `tests/doc-ast.test.ts`（11）：节点解析/大纲树/表格/代码/统计/归一化/空输入/CRLF
- `tests/document-reader.test.ts`（6）：自建最小 PDF + 最小 DOCX ZIP（真实 unpdf/mammoth 提取，离线）
- 真实端到端：sample.pdf → pdf-local（unpdf）+ AST；llama.cpp README → 9 headings / 1 code / 1 table
- root 套件 **2588 tests / 0 fail**
