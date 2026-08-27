import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import Reveal from './Reveal'

// framer-motion caches the media-query result on first use and only updates it
// through a 'change' listener, so the mock exposes a mutable flag + the handler.
let matchesFlag = false
let changeHandler: (() => void) | null = null

window.matchMedia = ((query: string) => ({
  get matches() {
    return matchesFlag
  },
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: (_event: string, cb: () => void) => {
    changeHandler = cb
  },
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

beforeAll(() => {
  // jsdom has no IntersectionObserver; whileInView only needs the API to exist
  class MockIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
})

describe('Reveal', () => {
  it('renders children', () => {
    matchesFlag = false
    render(<Reveal>Revealed</Reveal>)
    expect(screen.getByText('Revealed')).toBeInTheDocument()
  })

  // Must run after the non-reduced tests: the cached preference flips to true
  // and cannot flip back within this module instance.
  it('renders statically without motion styles when reduced motion is preferred', () => {
    matchesFlag = true
    changeHandler?.()
    const { container } = render(<Reveal>Static</Reveal>)
    expect(screen.getByText('Static')).toBeInTheDocument()
    expect(container.firstElementChild?.getAttribute('style')).toBeNull()
  })
})
