/**
 * OCR Engine Wrapper
 * 
 * Unified interface for Tesseract.js OCR operations.
 * Supports multiple languages, image preprocessing hints,
 * and structured output extraction.
 */

import { createWorker, type Worker } from "tesseract.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";

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
  /** Tesseract 语言数据目录（默认仓库根，含本地 eng.traineddata；可 TESSERACT_LANG_PATH 覆盖） */
  langPath?: string;
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
  private readonly langPath: string;

  /**
   * Initialize the OCR worker.
   * Must be called before any recognize() calls.
   */
  constructor(langPath?: string) {
    // 默认仓库根（eng.traineddata 所在），保证离线可用；env TESSERACT_LANG_PATH 可覆盖
    this.langPath = (langPath ?? readString("TESSERACT_LANG_PATH", "")) || defaultLangPath();
  }

  /**
   * 校验语言包存在于 langPath（纯文本或 .gz 均可）。
   * 缺失时抛出清晰错误（含可用语言列表），避免 tesseract worker 未捕获异常直接崩掉进程。
   */
  private assertLangsAvailable(languages: string[]): void {
    // langPath 本身不存在时给出可操作的错误，而不是 readdirSync 抛 ENOENT
    if (!fs.existsSync(this.langPath)) {
      throw new Error(
        `OCR 语言数据目录不存在: ${this.langPath}。请创建该目录并放入 ${languages.map((l) => `${l}.traineddata`).join(", ")}，` +
          `或通过 TESSERACT_LANG_PATH 指向正确的语言包目录。`,
      );
    }
    const missing = languages.filter((lang) => {
      const plain = path.join(this.langPath, `${lang}.traineddata`);
      return !fs.existsSync(plain) && !fs.existsSync(`${plain}.gz`);
    });
    if (missing.length === 0) return;
    const available = fs
      .readdirSync(this.langPath)
      .filter((f) => f.endsWith(".traineddata") || f.endsWith(".traineddata.gz"))
      .map((f) => f.replace(/.traineddata(.gz)?$/, ""))
      .filter((l) => l.length > 0);
    throw new Error(
      `OCR 语言包缺失: ${missing.join(", ")}（langPath=${this.langPath}；可用: ${available.join(", ") || "无"}）。` +
        `可通过 TESSERACT_LANG_PATH 指向语言包目录，或下载 @tesseract.js-data/<lang> 的 traineddata 放入 langPath。`,
    );
  }

  async initialize(languages: string[] = ["eng"]): Promise<void> {
    if (this.worker) return;

    const start = performance.now();
    this.currentLangs = languages;
    this.assertLangsAvailable(languages);

    try {
      this.worker = await createWorker(languages, 1, {
        logger: (m) => {
          if (m.status === "recognizing text") {
            logger.debug(`[OCR] ${m.status}: ${Math.round(m.progress * 100)}%`);
          }
        },
        langPath: this.langPath,
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

      // tesseract.js v7：结构化输出需显式请求 blocks；行文本位于 blocks→paragraphs→lines
      const result = await this.worker!.recognize(source as string | Buffer, {}, { blocks: true });
      const duration = Math.round(performance.now() - start);
      const data = result.data as unknown as {
        text?: string;
        confidence?: number;
        detectedLang?: string;
        lines?: Array<{ text?: string; confidence?: number; bbox?: { x0: number; y0: number; x1: number; y1: number }; words?: Array<unknown> }>;
        blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ text?: string; confidence?: number; bbox?: { x0: number; y0: number; x1: number; y1: number }; words?: Array<unknown> }> }> }>;
      };

      // 提取行：优先 v7 分层结构，兼容旧版 data.lines
      const lines = extractLines(data);

      // Build structured blocks from lines
      const blocks: OCRBlock[] = [];
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

/** 默认语言数据目录：仓库根（含 eng.traineddata），跨平台归一为前斜杠 + 结尾斜杠 */
function defaultLangPath(): string {
  const p = fileURLToPath(new URL("../../", import.meta.url));
  const norm = p.replace(/\\/g, "/");
  return norm.endsWith("/") ? norm : norm + "/";
}

/** Get or create the global OCR engine */
export async function getOCREngine(languages?: string[], langPath?: string): Promise<OCREngine> {
  if (!globalEngine) {
    globalEngine = new OCREngine(langPath);
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


/** 提取 OCR 行：tesseract.js v7 为 blocks→paragraphs→lines；旧版为 data.lines */
interface OcrLineLike {
  text?: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  words?: Array<unknown>;
}
function extractLines(data: {
  lines?: OcrLineLike[];
  blocks?: Array<{ paragraphs?: Array<{ lines?: OcrLineLike[] }> }>;
}): OcrLineLike[] {
  if (Array.isArray(data.lines)) return data.lines;
  const out: OcrLineLike[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) out.push(line);
    }
  }
  return out;
}
