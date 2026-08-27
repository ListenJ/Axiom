/**
 * 文档/网页摄取（Document Ingest）— DRE 知识入库的统一入口
 *
 * 需求：DRE 能"正常获取文档和网页的内容，通过 OCR 和文档识别排版框架完成处理"。
 * 本模块把四类来源统一为一条管线：
 *
 *   来源(URL/本地文件/Buffer) → 探测类型 → 路由 →
 *     HTML  → htmlToMarkdown（网页 → Markdown）
 *     PDF   → 外部 pdf-worker（若配置）→ Markdown（否则优雅降级并给出原因）
 *     图片  → OCR（Tesseract）→ 文档识别排版框架 postProcessOCR
 *             （布局分析：表格/多列/标题/段落 → StructuredDocument → Markdown）
 *     TEXT  → 直接解码为 Markdown
 *
 * 依赖全部注入（规则 8）：fetchImpl / ocrEngine / pdfWorker 可替换，测试零网络零真实 OCR。
 */

import fs from "fs";
import path from "path";
import type { OCRResult } from "../ocr/engine.js";
import { postProcessOCR, type StructuredDocument } from "../ocr/post-processor.js";
import { readDocument } from "./document-reader.js";
import { organizeDocument, type DocAst } from "./doc-ast.js";
import { logger } from "../utils/logger.js";
import { isSafeUrl } from "../utils/url-safety.js";
import { readString } from "../utils/env.js";

export type DocumentSource = { url: string } | { file: string } | { buffer: Uint8Array; name?: string };

export type IngestKind = "web" | "pdf" | "docx" | "image" | "text" | "unknown";
export type IngestVia = "web-markdown" | "pdf-local" | "pdf-worker" | "docx-mammoth" | "doc-ast" | "ocr-layout" | "text-decode";

export interface IngestedDocument {
  source: string;
  kind: IngestKind;
  /** 规范化后的 Markdown（可用于知识入库 / DRE 检索） */
  markdown: string;
  /** OCR 排版框架输出（image 来源时提供） */
  structured?: StructuredDocument;
  /** 文档 AST（md/txt/docx/pdf 来源时提供）：标题大纲/章节/表格/代码块/统计 */
  ast?: DocAst;
  /** 布局信息（image 来源时提供） */
  layout?: { columns: number; blocks: number; avgConfidence: number };
  metadata: {
    contentType?: string;
    title?: string;
    fetchedAt: number;
    via: IngestVia;
    bytes?: number;
  };
  /** 优雅降级原因（如 PDF 未配置外部 worker） */
  error?: string;
}

export interface DocumentIngestOptions {
  /** 外部 PDF worker 地址（可选）；不配置则 PDF 优雅降级 */
  pdfWorkerUrl?: string;
  /** OCR 语言（默认 ["eng"]） */
  ocrLanguages?: string[];
  /** 拉取体积上限（默认 20MB） */
  maxBytes?: number;
  /** 可注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 可注入 OCR 引擎（测试用；默认惰性加载全局引擎） */
  ocrEngine?: { recognize(src: string | Buffer, opts?: unknown): Promise<OCRResult> };
  /** 可注入 PDF worker 客户端（测试用）；submit 后必须 waitForCompletion 轮询终态 */
  pdfWorker?: {
    submit(task: { task_type: string; payload: Record<string, unknown> }): Promise<{ task_id: string; status?: string }>;
    waitForCompletion(
      taskId: string,
      opts?: { intervalMs?: number; timeoutMs?: number },
    ): Promise<{ status?: string; result?: { markdown?: string }; error?: string }>;
  };
  /** pdf-worker 终态轮询超时（默认 120s） */
  pdfWorkerTimeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** C2 审计修复：本地文件敏感段拒绝（.env/.git），与 fs 工具沙箱策略对齐 */
const INGEST_DENIED_SEGMENTS: RegExp[] = [/(^|[\\/])\.env(\.[^\\/]*)?([\\/]|$)/i, /(^|[\\/])\.git([\\/]|$)/i];

function isWithinAnyRoot(resolved: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, resolved);
    // isAbsolute 拦截 Windows 跨盘符/UNC 目标
    return !(rel.startsWith("..") || path.isAbsolute(rel));
  });
}

/** C2 审计修复：file 来源仅允许工作目录/Vault 根之内，拒绝敏感段与符号链接逃逸 */
function assertReadableFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  const roots = [process.cwd(), path.resolve(readString("OBSIDIAN_VAULT_PATH", "./axiom-memory"))];
  if (!isWithinAnyRoot(resolved, roots)) {
    throw new Error(`File path not allowed: ${filePath} (only workspace/vault files are readable)`);
  }
  if (INGEST_DENIED_SEGMENTS.some((re) => re.test(resolved))) {
    throw new Error(`File path not allowed: ${filePath} (denied sensitive segment)`);
  }
  try {
    const real = fs.realpathSync(resolved);
    if (!isWithinAnyRoot(real, roots)) {
      throw new Error(`File path not allowed: ${filePath} (symlink escape)`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("not allowed")) throw e;
    // 文件尚不存在 → 交由 readFileSync 抛 ENOENT
  }
}

