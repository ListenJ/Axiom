/**
 * Tools barrel — 工具抽象层
 *
 * 提供资源受限、数据隔离的 read/write/query 基元。
 * 每个工具在其独立管道中执行，不与其他工具共享可变状态。
 */
export { readTool, type ReadInput, type ReadOutput } from "./read-tool.js";
export { writeTool, type WriteInput, type WriteOutput } from "./write-tool.js";
export { queryTool, type QueryInput, type QueryOutput, type QueryResult } from "./query-tool.js";
export { runPipeline, type PipelineStep, type PipelineResult } from "./pipeline.js";
export type {
  Tool, ToolContext, ToolInput, ToolOutput, ToolMetrics, ToolPipeline,
} from "./types.js";
export { createToolContext, createToolOutput } from "./types.js";
