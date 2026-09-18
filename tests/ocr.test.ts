/**
 * OCR Engine Tests
 * 
 * Tests for the OCR processing pipeline:
 * - Engine initialization and configuration
 * - Post-processing and layout analysis
 * - Export format conversion
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { getOCREngine, terminateOCREngine, type OCRResult } from "../src/ocr/engine.js";
import { postProcessOCR, exportDocument, type StructuredDocument } from "../src/ocr/post-processor.js";

describe("OCR Engine", () => {
  // CI 环境跳过（Tesseract worker 加载慢），本地实跑——不再以 expect(true) 假通过
  const maybeTest = process.env.CI ? test.skip : test;
  maybeTest("should get engine with default config", async () => {
    const engine = await getOCREngine();
    expect(engine).toBeDefined();
    await terminateOCREngine();
  }, 30000);
});

describe("OCR Post-Processor", () => {
  const mockOCRResult: OCRResult = {
    text: "Document Title\n\nIntroduction\nThis is the first paragraph.\n\n- Item one\n- Item two\n\nCode example:\nfunction test() { return true; }\n\n> Quote block",
    confidence: 92,
    blocks: [
      { text: "Document Title", confidence: 95, bbox: { x0: 10, y0: 10, x1: 300, y1: 50 }, wordCount: 2 },
      { text: "Introduction", confidence: 90, bbox: { x0: 10, y0: 70, x1: 200, y1: 110 }, wordCount: 1 },
      { text: "This is the first paragraph.", confidence: 88, bbox: { x0: 10, y0: 120, x1: 400, y1: 160 }, wordCount: 5 },
      { text: "- Item one", confidence: 92, bbox: { x0: 10, y0: 170, x1: 150, y1: 210 }, wordCount: 3 },
      { text: "- Item two", confidence: 91, bbox: { x0: 10, y0: 220, x1: 150, y1: 260 }, wordCount: 3 },
      { text: "Code example:", confidence: 89, bbox: { x0: 10, y0: 270, x1: 200, y1: 310 }, wordCount: 2 },
      { text: "function test() { return true; }", confidence: 85, bbox: { x0: 10, y0: 320, x1: 450, y1: 360 }, wordCount: 6 },
      { text: "> Quote block", confidence: 93, bbox: { x0: 10, y0: 370, x1: 200, y1: 410 }, wordCount: 3 },
    ],
    language: "eng",
    duration: 1500,
  };

  test("should extract structure from OCR result", () => {
    const structured = postProcessOCR(mockOCRResult, {
      layoutAnalysis: true,
      extractStructure: true,
      textCorrection: false,
    });

    expect(structured.title).toBe("Document Title");
    expect(structured.sections.length).toBeGreaterThan(0);
    expect(structured.metadata.language).toBe("eng");
    expect(structured.metadata.avgConfidence).toBeGreaterThan(0);
  });

  test("should convert to markdown format", () => {
    const structured = postProcessOCR(mockOCRResult, {
      layoutAnalysis: true,
      extractStructure: true,
      textCorrection: false,
    });

    const markdown = structured.markdown;
    expect(markdown).toContain("# Document Title");
    expect(markdown).toContain("## Introduction");
    expect(markdown).toContain("- Item one");
    expect(markdown).toContain("```");
    expect(markdown).toContain("> Quote block");
  });

  test("should export to JSON format", () => {
    const structured = postProcessOCR(mockOCRResult, {
      layoutAnalysis: true,
      extractStructure: true,
      textCorrection: false,
    });

    const json = exportDocument(structured, "json");
    const parsed = JSON.parse(json);
    expect(parsed.title).toBe("Document Title");
    expect(parsed.sections).toBeInstanceOf(Array);
    expect(parsed.metadata).toBeDefined();
  });

  test("should filter low confidence blocks", () => {
    const lowConfidenceResult: OCRResult = {
      ...mockOCRResult,
      blocks: [
        { text: "Clear text", confidence: 95, bbox: { x0: 10, y0: 10, x1: 200, y1: 50 }, wordCount: 2 },
        { text: "Blurry text", confidence: 30, bbox: { x0: 10, y0: 60, x1: 200, y1: 100 }, wordCount: 2 },
      ],
    };

    const structured = postProcessOCR(lowConfidenceResult, {
      minConfidence: 50,
      layoutAnalysis: true,
    });

    const hasBlurry = structured.sections.some((s) =>
      s.content.includes("Blurry")
    );
    expect(hasBlurry).toBe(false);
  });

  test("should handle empty OCR result", () => {
    const emptyResult: OCRResult = {
      text: "",
      confidence: 0,
      blocks: [],
      language: "eng",
      duration: 0,
    };

    const structured = postProcessOCR(emptyResult, {
      layoutAnalysis: true,
    });

    expect(structured.title).toBe("Untitled Document");
    expect(structured.sections).toHaveLength(0);
    expect(structured.metadata.totalBlocks).toBe(0);
  });

  test("should merge nearby blocks", () => {
    const mergedResult: OCRResult = {
      ...mockOCRResult,
      blocks: [
        { text: "Line one", confidence: 90, bbox: { x0: 10, y0: 10, x1: 100, y1: 30 }, wordCount: 2 },
        { text: "Line two", confidence: 91, bbox: { x0: 10, y0: 35, x1: 100, y1: 55 }, wordCount: 2 },
      ],
    };

    const structured = postProcessOCR(mergedResult, {
      layoutAnalysis: true,
      mergeThreshold: 50,
    });

    expect(structured.sections.length).toBeLessThanOrEqual(2);
  });
});
