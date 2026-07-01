/**
 * axiom-runtime/memory — 记忆模块统一导出
 *
 * 基于数学原理的记忆系统，包含信息瓶颈压缩、共形预测检索、
 * 幻觉检测和确定性搜索等核心能力。
 *
 * 模块一览:
 *   MathEnhancedMemory         — 统一记忆管线（压缩 + 检索 + 验证）
 *   VIBCompressor             — 变分信息瓶颈记忆压缩器
 *   ConformalRetriever       — 共形预测检索器
 *   ConformalHallucinationDetector — 共形预测幻觉检测器
 *   DeterministicSearchEngine — 确定性记忆搜索引擎
 */

// ============================================================================
// MathEnhancedMemory — 统一记忆管线
// ============================================================================
export {
  MathEnhancedMemory,
  type MathEnhancedMemoryConfig,
  type ProcessContentResult,
  type MemoryPipelineStats,
} from "./math-enhanced-memory.js";
export { default as MathEnhancedMemoryDefault } from "./math-enhanced-memory.js";

// ============================================================================
// VIBCompressor — 变分信息瓶颈压缩器
// ============================================================================
export {
  VIBCompressor,
  type MemoryItem,
  type CompressedResult,
  type CompressionStats,
  type VIBConfig,
} from "./vib-compressor.js";
export { default as VIBCompressorDefault } from "./vib-compressor.js";

// ============================================================================
// ConformalRetriever — 共形预测检索器
// ============================================================================
export {
  ConformalRetriever,
  type CalibrationPair as RetrieverCalibrationPair,
  type ConformalResult,
  type ConformalRetrieverConfig,
} from "./conformal-retriever.js";
export { default as ConformalRetrieverDefault } from "./conformal-retriever.js";

// ============================================================================
// ConformalHallucinationDetector — 幻觉检测器
// ============================================================================
export {
  ConformalHallucinationDetector,
  type FactEntry,
  type HallucinationVerdict,
  type HallucinationDetectorConfig,
  type CalibrationPair as HallucinationCalibrationPair,
  type CalibrationQuality,
  type EvidenceItem,
} from "./hallucination-detector.js";
export { default as ConformalHallucinationDetectorDefault } from "./hallucination-detector.js";

// ============================================================================
// DeterministicSearchEngine — 确定性搜索引擎
// ============================================================================
export {
  DeterministicSearchEngine,
  type VaultNote,
  type SearchResult,
} from "./deterministic-search.js";
export { default as DeterministicSearchEngineDefault } from "./deterministic-search.js";
