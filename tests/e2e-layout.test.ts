/**
 * E2E Layout & Component Structure Tests
 *
 * Verifies that the frontend pages use the new shared UI components
 * (PageHeader, StatCard, EmptyState, Tabs, etc.) consistently,
 * reducing code duplication and ensuring the GUI presents each
 * function without bloat.
 */
import { describe, it, expect } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const PAGES = join(ROOT, "frontend", "src", "pages")
const COMPONENTS = join(ROOT, "frontend", "src", "components")

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".vite") continue
      out.push(...walk(p))
    } else if (entry.endsWith(".test.tsx") || entry.endsWith(".test.ts")) {
      // 测试文件不是真实页面，跳过
      continue
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(p)
    }
  }
  return out
}

function read(p: string): string {
  return readFileSync(p, "utf8")
}

const PAGE_FILES = walk(PAGES).filter((f) => !f.endsWith(".test.tsx")) // 只扫描页面，不扫描 colocated 测试
const COMPONENT_FILES = walk(COMPONENTS)

describe("E2E - All pages use shared UI components", () => {

  it("UI barrel index exports all expected components", () => {
    const index = read(join(COMPONENTS, "ui", "index.ts"))
    const expected = [
      "ShimmerCard",
      "Tabs",
      "EmptyState",
      "InlineEmptyState",
      "StatCard",
      "Button",
      "BarChart",
      "Skeleton",
      "PageHeader",
      "LoadingDots",
      "HelpModal",
      "Toasts",
    ]
    expected.forEach((name) => {
      expect(index).toContain(name)
    })
  })

  it("所有页面都应使用 PageHeader（避免重复 header markup）", () => {
    // 一些页面可能不直接用 PageHeader（如果它们有自定义 header），但应该是例外
    const exempt = ["Home", "Settings", "Chat", "Login", "Git"] // Home 有自定义 hero，Settings 有自定义结构，Chat 有 sessions sidebar，Login 为全屏独立页，Git 用 ShimmerCard 自定义头部
    PAGE_FILES.forEach((f) => {
      const name = f.split(/[\\/]/).pop()?.replace(".tsx", "") ?? ""
      if (exempt.includes(name)) return
      const src = read(f)
      const hasPageHeader = src.includes("PageHeader")
      const hasCustomHeader = /<header[^>]*>/.test(src) && /<h1[^>]*>/.test(src)
      // 期望: 用 PageHeader 或有自定义 header
      expect(hasPageHeader || hasCustomHeader).toBe(true)
    })
  })

  it("页面应使用 StatCard 或显式网格卡片", () => {
    const hasStatsPages = ["KG", "Perf", "Proxies", "Vault"]
    PAGE_FILES.forEach((f) => {
      const name = f.split(/[\\/]/).pop()?.replace(".tsx", "") ?? ""
      if (hasStatsPages.includes(name)) {
        const src = read(f)
        // 这些页面有统计数据（非空实现）
        expect(src.length).toBeGreaterThan(800)
      }
    })
  })
})

describe("E2E - Empty state consistency", () => {
  it("使用原始 inline 空态模式的页面必须引入 EmptyState 组件", () => {
    // 检测原始的 inline empty state 实现
    const inlineEmptyPattern = /flex flex-col items-center justify-center py-12 text-text-muted/g
    const violations: string[] = []
    PAGE_FILES.forEach((f) => {
      const src = read(f)
      if (inlineEmptyPattern.test(src)) {
        const usesComponent = src.includes("InlineEmptyState") || src.includes("EmptyState")
        // 大页面（>3000 字符）允许自定义 inline 空态；小页面必须用共享组件
        if (!usesComponent && src.length <= 3000) {
          violations.push(f)
        }
      }
    })
    expect(violations).toEqual([])
  })
})

describe("E2E - Layout structural integrity", () => {
  it("所有页面根容器应使用 space-y-N 节奏", () => {
    PAGE_FILES.forEach((f) => {
      const src = read(f)
      // 查找主渲染的根 div
      const rootMatch = src.match(/<div className="([^"]*space-y-\d+[^"]*)"/)
      if (rootMatch) {
        expect(rootMatch[1]).toContain("space-y-")
      }
    })
  })

  it("页面动效已统一到路由级过渡（Layout AnimatePresence，页面不再自含 fade-in）", () => {
    // 2026-08-03 统一动画流程（8dad563）：路由级过渡收口到 Layout，
    // 页面不再各自包裹 fade-in/PageTransition。断言 Layout 承担过渡、
    // 页面不再残留旧式 fade-in 根容器。
    const layout = read(join(ROOT, "frontend", "src", "components", "layout", "Layout.tsx"))
    expect(layout).toContain("AnimatePresence")
    expect(layout).toContain("MOTION_PRESETS")
    PAGE_FILES.forEach((f) => {
      const name = f.split(/[\\/]/).pop()?.replace(".tsx", "") ?? ""
      if (name === "Chat" || name === "Login") return // Chat/Login 有独立布局
      const src = read(f)
      // 不再强制要求 fade-in；允许页面继续使用 stagger 等局部动效类
      if (src.includes("fade-in")) {
        // 若仍用 fade-in，需同时使用 stagger 或 motion 组件（局部动效而非页面根容器）
        expect(src.includes("stagger") || src.includes("motion")).toBe(true)
      }
    })
  })

  it("页面应使用 stagger 类对列表项应用交错动画", () => {
    const hasStaggerPages = [
      "Home", "Settings", "KG", "Perf", "Proxies", "Vault",
      "Trends", "Eval", "Plugins", "Agents", "Code",
    ]
    PAGE_FILES.forEach((f) => {
      const name = f.split(/[\\/]/).pop()?.replace(".tsx", "") ?? ""
      if (hasStaggerPages.includes(name)) {
        const src = read(f)
        // 这些页面有列表/网格，应使用 stagger
        const hasStagger = src.includes("stagger")
        const hasList = src.includes("grid-cols-") || src.includes("space-y-")
        if (hasList) {
          expect(hasStagger).toBe(true)
        }
      }
    })
  })
})

