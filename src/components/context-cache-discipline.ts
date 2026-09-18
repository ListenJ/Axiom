import { createHash } from "node:crypto";
import { estimateTokens } from "../context/token-estimator.js";

export interface CacheDisciplineTool {
  name: string;
  description: string;
}

export interface CacheDisciplineInput {
  identity: string;
  toolSurface: CacheDisciplineTool[];
  skillIds?: string[];
}

export interface CacheDisciplineMetrics {
  stablePrefix: string;
  stablePrefixBytes: number;
  stablePrefixTokens: number;
  stableHash: string;
  toolCount: number;
  skillCount: number;
}

export interface CacheHitSummary {
  hits: number;
  misses: number;
  hitRate: number;
}

export function buildCacheDiscipline(input: CacheDisciplineInput): CacheDisciplineMetrics {
  const tools = [...input.toolSurface]
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const skills = [...new Set(input.skillIds ?? [])].sort((a, b) => a.localeCompare(b));
  const stablePrefix = JSON.stringify({
    identity: input.identity,
    tools,
    skills,
  });
  return {
    stablePrefix,
    stablePrefixBytes: Buffer.byteLength(stablePrefix, "utf8"),
    stablePrefixTokens: estimateTokens(stablePrefix),
    stableHash: createHash("sha256").update(stablePrefix).digest("hex"),
    toolCount: tools.length,
    skillCount: skills.length,
  };
}

export function summarizeCacheHits(hits: number, misses: number): CacheHitSummary {
  const total = hits + misses;
  return {
    hits,
    misses,
    hitRate: total > 0 ? Math.round((hits / total) * 1000) / 1000 : 0,
  };
}