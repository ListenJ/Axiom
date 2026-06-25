/**
 * OCR Engine Wrapper
 * 
 * Unified interface for Tesseract.js OCR operations.
 * Supports multiple languages, image preprocessing hints,
 * and structured output extraction.
 */

import { createWorker, type Worker } from "tesseract.js";
import { logger } from "../utils/logger.js";

/** OCR recognition options */
export interface OCROptions {
  /** Language codes (e.g., 'eng', 'chi_sim', 'jpn') */
  languages?: string[];
  /** Enable whitespace optimization */
  preserveWhitespace?: boolean;
  /** Confidence threshold (0-100) */
  confidenceThreshold?: number;
  /** Page segmentation mode */
  psm?: number;
  /** Enable OCR engine mode (0-3) */
  oem?: number;
}

/** Single text block with metadata */
export interface OCRBlock {
  text: string;
  confidence: number;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  paragraph?: number;
  line?: number;
  wordCount: number;
}

/** Full OCR result */
export interface OCRResult {
  /** Full extracted text */
  text: string;
  /** Confidence score (0-100) */
  confidence: number;
  /** Individual text blocks with bounding boxes */
  blocks: OCRBlock[];
  /** Detected language */
  language: string;
  /** Processing time in ms */
  duration: number;
}

/** OCR Engine */
export class OCREngine {
  private worker: Worker | null = null;
  private currentLangs: string[] = ["eng"];

  /**
   * Initialize the OCR worker.
   * Must be called before any recognize() calls.
   */
  async initialize(languages: string[] = ["eng"]): Promise<void> {
    if (this.worker) return;

    const start = performance.now();
    this.currentLangs = languages;

    try {
      this.worker = await createWorker(languages, 1, {
        logger: (m) => {
          if (m.status === "recognizing text") {
            logger.debug(`[OCR] ${m.status}: ${Math.round(m.progress * 100)}%`);
          }
        },
      });
      logger.info(`[OCR] Worker initialized`, {
        languages,
        duration: Math.round(performance.now() - start),
      });
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      logger.error("[OCR] Failed to initialize worker", err);
      throw new Error(`OCR initialization failed: ${err.message}`);
    }
  }

  /**
   * Recognize text from an image source.
   * @param source Image path, URL, or Buffer
   */
  async recognize(
    source: string | Buffer | ArrayBuffer,
    options: OCROptions = {}
  ): Promise<OCRResult> {
    if (!this.worker) {
      await this.initialize(options.languages || this.currentLangs);
    }

    const start = performance.now();

    try {
      // Set PSM if provided
      if (options.psm !== undefined) {
        await this.worker!.setParameters({
          tessedit_pageseg_mode: String(options.psm) as unknown as import("tesseract.js").PSM,
        });
      }

      const result = await this.worker!.recognize(source as string | Buffer);
      const duration = Math.round(performance.now() - start);
      const data = result.data as unknown as { lines: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number; }; words?: Array<unknown> }>; confidence: number; detectedLang?: string; };

      // Build structured blocks from lines
      const blocks: OCRBlock[] = [];
      const lines = data.lines || [];
      
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const words = line.words || [];

        blocks.push({
          text: String(line.text || ""),
          confidence: Number(line.confidence || 0),
          bbox: {
            x0: Number(line.bbox?.x0 || 0),
            y0: Number(line.bbox?.y0 || 0),
            x1: Number(line.bbox?.x1 || 0),
            y1: Number(line.bbox?.y1 || 0),
          },
          line: lineIdx,
          wordCount: words.length,
        });
      }

      // Filter by confidence threshold
      const threshold = options.confidenceThreshold || 0;
      const filteredBlocks = blocks.filter((b) => b.confidence >= threshold);
      const filteredText = filteredBlocks.map((b) => b.text).join("\n");

      return {
        text: options.preserveWhitespace !== false
          ? filteredText
          : filteredText.replace(/\s+/g, " ").trim(),
        confidence: data.confidence || 0,
        blocks: filteredBlocks,
        language: data.detectedLang || this.currentLangs[0],
        duration,
      };
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      logger.error("[OCR] Recognition failed", err);
      throw new Error(`OCR recognition failed: ${err.message}`);
    }
  }

  /**
   * Detect the dominant language of an image.
   */
  async detectLanguage(source: string | Buffer): Promise<string> {
    if (!this.worker) {
      await this.initialize(["osd"]); // Orientation and script detection
    }

    try {
      const result = await this.worker!.detect(source as string | Buffer);
      return result.data.script || "unknown";
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      logger.error("[OCR] Language detection failed", err);
      return "unknown";
    }
  }

  /**
   * Terminate the worker and free resources.
   */
  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      logger.info("[OCR] Worker terminated");
    }
  }

  /**
   * Reinitialize with different languages.
   */
  async reinitialize(languages: string[]): Promise<void> {
    await this.terminate();
    await this.initialize(languages);
  }
}

/** Global engine instance */
let globalEngine: OCREngine | null = null;

/** Get or create the global OCR engine */
export async function getOCREngine(languages?: string[]): Promise<OCREngine> {
  if (!globalEngine) {
    globalEngine = new OCREngine();
    await globalEngine.initialize(languages);
  } else if (languages) {
    await globalEngine.reinitialize(languages);
  }
  return globalEngine;
}

/** Terminate the global engine */
export async function terminateOCREngine(): Promise<void> {
  if (globalEngine) {
    await globalEngine.terminate();
    globalEngine = null;
  }
}
