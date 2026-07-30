import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import ApprovalModal from './ApprovalModal'
import { useApprovals, type ApprovalItem } from '@/state/useApprovals'

const sample: ApprovalItem = {
  id: 'a1',
  tool: 'shell.exec',
  args: { cmd: 'rm -rf /tmp/x' },
  risk: 'destructive',
}

describe('ApprovalModal', () => {
  const originalResolve = useApprovals.getState().resolve
  let resolveMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resolveMock = vi.fn().mockResolvedValue(undefined)
    useApprovals.setState({ queue: [], resolve: resolveMock as unknown as typeof originalResolve })
  })

  afterEach(() => {
    vi.useRealTimers()
    useApprovals.setState({ queue: [], resolve: originalResolve })
  })

  it('队列为空时不渲染', () => {
    const { container } = render(<ApprovalModal />)
    expect(container.firstChild).toBeNull()
  })

  it('展示工具名、风险等级与美化的参数 JSON', () => {
    useApprovals.setState({ queue: [sample] })
    render(<ApprovalModal />)
    expect(screen.getByRole('dialog', { name: '审批请求' })).toBeInTheDocument()
    expect(screen.getByText('shell.exec')).toBeInTheDocument()
    expect(screen.getByText('风险：高危')).toBeInTheDocument()
    expect(screen.getByText(/"cmd": "rm -rf \/tmp\/x"/)).toBeInTheDocument()
  })

  it('点击批准调用 resolve(id, true)', async () => {
    useApprovals.setState({ queue: [sample] })
    render(<ApprovalModal />)
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await act(async () => {})
    expect(resolveMock).toHaveBeenCalledWith('a1', true, undefined)
  })

  it('点击拒绝调用 resolve(id, false, reason)', async () => {
    useApprovals.setState({ queue: [sample] })
    render(<ApprovalModal />)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    await act(async () => {})
    expect(resolveMock).toHaveBeenCalledWith('a1', false, '用户拒绝')
  })

  it('15s 倒计时递减并展示剩余秒数', () => {
    vi.useFakeTimers()
    useApprovals.setState({ queue: [sample] })
    render(<ApprovalModal />)
    expect(screen.getByText('剩余 15 秒')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(screen.getByText('剩余 12 秒')).toBeInTheDocument()
  })

  it('倒计时结束自动拒绝且仅触发一次', async () => {
    vi.useFakeTimers()
    useApprovals.setState({ queue: [sample] })
    render(<ApprovalModal />)
    await act(async () => {
      vi.advanceTimersByTime(15_000)
    })
    expect(resolveMock).toHaveBeenCalledTimes(1)
    expect(resolveMock).toHaveBeenCalledWith('a1', false, '前端倒计时超时自动拒绝')
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(resolveMock).toHaveBeenCalledTimes(1)
  })
})
