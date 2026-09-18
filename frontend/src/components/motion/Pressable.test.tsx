import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Pressable from './Pressable'

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

describe('Pressable', () => {
  it('renders children', () => {
    matchesFlag = false
    render(
      <Pressable>
        <button>Press me</button>
      </Pressable>
    )
    expect(screen.getByRole('button', { name: 'Press me' })).toBeInTheDocument()
  })

  // Must run after the non-reduced tests: the cached preference flips to true
  // and cannot flip back within this module instance.
  it('renders statically without motion styles when reduced motion is preferred', () => {
    matchesFlag = true
    changeHandler?.()
    const { container } = render(<Pressable>plain</Pressable>)
    expect(screen.getByText('plain')).toBeInTheDocument()
    expect(container.firstElementChild?.getAttribute('style')).toBeNull()
  })
})
