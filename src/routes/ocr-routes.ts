/**
 * OCR HTTP API Routes
 * 
 * POST /ocr/scan       — Scan image/PDF and return OCR text
 * POST /ocr/export     — Scan and export to specific format
 * GET  /ocr/status     — OCR engine status
 */

import type { RouteContext } from "./types.js";
import { getOCREngine, terminateOCREngine } from "../ocr/engine.js";
import { postProcessOCR, exportDocument } from "../ocr/post-processor.js";
import type { StructuredDocument } from "../ocr/post-processor.js";
import { logger } from "../utils/logger.js";

/** Store last processed document */
let lastDocument: StructuredDocument | null = null;

/** Handle /ocr/* routes */
export async function handleOCRRoutes(ctx: RouteContext): Promise<Response | null> {
  const path = ctx.url.pathname;

  // GET /ocr/status — Engine status
  if (path === "/ocr/status" && ctx.req.method === "GET") {
    return ctx.jsonResponse({
      status: "ready",
      engine: "tesseract.js v7.0",
      supportedLanguages: ["eng", "chi_sim", "chi_tra", "jpn", "kor", "fra", "deu", "spa", "rus"],
      features: ["text_recognition", "layout_analysis", "structure_extraction", "confidence_filtering"],
    }, 200, ctx.baseHeaders);
  }

  // POST /ocr/scan — Scan image and return OCR result
  if (path === "/ocr/scan" && ctx.req.method === "POST") {
    try {
      const body = await ctx.req.json();
      const { image, options = {} } = body;

      if (!image) {
        return ctx.jsonResponse({ error: "Missing 'image' field (base64 string or URL)" }, 400, ctx.baseHeaders);
      }

      // Convert base64 to buffer if needed
      let source: string | Buffer = image;
      if (typeof image === "string" && image.startsWith("data:")) {
        const base64 = image.split(",")[1];
        source = Buffer.from(base64, "base64");
      }

      // Initialize OCR engine
      const engine = await getOCREngine(options.languages);
      
      // Perform OCR
      const start = performance.now();
      const result = await engine.recognize(source, {
        languages: options.languages,
        confidenceThreshold: options.confidenceThreshold || 30,
        preserveWhitespace: options.preserveWhitespace !== false,
        psm: options.psm,
      });
      const ocrDuration = Math.round(performance.now() - start);

      // Post-process
      const doc = postProcessOCR(result, {
        layoutAnalysis: options.layoutAnalysis !== false,
        textCorrection: options.textCorrection !== false,
        extractStructure: options.extractStructure !== false,
        minConfidence: options.minConfidence || 30,
      });

      lastDocument = doc;

      logger.info(`[OCR] Scan completed`, {
        blocks: doc.metadata.totalBlocks,
        confidence: doc.metadata.avgConfidence,
        duration: ocrDuration,
        language: doc.metadata.language,
      });

      return ctx.jsonResponse({
        success: true,
        text: result.text,
        confidence: result.confidence,
        blocks: result.blocks.length,
        structured: doc,
        duration: ocrDuration,
      }, 200, ctx.baseHeaders);

    } catch (e: any) {
      logger.error("[OCR] Scan failed", e);
      return ctx.jsonResponse(
        { error: "OCR scan failed", message: e.message },
        500,
        ctx.baseHeaders
      );
    }
  }

  // POST /ocr/export — Export to specific format
  if (path === "/ocr/export" && ctx.req.method === "POST") {
    try {
      const body = await ctx.req.json();
      const { 
        image, 
        format = "markdown", 
        options = {} 
      }: { 
        image?: string; 
        format?: "markdown" | "json" | "text" | "html"; 
        options?: any;
      } = body;

      let doc: StructuredDocument;

      if (image) {
        // New scan + export
        let source: string | Buffer = image;
        if (typeof image === "string" && image.startsWith("data:")) {
          const base64 = image.split(",")[1];
          source = Buffer.from(base64, "base64");
        }

        const engine = await getOCREngine(options.languages);
        const result = await engine.recognize(source, {
          languages: options.languages,
          confidenceThreshold: options.confidenceThreshold || 30,
        });

        doc = postProcessOCR(result, {
          layoutAnalysis: options.layoutAnalysis !== false,
          textCorrection: options.textCorrection !== false,
          extractStructure: options.extractStructure !== false,
        });
        lastDocument = doc;
      } else if (lastDocument) {
        // Export last scanned document
        doc = lastDocument;
      } else {
        return ctx.jsonResponse(
          { error: "No document to export. Scan first with POST /ocr/scan or provide 'image'" },
          400,
          ctx.baseHeaders
        );
      }

      // Export to requested format
      const exported = exportDocument(doc, format);

      // Set appropriate content type
      const contentTypes: Record<string, string> = {
        markdown: "text/markdown",
        json: "application/json",
        text: "text/plain",
        html: "text/html",
      };

      return new Response(exported, {
        status: 200,
        headers: {
          ...ctx.baseHeaders,
          "Content-Type": contentTypes[format] || "text/plain",
          "X-OCR-Confidence": String(doc.metadata.avgConfidence),
          "X-OCR-Language": doc.metadata.language,
        },
      });

    } catch (e: any) {
      logger.error("[OCR] Export failed", e);
      return ctx.jsonResponse(
        { error: "OCR export failed", message: e.message },
        500,
        ctx.baseHeaders
      );
    }
  }

  return null;
}
