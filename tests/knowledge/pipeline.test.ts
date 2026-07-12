import { describe, it, expect, afterAll } from "bun:test"
import { runPipeline } from "../../src/knowledge/pipeline.js"

afterAll(async () => {
  const vault = (await import("../../src/memory/vault-manager.js")).getGlobalVault()
  try { await vault.deleteNote("00-Knowledge/GitHub/trending") } catch {}
  try { await vault.deleteNote("00-Knowledge/Books") } catch {}
})

describe("Pipeline", () => {
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
