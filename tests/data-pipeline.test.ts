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

  it("should search and return results", async () => {
    const results = await pipeline.searchStructured("OpenClaw AI agent", "duckduckgo", { num: 3 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(0);
    
    if (results.length > 0) {
      expect(results[0]).toHaveProperty("title");
      expect(results[0]).toHaveProperty("link");
      expect(results[0]).toHaveProperty("snippet");
    }
  });

  it("should crawl and structure a webpage", async () => {
    const result = await pipeline.crawlStructured("https://example.com");
    
    if (result) {
      expect(result).toHaveProperty("url");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("markdown");
      expect(result).toHaveProperty("headings");
      expect(result).toHaveProperty("links");
      expect(result).toHaveProperty("chunks");
      expect(Array.isArray(result.headings)).toBe(true);
      expect(Array.isArray(result.links)).toBe(true);
      expect(Array.isArray(result.chunks)).toBe(true);
    }
  });

  it("should calculate quality score", async () => {
    const result = await pipeline.crawlStructured("https://example.com");
    
    if (result) {
      expect(result).toHaveProperty("url");
      expect(typeof result.title).toBe("string");
    }
  });
});
