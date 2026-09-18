import { estimateTokens } from "../context/token-estimator.js";

export interface ToolSurfaceItem {
  name: string;
  description: string;
}

export interface ToolSurfaceMetrics {
  toolCount: number;
  serializedBytes: number;
  estimatedTokens: number;
}

export function measureToolSurface(tools: ToolSurfaceItem[]): ToolSurfaceMetrics {
  const serialized = JSON.stringify(tools);
  return {
    toolCount: tools.length,
    serializedBytes: Buffer.byteLength(serialized, "utf8"),
    estimatedTokens: estimateTokens(serialized),
  };
}

export interface LatencySummary {
  samples: number;
  averageMs: number;
  p50Ms: number;
  p90Ms: number;
}

export function summarizeLatencies(latenciesMs: number[]): LatencySummary {
  if (latenciesMs.length === 0) {
    return { samples: 0, averageMs: 0, p50Ms: 0, p90Ms: 0 };
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[index] ?? 0;
  };
  return {
    samples: sorted.length,
    averageMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: percentile(0.5),
    p90Ms: percentile(0.9),
  };
}

export function estimateToolResultTokens(text: string): number {
  return estimateTokens(text);
}