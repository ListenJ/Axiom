# Deep Code Review: Knowledge Network Modules

**Date:** 2026-07-14  
**Scope:** 8 files across `src/knowledge/`, `src/workers/`, and `src/crawl/`  
**Reviewer:** Automated deep review

---

## Files Reviewed

| # | File | Lines | Role |
|---|------|-------|------|
| 1 | `src/knowledge/pipeline.ts` | 193 | Knowledge pipeline orchestrator |
| 2 | `src/knowledge/sources/github-trending.ts` | 159 | GitHub trending scraper + API search |
| 3 | `src/knowledge/sources/z-library.ts` | 119 | Open-book discovery (Gutenberg, arXiv, OpenStax) |
| 4 | `src/knowledge/store.ts` | 288 | SQLite knowledge store |
| 5 | `src/knowledge/collector.ts` | 233 | Knowledge collector + Wiktionary parser |
| 6 | `src/knowledge/searcher.ts` | 155 | Knowledge searcher with curated + web results |
| 7 | `src/workers/pdf-worker.ts` | 60 | PDF worker HTTP client |
| 8 | `src/crawl/search-engines.ts` | 308 | Multi-engine search abstraction (DDG, Bing, SearXNG) |

---

## 1. `src/knowledge/pipeline.ts` — Knowledge Pipeline Orchestrator

### Summary

The pipeline orchestrates GitHub trending collection, book discovery, PDF conversion, and optional GLM-based content structuring. It's well-structured with clear sequential phases, but has several correctness and performance concerns.

### Issues

#### Critical

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 1 | 166–171 | **Race condition on JSONL append.** When multiple topics are processed concurrently (or the pipeline is invoked while a previous run is still writing), `appendFileSync` appends to the same `${safeTopic}.jsonl` file. If the same topic runs concurrently, interleaved writes could corrupt the file. | Use a write lock per topic file, or collect all structured results and write them in batch after the loop. Alternatively, use an async append with a queue. |
| 2 | 64 | **`JSON.parse(content)` without try/catch around parse.** If the GLM API returns malformed JSON (e.g., truncated response, markdown fences around JSON), the `structureWithGLM` function will throw an unhandled error at line 66. The outer try/catch on line 67 catches it, but the error message ("GLM structuring failed") is opaque. | Add a dedicated try/catch around `JSON.parse` with a specific warning message. Consider stripping markdown code fences before parsing: `content.replace(/^```(?:json)?\s*\|?\s*```$/gm, '').trim()`. |
| 3 | 52 | **`rawMarkdown.slice(0, 16_000)` can split multi-byte UTF-8 characters.** JavaScript `.slice()` operates on UTF-16 code units, not code points. A character like `💡` (U+1F4A1) is 2 UTF-16 code units. Slicing at 16,000 could split a surrogate pair, producing invalid Unicode. GLM may return malformed JSON when fed broken UTF-16. | Use `Array.from(rawMarkdown).slice(0, 16_000).join('')` or use a library that counts by grapheme clusters. Alternatively, adjust to a safer margin (e.g., 15,900) and re-encode. |

#### Warning

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 4 | 67 | **No retry on GLM API failure.** A transient network error or rate-limit response causes the structured data to be silently lost for that document. | Add exponential backoff retry (2–3 attempts) for transient errors (429, 5xx). |
| 5 | 124–188 | **Sequential topic processing.** Book topics are processed one at a time in a `for...of` loop. With many topics, this adds unnecessary wall-clock time since each topic's I/O is independent. | Use `Promise.all` with a concurrency limiter (e.g., `p-limit` or a simple semaphore) to process topics with limited parallelism. |
| 6 | 152–179 | **Sequential PDF conversion per topic.** Books within a topic are converted one at a time (`for (const book of books.slice(0, 3))`). Each conversion involves a HTTP submit + polling loop that can take up to 2 minutes. | Parallelize PDF conversions with a concurrency limit of 2–3. |
| 7 | 108 | **`formatTrendingTable(repos).slice(0, 50)` — external slice duplicates `formatTrendingTable`'s own slice.** The `formatTrendingTable` function (in github-trending.ts:154) already slices to 50. Slicing again in the caller is redundant. | Remove the caller-side slice; the formatting function already limits. |
| 8 | 112 | **Hardcoded vault path prefix `00-Knowledge/GitHub/trending/`.** If the vault structure is ever reorganized, this path will be wrong. | Make the vault path configurable or derive it from constants/enum. |
| 9 | 148–180 | **Dynamic imports inside hot loop.** `import("../workers/pdf-worker.js")`, `import("path")`, `import("fs")` are dynamically imported inside the book loop. While subsequent calls are cached, the first call per execution adds latency. | Move static imports to the top of the file. |

