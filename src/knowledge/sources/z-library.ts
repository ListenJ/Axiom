import { logger } from "../../utils/logger.js"

export interface BookInfo {
  title: string
  author: string
  year?: number
  url: string
  pages?: number
  language?: string
  source: "z-library" | "open-library" | "openstax" | "mit-ocw" | "arxiv" | "gutenberg"
  quality: number
}

const OPEN_BOOK_SOURCES: Array<{
  id: BookInfo["source"]
  name: string
  searchUrl: (query: string) => string
  parser: (html: string, query: string) => BookInfo[]
}> = [
  {
    id: "gutenberg",
    name: "Project Gutenberg",
    searchUrl: (q) => `https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(q)}`,
    parser: (html) => {
      const books: BookInfo[] = []
      const matchIterator = html.matchAll(/<li[^>]*class="booklink"[^>]*>([\s\S]*?)<\/li>/gi)
      for (const match of matchIterator) {
        const titleMatch = /<span[^>]*class="title"[^>]*>([\s\S]*?)<\/span>/.exec(match[1])
        const authorMatch = /<span[^>]*class="subtitle"[^>]*>([\s\S]*?)<\/span>/.exec(match[1])
        const linkMatch = /<a[^>]*href="(\/ebooks\/\d+)"[^>]*>/.exec(match[1])
        if (titleMatch && linkMatch) {
          books.push({
            title: titleMatch[1].trim(),
            author: authorMatch ? authorMatch[1].trim().replace(/^by\s+/i, "") : "Unknown",
            url: `https://www.gutenberg.org${linkMatch[1]}`,
            source: "gutenberg",
            quality: 0.8,
          })
        }
      }
      return books
    },
  },
  {
    id: "openstax",
    name: "OpenStax",
    searchUrl: (q) => `https://openstax.org/search?q=${encodeURIComponent(q)}`,
    parser: () => {
      return []
    },
  },
  {
    id: "arxiv",
    name: "arXiv",
    searchUrl: (q) => `https://arxiv.org/search/?query=${encodeURIComponent(q)}&searchtype=all`,
    parser: (html) => {
      const books: BookInfo[] = []
      const matchIterator = html.matchAll(/<li[^>]*class="arxiv-result"[^>]*>([\s\S]*?)<\/li>/gi)
      for (const match of matchIterator) {
        const titleMatch = /<p[^>]*class="list-title"[^>]*>([\s\S]*?)<\/p>/.exec(match[1])
        const linkMatch = /<a[^>]*href="(https?:\/\/arxiv\.org\/abs\/[^"]+)"[^>]*>/.exec(match[1])
        if (titleMatch && linkMatch) {
          books.push({
            title: titleMatch[1].replace(/<[^>]+>/g, "").replace(/^Title:\s*/i, "").trim(),
            author: "",
            url: linkMatch[1],
            source: "arxiv",
            quality: 0.7,
          })
        }
      }
      return books
    },
  },
]

export async function discoverBooks(query: string, opts?: { sources?: BookInfo["source"][] }): Promise<BookInfo[]> {
  const activeSources = opts?.sources ? OPEN_BOOK_SOURCES.filter((s) => opts.sources!.includes(s.id)) : OPEN_BOOK_SOURCES
  const results: BookInfo[] = []
  const seenUrls = new Set<string>()

  for (const source of activeSources) {
    try {
      const url = source.searchUrl(query)
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        logger.warn(`[BookDiscovery] ${source.name} returned ${res.status}`)
        continue
      }
      const html = await res.text()
      const books = source.parser(html, query)
      for (const book of books) {
        if (!seenUrls.has(book.url)) {
          seenUrls.add(book.url)
          results.push(book)
        }
      }
      logger.info(`[BookDiscovery] ${source.name}: ${books.length} books`)
    } catch (err) {
      logger.warn(`[BookDiscovery] ${source.name} failed: ${(err as Error).message?.slice(0, 60)}`)
    }
  }

  return results.sort((a, b) => b.quality - a.quality)
}

export function getPdfUrl(book: BookInfo): string {
  switch (book.source) {
    case "gutenberg":
      return book.url.replace(/\/ebooks\//, "/ebooks/").replace(/$/, ".pdf")
    case "arxiv":
      return book.url.replace("/abs/", "/pdf/")
    default:
      return book.url
  }
}
