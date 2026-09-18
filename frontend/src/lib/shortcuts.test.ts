import { describe, it, expect } from 'vitest'
import {
  SHORTCUTS,
  GLOBAL_SHORTCUTS,
  NAV_SHORTCUTS,
  matchShortcut,
  shortcutLabel,
} from './shortcuts'
import { VISIBLE_NAV_ITEMS } from './nav'

function keyEvent(key: string, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, ...init })
}

describe('shortcuts registry', () => {
  it('has unique ids', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every entry has a non-empty display label and description', () => {
    for (const s of SHORTCUTS) {
      expect(s.label.trim().length).toBeGreaterThan(0)
      expect(s.description.trim().length).toBeGreaterThan(0)
      expect(s.keys.length).toBeGreaterThan(0)
    }
  })

  it('every entry has a valid category', () => {
    for (const s of SHORTCUTS) {
      expect(['global', 'nav', 'menu']).toContain(s.category)
    }
  })

  it('derives nav shortcuts from VISIBLE_NAV_ITEMS', () => {
    expect(NAV_SHORTCUTS).toHaveLength(VISIBLE_NAV_ITEMS.length)
    for (const item of VISIBLE_NAV_ITEMS) {
      const s = NAV_SHORTCUTS.find((x) => x.id === `nav-${item.id}`)
      expect(s).toBeDefined()
      expect(s!.keys).toContain(item.shortcut)
      expect(s!.path).toBe(item.path)
      expect(s!.category).toBe('nav')
    }
  })

  it('covers all global rules: help, escape, terminal, theme, search', () => {
    const ids = GLOBAL_SHORTCUTS.map((s) => s.id)
    for (const id of ['help', 'escape', 'terminal', 'theme', 'search-slash', 'search-ctrl-k']) {
      expect(ids).toContain(id)
    }
  })

  describe('matchShortcut', () => {
    it('matches ? without ctrl/meta', () => {
      const s = SHORTCUTS.find((x) => x.id === 'help')!
      expect(matchShortcut(s, keyEvent('?'))).toBe(true)
      expect(matchShortcut(s, keyEvent('?', { ctrlKey: true }))).toBe(false)
      expect(matchShortcut(s, keyEvent('?', { metaKey: true }))).toBe(false)
    })

    it('matches Escape regardless of modifiers', () => {
      const s = SHORTCUTS.find((x) => x.id === 'escape')!
      expect(matchShortcut(s, keyEvent('Escape'))).toBe(true)
      expect(matchShortcut(s, keyEvent('Escape', { ctrlKey: true }))).toBe(true)
    })

    it('matches terminal on Ctrl/Cmd + ` or Backquote', () => {
      const s = SHORTCUTS.find((x) => x.id === 'terminal')!
      expect(matchShortcut(s, keyEvent('`', { ctrlKey: true }))).toBe(true)
      expect(matchShortcut(s, keyEvent('Backquote', { metaKey: true }))).toBe(true)
      expect(matchShortcut(s, keyEvent('`'))).toBe(false)
    })

    it('matches theme on Shift+T', () => {
      const s = SHORTCUTS.find((x) => x.id === 'theme')!
      expect(matchShortcut(s, keyEvent('T', { shiftKey: true }))).toBe(true)
      expect(matchShortcut(s, keyEvent('T'))).toBe(false)
      expect(matchShortcut(s, keyEvent('t', { shiftKey: true }))).toBe(false)
    })

    it('matches search via / (no modifiers) and Ctrl/Cmd+K', () => {
      const slash = SHORTCUTS.find((x) => x.id === 'search-slash')!
      const ctrlK = SHORTCUTS.find((x) => x.id === 'search-ctrl-k')!
      expect(matchShortcut(slash, keyEvent('/'))).toBe(true)
      expect(matchShortcut(slash, keyEvent('/', { ctrlKey: true }))).toBe(false)
      expect(matchShortcut(ctrlK, keyEvent('k', { ctrlKey: true }))).toBe(true)
      expect(matchShortcut(ctrlK, keyEvent('k', { metaKey: true }))).toBe(true)
      expect(matchShortcut(ctrlK, keyEvent('k'))).toBe(false)
    })

    it('nav shortcuts reject ctrl/meta/alt', () => {
      const s = NAV_SHORTCUTS[0]
      expect(matchShortcut(s, keyEvent(s.keys[0]))).toBe(true)
      expect(matchShortcut(s, keyEvent(s.keys[0], { ctrlKey: true }))).toBe(false)
      expect(matchShortcut(s, keyEvent(s.keys[0], { metaKey: true }))).toBe(false)
      expect(matchShortcut(s, keyEvent(s.keys[0], { altKey: true }))).toBe(false)
    })
  })

  describe('shortcutLabel', () => {
    it('returns display labels for known ids', () => {
      expect(shortcutLabel('terminal')).toBe('Ctrl+`')
      expect(shortcutLabel('theme')).toBe('Shift+T')
      expect(shortcutLabel('help')).toBe('?')
      expect(shortcutLabel('escape')).toBe('Esc')
      for (const item of VISIBLE_NAV_ITEMS) {
        expect(shortcutLabel(`nav-${item.id}`)).toBe(item.shortcut)
      }
    })

    it('throws for unknown ids', () => {
      expect(() => shortcutLabel('nope')).toThrow()
    })
  })
})