#### Info

| # | Line(s) | Issue |
|---|---------|-------|
| 10 | 38–71 | The `structureWithGLM` function is well-isolated with clear early-exit on missing API key. Good defensive pattern. |
| 11 | 73–91 | `PipelineOptions` and `PipelineResult` interfaces are well-typed and cover all relevant metrics. |
| 12 | 96–192 | The pipeline has good overall structure with clear phases, comprehensive error collection, and logging. |

---

## 2. `src/knowledge/sources/github-trending.ts` — GitHub Trending Scraper

### Summary

Dual-strategy repo discovery: scrapes `github.com/trending` HTML and queries the GitHub search API. Results are deduplicated and sorted. The file is clean and well-commented.

### Issues

#### Warning

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 1 | 93 | **Hardcoded date `2026-01-01` in API query.** `pushed:>2026-01-01` will become stale after January 2026, returning zero results. | Compute a relative date: ``new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10)`` (6 months ago). |
| 2 | 41, 46, 49, 52, 55 | **Regex-based HTML parsing of GitHub trending is fragile.** GitHub frequently changes their markup. A layout change (class names, element structure) will silently return zero results with only a vague warning log. | Consider (a) adding a structural validation step that checks for expected patterns and warns if the page structure appears to have changed, or (b) using the unofficial GitHub trending API (e.g., `gh trending` CLI). |
| 3 | 52–53 | **`starsToday` regex is overly broad.** The pattern `/[\s\S]*?<\/svg>([\s\S]*?)<\/span>/` matches any content between `</svg>` and the next `</span>`. If the HTML contains an SVG icon followed by non-star content, it could capture the wrong number. | Tighten the selector context. Match the specific star icon context (e.g., look for the "star" SVG icon class). |
| 4 | 87–91 | **Silent fallback on missing GITHUB_TOKEN.** `searchHighPotentialRepos` returns `[]` without even a warning about the missed opportunity. | Log at `info` level that the API search is skipped due to missing token, so operators know they could get better results by configuring it. |

#### Info

| # | Line(s) | Issue |
|---|---------|-------|
| 5 | 130–133 | `discoverGitHubRepos` runs both strategies concurrently via `Promise.all`. Good use of parallelism. |
| 6 | 125–143 | Dedup logic via `Set<string>` is simple and correct. First-occurrence-wins (trending > API) is sensible. |
| 7 | 149–158 | `formatTrendingTable` properly sanitizes pipes in descriptions to avoid markdown table corruption. |

---

## 3. `src/knowledge/sources/z-library.ts` — Open Book Discovery

### Summary

Discovers books from Project Gutenberg, arXiv, and OpenStax by scraping search result pages. Results are deduplicated and sorted by quality.

### Issues

#### Warning

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 1 | 110–113 | **`getPdfUrl` for Gutenberg is unnecessarily confusing.** The first replace `/\/ebooks\//` → `"/ebooks/"` is a no-op (replaces the string with itself). The intent was to append `.pdf`. | Simplify to `return \`${book.url}.pdf\`` for Gutenberg. |
| 2 | 47–50 | **OpenStax parser is a stub returning `[]`.** The parser exists but returns nothing. This silently produces no results for OpenStax with no log indicating the source is unimplemented. | Either implement the parser, remove the source entry entirely, or add a `logger.warn` on construction/usage indicating it's a stub. |
| 3 | 78 | **Non-null assertion `opts.sources!` is unnecessary.** The guard `opts?.sources ? ... filter ... : OPEN_BOOK_SOURCES` already narrows the type, making `!` redundant. | Use `opts.sources.includes(s.id)` without the assertion after the ternary guard. |
| 4 | 82–105 | **Sequential source iteration.** Each book source is queried one at a time. All source queries are independent and could be parallelized. | Use `Promise.all` with the active sources to reduce wall-clock time. |
| 5 | 96–100 | **Per-call dedup only.** `seenUrls` is scoped to a single `discoverBooks` call. If the same book appears for two different queries, it will be processed twice. | This may be intentional, but if the `pipeline.ts` caller loops over topics, the same book URL could be saved as a knowledge source multiple times (though the DB uses `INSERT OR IGNORE`). |

