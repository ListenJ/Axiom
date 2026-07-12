# Task 3: Z-Library / Open Book Discovery

**Files:**
- Modify: `src/knowledge/sources/index.ts` (add book exports)
- Create: `src/knowledge/sources/z-library.ts`
- Create: `tests/knowledge/sources/z-library.test.ts`

**Global Constraints:** TypeScript/Bun, no secrets, tests pass.

## Code

### `src/knowledge/sources/z-library.ts`

Copy from `docs/superpowers/plans/2026-07-12-knowledge-network.md` lines 444-616 — contains:
- `BookInfo` interface
- `OPEN_BOOK_SOURCES` array (gutenberg + openstax + arxiv)
- `discoverBooks(query, opts?)` function
- `getPdfUrl(book)` function

### Update `src/knowledge/sources/index.ts`

Add to existing exports:
```typescript
export { discoverBooks, getPdfUrl } from "./z-library.js"
export type { BookInfo } from "./z-library.js"
```

### `tests/knowledge/sources/z-library.test.ts`

Copy from plan lines 630-653:
```typescript
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
```

## Steps
1. Create `src/knowledge/sources/z-library.ts` (source scanning + PDF URL extraction)
2. Update `src/knowledge/sources/index.ts`
3. Create test file
4. Run: `bun test tests/knowledge/sources/z-library.test.ts`
5. Commit: `git add src/knowledge/sources/ tests/knowledge/sources/ && git commit -m "feat(knowledge): add open book discovery (Gutenberg/arXiv/OpenStax)"`
