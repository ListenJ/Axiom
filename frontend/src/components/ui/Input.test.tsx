import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Input, Textarea, Select } from './Input'

describe('Input', () => {
  it('renders a basic input', () => {
    render(<Input placeholder="email" />)
    expect(screen.getByPlaceholderText('email')).toBeInTheDocument()
  })

  it('renders a label when provided', () => {
    render(<Input label="Email" id="email" />)
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
  })

  it('fires onChange when user types', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Input label="Name" onChange={onChange} />)
    await user.type(screen.getByLabelText('Name'), 'abc')
    expect(onChange).toHaveBeenCalled()
  })

  it('renders hint when no error is set', () => {
    render(<Input label="x" hint="some hint" />)
    expect(screen.getByText('some hint')).toBeInTheDocument()
  })

  it('renders error instead of hint when error is set', () => {
    render(<Input label="x" hint="some hint" error="some error" />)
    expect(screen.getByText('some error')).toBeInTheDocument()
    expect(screen.queryByText('some hint')).not.toBeInTheDocument()
  })
})

describe('Textarea', () => {
  it('renders textarea with label', () => {
    render(<Textarea label="Notes" />)
    expect(screen.getByLabelText('Notes')).toBeInstanceOf(HTMLTextAreaElement)
  })

  it('fires onChange', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Textarea label="Notes" onChange={onChange} />)
    await user.type(screen.getByLabelText('Notes'), 'hi')
    expect(onChange).toHaveBeenCalled()
  })
})

describe('Select', () => {
  it('renders a select with options', () => {
    render(
      <Select label="Color">
        <option value="r">Red</option>
        <option value="b">Blue</option>
      </Select>
    )
    const select = screen.getByLabelText('Color')
    expect(select).toBeInstanceOf(HTMLSelectElement)
    expect(screen.getByRole('option', { name: 'Red' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Blue' })).toBeInTheDocument()
  })
})
