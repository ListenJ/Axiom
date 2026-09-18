import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Collapsible from './Collapsible'

describe('Collapsible', () => {
  it('渲染标题与描述，默认收起内容', () => {
    render(
      <Collapsible title="代理配置" description="出站请求代理设置">
        <p>代理明细</p>
      </Collapsible>,
    )
    expect(screen.getByText('代理配置')).toBeInTheDocument()
    expect(screen.getByText('出站请求代理设置')).toBeInTheDocument()
    expect(screen.queryByText('代理明细')).not.toBeInTheDocument()
  })

  it('点击后展开并展示最新内容', async () => {
    const user = userEvent.setup()
    render(
      <Collapsible title="Token 明细" description="按模型查看调用统计">
        <p>最新调用数据</p>
      </Collapsible>,
    )
    const trigger = screen.getByRole('button', { name: /Token 明细/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    await screen.findByText('最新调用数据')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('支持 defaultOpen 与受控模式', () => {
    const { rerender } = render(
      <Collapsible title="默认展开" defaultOpen>
        <p>内容一</p>
      </Collapsible>,
    )
    expect(screen.getByText('内容一')).toBeInTheDocument()
    rerender(
      <Collapsible title="受控" open={false} onToggle={() => {}}>
        <p>内容二</p>
      </Collapsible>,
    )
    expect(screen.queryByText('内容二')).not.toBeInTheDocument()
  })

  it('触发 onToggle 且键盘可操作', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <Collapsible title="键盘可达" description="Enter 或空格展开" onToggle={onToggle}>
        <p>键盘内容</p>
      </Collapsible>,
    )
    const trigger = screen.getByRole('button', { name: /键盘可达/ })
    await user.tab()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onToggle).toHaveBeenCalledWith(true)
  })
})