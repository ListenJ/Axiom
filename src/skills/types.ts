/**
 * Skill System Types
 *
 * Extracted from prompt-engineer.ts for shared use across the codebase.
 * Supports dynamic loading from JSON/YAML skill files.
 */

export interface PromptTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  template: string;
  variables: string[];
  tags: string[];
  thinkingIntensity: "none" | "low" | "medium" | "high";
  modelConstraints?: {
    minContextWindow?: number;
    requiresToolCalling?: boolean;
    supportsThinking?: boolean;
  };
  examples?: Array<{ input: string; output: string }>;
  version: string;
  source?: "builtin" | "file" | "hermes";
  filePath?: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  promptTemplate: string;
  requiredTools: string[];
  outputFormat: "text" | "json" | "markdown" | "code";
  version: string;
  source?: "builtin" | "file" | "hermes";
  filePath?: string;
  /** Optional: Programming language this skill targets */
  language?: string;
  /** Optional: File patterns this skill applies to (glob) */
  filePatterns?: string[];
}

export interface SkillFile {
  /** Schema version */
  version: string;
  /** Skill definitions */
  skills: SkillDefinition[];
  /** Optional prompt templates bundled with skills */
  templates?: PromptTemplate[];
  /** Metadata */
  meta?: {
    name: string;
    description: string;
    author?: string;
    tags?: string[];
  };
}

export interface PromptMatchResult {
  template: PromptTemplate;
  score: number;
  reasons: string[];
  filledPrompt?: string;
}

/**
 * 默认 skill 加载目录（2026-07-26 W3 修复：统一三处发散的列表）。
 * 所有 loader/consumer 必须引用本常量，不再各自硬编码。
 * 目录均可不存在（loader 跳过）；子目录递归加载，可用于来源命名空间隔离。
 */
export const DEFAULT_SKILL_DIRS = [
  "./skills",
  "./axiom-memory/03-Resources/skills",
  "./data/skills",
] as const;
