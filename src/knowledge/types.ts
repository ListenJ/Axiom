import { Database } from "bun:sqlite";
import { z } from "zod";

export interface KnowledgeSource {
  id: string;
  title: string;
  domain: 'philosophy' | 'mathematics' | 'computer-science' | 'dictionary' | 'physics' | 'books' | 'github' | 'general';
  subdomain: string;
  url: string;
  quality: number;
  storedAt: number;
}

export interface DictionaryEntry {
  word: string;
  pronunciation?: string;
  partOfSpeech: string;
  definitions: string[];
  examples?: string[];
  synonyms?: string[];
  antonyms?: string[];
  etymology?: string;
}

export interface CollectOptions {
  domain: string;
  subdomain?: string;
  maxSources?: number;
  qualityThreshold?: number;
  force?: boolean;
}

export interface CollectResult {
  domain: string;
  subdomain: string;
  searched: number;
  collected: number;
  skipped: number;
  failed: number;
  durationMs: number;
  sources: KnowledgeSource[];
}

// ============================================================================
// Task 3.1 — zod schema 验证层
//
// 这些 schema 与上述 interface 一一对应，用作运行时验证（不替换类型）。
// 在 knowledge/pipeline.ts 写入 JSONL 前调用 safeParse 做边界校验。
// ============================================================================

/** KnowledgeSource 的 zod schema（与 KnowledgeSource interface 对应） */
export const KnowledgeSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  domain: z.enum([
    "philosophy", "mathematics", "computer-science", "dictionary",
    "physics", "books", "github", "general",
  ]),
  subdomain: z.string(),
  url: z.string().url(),
  quality: z.number().min(0).max(1),
  storedAt: z.number().int().nonnegative(),
});

/** DictionaryEntry 的 zod schema（与 DictionaryEntry interface 对应） */
export const DictionaryEntrySchema = z.object({
  word: z.string().min(1),
  pronunciation: z.string().optional(),
  partOfSpeech: z.string().min(1),
  definitions: z.array(z.string().min(1)).min(1),
  examples: z.array(z.string()).optional(),
  synonyms: z.array(z.string()).optional(),
  antonyms: z.array(z.string()).optional(),
  etymology: z.string().optional(),
});

/**
 * StructureResult 的 zod schema — GLM `structureWithGLM` 返回值验证。
 *
 * 与 pipeline.ts:29-37 的 StructureResult interface 对应。
 * 导出此 schema 以便 pipeline.ts 在写入 JSONL 前做边界校验，
 * 防止 GLM 返回不完整 / 字段类型错乱的数据污染 dataset。
 */
export const StructuredKnowledgeSchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  keywords: z.array(z.string()).default([]),
  quality_score: z.number().min(0).max(1).default(0),
  sections: z.array(z.object({
    heading: z.string(),
    content: z.string(),
  })).default([]),
  entities: z.array(z.object({
    name: z.string(),
    type: z.string(),
  })).default([]),
  structured_data: z.unknown().nullable().default(null),
});

/** 通过 StructuredKnowledgeSchema 校验后的类型 */
export type StructuredKnowledge = z.infer<typeof StructuredKnowledgeSchema>;