#### Info

| # | Line(s) | Issue |
|---|---------|-------|
| 6 | 14–75 | The source registry pattern (list of `{ id, name, searchUrl, parser }`) is clean and extensible. Adding a new source is straightforward. |
| 7 | 77–108 | Good error isolation: a failure in one source doesn't block others. |
| 8 | 107 | Results sorted by quality descending. Sensible default. |

---

## 4. `src/knowledge/store.ts` — SQLite Knowledge Store

### Summary

Core persistence layer using `bun:sqlite` with WAL mode, FTS5 full-text search, and a singleton accessor. Parameterized queries are used throughout, preventing SQL injection in the primary queries.

### Issues

#### Critical

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 1 | 166–172 | **FTS5 query injection vulnerability.** The `searchDictionary` method constructs an FTS5 query by wrapping user words in quotes and appending `*`: `.map((w) => \`"${w}"*\`)`. If a user provides a word containing a double-quote (e.g., `" OR *`), it breaks out of the quoted term and can inject arbitrary FTS5 syntax. While FTS5 injection is limited to search manipulation (not arbitrary SQL execution), an attacker could craft queries that return unrelated data or cause expensive searches. | Sanitize input by removing/rejecting characters that have special meaning in FTS5 syntax (`"`, `*`, `(`, `)`, `OR`, `AND`, `NOT`, `+`, `-`, `~`). Alternatively, use `fts5`'s `rank` normalization or use simple `LIKE` for untrusted input. |
| 2 | 173, 181 | **`query(...)` with dynamic `ftsQuery` uses parameterized `?` for the FTS match string — but the string itself is constructed unsafely.** The `?` parameter binding correctly prevents SQL injection, but the *content* of that parameter is an FTS5 query string built from user input, which is a second-order injection vector into FTS5 itself. | Same fix as above — sanitize before building the FTS5 expression. |

#### Warning

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 3 | 14–15 | **Database path resolved from env var with a fallback to `./data/knowledge.db`.** If the `data/` directory doesn't exist, Bun will throw an error because `bun:sqlite` doesn't auto-create parent directories. | Use `mkdirSync(path.dirname(resolvedPath), { recursive: true })` before opening the database. |
| 4 | 14 | **DB instance stored with `close()` method exposed but never called.** The singleton is never closed in normal operation. Over long-running processes with heavy write loads, WAL file can grow unbounded. | Add periodic `checkpoint` calls (`PRAGMA wal_checkpoint(PASSIVE)`) or expose a graceful shutdown hook. |
| 5 | 250–253 | **`generateId` uses `Bun.hash(url)` which returns a `number`/`bigint`, then converts to `Number`.** On 64-bit systems, `Bun.hash` returns a 64-bit value, and converting to `Number` can lose precision for very large hashes, potentially causing collisions. | Use the first 8 bytes of a hex string from a proper hash (e.g., `Bun.hash(url).toString(36).slice(0, 12)`) to avoid floating-point rounding. |
| 6 | 255–265 | **`rowToSource` casts `row.domain` to a union type without validation.** If a row contains a domain value not in the union (e.g., from a future migration), the cast silently succeeds and the invalid value flows through the system. | Validate against the known domain list at the read boundary, or widen the type and use runtime checks at consumption points. |
| 7 | 86, 150 | **`getSourceByUrl` and `isCollected` issue separate queries for the same check.** `isCollected(url)` followed by `getSourceByUrl(url)` would query the database twice. Callers in `collector.ts` only use `isCollected`, but the pattern could be optimized. | Minor — consider merging or documenting. |
| 8 | 199–230 | **`storeAsVaultNote` fails silently if the vault note write fails but the DB save succeeds.** If `vault.writeNote` throws, the `saveSource` call on line 219 won't execute (due to the thrown error propagating up). But if `saveSource` fails (unlikely, but possible with `INSERT OR IGNORE`), the vault note has already been written — creating an orphan note. | Consider wrapping in a transaction or adding compensation logic. |