/** 探测 MIME：优先响应头，其次扩展名，其次魔数 */
function detectContentType(name: string | undefined, header?: string | null, head?: Uint8Array): string {
  if (header && header.length > 0 && !header.startsWith("text/plain")) return header.toLowerCase();
  const lower = (name ?? "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) return "text/plain";
  // 魔数
  if (head && head.length >= 5) {
    const sig = String.fromCharCode(...Array.from(head.slice(0, 5)));
    if (sig.startsWith("%PDF")) return "application/pdf";
    if (head[0] === 0x50 && head[1] === 0x4b && name?.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
    if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  }
  return header ?? "application/octet-stream";
}

function kindFor(mime: string): IngestKind {
  if (mime.includes("html") || mime.includes("xhtml")) return "web";
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("officedocument") || mime.includes("wordprocessingml")) return "docx";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("markdown")) return "text";
  return "unknown";
}

/** 读取来源为字节 + 名称（注入 fetch 以便测试） */
async function readSource(source: DocumentSource, opts: DocumentIngestOptions, maxBytes: number): Promise<{ bytes: Uint8Array; name?: string; contentType?: string; http?: string }> {
  if ("buffer" in source) return { bytes: source.buffer, name: source.name };
  if ("file" in source) {
    assertReadableFile(source.file);
    const f = await import("fs");
    const buf = f.readFileSync(source.file);
    return { bytes: new Uint8Array(buf), name: source.file.split(/[\\/]/).pop() };
  }
  // C2 审计修复：URL 先过 SSRF 守卫（含注入 fetchImpl 的场景），回环/内网/非 http(s) 一律拦截
  if (!isSafeUrl(source.url)) {
    throw new Error(`URL blocked by SSRF guard: ${source.url}`);
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(source.url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} ${source.url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`content exceeds maxBytes (${maxBytes})`);
  const ct = res.headers.get("content-type");
  const name = source.url.split("/").pop()?.split("?")[0];
  return { bytes: buf, name, contentType: ct ?? undefined, http: source.url };
}

/** 文档摄取主入口（确定性路由 + 可注入依赖） */
export async function ingestDocument(source: DocumentSource, opts: DocumentIngestOptions = {}): Promise<IngestedDocument> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchedAt = Date.now();
  try {
    const { bytes, name, contentType, http } = await readSource(source, opts, maxBytes);
    const mime = detectContentType(name, contentType, bytes);
    const kind = kindFor(mime);
    const sourceLabel = http ?? name ?? "buffer";

    if (kind === "web" || kind === "text" || kind === "docx") {
      const format = kind === "web" ? "html" : kind === "docx" ? "docx" : "text";
      const read = await readDocument(bytes, format);
      if (read.error) {
        return { source: sourceLabel, kind, markdown: "", metadata: { contentType: mime, title: name, fetchedAt, via: "doc-ast", bytes: bytes.length }, error: read.error };
      }
      // 自研 AST 整理：标题大纲/章节/表格/代码块/统计 → 归一化 Markdown
      const ast = organizeDocument(read.text);
      const via: IngestVia = kind === "docx" ? "docx-mammoth" : kind === "web" ? "web-markdown" : "doc-ast";
      return {
        source: sourceLabel,
        kind,
        markdown: ast.markdown,
        ast,
        metadata: { contentType: mime, title: name ?? ast.title, fetchedAt, via, bytes: bytes.length },
      };
    }

    if (kind === "pdf") {
      return await ingestPdf(source, bytes, mime, sourceLabel, fetchedAt, opts);
    }

    if (kind === "image") {
      return await ingestImage(source, bytes, mime, sourceLabel, fetchedAt, opts);
    }

    return { source: sourceLabel, kind, markdown: "", metadata: { contentType: mime, title: name, fetchedAt, via: "web-markdown" }, error: `unsupported content type: ${mime}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("[DocumentIngest] failed", { source: "url" in source ? source.url : "file" in source ? source.file : "buffer", error: msg });
    return { source: "url" in source ? source.url : "file" in source ? source.file : "buffer", kind: "unknown", markdown: "", metadata: { fetchedAt, via: "web-markdown" }, error: msg };
  }
}

/** PDF：优先外部 pdf-worker；未配置则优雅降级（返回原因 + 空 markdown） */
async function ingestPdf(source: DocumentSource, bytes: Uint8Array, mime: string, sourceLabel: string, fetchedAt: number, opts: DocumentIngestOptions): Promise<IngestedDocument> {
  const base = { source: sourceLabel, kind: "pdf" as const, markdown: "", metadata: { contentType: mime, title: sourceLabel.split("/").pop(), fetchedAt, via: "pdf-local" as IngestVia, bytes: bytes.length } };

  // 1) 本地轻量提取（unpdf，纯 JS 框架，毫秒级）——文字型 PDF 无需外部服务/OCR
  const local = await readDocument(bytes, "pdf");
  if (!local.error && local.text.trim().length > 0) {
    const ast = organizeDocument(local.text);
    return { ...base, markdown: ast.markdown, ast, metadata: { ...base.metadata, via: "pdf-local", title: base.metadata.title ?? ast.title } };
  }

  // 2) 无文本层（扫描型 PDF）→ 外部 pdf-worker（若配置）
  if (opts.pdfWorkerUrl || opts.pdfWorker) {
    try {
      const worker = opts.pdfWorker ?? (await createPdfWorkerClientProxy(opts.pdfWorkerUrl!));
      // 审计 F-2（2026-08-24）：本地文件此前仅上传前 64 字节且缺 url 字段，
      // Python 端 KeyError 必失败。现以 data_base64 全量内联上传。
      const task =
        "url" in source
          ? { task_type: "pdf:convert", payload: { url: source.url } }
          : {
              task_type: "pdf:convert",
              payload: {
                name: sourceLabel,
                data_base64: Buffer.from(bytes).toString("base64"),
              },
            };
      // 审计 F-1（2026-08-24）：submit 仅返回 {task_id,status:"queued"}，
      // 此前被当作终态导致 markdown 恒为空串且无 error。必须轮询至终态。
      const ack = await worker.submit(task);
      const resp = await worker.waitForCompletion(ack.task_id, {
        intervalMs: 2000,
        timeoutMs: opts.pdfWorkerTimeoutMs ?? 120_000,
      });
      if (resp.error) return { ...base, error: resp.error };
      const markdown = resp.result?.markdown ?? "";
      if (!markdown) {
        return { ...base, error: "pdf-worker completed without markdown output" };
      }
      return { ...base, markdown, metadata: { ...base.metadata, via: "pdf-worker" } };
    } catch (err) {
      return { ...base, error: "pdf-worker failed: " + (err instanceof Error ? err.message : String(err)) };
    }
  }

  // 3) 降级说明
  return { ...base, error: local.error ?? "PDF 无文本层（扫描型）；可配置 pdf-worker 或对页面走 OCR" };
}

/** 图片：OCR → 文档识别排版框架（布局分析 → 结构化 Markdown） */
async function ingestImage(source: DocumentSource, bytes: Uint8Array, mime: string, sourceLabel: string, fetchedAt: number, opts: DocumentIngestOptions): Promise<IngestedDocument> {
  const base = { source: sourceLabel, kind: "image" as const, markdown: "", metadata: { contentType: mime, title: sourceLabel.split("/").pop(), fetchedAt, via: "ocr-layout" as const, bytes: bytes.length } };
  try {
    let engine = opts.ocrEngine;
    if (!engine) {
      const { getOCREngine } = await import("../ocr/engine.js");
      engine = await getOCREngine(opts.ocrLanguages ?? ["eng"]);
    }
    const result = await engine.recognize(Buffer.from(bytes), { languages: opts.ocrLanguages });
    const structured = postProcessOCR(result, { layoutAnalysis: true, extractStructure: true });
    return {
      ...base,
      markdown: structured.markdown,
      structured,
      layout: {
        columns: detectColumnCount(structured.sections),
        blocks: structured.metadata.totalBlocks,
        avgConfidence: structured.metadata.avgConfidence,
      },
      metadata: { ...base.metadata, title: structured.title || base.metadata.title, via: "ocr-layout" },
    };
  } catch (err) {
    return { ...base, error: `OCR failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 简易列数检测：sections 中出现 ≥2 个"相邻行 bbox 高度重叠但 x 不重叠"的表格列块时计多列 */
function detectColumnCount(sections: StructuredDocument["sections"]): number {
  const tables = sections.filter((s) => s.type === "table");
  if (tables.length > 0) return tables.length;
  return 1;
}

/** 最小 pdf-worker 客户端代理（惰性 import，ESM 兼容）；含终态轮询 */
async function createPdfWorkerClientProxy(baseUrl: string): Promise<{
  submit(task: { task_type: string; payload: Record<string, unknown> }): Promise<{ task_id: string; status?: string }>;
  waitForCompletion(
    taskId: string,
    opts?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<{ status?: string; result?: { markdown?: string }; error?: string }>;
}> {
  const { createPdfWorkerClient } = await import("../workers/pdf-worker.js");
  const client = createPdfWorkerClient(baseUrl);
  return {
    submit: (task) => client.submit(task as never),
    waitForCompletion: (taskId, o) => client.waitForCompletion(taskId, o),
  };
}
