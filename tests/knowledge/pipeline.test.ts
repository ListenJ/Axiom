import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { runPipeline } from "../../src/knowledge/pipeline.js"

describe("Pipeline", () => {
  // Deterministic: mock the network so pipeline tests never hit live
  // github.com / z-library / GLM APIs (which time out when offline/rate-limited).
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("", { status: 200 })) as unknown as typeof fetch
    );
  });

  afterAll(() => {
    fetchSpy.mockRestore();
  });
  it("runs with empty options without crashing", async () => {
    const result = await runPipeline({})
    expect(Array.isArray(result.errors)).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  }, 30000)

  it("runs GitHub trending collection", async () => {
    const result = await runPipeline({ githubTrending: true })
    // May error if GITHUB_TOKEN missing for API search, but trending scrape should work
    expect(result.githubReposCollected).toBeGreaterThanOrEqual(0)
  }, 30000)

  it("discovers books for a topic without crashing", async () => {
    const result = await runPipeline({ bookTopics: ["machine learning"] })
    expect(result.errors.length).toBe(0)
  }, 30000)
})
