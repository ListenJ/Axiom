import { describe, it, expect, beforeEach } from 'vitest'
import { parseMotionLevel, useMotionPrefs } from './useMotionPrefs'

describe('useMotionPrefs', () => {
  beforeEach(() => {
    useMotionPrefs.setState({ level: 'system' })
    localStorage.clear()
  })

  it('defaults to following the system preference', () => {
    expect(useMotionPrefs.getState().level).toBe('system')
  })

  it('persists a chosen level and updates the store', () => {
    useMotionPrefs.getState().setLevel('reduced')
    expect(useMotionPrefs.getState().level).toBe('reduced')
    expect(localStorage.getItem('axiom:motion')).toBe('reduced')
  })

  it('supports turning all motion off', () => {
    useMotionPrefs.getState().setLevel('off')
    expect(useMotionPrefs.getState().level).toBe('off')
    expect(localStorage.getItem('axiom:motion')).toBe('off')
  })

  it('parses only known levels and falls back to system', () => {
    expect(parseMotionLevel('reduced')).toBe('reduced')
    expect(parseMotionLevel('off')).toBe('off')
    expect(parseMotionLevel('turbo')).toBe('system')
    expect(parseMotionLevel(null)).toBe('system')
  })
})