#### Info

| # | Line(s) | Issue |
|---|---------|-------|
| 9 | 1–7 | Clean imports, proper use of `bun:sqlite` type imports from the types file. |
| 10 | 16–17 | WAL mode + NORMAL synchronous mode is a good default for read-heavy workloads. |
| 11 | 21–79 | Schema initialization is thorough with indexes and an FTS5 virtual table + trigger. |
| 12 | 81–84 | `isCollected` is used as a fast-path check in the collector — good pattern. |
| 13 | 283–288 | Singleton pattern is simple and correct for single-threaded JS. |

---

## 5. `src/knowledge/collector.ts` — Knowledge Collector

### Summary

Collects web content for a given domain/subdomain, validates quality, and stores results as vault notes. Includes a Wiktionary-based dictionary word collector.

### Issues

#### Critical

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 1 | 96 | **ID computation duplicated with `store.ts`.** The collector computes `id: \`know_${Math.abs(Number(Bun.hash(result.link))).toString(36)}\`` independently, while `store.ts`'s `storeAsVaultNote` → `saveSource` → `generateId` computes the same value. This duplicated logic will drift if one changes and the other doesn't. | Have `storeAsVaultNote` return the generated ID (or the full source record) so the collector doesn't need to recompute it. |
| 2 | 206–216 | **Wiktionary HTML parser is dangerously broad.** The regex `/<li[^>]*>([\s\S]*?)<\/li>/gi` matches **every** `<li>` element on the entire Wiktionary page — navigation bars, side panels, footers, related terms, see-also sections, etc. It then filters by `text.length > 10`, but this still captures a large amount of irrelevant content. For a word like "set" (which has dozens of definitions across multiple languages), the parser will return noise. | Scope parsing to the English section only (look for `<span class="mw-headline" id="English">`), and target definition-specific `<li>` elements within that section's definition list (`<ol>` or `<dl>`). |
| 3 | 150–151 | **`proxyFetch(url)` used without timeout.** If Wiktionary is slow or unreachable, the request could hang indefinitely. | Add a timeout signal (e.g., `AbortSignal.timeout(15_000)`). |

#### Warning

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 4 | 66–112 | **Sequential crawl + store loop.** Search results are processed one at a time: crawl, validate, store. With `maxSources` up to 5, this is reasonable, but each crawl can take seconds. | Consider using a small concurrent pool (2–3 at a time) for crawling, with a shared counter for `collected >= maxSources` to stop early. |
| 5 | 69 | **`isCollected` check before crawling.** This checks the DB for each URL before crawling. For large search result sets (up to 30 URLs per domain), this is 30+ DB queries. | Batch the `isCollected` check: query all known URLs for the domain in one query and check against a Set. |
| 6 | 27–25 | **`validateContent` function uses global regex flags (`/g`, `/m`) on non-global methods.** `hasHeadings` uses `/^#{1,6}\s+/m` (multiline) with `.test()` — this is correct. But `hasCode` uses `/[\s\S]*?/g` with `.test()` — the global flag on `.test()` causes the regex to advance `lastIndex` on subsequent calls. If `validateContent` is called on different strings in sequence with the same global regex... wait, the regex is recreated each function call because it's a literal, so `lastIndex` resets. This is fine. |
| 7 | 148 | **`proxyFetch(url)` — the URL is constructed with `encodeURIComponent(word)` which is correct for Wiktionary URLs.** No issue here. |

#### Info

| # | Line(s) | Issue |
|---|---------|-------|
| 8 | 10–25 | `validateContent` is a well-structured heuristic quality scorer with clear weighting. |
| 9 | 32–56 | Recursive subdomain expansion is a clean pattern. |
| 10 | 131–191 | `collectDictionaryWords` is well-isolated with clear skip/fail accounting. |

---

## 6. `src/knowledge/searcher.ts` — Knowledge Searcher

### Summary

Curated resource database with live web search fallback. Provides domain/subdomain source discovery and dictionary search.

