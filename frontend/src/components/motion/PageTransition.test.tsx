import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PageTransition from './PageTransition'

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

describe('PageTransition', () => {
  it('renders children', () => {
    matchesFlag = false
    render(<PageTransition>Page body</PageTransition>)
    expect(screen.getByText('Page body')).toBeInTheDocument()
  })

  // Must run after the non-reduced tests: the cached preference flips to true
  // and cannot flip back within this module instance.
  it('renders statically without motion styles when reduced motion is preferred', () => {
    matchesFlag = true
    changeHandler?.()
    const { container } = render(<PageTransition>Page body</PageTransition>)
    expect(screen.getByText('Page body')).toBeInTheDocument()
    expect(container.firstElementChild?.getAttribute('style')).toBeNull()
  })
})
