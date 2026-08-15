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