### Issues

#### Warning

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 1 | 12–77 | **Curated URLs may become stale.** The `KNOWN_RESOURCES` map contains hardcoded URLs to textbooks and courses. If any of these sites restructure, URLs will 404. There is no link-verification mechanism. | Add a periodic or on-use link-checking mechanism (HEAD requests) that logs stale URLs. Alternatively, add a `lastVerified` timestamp to each entry. |
| 2 | 121 | **Silent catch swallows all search failures.** `catch { /* ignore search failures */ }` discards the error with no logging. If DuckDuckGo is rate-limiting or returning errors, the operator has no visibility. | Log at `debug` or `warn` level with the error message. |
| 3 | 112–122 | **Hardcoded to DuckDuckGo only.** `searchAggregator.searchMulti` is called with `["duckduckgo"]` — the multi-engine capability is unused. | Either use more engines (with fallback) or make the engine list configurable. |
| 4 | 108 | **Queries hardcoded to `" textbook " + domain`.** For philosophy subjects (ethics, logic), "textbook" may not be the best qualifier. Encyclopedia or "introduction" might be more appropriate. | Make the query template configurable per domain or subdomain. |
| 5 | 114 | **Quality score hardcoded to `0.6` for web results.** All web search results get the same quality score regardless of actual content quality. | Consider adjusting quality based on the source domain, or perform a quick validation crawl to score dynamically. |

#### Info

| # | Line(s) | Issue |
|---|---------|-------|
| 6 | 12–77 | The curated resource list is comprehensive and well-organized. Good coverage of mathematics, CS, and philosophy. |
| 7 | 79–93 | `SUBDOMAIN_QUERIES` maps subdomains to search queries for live web search. Well-structured. |
| 8 | 150–155 | `getSubdomainsForDomain` has a sensible fallback to all known resources for unknown domains. |

---

## 7. `src/workers/pdf-worker.ts` — PDF Worker Client

### Summary

HTTP client for a remote PDF conversion worker. Provides submit, status polling, and wait-for-completion methods.

### Issues

#### Warning

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 1 | 28–36, 38–42 | **No timeout on fetch calls.** `submit` and `getStatus` use bare `fetch()` without an `AbortSignal`. If the worker server is unresponsive, these calls can hang indefinitely, blocking the pipeline. | Add `AbortSignal.timeout(15_000)` for `submit` and `10_000` for `getStatus`. |
| 2 | 34, 42 | **Unsafe `as` type assertions.** `return res.json() as Promise<WorkerResponse>` bypasses runtime validation. If the server returns a malformed response (e.g., missing `task_id` or unexpected status values), the error surfaces downstream with confusing messages. | Add a runtime schema validator (e.g., `zod` or a manual check) that verifies the response shape before returning. |
| 3 | 56 | **Hardcoded 300-second default timeout.** `opts?.timeoutMs ?? 300_000` (5 minutes) is very long. The pipeline in `pipeline.ts` already passes `120_000` (2 minutes), so the default is only used if the caller doesn't specify. Still, 5 minutes as a default is aggressive. | Consider reducing the default to 120 seconds. |

#### Info

| # | Line(s) | Issue |
|---|---------|-------|
| 4 | 1–25 | Well-typed interfaces for all message types. |
| 5 | 44–57 | Polling loop with configurable interval and timeout is clean and simple. |
| 6 | 27–59 | Factory function pattern (`createPdfWorkerClient`) is clean and testable. |

---

## 8. `src/crawl/search-engines.ts` — Multi-Engine Search

### Summary

Abstracts DuckDuckGo HTML scraping, Bing Web Search API, and SearXNG API behind a unified `SearchAggregator`. Provides deduplication, URL normalization, and engine availability checks.

### Issues

