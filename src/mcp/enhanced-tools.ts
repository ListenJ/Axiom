/**
 * Enhanced Tool System — Public API
 *
 * Modules:
 * - ToolFactory: Adaptive tool creation from templates
 * - ToolMiddleware: Validation, mode guard, metrics, caching
 * - ToolComposition: Pipeline and parallel execution
 * - SceneRouter: Intent-based tool routing (fixed)
 */

export { toolFactory } from "./tool-factory.js";
export type { ToolSpec, GeneratedTool, ToolTemplate } from "./tool-factory.js";

export { wrapWithMiddleware, wrapAllTools, getToolMetrics, getAllMetrics } from "./tool-middleware.js";
export type { Middleware, MiddlewareContext, MiddlewareResult, ToolMetrics } from "./tool-middleware.js";

export { compositionEngine } from "./tool-composition.js";
export type { PipelineDef, PipelineStep, PipelineResult, ParallelDef } from "./tool-composition.js";

export { SceneRouter, DEFAULT_SCENES } from "./scene-router.js";
export type { Scene } from "./scene-router.js";
