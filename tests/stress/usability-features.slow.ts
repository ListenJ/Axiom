/**
 * Tests for usability features: typed errors, health check, presets.
 */

import { describe, test, expect } from "bun:test";
import {
  DREError,
  DREValidationError,
  DREResourceError,
  DREPipelineError,
  DRELLMError,
  DREConsistencyError,
  DRETaskError,
  wrapDREError,
  PRESETS,
  LLM_PRESETS,
} from "../../src/dre/index.js";

// ========== Typed Errors ==========

describe("DRE Error Hierarchy", () => {
  test("each error subclass has correct code and name", () => {
    const validation = new DREValidationError("bad input");
    expect(validation.code).toBe("VALIDATION_ERROR");
    expect(validation.name).toBe("DREValidationError");
    expect(validation).toBeInstanceOf(DREError);
    expect(validation).toBeInstanceOf(Error);

    const resource = new DREResourceError("out of memory");
    expect(resource.code).toBe("RESOURCE_ERROR");

    const pipeline = new DREPipelineError("prefilter failed", "prefilter");
    expect(pipeline.code).toBe("PIPELINE_ERROR");
    expect(pipeline.stage).toBe("prefilter");
    expect(pipeline.context?.stage).toBe("prefilter");

    const llm = new DRELLMError("fetch failed", true);
    expect(llm.code).toBe("LLM_ERROR");
    expect(llm.retriable).toBe(true);

    const consistency = new DREConsistencyError("atom mismatch");
    expect(consistency.code).toBe("CONSISTENCY_ERROR");

    const task = new DRETaskError("deadline exceeded", "task_123");
    expect(task.code).toBe("TASK_ERROR");
    expect(task.taskId).toBe("task_123");
  });

  test("toJSON serializes structured error info", () => {
    const err = new DREPipelineError("stage 2 failed", "verification", { nodeId: "n1" });
    const json = err.toJSON();
    expect(json.name).toBe("DREPipelineError");
    expect(json.code).toBe("PIPELINE_ERROR");
    expect(json.message).toBe("stage 2 failed");
    expect((json.context as Record<string, unknown>)?.stage).toBe("verification");
    expect((json.context as Record<string, unknown>)?.nodeId).toBe("n1");
  });

  test("wrapDREError preserves DREError instances", () => {
    const original = new DREValidationError("already typed");
    const wrapped = wrapDREError(original);
    expect(wrapped).toBe(original); // same reference
  });

  test("wrapDREError classifies generic errors heuristically", () => {
    const network = wrapDREError(new Error("fetch failed: connection refused"));
    expect(network).toBeInstanceOf(DRELLMError);
    expect((network as DRELLMError).retriable).toBe(true);

    const validation = wrapDREError(new Error("field 'x' is required"));
    expect(validation).toBeInstanceOf(DREValidationError);

    const unknown = wrapDREError(new Error("something weird"));
    expect(unknown).toBeInstanceOf(DREError);
    expect(unknown.code).toBe("UNKNOWN");
  });

  test("wrapDREError handles non-Error values", () => {
    const wrapped = wrapDREError("string error");
    expect(wrapped).toBeInstanceOf(DREError);
    expect(wrapped.code).toBe("UNKNOWN");
    expect(wrapped.context?.original).toBe("string error");
  });

  test("callers can catch by category", () => {
    function classify(err: unknown): string {
      const e = wrapDREError(err);
      if (e instanceof DREValidationError) return "validation";
      if (e instanceof DREResourceError) return "resource";
      if (e instanceof DREPipelineError) return "pipeline";
      if (e instanceof DRELLMError) return "llm";
      return "other";
    }

    expect(classify(new Error("input is required"))).toBe("validation");
    expect(classify(new Error("fetch timeout"))).toBe("llm");
    expect(classify(new Error("unknown"))).toBe("other");
  });
});

// ========== Presets ==========

describe("DRE Presets", () => {
  test("minimal() returns in-memory config with no LLM", () => {
    const config = PRESETS.minimal();
    expect(config.dbPath).toBe(":memory:");
    expect(config.mainLLM.model).toBe("none");
    expect(config.workingMemoryCapacity).toBe(8);
  });

  test("standard() returns local model config with overridable paths", () => {
    const config = PRESETS.standard({ dbPath: "/tmp/test.db" });
    expect(config.dbPath).toBe("/tmp/test.db");
    expect(config.mainLLM.baseUrl).toBe("http://localhost:11434");
    expect(config.workingMemoryCapacity).toBe(16);
  });

  test("production() requires dbPath and sets up discriminLLM", () => {
    const config = PRESETS.production({
      dbPath: "/var/lib/dre/prod.db",
      apiKey: "sk-test",
    });
    expect(config.dbPath).toBe("/var/lib/dre/prod.db");
    expect(config.mainLLM.apiKey).toBe("sk-test");
    expect(config.discriminLLM).toBeDefined();
    expect(config.workingMemoryCapacity).toBe(32);
  });

  test("research() has large memory and long TTL", () => {
    const config = PRESETS.research();
    expect(config.workingMemoryCapacity).toBe(64);
    expect(config.episodicTTL).toBe(86400000); // 24 hours
  });

  test("presets are overridable via spread", () => {
    const config = {
      ...PRESETS.standard(),
      workingMemoryCapacity: 100,
    };
    expect(config.workingMemoryCapacity).toBe(100);
    expect(config.dbPath).toBe("./dre.db"); // preserved from preset
  });

  test("LLM_PRESETS produce valid configs", () => {
    const local = LLM_PRESETS.local("qwen3:8b");
    expect(local.model).toBe("qwen3:8b");
    expect(local.baseUrl).toBe("http://localhost:11434");
    expect(local.retry?.maxRetries).toBe(2);

    const cloud = LLM_PRESETS.cloud("gpt-4o", "sk-test");
    expect(cloud.model).toBe("gpt-4o");
    expect(cloud.retry?.maxRetries).toBe(3);

    const none = LLM_PRESETS.none();
    expect(none.retry?.maxRetries).toBe(0);
  });
});
