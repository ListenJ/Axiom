/**
 * 文档摄取测试 — DRE 获取文档/网页 + OCR + 排版框架处理
 *
 * 覆盖：web(html→markdown)、text、image(OCR→布局排版→结构化)、pdf(worker/降级)、
 * 未知类型、体积上限、本地文件、Buffer 魔数探测。
 */
import { describe, it, expect } from "bun:test";
import { writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ingestDocument } from "../src/knowledge/document-ingest.js";
import type { OCRResult } from "../src/ocr/engine.js";

function mockFetch(status: number, body: Uint8Array | string, contentType?: string): typeof fetch {
  return (async () =>
    new Response((typeof body === "string" ? body : body) as BodyInit, {
      status,
      headers: contentType ? { "content-type": contentType } : {},
    })) as unknown as typeof fetch;
}

const mockOCR: OCRResult = {
  text: "Document Title\n\nIntroduction\nThis is the first paragraph.\n\n| Name | Value |\n| A | 1 |",
  confidence: 92,
  blocks: [
    { text: "Document Title", confidence: 95, bbox: { x0: 10, y0: 10, x1: 300, y1: 50 }, wordCount: 2 },
    { text: "Introduction", confidence: 90, bbox: { x0: 10, y0: 70, x1: 200, y1: 110 }, wordCount: 1 },
    { text: "This is the first paragraph.", confidence: 88, bbox: { x0: 10, y0: 120, x1: 400, y1: 160 }, wordCount: 5 },
    { text: "| Name | Value |", confidence: 92, bbox: { x0: 10, y0: 170, x1: 300, y1: 210 }, wordCount: 4 },
    { text: "| A | 1 |", confidence: 91, bbox: { x0: 10, y0: 220, x1: 300, y1: 260 }, wordCount: 4 },
  ],
  language: "eng",
  duration: 100,
};

describe("DocumentIngest — web", () => {
  it("HTML → Markdown（mock fetch）", async () => {
    const html = "<html><head><title>Test</title></head><body><h1>Hello</h1><p>World</p><a href='https://x'>link</a></body></html>";
    const doc = await ingestDocument({ url: "https://example.com/page.html" }, { fetchImpl: mockFetch(200, html, "text/html") });
    expect(doc.kind).toBe("web");
    expect(doc.metadata.via).toBe("web-markdown");
    expect(doc.markdown).toContain("Hello");
    expect(doc.markdown).toContain("World");
  });

  it("本地 HTML 文件 → Markdown", async () => {
    const p = join(tmpdir(), `ingest-${Date.now()}.html`);
    writeFileSync(p, "<html><body><h2>Local</h2><p>content</p></body></html>");
    try {
      const doc = await ingestDocument({ file: p });
      expect(doc.kind).toBe("web");
      expect(doc.markdown).toContain("Local");
    } finally {
      if (existsSync(p)) rmSync(p);
    }
  });
});

describe("DocumentIngest — text", () => {
  it("纯文本解码为 Markdown", async () => {
    const doc = await ingestDocument({ url: "https://example.com/readme.md" }, { fetchImpl: mockFetch(200, "# Title\n\nbody", "text/plain") });
    expect(doc.kind).toBe("text");
    expect(doc.markdown).toBe("# Title\n\nbody");
  });
});

describe("DocumentIngest — image（OCR + 排版框架）", () => {
  it("OCR → 布局分析 → 结构化 Markdown（注入 mock OCR 引擎）", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const doc = await ingestDocument({ url: "https://example.com/scan.png" }, {
      fetchImpl: mockFetch(200, png, "image/png"),
      ocrEngine: { recognize: async () => mockOCR },
    });
    expect(doc.kind).toBe("image");
    expect(doc.metadata.via).toBe("ocr-layout");
    expect(doc.structured).toBeDefined();
    expect(doc.markdown.length).toBeGreaterThan(0);
    expect(doc.markdown).toContain("Introduction");
    expect(doc.layout).toBeDefined();
    expect(doc.layout!.blocks).toBe(mockOCR.blocks.length);
    expect(doc.layout!.avgConfidence).toBeGreaterThan(0);
    expect(doc.error).toBeUndefined();
  });

  it("OCR 失败时优雅降级（带原因）", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const doc = await ingestDocument({ url: "https://example.com/bad.png" }, {
      fetchImpl: mockFetch(200, png, "image/png"),
      ocrEngine: { recognize: async () => { throw new Error("worker crashed"); } },
    });
    expect(doc.kind).toBe("image");
    expect(doc.error).toContain("OCR failed");
    expect(doc.markdown).toBe("");
  });
});

describe("DocumentIngest — pdf", () => {
  it("配置 pdf-worker → 返回 Markdown（注入 mock worker）", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
    const doc = await ingestDocument({ url: "https://example.com/doc.pdf" }, {
      fetchImpl: mockFetch(200, pdfBytes, "application/pdf"),
      pdfWorker: { submit: async () => ({ result: { markdown: "# PDF content\n\nfrom worker" } }) },
    });
    expect(doc.kind).toBe("pdf");
    expect(doc.metadata.via).toBe("pdf-worker");
    expect(doc.markdown).toContain("PDF content");
  });

  it("未配置 pdf-worker → 优雅降级并说明原因", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const doc = await ingestDocument({ url: "https://example.com/doc.pdf" }, { fetchImpl: mockFetch(200, pdfBytes, "application/pdf") });
    expect(doc.kind).toBe("pdf");
    expect(doc.error).toContain("pdf-worker");
    expect(doc.markdown).toBe("");
  });

  it("Buffer 魔数探测 → pdf", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x20]);
    const doc = await ingestDocument({ buffer: pdfBytes, name: "x" }, { pdfWorker: { submit: async () => ({ result: { markdown: "ok" } }) } });
    expect(doc.kind).toBe("pdf");
    expect(doc.markdown).toBe("ok");
  });
});

describe("DocumentIngest — 边界", () => {
  it("未知类型 → 报不支持", async () => {
    const doc = await ingestDocument({ url: "https://example.com/file.bin" }, { fetchImpl: mockFetch(200, new Uint8Array([1, 2, 3]), "application/octet-stream") });
    expect(doc.kind).toBe("unknown");
    expect(doc.error).toContain("unsupported");
  });

  it("超过 maxBytes → 拒绝", async () => {
    const big = new Uint8Array(1000);
    const doc = await ingestDocument({ url: "https://example.com/big.txt" }, { fetchImpl: mockFetch(200, big, "text/plain"), maxBytes: 100 });
    expect(doc.error).toContain("maxBytes");
  });

  it("fetch 失败 → 优雅降级", async () => {
    const doc = await ingestDocument({ url: "https://example.com/404" }, { fetchImpl: mockFetch(404, "", "text/html") });
    expect(doc.error).toContain("HTTP 404");
  });
});