#### Critical

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 1 | 81 | **DuckDuckGo HTML regex is fragile and may be blocked.** DuckDuckGo actively discourages scraping and may serve CAPTCHAs or alternative HTML structures. The regex `/<div class="result results_links[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi` depends on specific class names (e.g., `results_links_main`) that have changed in the past. When the HTML structure changes, this silently returns zero results. | (a) Add a "sanity check" that validates at least one result was found, warning if parsing yields 0 results despite HTTP 200. (b) Consider using DuckDuckGo's instant answer API (duckduckgo.com/api) instead of scraping HTML. (c) Add a structural health check that logs the first 500 chars of response when no results are parsed. |
| 2 | 136 | **Bing API uses hardcoded `zh-CN` as default market (`mkt`).** ``opts.lang ? this.mapLocale(opts.lang) : "zh-CN"`` defaults to Chinese. For a globally-oriented system, `en-US` or unset (letting Bing auto-detect) is more appropriate. | Change default to `"en-US"` or omit `mkt` to let Bing use GeoIP-based locale. |

#### Warning

| # | Line(s) | Issue | Suggested Fix |
|---|---------|-------|---------------|
| 3 | 39–55 | **`fetch` method uses both `AbortController` and `setTimeout` for timeout, but `proxyFetch` is also called inside.** If `proxyFetch` already implements its own timeout (needs verification), the dual timeout could cause double-abort errors (aborting an already-aborted signal throws in some runtimes). | Check whether `proxyFetch` has its own timeout logic. If it does, remove the redundant `AbortController` from the base class and use `proxyFetch`'s timeout parameter. |
| 4 | 277–291 | **`mergeAndDeduplicate` sorts by position, but positions are engine-local.** Engine A's result #1 and Engine B's result #1 both have position 1. The merge preserves whichever was encountered first (Engine A, since it runs first in `Promise.all` due to the engine list order). This means the sort is essentially arbitrary across engines. | After merging, re-sort by a combined relevance score, or at minimum use the average position across engines. |
| 5 | 286 | **Engine name concatenation can grow unbounded.** `existing.engine += \`+\${r.engine}\`` could produce very long strings if the same result appears in many engines with different sub-engine names (especially SearXNG which includes `r.engine`). | Use a `Set<string>` internally and join only for display. |
| 6 | 294–305 | **`normalizeUrl` strips tracking parameters but doesn't normalize trailing slashes or protocol (http vs https).** `example.com/page` and `example.com/page/` would be treated as different URLs. | Normalize by removing trailing slashes and lowercasing the protocol+host. |

#### Info

| # | Line(s) | Issue |
|---|---------|-------|
| 7 | 58–118 | DuckDuckGo engine has reasonably specific regex patterns for the known DDG HTML structure. |
| 8 | 120–173 | Bing engine correctly uses the Ocp-Apim-Subscription-Key header and maps locales. |
| 9 | 176–216 | SearXNG engine is clean and respects the standard JSON API format. |
| 10 | 220–306 | `SearchAggregator` is well-structured with clear method separation, error isolation per engine, and dedup logic. |

---

## Cross-Cutting Concerns

### Correctness

| # | Issue | Affected Files | Severity |
|---|-------|----------------|----------|
| 1 | **Duplicated ID generation logic** — `collector.ts` and `store.ts` both compute the same `know_<hash>` ID via separate code paths. Any change to one must be mirrored in the other. | `collector.ts:96`, `store.ts:250–253` | Warning |
| 2 | **FTS5 injection in dictionary search** — User-supplied words are interpolated into an FTS5 query string without sanitization. | `store.ts:166–172` | Critical |
| 3 | **Bun-specific APIs** — `Bun.hash()` is used in `store.ts`, `collector.ts`. The code is non-portable to Node.js. | `store.ts`, `collector.ts` | Info (project uses Bun) |
| 4 | **AppendFileSync race** — `pipeline.ts` appends to JSONL files without synchronization, risking corruption under concurrent topic execution. | `pipeline.ts:166–171` | Critical |

### Performance

| # | Issue | Affected Files | Severity |
|---|-------|----------------|----------|
| 5 | **Missing fetch timeouts** — `pdf-worker.ts` (submit, getStatus) and `collector.ts` (Wiktionary) don't set fetch timeouts, risking hanging processes. | `pdf-worker.ts:28–42`, `collector.ts:150` | Warning |
| 6 | **Sequential loops instead of concurrent** — Book discovery, PDF conversion, topic processing, and dictionary word collection all run sequentially. | `pipeline.ts`, `z-library.ts`, `collector.ts` | Warning |
| 7 | **No `isCollected` batch query** — Each URL in a search result set triggers a separate DB query. | `collector.ts:69` | Info |
| 8 | **Duplicate regex parsing of DuckDuckGo HTML** — The entire HTML page is loaded into memory and parsed via `matchAll` with multiple regex passes. For large result sets, this is CPU/memory intensive. | `search-engines.ts:75–109` | Info |

