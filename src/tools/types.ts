/**
 * 工具层核心类型 — 数据隔离 + 资源约束
 *
 * 每个工具在其自己的管道中执行，输入/输出严格隔离，
 * 不与其他工具共享可变状态。
 */

/** 工具执行上下文（每个请求独立） */
export interface ToolContext {
  readonly requestId: string;
  readonly startTime: number;
  /** 最大内存预算 (bytes)，超限则终止 */
  readonly maxMemoryBytes: number;
  /** 最大 CPU 预算 (ms)，超限则终止 */
  readonly maxCpuMs: number;
  /** 工具专属存储（不与其他工具交联） */
  readonly localStore: Map<string, unknown>;
}

/** 工具输入 */
export interface ToolInput<I = unknown> {
  readonly payload: I;
  readonly context: ToolContext;
}

/** 工具执行指标 */
export interface ToolMetrics {
  readonly durationMs: number;
  readonly cpuMs: number;
  readonly memoryBytes: number;
}

/** 工具输出 */
export interface ToolOutput<O = unknown> {
  readonly data: O;
  readonly metrics: ToolMetrics;
}

/** 工具接口 */
export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  /** 执行验证（同步，返回错误信息或 null） */
  validate?(input: I): string | null;
  /** 核心执行逻辑 */
  execute(input: ToolInput<I>): Promise<ToolOutput<O>>;
  /** 清理资源 */
  dispose?(): void | Promise<void>;
}

/** 工具管道编排 */
export type ToolPipeline = {
  /** 按序执行一系列工具 */
  readonly pipe: readonly Tool[];
  /** 管道名称 */
  readonly name: string;
};

/** 创建资源受限的执行上下文 */
export function createToolContext(
  requestId?: string,
  maxMemoryBytes = 50 * 1024 * 1024,  // 50MB
  maxCpuMs = 5_000,                    // 5s
): ToolContext {
  return {
    requestId: requestId ?? crypto.randomUUID(),
    startTime: Date.now(),
    maxMemoryBytes,
    maxCpuMs,
    localStore: new Map(),
  };
}

/** 创建工具输出 */
export function createToolOutput<O>(data: O, startTime: number): ToolOutput<O> {
  return {
    data,
    metrics: {
      durationMs: Date.now() - startTime,
      cpuMs: Date.now() - startTime, // simplified: wall time
      memoryBytes: process.memoryUsage?.()?.rss ?? 0,
    },
  };
}
