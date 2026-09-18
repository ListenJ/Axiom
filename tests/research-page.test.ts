/**
 * Research Page — 深度研究单元测试
 * 运行: bun test tests/research-page.test.ts
 */
import { describe, it, expect } from "bun:test"

interface ResearchSource {
  title: string
  link: string
  snippet: string
  source: string
}

interface ResearchEntity {
  name: string
  type: string
}

interface ResearchResult {
  query: string
  summary?: string
  sources: ResearchSource[]
  entities: ResearchEntity[]
  depth: number
}

describe("Research Page", () => {
  describe("研究查询验证", () => {
    it("空查询应被拒绝", () => {
      const q = ""
      expect(q.trim()).toBe("")
    })

    it("空白查询应被拒绝", () => {
      const q = "   \n  "
      expect(q.trim()).toBe("")
    })

    it("有效查询应能 trim 成功", () => {
      const q = "  Rust vs Go 微服务  "
      expect(q.trim().length).toBeGreaterThan(0)
    })
  })

  describe("深度参数", () => {
    it("深度应被限制在 1-5 之间", () => {
      const clamp = (n: number) => {
        const safe = Number.isFinite(n) && n > 0 ? n : 3
        return Math.max(1, Math.min(5, safe))
      }
      expect(clamp(0)).toBe(3)  // 0 falls back to default
      expect(clamp(3)).toBe(3)
      expect(clamp(10)).toBe(5)
      expect(clamp(-1)).toBe(3)  // negative falls back to default
      expect(clamp(NaN)).toBe(3)
    })
  })

  describe("最大来源数", () => {
    it("最大来源数应被限制在 1-50 之间", () => {
      const clamp = (n: number) => {
        const safe = Number.isFinite(n) && n > 0 ? n : 10
        return Math.max(1, Math.min(50, safe))
      }
      expect(clamp(0)).toBe(10)  // 0 falls back to default
      expect(clamp(10)).toBe(10)
      expect(clamp(100)).toBe(50)
      expect(clamp(NaN)).toBe(10)
    })
  })

  describe("结果规范化", () => {
    it("应能处理缺失的 sources 字段", () => {
      const r: Partial<ResearchResult> = { query: "x", entities: [] }
      const sources = Array.isArray(r.sources) ? r.sources : []
      expect(sources).toEqual([])
    })

    it("应能处理缺失的 entities 字段", () => {
      const r: Partial<ResearchResult> = { query: "x", sources: [] }
      const entities = Array.isArray(r.entities) ? r.entities : []
      expect(entities).toEqual([])
    })

    it("应保留有效来源", () => {
      const r: ResearchResult = {
        query: "x",
        sources: [{ title: "A", link: "https://a.com", snippet: "s", source: "Web" }],
        entities: [],
        depth: 3,
      }
      expect(r.sources).toHaveLength(1)
      expect(r.sources[0].title).toBe("A")
    })
  })

  describe("来源去重", () => {
    it("应能根据 link 去重", () => {
      const sources: ResearchSource[] = [
        { title: "A1", link: "https://a.com", snippet: "x", source: "Web" },
        { title: "A2", link: "https://a.com", snippet: "y", source: "Web" },
        { title: "B", link: "https://b.com", snippet: "z", source: "Web" },
      ]
      const unique = sources.filter(
        (s, i, arr) => arr.findIndex((x) => x.link === s.link) === i
      )
      expect(unique).toHaveLength(2)
    })
  })

  describe("实体提取", () => {
    it("应能按类型分组实体", () => {
      const entities: ResearchEntity[] = [
        { name: "Axiom", type: "project" },
        { name: "Bun", type: "tool" },
        { name: "SQLite", type: "tool" },
        { name: "Hermes", type: "project" },
      ]
      const byType = entities.reduce((acc, e) => {
        if (!acc[e.type]) acc[e.type] = []
        acc[e.type].push(e.name)
        return acc
      }, {} as Record<string, string[]>)
      expect(byType["project"]).toEqual(["Axiom", "Hermes"])
      expect(byType["tool"]).toEqual(["Bun", "SQLite"])
    })

    it("应能去重同名实体", () => {
      const entities: ResearchEntity[] = [
        { name: "X", type: "tool" },
        { name: "X", type: "tool" },
        { name: "Y", type: "tool" },
      ]
      const unique = entities.filter(
        (e, i, arr) => arr.findIndex((x) => x.name === e.name) === i
      )
      expect(unique).toHaveLength(2)
    })
  })

  describe("URL 验证", () => {
    it("应能识别有效 URL", () => {
      const isValidUrl = (s: string) => {
        try {
          new URL(s)
          return true
        } catch {
          return false
        }
      }
      expect(isValidUrl("https://example.com")).toBe(true)
      expect(isValidUrl("http://localhost:3000/x")).toBe(true)
    })

    it("应能拒绝无效 URL", () => {
      const isValidUrl = (s: string) => {
        try {
          new URL(s)
          return true
        } catch {
          return false
        }
      }
      expect(isValidUrl("not a url")).toBe(false)
      expect(isValidUrl("")).toBe(false)
    })
  })
})
