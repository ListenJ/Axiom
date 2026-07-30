import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useApprovals, handleApprovalWsMessage, type ApprovalItem } from './useApprovals'
import { api } from '@/lib/api'

const sample: ApprovalItem = { id: 'a1', tool: 'shell.exec', args: { cmd: 'ls' }, risk: 'destructive' }

function requestedEvent(item: Partial<ApprovalItem> & { id: string; tool: string }): string {
  return JSON.stringify({ type: 'approval.requested', payload: item, timestamp: new Date().toISOString() })
}

describe('useApprovals', () => {
  beforeEach(() => {
    useApprovals.setState({ queue: [], connected: false })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('approval.requested 事件入队', () => {
    handleApprovalWsMessage(requestedEvent(sample))
    const queue = useApprovals.getState().queue
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ id: 'a1', tool: 'shell.exec', risk: 'destructive' })
  })

  it('同一 id 重复事件不重复入队', () => {
    handleApprovalWsMessage(requestedEvent(sample))
    handleApprovalWsMessage(requestedEvent(sample))
    expect(useApprovals.getState().queue).toHaveLength(1)
  })

  it('非法 risk 降级为 unknown', () => {
    handleApprovalWsMessage(requestedEvent({ id: 'a2', tool: 'fs.write', risk: 'bogus' as ApprovalItem['risk'] }))
    expect(useApprovals.getState().queue[0]?.risk).toBe('unknown')
  })

  it('approval.resolved 事件出队', () => {
    handleApprovalWsMessage(requestedEvent(sample))
    handleApprovalWsMessage(JSON.stringify({ type: 'approval.resolved', payload: { id: 'a1', approved: true } }))
    expect(useApprovals.getState().queue).toHaveLength(0)
  })

  it('忽略畸形 JSON 与未知事件类型', () => {
    handleApprovalWsMessage('not-json')
    handleApprovalWsMessage(JSON.stringify({ type: 'chat.token', payload: { id: 'x' } }))
    handleApprovalWsMessage(JSON.stringify({ type: 'approval.requested', payload: { tool: 'no-id' } }))
    expect(useApprovals.getState().queue).toHaveLength(0)
  })

  it('resolve 调用正确的 REST 端点并出队', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ success: true })
    useApprovals.getState().enqueue(sample)

    await useApprovals.getState().resolve('a1', true)

    expect(post).toHaveBeenCalledWith('/approvals/a1/resolve', { approved: true })
    expect(useApprovals.getState().queue).toHaveLength(0)
  })

  it('resolve 拒绝时携带 reason', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ success: true })
    await useApprovals.getState().resolve('a9', false, '用户拒绝')
    expect(post).toHaveBeenCalledWith('/approvals/a9/resolve', { approved: false, reason: '用户拒绝' })
  })

  it('resolve 请求失败时保留队列并抛错', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('404'))
    useApprovals.getState().enqueue(sample)

    await expect(useApprovals.getState().resolve('a1', true)).rejects.toThrow('404')
    expect(useApprovals.getState().queue).toHaveLength(1)
  })
})
