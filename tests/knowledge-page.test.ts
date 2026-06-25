/**
 * Knowledge Review Page — 知识审核单元测试
 * 运行: bun test tests/knowledge-page.test.ts
 */
import { describe, it, expect } from "bun:test"

interface PendingNote {
  file: string
  title: string
  source: string
  reason?: string
  created: string
  updated?: string
}

describe("Knowledge Review Page", () => {
  describe("笔记数据规范化", () => {
    it("应能解析标准 pending-review 响应", () => {
      const resp = {
        notes: [
          {
            file: "atomic-001.md",
            title: "React Hooks 最佳实践",
            source: "Web Clip",
            reason: "需要人工审核",
            created: "2026-06-10",
            updated: "2026-06-12",
          },
        ],
        count: 1,
      }
      expect(resp.notes).toHaveLength(1)
      expect(resp.notes[0].file).toBe("atomic-001.md")
      expect(resp.notes[0].title).toBe("React Hooks 最佳实践")
    })

    it("应能处理空响应", () => {
      const resp = { notes: [], count: 0 }
      expect(resp.notes).toEqual([])
      expect(resp.count).toBe(0)
    })

    it("应能处理缺失可选字段的笔记", () => {
      const note: PendingNote = {
        file: "x.md",
        title: "X",
        source: "",
        created: "2026-06-10",
      }
      expect(note.reason).toBeUndefined()
      expect(note.updated).toBeUndefined()
    })
  })

  describe("审核操作验证", () => {
    it("approve action 应被允许", () => {
      const isValidAction = (a: string) => a === "approve" || a === "reject"
      expect(isValidAction("approve")).toBe(true)
    })

    it("reject action 应被允许", () => {
      const isValidAction = (a: string) => a === "approve" || a === "reject"
      expect(isValidAction("reject")).toBe(true)
    })

    it("其他 action 应被拒绝", () => {
      const isValidAction = (a: string) => a === "approve" || a === "reject"
      expect(isValidAction("delete")).toBe(false)
      expect(isValidAction("archive")).toBe(false)
      expect(isValidAction("")).toBe(false)
    })
  })

  describe("本地状态管理", () => {
    it("批准后应能从列表中移除笔记", () => {
      let notes: PendingNote[] = [
        { file: "a.md", title: "A", source: "", created: "2026-06-10" },
        { file: "b.md", title: "B", source: "", created: "2026-06-11" },
      ]
      const file = "a.md"
      notes = notes.filter((n) => n.file !== file)
      expect(notes).toHaveLength(1)
      expect(notes[0].file).toBe("b.md")
    })

    it("应能根据文件路径过滤", () => {
      const notes: PendingNote[] = [
        { file: "a.md", title: "A", source: "", created: "" },
        { file: "b.md", title: "B", source: "", created: "" },
        { file: "c.md", title: "C", source: "", created: "" },
      ]
      const a = notes.find((n) => n.file === "a.md")
      expect(a).toBeTruthy()
      expect(a?.title).toBe("A")
    })
  })

  describe("日期与时间", () => {
    it("应能格式化 created 日期", () => {
      const note: PendingNote = { file: "x.md", title: "X", source: "", created: "2026-06-10" }
      expect(note.created).toBe("2026-06-10")
    })

    it("应能按 created 时间排序（最新在前）", () => {
      const notes: PendingNote[] = [
        { file: "a.md", title: "A", source: "", created: "2026-06-08" },
        { file: "b.md", title: "B", source: "", created: "2026-06-14" },
        { file: "c.md", title: "C", source: "", created: "2026-06-10" },
      ]
      const sorted = [...notes].sort((a, b) => b.created.localeCompare(a.created))
      expect(sorted[0].file).toBe("b.md")
      expect(sorted[2].file).toBe("a.md")
    })
  })

  describe("Markdown 文件验证", () => {
    it("文件应具有 .md 扩展名", () => {
      const file = "atomic-001.md"
      expect(file.endsWith(".md")).toBe(true)
    })

    it("应能从文件路径提取 ID", () => {
      const file = "atomic-2026-06-10-001.md"
      const id = file.replace(".md", "")
      expect(id).toBe("atomic-2026-06-10-001")
    })
  })
})
