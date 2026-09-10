import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MarkdownContent from './MarkdownContent'

describe('MarkdownContent', () => {
  it('renders headings, lists and inline code', () => {
    render(<MarkdownContent content={'# 标题\n\n- 甲\n- 乙\n\n`inline` 代码'} />)
    expect(screen.getByRole('heading', { level: 1, name: '标题' })).toBeInTheDocument()
    expect(screen.getByText('甲')).toBeInTheDocument()
    expect(screen.getByText('乙')).toBeInTheDocument()
    expect(screen.getByText('inline')).toBeInTheDocument()
  })

  it('strips raw HTML to visible text (XSS 防护)', () => {
    const { container } = render(<MarkdownContent content={'<script>window.pwned=1</script>安全'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText(/安全/)).toBeInTheDocument()
  })

  it('blocks javascript: links and renders them as plain text', () => {
    const { container } = render(<MarkdownContent content={'[危险](javascript:alert(1))'} />)
    expect(container.querySelector('a')).toBeNull()
    expect(screen.getByText(/危险/)).toBeInTheDocument()
  })

  it('allows https links with rel=noopener', () => {
    const { container } = render(<MarkdownContent content={'[官网](https://example.com)'} />)
    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.getAttribute('rel')).toContain('noopener')
  })

  it('highlights code blocks and exposes a copy button', () => {
    const { container } = render(<MarkdownContent content={'```ts\nconst a: number = 1;\n```'} />)
    expect(container.querySelector('.md-code')).not.toBeNull()
    expect(container.querySelector('.md-code__lang')?.textContent).toBe('ts')
    expect(container.querySelector('.md-code__copy')).not.toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('const a')
  })

  it('renders GFM tables', () => {
    const { container } = render(<MarkdownContent content={'| a | b |\n|---|---|\n| 1 | 2 |'} />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('returns nothing for empty content', () => {
    const { container } = render(<MarkdownContent content="" />)
    expect(container.firstChild).toBeNull()
  })
})