### Maintainability

| # | Issue | Affected Files | Severity |
|---|-------|----------------|----------|
| 9 | **Hardcoded dates** — `github-trending.ts` uses a static date (`2026-01-01`) in the API query. Must be updated manually. | `github-trending.ts:93` | Warning |
| 10 | **OpenStax parser is a stub** — Returns `[]` with no notification. Dead code that could confuse future maintainers. | `z-library.ts:47–50` | Warning |
| 11 | **No runtime validation of external API responses** — JSON responses from GitHub, GLM, Bing, and the PDF worker are typed with `as` assertions but never validated. | Multiple files | Info |
| 12 | **No automatic link health checking** — Curated resource URLs in `searcher.ts` could go stale without detection. | `searcher.ts:12–77` | Info |

### Security

| # | Issue | Affected Files | Severity |
|---|-------|----------------|----------|
| 13 | **FTS5 injection** — See Correctness #2 above. User-controlled FTS5 query construction. | `store.ts:166–172` | Critical |
| 14 | **No URL validation on stored URLs** — URLs from web search are stored and used directly without validation (e.g., `javascript:` or `file:` protocol URLs). While unlikely in search results, a compromised search engine could inject malicious URLs. | `store.ts:101–115`, `collector.ts:88–93` | Info |
| 15 | **API keys in memory** — ZHIPU_API_KEY, GITHUB_TOKEN, BING_API_KEY are read from env vars and held in memory. Not a vulnerability per se, but no effort is made to clear them after use. | Multiple files | Info |

---

## File Size Assessment

| File | Lines | Assessment |
|------|-------|------------|
| `pipeline.ts` | 193 | **Good.** Well within the 300-line comfort zone. |
| `github-trending.ts` | 159 | **Good.** Focused scope. |
| `z-library.ts` | 119 | **Good.** Concise and well-extracted. |
| `store.ts` | 288 | **Watch.** Near the 300-line threshold. Consider extracting FTS5 logic and the Wiktionary parsing into separate modules. |
| `collector.ts` | 233 | **Good.** But the Wiktionary parser (lines 193–233) could be extracted. |
| `searcher.ts` | 155 | **Good.** |
| `pdf-worker.ts` | 60 | **Good.** Minimal and focused. |
| `search-engines.ts` | 308 | **Watch.** Just over 300 lines. If more engines are added, extract each engine into its own file (e.g., `search-engines/duckduckgo.ts`, `search-engines/bing.ts`, `search-engines/searxng.ts`). |

---

## Recommendations (Priority Order)

1. **[Critical] Fix FTS5 injection in `store.ts:166–172`.** Sanitize user input before building the FTS5 query string. Strip or reject FTS5 special characters.

2. **[Critical] Fix JSONL race condition in `pipeline.ts:166–171`.** Use async file writes with a per-file write queue, or collect all structured results and flush them after the loop.

3. **[Critical] Fix Wiktionary parser in `collector.ts:206–216`.** Scope parsing to the English-language section of the page to avoid capturing irrelevant list items.

4. **[Warning] Add fetch timeouts to `pdf-worker.ts` (submit/getStatus) and `collector.ts` Wiktionary fetch.**

5. **[Warning] Make the GitHub API pushed-date dynamic in `github-trending.ts:93`.**

6. **[Warning] Eliminate duplicated ID generation logic between `collector.ts` and `store.ts`.**

7. **[Warning] Add logging to the silent catch blocks in `searcher.ts:121` and the stub parser in `z-library.ts:47–50`.**

8. **[Warning] Parallelize independent operations** — book source queries, PDF conversions, and dictionary word fetches — with concurrency limits.

9. **[Info] Extract each search engine into its own file** as `search-engines.ts` grows past 300 lines.

10. **[Info] Add runtime JSON response validation** for external API calls (GLM, GitHub, Bing, PDF worker) to catch upstream API changes early.
