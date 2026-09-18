import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import BarChart from './BarChart'

describe('BarChart', () => {
  it('shows empty-state text when data is empty', () => {
    render(<BarChart data={[]} />)
    expect(screen.getByText('暂无数据')).toBeInTheDocument()
  })

  it('renders one bar per data entry', () => {
    const data = [
      { label: 'A', value: 10 },
      { label: 'B', value: 20 },
      { label: 'C', value: 30 },
    ]
    const { container } = render(<BarChart data={data} />)
    // Each bar is a div with a title attribute "Label: Value"
    const bars = container.querySelectorAll('div[title]')
    expect(bars).toHaveLength(3)
    expect(bars[0]).toHaveAttribute('title', 'A: 10')
    expect(bars[2]).toHaveAttribute('title', 'C: 30')
  })

  it('uses provided maxValue as the scaling baseline', () => {
    const data = [
      { label: 'A', value: 1 },
      { label: 'B', value: 1 },
    ]
    const { container } = render(<BarChart data={data} maxValue={10} />)
    // Each bar height style is a percentage; with maxValue=10 and value=1 → 10%
    const bars = container.querySelectorAll<HTMLElement>('div[title]')
    expect(bars[0].style.height).toBe('10%')
  })

  it('falls back to data max when no maxValue given', () => {
    const data = [
      { label: 'A', value: 1 },
      { label: 'B', value: 4 },
    ]
    const { container } = render(<BarChart data={data} />)
    const bars = container.querySelectorAll<HTMLElement>('div[title]')
    // Max is 4, so values are 25% and 100%
    expect(bars[0].style.height).toBe('25%')
    expect(bars[1].style.height).toBe('100%')
  })

  it('sets a sensible accessible label with item count', () => {
    render(<BarChart data={[{ label: 'A', value: 1 }, { label: 'B', value: 2 }]} />)
    expect(screen.getByRole('img', { name: '柱状图，共 2 项' })).toBeInTheDocument()
  })

  it('hides labels when showLabels is false', () => {
    const data = [{ label: 'A', value: 10 }]
    const { container } = render(<BarChart data={data} showLabels={false} />)
    expect(container.textContent).not.toContain('A')
  })
})
