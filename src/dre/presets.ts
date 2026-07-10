/**
 * DRE Presets — Quick-start factory configurations.
 *
 * Inspired by CrewAI's `Crew()` and Pydantic AI's `Agent()`: instead of
 * constructing a 15-field DREConfig by hand, users pick a preset and
 * override only what they need.
 *
 * Usage:
 *   import { createDRE, PRESETS } from "./dre";
 *
 *   // Minimal: in-memory DB, no LLM, for testing
 *   const engine = createDRE(PRESETS.minimal());
 *
 *   // Standard: local model, SQLite, common defaults
 *   const engine = createDRE(PRESETS.standard({ dbPath: "./data.db" }));
 *
 *   // With overrides
 *   const engine = createDRE({
 *     ...PRESETS.standard(),
 *     mainLLM: { model: "qwen3-1.7b", baseUrl: "http://localhost:11434" },
 *   });
 */

import { readString } from "../utils/env.js";
import type { DREConfig } from "./engine.js";
import type { LLMConfig } from "./llm/client.js";

/** Common LLM configurations. */
export const LLM_PRESETS = {
  /** No LLM — for storage/knowledge tests that don't need inference. */
  none: () => ({
    model: "none",
    baseUrl: "http://127.0.0.1:1",
    retry: { maxRetries: 0 },
  }),

  /** Local Ollama with Qwen3 1.7B — free, private, medium quality. */
  local: (model = "qwen3:1.7b") => ({
    model,
    baseUrl: "http://localhost:11434",
    retry: { maxRetries: 2 },
  }),

  /** OpenAI-compatible cloud API — highest quality, costs money. */
  cloud: (model = "gpt-4o-mini", apiKey?: string) => ({
    model,
    baseUrl: "https://api.openai.com/v1",
    apiKey: apiKey ?? readString("OPENAI_API_KEY"),
    retry: { maxRetries: 3 },
  }),
} as const;

/**
 * Preset configurations for common use cases.
 * Each returns a complete DREConfig; spread + override to customize.
 */
export const PRESETS = {
  /**
   * Minimal preset: in-memory DB, no LLM, small memory.
   * Use for: unit tests, CI, quick experiments.
   */
  minimal(): DREConfig {
    return {
      dbPath: ":memory:",
      mainLLM: LLM_PRESETS.none() as LLMConfig,
      workingMemoryCapacity: 8,
      episodicTTL: 60000,
    };
  },

  /**
   * Standard preset: local SQLite DB, local Ollama model, common defaults.
   * Use for: local development, personal projects.
   */
  standard(opts?: { dbPath?: string; model?: string }): DREConfig {
    return {
      dbPath: opts?.dbPath ?? "./dre.db",
      mainLLM: LLM_PRESETS.local(opts?.model) as LLMConfig,
      workingMemoryCapacity: 16,
      episodicTTL: 3600000,
      cloudFallback: undefined,
    };
  },

  /**
   * Production preset: persistent DB, cloud LLM with local fallback.
   * Use for: deployed services, shared environments.
   */
  production(opts: {
    dbPath: string
    apiKey?: string
    model?: string
    cloudFallback?: { baseUrl: string; apiKey?: string; model: string }
  }): DREConfig {
    return {
      dbPath: opts.dbPath,
      mainLLM: LLM_PRESETS.cloud(opts.model, opts.apiKey) as LLMConfig,
      discriminLLM: LLM_PRESETS.local() as LLMConfig,
      workingMemoryCapacity: 32,
      episodicTTL: 7200000,
      cloudFallback: opts.cloudFallback,
    };
  },

  /**
   * Research preset: large memory, long TTL, no retry limits.
   * Use for: batch processing, experiments, data analysis.
   */
  research(opts?: { dbPath?: string; model?: string }): DREConfig {
    return {
      dbPath: opts?.dbPath ?? "./research.db",
      mainLLM: LLM_PRESETS.local(opts?.model) as LLMConfig,
      workingMemoryCapacity: 64,
      episodicTTL: 86400000,
    };
  },
} as const;
