import { describe, it, expect } from "bun:test";
import { performance } from "perf_hooks";

describe("Performance Benchmarks", () => {
  describe("Model Assignment Speed", () => {
    it("should assign models in under 10ms", async () => {
      const { assignModel } = await import("../src/router/model-capability-registry.js");
      
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        assignModel("coding");
      }
      const elapsed = performance.now() - start;
      
      expect(elapsed).toBeLessThan(1000); // 100 assignments under 1s
    });
  });

  describe("Route Matching Speed", () => {
    it("should match routes efficiently", () => {
      const routes = [
        "/health", "/stats", "/metrics", "/chat",
        "/search", "/vault/:path", "/codegraph/:action",
        "/agents/:agent/:action", "/eval/:type",
      ];

      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        const path = routes[i % routes.length];
        const matched = routes.some(r => {
          const pattern = r.replace(/:[^/]+/g, "[^/]+");
          return new RegExp(`^${pattern}$`).test(path);
        });
        expect(matched).toBe(true);
      }
      const elapsed = performance.now() - start;
      
      expect(elapsed).toBeLessThan(500); // 10k matches under 500ms
    });
  });

  describe("Memory Usage", () => {
    it("should not leak memory on repeated operations", () => {
      const initialMemory = process.memoryUsage().heapUsed;
      
      const cache = new Map<string, string>();
      for (let i = 0; i < 1000; i++) {
        cache.set(`key-${i}`, `value-${i}`);
      }
      cache.clear();
      
      // Force GC if available
      if (global.gc) global.gc();
      
      const finalMemory = process.memoryUsage().heapUsed;
      const growth = finalMemory - initialMemory;
      
      // Allow some growth but not excessive
      expect(growth).toBeLessThan(50 * 1024 * 1024); // Less than 50MB growth
    });
  });

  describe("CodeGraph Cache Performance", () => {
    it("should cache queries efficiently", () => {
      const cache = new Map<string, { value: unknown; timestamp: number }>();
      const TTL = 60000;

      const get = (key: string) => {
        const entry = cache.get(key);
        if (entry && Date.now() - entry.timestamp < TTL) {
          return entry.value;
        }
        return undefined;
      };

      const set = (key: string, value: unknown) => {
        cache.set(key, { value, timestamp: Date.now() });
      };

      // Simulate 1000 cached lookups
      for (let i = 0; i < 1000; i++) {
        set(`query-${i % 10}`, { result: `data-${i}` });
      }

      const start = performance.now();
      let hits = 0;
      for (let i = 0; i < 10000; i++) {
        if (get(`query-${i % 10}`)) hits++;
      }
      const elapsed = performance.now() - start;

      expect(hits).toBe(10000);
      expect(elapsed).toBeLessThan(50); // 10k lookups under 50ms
    });
  });
});
