/**
 * FisheyeNav 鱼眼导航组件测试
 *
 * 测行为不测实现：渲染圆点数量、点击回调、aria 可达性、
 * 常态窄条容器（不侵入主内容布局）。
 * 几何/动效行为（宽度展开、高亮）由 Playwright 实操验证。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FisheyeNav } from './FisheyeNav'
import type { ChatSession } from '@/components/chat-sessions-sidebar'

const sessions: ChatSession[] = [
  { session_id: 'sess-aaaa', message_count: 3, total_tokens: 1200, last_active: 1720000000000 },
  { session_id: 'sess-bbbb', message_count: 7, total_tokens: 3400, last_active: 1720000000000 },
  { session_id: 'sess-cccc', message_count: 1, total_tokens: 200, last_active: 1720000000000 },
]

describe('FisheyeNav', () => {
  it('为每个会话渲染一个可访问的圆点', () => {
    render(<FisheyeNav sessions={sessions} activeSession={null} onSelect={() => {}} />)
    const dots = screen.getAllByRole('button', { name: /会话/ })
    expect(dots).toHaveLength(3)
  })

  it('点击圆点触发 onSelect 并携带会话 id', () => {
    const onSelect = vi.fn()
    render(<FisheyeNav sessions={sessions} activeSession={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /sess-bbbb/ }))
    expect(onSelect).toHaveBeenCalledWith('sess-bbbb')
  })

  it('活跃会话的圆点带 aria-current 标注', () => {
    render(<FisheyeNav sessions={sessions} activeSession="sess-aaaa" onSelect={() => {}} />)
    const active = screen.getByRole('button', { name: /sess-aaaa/ })
    expect(active.getAttribute('aria-current')).toBe('true')
  })

  it('空会话列表渲染为空容器（不报错）', () => {
    render(<FisheyeNav sessions={[]} activeSession={null} onSelect={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
