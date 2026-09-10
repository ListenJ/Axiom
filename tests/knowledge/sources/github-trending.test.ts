import { describe, it, expect, spyOn } from "bun:test"
import { formatTrendingTable } from "../../../src/knowledge/sources/github-trending.js"
import type { TrendingRepo } from "../../../src/knowledge/sources/github-trending.js"

describe("formatTrendingTable", () => {
  it("formats repos as markdown table", () => {
    const repos: TrendingRepo[] = [
      { name: "test-repo", fullName: "org/test-repo", url: "https://github.com/org/test-repo", description: "A test repo", language: "TypeScript", stars: 1000, forks: 50, starsToday: 100, topics: [], source: "api-search" },
    ]
    const table = formatTrendingTable(repos)
    expect(table).toContain("| 1 | [org/test-repo]")
    expect(table).toContain("TypeScript")
    expect(table).toContain("1000")
  })

  it("returns header for empty list", () => {
    const table = formatTrendingTable([])
    expect(table).toContain("Repository")
  })
})

describe("discoverGitHubRepos", () => {
  it("returns empty array without token (API) but will still scrape trending", async () => {
    // Mock the network so the test is deterministic (no live github.com fetch).
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("", { status: 200 })) as unknown as typeof fetch)
    try {
      const { discoverGitHubRepos } = await import("../../../src/knowledge/sources/github-trending.js")
      const repos = await discoverGitHubRepos({ limit: 3 })
      expect(Array.isArray(repos)).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
