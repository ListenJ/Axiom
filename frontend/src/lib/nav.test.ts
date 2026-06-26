import { describe, it, expect } from 'vitest'
import { NAV_ITEMS, MOBILE_NAV_ITEMS, VISIBLE_NAV_ITEMS } from './nav'

describe('NAV_ITEMS', () => {
  it('contains the expected core pages', () => {
    const paths = NAV_ITEMS.map((i) => i.path)
    expect(paths).toContain('/')
    expect(paths).toContain('/chat')
    expect(paths).toContain('/search')
    expect(paths).toContain('/plugins')
    expect(paths).toContain('/settings')
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

  it('contains the home/chat/search/code/agents entries', () => {
    const ids = VISIBLE_NAV_ITEMS.map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['home', 'chat', 'search', 'code', 'agents']))
  })

  it('hides internal/backend-only pages', () => {
    const ids = VISIBLE_NAV_ITEMS.map((i) => i.id)
    expect(ids).not.toContain('ocr')
    expect(ids).not.toContain('research')
    expect(ids).not.toContain('proxies')
    expect(ids).not.toContain('trends')
    expect(ids).not.toContain('router')
    expect(ids).not.toContain('perf')
    expect(ids).not.toContain('eval')
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

  it('contains the home/chat/search/code/agents entries', () => {
    const ids = MOBILE_NAV_ITEMS.map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['home', 'chat', 'search', 'code', 'agents']))
  })
})
