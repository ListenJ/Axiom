/**
 * 文档/网页摄取 MCP 工具 — knowledge_ingest_document
 *
 * 需求：DRE 获取文档和网页内容，经 OCR + 文档识别排版框架处理为 Markdown。
 * 微内核插件化暴露：html→markdown、pdf→外部 pdf-worker（可配）、图片→OCR+布局。
 */
import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { readString } from "../../utils/env.js";

export function registerDocumentTools(registry: ToolRegistry): void {
  registry.add({
    name: "knowledge_ingest_document",
    description: "摄取文档/网页：URL 或本地文件 → 按类型路由（HTML→Markdown / PDF→pdf-worker / 图片→OCR+排版框架），返回规范化 Markdown 与布局信息",
    exposure: ["external", "safe-external"],
    inputSchema: {
      url: z.string().optional().describe("文档/网页 URL（与 file 二选一）"),
      file: z.string().optional().describe("本地文件路径（与 url 二选一）"),
      pdfWorkerUrl: z.string().optional().describe("外部 PDF worker 地址（默认读 AXIOM_PDF_WORKER_URL）"),
      ocrLanguages: z.array(z.string()).optional().describe("OCR 语言（默认 eng）"),
    },
    handler: async (args: Record<string, unknown>) => {
      const { ingestDocument } = await import("../../knowledge/document-ingest.js");
      const source = args.url ? { url: args.url as string } : args.file ? { file: args.file as string } : null;
      if (!source) throw new Error("knowledge_ingest_document requires url or file");
      const pdfWorkerUrl = (args.pdfWorkerUrl as string | undefined) ?? readString("AXIOM_PDF_WORKER_URL", "");
      const doc = await ingestDocument(source, {
        ...(pdfWorkerUrl ? { pdfWorkerUrl } : {}),
        ...(Array.isArray(args.ocrLanguages) ? { ocrLanguages: args.ocrLanguages as string[] } : {}),
      });
      return {
        source: doc.source,
        kind: doc.kind,
        via: doc.metadata.via,
        markdown: doc.markdown,
        layout: doc.layout,
        structured: doc.structured,
        error: doc.error,
      };
    },
  });
}
