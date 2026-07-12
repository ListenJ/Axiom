import { logger } from "../../utils/logger.js"

export interface TrendingRepo {
  name: string
  fullName: string
  url: string
  description: string
  language: string | null
  stars: number
  forks: number
  starsToday: number
  topics: string[]
  source: "trending" | "api-search"
}

/**
 * Scrape github.com/trending for daily trending repos
 */
export async function fetchGitHubTrending(language = "", since = "daily"): Promise<TrendingRepo[]> {
  const url = `https://github.com/trending${language ? `/${encodeURIComponent(language)}` : ""}?since=${since}`
  logger.info(`[GitHubTrending] Fetching ${url}`)

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  })
  if (!res.ok) {
    logger.warn(`[GitHubTrending] HTTP ${res.status}, falling back`)
    return []
  }

  const html = await res.text()
  const repos: TrendingRepo[] = []

  // Parse article.Box-row elements
  const rowRegex = /<article\s+class="Box-row"[^>]*>([\s\S]*?)<\/article>/gi
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const block = rowMatch[1]

    const nameMatch = /<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"]+)"[^>]*>[\s\S]*?<\/h2>/.exec(block)
    if (!nameMatch) continue
    const fullName = nameMatch[1].trim()
    const [org, repoName] = fullName.split("/")

    const descMatch = /<p[^>]*class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block)
    const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, "").trim() : ""

    const langMatch = /<span[^>]*itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/.exec(block)
    const language = langMatch ? langMatch[1].trim() : null

    const starMatch = /<span[^>]*class="d-inline-block float-sm-right"[^>]*>([\s\S]*?)<\/span>/.exec(block)
    const starsToday = starMatch ? parseInt(starMatch[1].replace(/[^0-9]/g, ""), 10) || 0 : 0

    repos.push({
      name: repoName ?? fullName,
      fullName,
      url: `https://github.com/${fullName}`,
      description,
      language,
      stars: 0,
      forks: 0,
      starsToday,
      topics: [],
      source: "trending",
    })
  }

  logger.info(`[GitHubTrending] Parsed ${repos.length} trending repos`)
  return repos
}

/**
 * Search GitHub API for high-potential repos (many stars, recently pushed)
 */
export async function searchHighPotentialRepos(
  opts?: { minStars?: number; maxStars?: number; language?: string; limit?: number },
): Promise<TrendingRepo[]> {
  const minStars = opts?.minStars ?? 5000
  const maxStars = opts?.maxStars ?? 50000
  const language = opts?.language
  const limit = opts?.limit ?? 25

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    logger.warn("[GitHubTrending] No GITHUB_TOKEN set, skipping API search")
    return []
  }

  let query = `stars:${minStars}..${maxStars} pushed:>2026-01-01`
  if (language) query += `+language:${encodeURIComponent(language)}`

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.min(limit, 100)}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "User-Agent": "openclaw-knowledge" },
  })
  if (!res.ok) {
    logger.warn(`[GitHubTrending] API search failed: ${res.status}`)
    return []
  }

  const data = (await res.json()) as { items: Array<{ full_name: string; html_url: string; description: string | null; language: string | null; stargazers_count: number; forks_count: number; topics: string[] }> }

  return (data.items ?? []).map((item) => ({
    name: item.full_name.split("/")[1],
    fullName: item.full_name,
    url: item.html_url,
    description: item.description ?? "",
    language: item.language,
    stars: item.stargazers_count,
    forks: item.forks_count,
    starsToday: 0,
    topics: item.topics ?? [],
    source: "api-search" as const,
  }))
}

/**
 * Combine both strategies, dedup by fullName, sort by stars
 */
export async function discoverGitHubRepos(opts?: {
  language?: string
  minStars?: number
  limit?: number
}): Promise<TrendingRepo[]> {
  const [trending, api] = await Promise.all([
    fetchGitHubTrending(opts?.language),
    searchHighPotentialRepos({ minStars: opts?.minStars ?? 5000, language: opts?.language, limit: opts?.limit }),
  ])

  const seen = new Set<string>()
  const all: TrendingRepo[] = []
  for (const repo of [...trending, ...api]) {
    if (!seen.has(repo.fullName)) {
      seen.add(repo.fullName)
      all.push(repo)
    }
  }
  return all.sort((a, b) => (b.stars || b.starsToday) - (a.stars || a.starsToday))
}

/**
 * Format trending repos as markdown table
 */
export function formatTrendingTable(repos: TrendingRepo[]): string {
  const lines = [
    "| # | Repository | Description | Language | Stars | Stars/Day |",
    "|---|------------|-------------|----------|-------|-----------|",
  ]
  repos.slice(0, 50).forEach((r, i) => {
    const desc = r.description.replace(/\|/g, "-").slice(0, 60)
    lines.push(`| ${i + 1} | [${r.fullName}](${r.url}) | ${desc} | ${r.language ?? "-"} | ${r.stars ?? "?"} | ${r.starsToday || "-"} |`)
  })
  return lines.join("\n")
}
