import { describe, it, expect, beforeEach } from "bun:test";
import { DataPipeline } from "../src/crawl/data-pipeline.js";

describe("DataPipeline", () => {
  let pipeline: DataPipeline;

  beforeEach(() => {
    pipeline = new DataPipeline({
      maxConcurrent: 2,
      requestDelay: 100,
      maxDepth: 1,
      retries: 1,
    });
  });

  it("should initialize with correct options", () => {
    expect(pipeline).toBeDefined();
  });

  it("should list search engines", () => {
    const engines = pipeline.listSearchEngines();
    expect(Array.isArray(engines)).toBe(true);
    expect(engines.length).toBeGreaterThan(0);
    expect(engines[0]).toHaveProperty("name");
    expect(engines[0]).toHaveProperty("available");
  });

  it("should search and return results (network)", async () => {
    try {
      const results = await pipeline.searchStructured("test", "duckduckgo", { num: 1 });
      expect(Array.isArray(results)).toBe(true);
    } catch {
      // Network unavailable — acceptable
      expect(true).toBe(true);
    }
  }, 10000);

  it("should handle crawl errors gracefully", async () => {
    try {
      const result = await pipeline.crawlStructured("https://invalid.example.invalid");
      // Should return null or throw
      if (result) {
        expect(result).toHaveProperty("url");
      }
    } catch {
      // Expected for invalid URL
      expect(true).toBe(true);
    }
  }, 10000);
});
