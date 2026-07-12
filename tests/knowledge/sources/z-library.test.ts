import { describe, it, expect } from "bun:test"
import { getPdfUrl } from "../../../src/knowledge/sources/z-library.js"
import type { BookInfo } from "../../../src/knowledge/sources/z-library.js"

describe("getPdfUrl", () => {
  it("converts gutenberg ebook URL to PDF", () => {
    const book: BookInfo = { title: "Test", author: "Author", url: "https://www.gutenberg.org/ebooks/12345", source: "gutenberg", quality: 0.8 }
    expect(getPdfUrl(book)).toBe("https://www.gutenberg.org/ebooks/12345.pdf")
  })

  it("converts arxiv abs URL to PDF", () => {
    const book: BookInfo = { title: "Paper", author: "Author", url: "https://arxiv.org/abs/2401.12345", source: "arxiv", quality: 0.7 }
    expect(getPdfUrl(book)).toBe("https://arxiv.org/pdf/2401.12345.pdf")
  })

  it("returns url as-is for unknown sources", () => {
    const book: BookInfo = { title: "Test", author: "Author", url: "https://example.com/book", source: "openstax", quality: 0.5 }
    expect(getPdfUrl(book)).toBe("https://example.com/book")
  })
})
