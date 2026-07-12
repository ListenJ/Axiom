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
    expect(result.errors).toBeArray()
    expect(result.durationMs).toBeGreaterThan(0)
  })

  it("runs GitHub trending collection", async () => {
    const result = await runPipeline({ githubTrending: true })
    expect(result.errors.length).toBe(0)
  })

  it("discovers books for a topic without crashing", async () => {
    const result = await runPipeline({ bookTopics: ["machine learning"] })
    expect(result.errors.length).toBe(0)
  })
})
