/**
 * OCR Module — Unified Exports
 * 
 * Provides OCR-powered document scanning and export with
 * enhanced accuracy through post-processing.
 */

export { OCREngine, getOCREngine, terminateOCREngine } from "./engine.js";
export type { OCRResult, OCRBlock, OCROptions } from "./engine.js";

export {
  postProcessOCR,
  exportDocument,
} from "./post-processor.js";
export type {
  StructuredDocument,
  PostProcessOptions,
} from "./post-processor.js";
