import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import IntroOutline from './IntroOutline'

// 与 motion 组件测试同款：framer-motion 在模块级缓存 media-query 结果，
// mock 暴露可变 flag + change handler；reduced-motion 用例必须排最后。
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

describe('IntroOutline', () => {
  it('渲染全屏 SVG 线框（8 个描边元素：侧边栏/顶栏/标题/卡片×4/输入框）', () => {
    matchesFlag = false
    const { container } = render(<IntroOutline onDone={() => {}} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
    const rects = container.querySelectorAll('rect')
    expect(rects.length).toBe(8)
  })

  it('勾勒 + 淡出编排结束后触发 onDone', async () => {
    matchesFlag = false
    const onDone = vi.fn()
    render(
      <IntroOutline onDone={onDone} drawDuration={0.01} staggerDelay={0.01} fadeDuration={0.01} />,
    )
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 3000 })
  })

  it('动画期间点击可跳过', () => {
    matchesFlag = false
    const onSkip = vi.fn()
    const { container } = render(<IntroOutline onDone={() => {}} onSkip={onSkip} />)
    fireEvent.click(container.firstElementChild as Element)
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('动画期间按键可跳过', () => {
    matchesFlag = false
    const onSkip = vi.fn()
    render(<IntroOutline onDone={() => {}} onSkip={onSkip} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  // 必须排最后：缓存的 reduced-motion 偏好翻为 true 后无法翻回
  it('reduced-motion 时立即 onDone 且不渲染 SVG', () => {
    matchesFlag = true
    changeHandler?.()
    const onDone = vi.fn()
    const { container } = render(<IntroOutline onDone={onDone} />)
    expect(onDone).toHaveBeenCalled()
    expect(container.querySelector('svg')).toBeNull()
  })
})
