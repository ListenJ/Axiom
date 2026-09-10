import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import Tabs from './Tabs'

const tabs = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'c', label: 'C' },
]

function ControlledTabs() {
  const [active, setActive] = useState('b')
  return <Tabs tabs={tabs} active={active} onChange={setActive} />
}

describe('Tabs keyboard navigation', () => {
  it('ArrowRight activates next tab, ArrowLeft previous (wrap)', () => {
    render(<ControlledTabs />)
    const list = screen.getByRole('tablist')
    fireEvent.keyDown(list, { key: 'ArrowRight' }) // b -> c
    expect(screen.getByRole('tab', { name: 'C' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(list, { key: 'ArrowRight' }) // c -> a (wrap)
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(list, { key: 'ArrowLeft' }) // a -> c (wrap back)
    expect(screen.getByRole('tab', { name: 'C' }).getAttribute('aria-selected')).toBe('true')
  })
})
