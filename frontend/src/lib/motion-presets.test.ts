import { describe, it, expect } from 'vitest'
import {
  MOTION_DURATIONS,
  MOTION_EASES,
  MOTION_PRESETS,
  staggerContainer,
  staggerItem,
} from './motion-presets'

describe('MOTION_PRESETS', () => {
  it('centralizes the documented duration tokens', () => {
    expect(MOTION_DURATIONS.fast).toBe(0.15)
    expect(MOTION_DURATIONS.normal).toBe(0.22)
    expect(MOTION_DURATIONS.slow).toBe(0.32)
  })

  it('reuses the shared enter ease for fade and page presets', () => {
    expect(MOTION_PRESETS.fadeIn.ease).toBe(MOTION_EASES.out)
    expect(MOTION_PRESETS.pageEnter.ease).toBe(MOTION_EASES.out)
  })

  it('exposes stagger item variants with the shared fade transition', () => {
    expect(staggerItem.hidden.opacity).toBe(0)
    expect(staggerItem.show.opacity).toBe(1)
    expect(staggerItem.show.y).toBe(0)
    expect(staggerItem.show.transition.duration).toBe(MOTION_DURATIONS.slow)
  })

  it('builds a stagger container with a configurable delay', () => {
    const variants = staggerContainer({ staggerDelay: 0.1 })
    expect(variants.show.transition.staggerChildren).toBe(0.1)
  })
})
