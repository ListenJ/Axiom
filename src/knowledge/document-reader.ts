/**
 * 统一文档读取器（Document Reader）— 轻量化文件处理框架
 *
 * 能力：PDF / DOCX / Markdown / HTML / TXT → 文本/Markdown。
 *   - PDF  → unpdf（基于 pdf.js 的轻量封装，文字型 PDF 毫秒级）
 *   - DOCX → mammoth.convertToHtml（保留 h1-h6 结构）→ htmlToMarkdown
 *   - MD/TXT → 直接解码
 *   - HTML → htmlToMarkdown
 * 依赖全部惰性 import（只有用到该格式时才加载，保持启动轻量）。
 */

import { htmlToMarkdown } from "../crawl/html-to-markdown.js";

export type DocumentFormat = "pdf" | "docx" | "markdown" | "html" | "text" | "unknown";
export type ReaderVia = "unpdf" | "mammoth" | "html-to-markdown" | "decode" | "passthrough";

export interface ReadResult {
  format: DocumentFormat;
  /** 提取的文本/Markdown */
  text: string;
  via: ReaderVia;
  error?: string;
}

/** 由 MIME/扩展名映射格式 */
export function formatFor(mime: string): DocumentFormat {
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("officedocument") || mime.includes("word") || mime.endsWith("docx")) return "docx";
  if (mime.includes("markdown") || mime.endsWith("md")) return "markdown";
  if (mime.includes("html") || mime.includes("xhtml")) return "html";
  if (mime.startsWith("text/") || mime.includes("json")) return "text";
  return "unknown";
}

const decoder = new TextDecoder();

/** 读取文档内容 → 文本/Markdown（惰性加载依赖） */
export async function readDocument(bytes: Uint8Array, format: DocumentFormat): Promise<ReadResult> {
  switch (format) {
    case "pdf": {
      try {
        const { extractText } = await import("unpdf");
        // unpdf/pdf.js 会 transfer 输入 buffer（detach），先拷贝以保护调用方
        const { text } = await extractText(bytes.slice());
        const joined = Array.isArray(text) ? text.join("\n") : String(text ?? "");
        return { format, text: joined, via: "unpdf" };
      } catch (err) {
        return { format, text: "", via: "unpdf", error: `unpdf failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case "docx": {
      try {
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
        const markdown = htmlToMarkdown(result.value ?? "", { preserveLinks: true });
        return { format, text: markdown, via: "mammoth" };
      } catch (err) {
        return { format, text: "", via: "mammoth", error: `mammoth failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case "html": {
      const html = decoder.decode(bytes);
      return { format, text: htmlToMarkdown(html), via: "html-to-markdown" };
    }
    case "markdown":
    case "text": {
      return { format, text: decoder.decode(bytes), via: "decode" };
    }
    default:
      return { format, text: "", via: "passthrough", error: `unsupported format: ${format}` };
  }
}