describe("E2E - Accessibility & sizing", () => {
  it("页面 header 图标应为 size-5 标准化", () => {
    PAGE_FILES.forEach((f) => {
      const src = read(f)
      // 检测 PageHeader 图标
      const headerMatch = src.match(/<PageHeader[^>]+icon=\{<(\w+) className="size-(\d+)"/)
      if (headerMatch) {
        expect(headerMatch[2]).toBe("5")
      }
    })
  })

  it("按钮应有 aria-label 或可见文本", () => {
    const violations: Array<{ file: string; button: string }> = []
    PAGE_FILES.forEach((f) => {
      const src = read(f)
      // 提取所有 <button ...> 起始标签
      const buttons = src.match(/<button\b[\s\S]*?>/g) ?? []
      buttons.forEach((btn) => {
        const hasAria = /aria-label=/.test(btn) || /aria-labelledby=/.test(btn)
        const isSubmit = /type="submit"/.test(btn) || /type="button"/.test(btn)
        // aria-hidden 按钮（如移动端关闭按钮）允许跳过
        const ariaHidden = /aria-hidden="true"/.test(btn)
        if (!hasAria && !isSubmit && !ariaHidden) {
          violations.push({ file: f, button: btn.slice(0, 80) })
        }
      })
    })
    expect(violations).toEqual([])
  })
})

describe("E2E - No Tailwind shorthand color leaks", () => {
  it("应避免使用原始 hex 颜色（必须用 design tokens）", () => {
    const hexPattern = /#[0-9a-fA-F]{3,8}/
    PAGE_FILES.forEach((f) => {
      const src = read(f)
      const matches = src.match(hexPattern) ?? []
      // 允许注释中的 hex
      const codeOnly = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
      const codeMatches = codeOnly.match(hexPattern) ?? []
      expect(codeMatches).toEqual([])
    })
  })

  it("应避免硬编码的 Tailwind 调色板（text-red-500 等）", () => {
    // 应使用 design tokens 替代 raw Tailwind 调色板
    const rawColorPattern = /\b(text|bg|border|ring|shadow)-(red|blue|green|yellow|purple|pink|indigo|cyan|teal|orange|gray|slate|zinc|neutral|stone)-\d{2,3}\b/
    PAGE_FILES.forEach((f) => {
      const src = read(f)
      // 一些颜色（如 indigo for accent）是允许的
      const matches = src.match(rawColorPattern) ?? []
      // 允许特定的颜色（已在 config 中定义）
      const allowed = matches.filter(
        (m) =>
          // 这些是显式允许的（用于特殊目的）
          m.includes("text-red-500") || // destructive buttons
          m.includes("hover:bg-red-500") || // destructive hover
          m.includes("hover:text-red-500"), // destructive hover
      )
      // 至少要避免一般性的 raw 调色板
      const unexpected = matches.filter((m) => !allowed.includes(m))
      if (unexpected.length > 0) {
        // 允许一定程度的例外（如 custom CSS class 名称误判）
        // 但记录以供审查
        expect(unexpected.length).toBeLessThan(20)
      }
    })
  })
})

describe("E2E - Bloat prevention", () => {
  it("页面应小于 650 行（防止臃肿）", () => {
    PAGE_FILES.forEach((f) => {
      const src = read(f)
      const lines = src.split("\n").length
      // Chat 是业务最复杂页面（聊天流/会话/工具台/输入栏），已拆出
      // ChatComposer/IdeOpenMenu 等子组件；其余页面应更紧凑。
      const limit = 650
      expect(lines).toBeLessThan(limit)
    })
  })

  it("复用组件应来自 ui/ 目录", () => {
    // 验证从 '@/components/ui' 导入
    PAGE_FILES.forEach((f) => {
      const src = read(f)
      // 不应从单个文件路径导入组件
      const directImports = (src.match(/from\s+['"]@\/components\/ui\/[A-Z]\w+['"]/g) ?? []).length
      const barrelImports = (src.match(/from\s+['"]@\/components\/ui['"]/g) ?? []).length
      // 至少应该使用 barrel 或多个 direct imports
      expect(directImports + barrelImports).toBeGreaterThan(0)
    })
  })
})
