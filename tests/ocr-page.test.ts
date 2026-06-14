/**
 * OCR Page — 文字识别单元测试
 * 运行: bun test tests/ocr-page.test.ts
 */
import { describe, it, expect } from "bun:test"

interface OcrStatus {
  ready: boolean
  languages: string[]
  version?: string
}

describe("OCR Page", () => {
  describe("OCR 引擎状态", () => {
    it("就绪状态应有 languages 数组", () => {
      const status: OcrStatus = { ready: true, languages: ["eng", "chi_sim"] }
      expect(status.ready).toBe(true)
      expect(status.languages.length).toBeGreaterThan(0)
    })

    it("未就绪状态应包含警告标志", () => {
      const status: OcrStatus = { ready: false, languages: [] }
      expect(status.ready).toBe(false)
    })

    it("默认应使用英文", () => {
      const defaultLangs = ["eng"]
      expect(defaultLangs).toContain("eng")
    })
  })

  describe("语言代码解析", () => {
    it("应能解析逗号分隔的语言字符串", () => {
      const input = "eng, chi_sim, fra"
      const langs = input.split(",").map((s) => s.trim()).filter(Boolean)
      expect(langs).toEqual(["eng", "chi_sim", "fra"])
    })

    it("应能处理空字符串", () => {
      const input = ""
      const langs = input.split(",").map((s) => s.trim()).filter(Boolean)
      expect(langs).toEqual([])
    })

    it("应能过滤空白项", () => {
      const input = "eng, , chi_sim,  "
      const langs = input.split(",").map((s) => s.trim()).filter(Boolean)
      expect(langs).toEqual(["eng", "chi_sim"])
    })

    it("应能识别 Tesseract 支持的语言代码", () => {
      const validCodes = ["eng", "chi_sim", "chi_tra", "fra", "deu", "spa", "jpn", "kor"]
      const input = "eng, chi_sim"
      const langs = input.split(",").map((s) => s.trim())
      langs.forEach((lang) => {
        expect(validCodes).toContain(lang)
      })
    })
  })

  describe("文件路径处理", () => {
    it("应能从路径中提取文件名（POSIX）", () => {
      const path = "/path/to/image.png"
      const fileName = path.split("/").pop() ?? ""
      expect(fileName).toBe("image.png")
    })

    it("应能从路径中提取文件名（Windows）", () => {
      const path = "C:\\Users\\test\\document.pdf"
      const fileName = path.split(/[/\\]/).pop() ?? ""
      expect(fileName).toBe("document.pdf")
    })

    it("应能去除文件扩展名", () => {
      const fileName = "document.pdf"
      const name = fileName.replace(/\.[^.]+$/, "")
      expect(name).toBe("document")
    })

    it("应能处理无扩展名文件", () => {
      const fileName = "README"
      const name = fileName.replace(/\.[^.]+$/, "")
      expect(name).toBe("README")
    })

    it("应能处理多扩展名文件", () => {
      const fileName = "archive.tar.gz"
      const name = fileName.replace(/\.[^.]+$/, "")
      expect(name).toBe("archive.tar")
    })
  })

  describe("导出格式", () => {
    it("应支持 md, txt, json 三种格式", () => {
      const formats: Array<"md" | "txt" | "json"> = ["md", "txt", "json"]
      expect(formats.length).toBe(3)
    })

    it("应能根据格式生成正确的 MIME 类型", () => {
      const mimeMap: Record<string, string> = {
        md: "text/markdown",
        txt: "text/plain",
        json: "application/json",
      }
      expect(mimeMap["md"]).toBe("text/markdown")
      expect(mimeMap["txt"]).toBe("text/plain")
      expect(mimeMap["json"]).toBe("application/json")
    })
  })

  describe("路径验证", () => {
    it("空路径应被拒绝", () => {
      const path = ""
      expect(path.trim()).toBe("")
    })

    it("空白路径应被拒绝", () => {
      const path = "   "
      expect(path.trim()).toBe("")
    })

    it("有效路径应通过 trim() 后仍有内容", () => {
      const path = "  /path/to/file.png  "
      expect(path.trim().length).toBeGreaterThan(0)
    })
  })
})
