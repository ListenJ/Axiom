/**
 * TerminalPanel 终端栏组件测试
 *
 * 行为：输入命令回车执行；展示输出（stdout/stderr/退出码）；
 * 执行期间禁用输入；清空按钮；命令历史（↑/↓ 导航）。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TerminalPanel } from './TerminalPanel'

describe('TerminalPanel', () => {
  it('输入命令回车后调用 onExecute 并清空输入', () => {
    const onExecute = vi.fn().mockResolvedValue({ success: true, stdout: 'ok', stderr: '', exitCode: 0 })
    render(<TerminalPanel onExecute={onExecute} />)
    const input = screen.getByRole('textbox', { name: '终端命令' })
    fireEvent.change(input, { target: { value: 'ls -la' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onExecute).toHaveBeenCalledWith('ls -la')
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('执行成功后展示 stdout', async () => {
    const onExecute = vi.fn().mockResolvedValue({ success: true, stdout: 'file1\nfile2', stderr: '', exitCode: 0 })
    render(<TerminalPanel onExecute={onExecute} />)
    const input = screen.getByRole('textbox', { name: '终端命令' })
    fireEvent.change(input, { target: { value: 'ls' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText(/file1/)).toBeVisible())
    expect(screen.getByText(/file2/)).toBeVisible()
  })

  it('执行失败时展示 stderr 与退出码', async () => {
    const onExecute = vi.fn().mockResolvedValue({ success: false, stdout: '', stderr: 'command not found', exitCode: 127 })
    render(<TerminalPanel onExecute={onExecute} />)
    const input = screen.getByRole('textbox', { name: '终端命令' })
    fireEvent.change(input, { target: { value: 'nonexistent' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText(/command not found/)).toBeVisible())
    expect(screen.getByText(/exit 127/)).toBeVisible()
  })

  it('执行期间输入框禁用（防止重复提交）', async () => {
    let resolve!: (v: unknown) => void
    const onExecute = vi.fn().mockImplementation(() => new Promise((r) => { resolve = r }))
    render(<TerminalPanel onExecute={onExecute} />)
    const input = screen.getByRole('textbox', { name: '终端命令' })
    fireEvent.change(input, { target: { value: 'sleep 1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLInputElement).disabled).toBe(true)
    resolve({ success: true, stdout: '', stderr: '', exitCode: 0 })
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false))
  })

  it('↑/↓ 键在命令历史中导航', async () => {
    const onExecute = vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 })
    render(<TerminalPanel onExecute={onExecute} />)
    const input = screen.getByRole('textbox', { name: '终端命令' })
    fireEvent.change(input, { target: { value: 'git status' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'ls' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false))
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect((input as HTMLInputElement).value).toBe('ls')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect((input as HTMLInputElement).value).toBe('git status')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect((input as HTMLInputElement).value).toBe('ls')
  })

  it('清空按钮清除输出', async () => {
    const onExecute = vi.fn().mockResolvedValue({ success: true, stdout: 'hello', stderr: '', exitCode: 0 })
    render(<TerminalPanel onExecute={onExecute} />)
    const input = screen.getByRole('textbox', { name: '终端命令' })
    fireEvent.change(input, { target: { value: 'echo hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('hello', { exact: true })).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: '清空终端' }))
    expect(screen.queryByText('hello', { exact: true })).toBeNull()
  })
})
