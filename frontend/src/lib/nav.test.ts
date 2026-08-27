import { describe, it, expect } from 'vitest'
import { NAV_ITEMS, NAV_SECTIONS, MOBILE_NAV_ITEMS, VISIBLE_NAV_ITEMS } from './nav'

describe('NAV_SECTIONS', () => {
  it('has unique section ids', () => {
    const ids = NAV_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every item belongs to a declared section and every section has a visible item', () => {
    const ids = NAV_SECTIONS.map((s) => s.id)
    for (const item of NAV_ITEMS) expect(ids).toContain(item.section)
    for (const section of NAV_SECTIONS) {
      expect(VISIBLE_NAV_ITEMS.some((i) => i.section === section.id)).toBe(true)
    }
  })
})

describe('NAV_ITEMS', () => {
  it('contains the expected core pages', () => {
    const paths = NAV_ITEMS.map((i) => i.path)
    // 首页与对话合并：/ 不再是一级导航，由 /chat 承担
    expect(paths).toContain('/chat')
    expect(paths).toContain('/search')
    expect(paths).toContain('/settings')
    expect(paths).toContain('/vault')
    expect(paths).toContain('/sessions')
  })

  it('every item has required fields', () => {
    for (const item of NAV_ITEMS) {
      expect(item.id).toBeTruthy()
      expect(item.path).toMatch(/^\//)
      expect(item.label).toBeTruthy()
      expect(item.shortcut).toBeTruthy()
      // Lucide icons are React.forwardRef objects at runtime, not plain functions
      expect(item.icon).toBeDefined()
      expect(item.icon).toBeTruthy()
      expect(typeof item.mobilePrimary).toBe('boolean')
      expect(typeof item.visible).toBe('boolean')
      expect(['workspace', 'knowledge', 'dev', 'system']).toContain(item.section)
    }
  })

  it('has no duplicate paths', () => {
    const paths = NAV_ITEMS.map((i) => i.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('has no duplicate ids', () => {
    const ids = NAV_ITEMS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('VISIBLE_NAV_ITEMS', () => {
  it('is a strict subset of NAV_ITEMS filtered to visible=true', () => {
    expect(VISIBLE_NAV_ITEMS.every((i) => i.visible)).toBe(true)
    expect(VISIBLE_NAV_ITEMS.length).toBeGreaterThan(0)
    for (const v of VISIBLE_NAV_ITEMS) {
      expect(NAV_ITEMS.find((n) => n.id === v.id)).toBeDefined()
    }
  })

  it('contains the workspace, knowledge, dev, and system entries', () => {
    const ids = VISIBLE_NAV_ITEMS.map((i) => i.id)
    expect(ids).toEqual(
      expect.arrayContaining(['chat', 'search', 'code', 'vault', 'providers', 'git', 'sessions', 'tokens', 'settings']),
    )
  })

  it('hides internal/backend-only pages', () => {
    const ids = VISIBLE_NAV_ITEMS.map((i) => i.id)
    expect(ids).not.toContain('proxies')
    expect(ids).not.toContain('trends')
    expect(ids).not.toContain('perf')
  })
})

describe('MOBILE_NAV_ITEMS', () => {
  it('is a strict subset of visible items filtered to mobilePrimary=true', () => {
    expect(MOBILE_NAV_ITEMS.every((i) => i.mobilePrimary && i.visible)).toBe(true)
    expect(MOBILE_NAV_ITEMS.length).toBeGreaterThan(0)
    for (const m of MOBILE_NAV_ITEMS) {
      expect(VISIBLE_NAV_ITEMS.find((n) => n.id === m.id)).toBeDefined()
    }
  })

  it('contains the chat/search/code entries', () => {
    const ids = MOBILE_NAV_ITEMS.map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['chat', 'search', 'code']))
  })
})