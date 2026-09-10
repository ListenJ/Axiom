import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ChatAttachment, type PermissionLevel } from './ChatComposer'
import { useApp } from '@/state/useApp'
import type { ModelOption, ReasoningEffort } from './ModelPicker'

const MODELS: ModelOption[] = [{ id: 'glm', name: 'GLM', provider: 'zhipu' }]

function renderComposer(overrides: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const onChangeSpy = vi.fn()
  const props = {
    value: '',
    onChange: onChangeSpy,
    sending: false,
    disabled: true,
    models: MODELS,
    selectedModel: 'glm',
    reasoningEffort: 'medium' as ReasoningEffort,
    onModelSelect: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    attachments: [] as ChatAttachment[],
    onAttach: vi.fn(),
    onRemoveAttachment: vi.fn(),
    permissionLevel: 'ask' as PermissionLevel,
    onPermissionLevelChange: vi.fn(),
    ...overrides,
  }
  function Wrapper() {
    const [value, setValue] = useState('')
    return (
      <ChatComposer
        {...props}
        value={value}
        onChange={(v) => {
          setValue(v)
          onChangeSpy(v)
        }}
      />
    )
  }
  render(
    <MemoryRouter>
      <Wrapper />
    </MemoryRouter>,
  )
  return { ...props, onChange: onChangeSpy }
}

beforeEach(() => {
  useApp.setState({ terminalOpen: false, helpOpen: false, rightbarOpen: false })
})

describe('ChatComposer slash command menu', () => {
  it('opens a command list when the input starts with "/"', async () => {
    renderComposer()
    const input = screen.getByLabelText('消息输入框')
    await userEvent.type(input, '/')
    expect(screen.getByRole('listbox', { name: '命令面板' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /搜索/ })).toBeInTheDocument()
  })

  it('filters commands while typing', async () => {
    renderComposer()
    const input = screen.getByLabelText('消息输入框')
    await userEvent.type(input, '/term')
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(0)
    expect(options.every((o) => o.textContent?.includes('终端'))).toBe(true)
  })

  it('selects a command with Enter and executes its action', async () => {
    const { onChange } = renderComposer()
    const input = screen.getByLabelText('消息输入框')
    await userEvent.type(input, '/term')
    await userEvent.keyboard('{Enter}')
    expect(useApp.getState().terminalOpen).toBe(true)
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('closes the menu when Escape is pressed', async () => {
    renderComposer()
    const input = screen.getByLabelText('消息输入框')
    await userEvent.type(input, '/')
    expect(screen.getByRole('listbox', { name: '命令面板' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(
      () => expect(screen.queryByRole('listbox', { name: '命令面板' })).not.toBeInTheDocument(),
      { timeout: 2000 },
    )
  })
})
