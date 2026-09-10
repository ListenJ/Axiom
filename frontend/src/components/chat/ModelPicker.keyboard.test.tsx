// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'

const models = [
  { id: 'a', name: 'Alpha', provider: 'x' },
  { id: 'b', name: 'Beta', provider: 'y' },
  { id: 'c', name: 'Gamma', provider: 'z' },
]

describe('ModelPicker combobox keyboard', () => {
  it('ArrowDown opens and focuses selected model; Escape closes', async () => {
    render(<ModelPicker models={models} selectedModel="b" onSelect={() => {}} />)
    const combo = screen.getByRole('combobox')
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    await waitFor(() => expect(document.activeElement).toBe(options[1]))
    fireEvent.keyDown(combo, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('ArrowDown/ArrowUp move focus, Home/End jump', async () => {
    render(<ModelPicker models={models} selectedModel="a" onSelect={() => {}} />)
    const combo = screen.getByRole('combobox')
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    const options = screen.getAllByRole('option')
    expect(document.activeElement).toBe(options[1])
    fireEvent.keyDown(combo, { key: 'End' })
    expect(document.activeElement).toBe(options[2])
    fireEvent.keyDown(combo, { key: 'Home' })
    expect(document.activeElement).toBe(options[0])
  })
})
