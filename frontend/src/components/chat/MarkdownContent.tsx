/**
 * MarkdownContent — 助手消息 Markdown 渲染（GFM + 代码高亮 + 复制按钮）
 *
 * 安全设计：
 *  - 原始 HTML 一律转义为文本（renderer.html → escape），不渲染任意 HTML
 *  - 链接 href 仅放行 http(s)/mailto/#/相对路径，杜绝 javascript: 注入
 *  - 代码块语言与内容经 hljs 转义后输出，lang 标签转义
 *
 * 性能：marked.parse 结果按 content useMemo 缓存；流式逐 token 重渲染时
 * 仅当内容变化才重新解析。
 */
import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', cpp)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('yaml', yaml)

const SUPPORTED_LANGS = new Set([
  'javascript', 'typescript', 'python', 'bash', 'shell', 'json',
  'xml', 'html', 'css', 'sql', 'go', 'rust', 'java', 'cpp', 'c',
  'markdown', 'yaml',
])

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, '&#96;')
}

/** 仅放行安全协议 / 锚点 / 相对路径；其余返回 null（渲染为纯文本）。 */
function safeUrl(href: string): string | null {
  const trimmed = href.trim()
  if (/^(https?:|mailto:|#|\/)/i.test(trimmed)) return trimmed
  return null
}

const renderer = new marked.Renderer()

// 原始 HTML 块 → 转义为可见文本（防 XSS）
renderer.html = ({ text }) => escapeHtml(text)

// 链接：拦截危险协议（function 表达式以取 this.parser 渲染内联 tokens）
renderer.link = function ({ href, title, tokens }) {
  const parser = (this as unknown as { parser: { parseInline(tokens: unknown[]): string } }).parser
  const url = safeUrl(href ?? '')
  const text = tokens ? parser.parseInline(tokens) : escapeHtml(href ?? '')
  if (!url) return text
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
  return `<a href="${escapeAttr(url)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
}

// 图片：同样拦截危险协议
renderer.image = ({ href, title, text }) => {
  const url = safeUrl(href ?? '')
  if (!url) return escapeHtml(text)
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
  return `<img src="${escapeAttr(url)}" alt="${escapeAttr(text)}"${titleAttr} loading="lazy" />`
}

// 代码块：hljs 高亮 + 语言标签 + 复制按钮
renderer.code = ({ text, lang }) => {
  const rawLang = (lang ?? '').trim().toLowerCase()
  const language = SUPPORTED_LANGS.has(rawLang) ? rawLang : 'plaintext'
  const highlighted =
    language === 'plaintext'
      ? escapeHtml(text)
      : hljs.highlight(text, { language, ignoreIllegals: true }).value
  const label = escapeHtml(rawLang || 'text')
  return [
    `<div class="md-code">`,
    `<div class="md-code__head">`,
    `<span class="md-code__lang">${label}</span>`,
    `<button type="button" class="md-code__copy" data-copy-code>复制</button>`,
    `</div>`,
    `<pre class="md-code__pre"><code class="hljs language-${escapeAttr(language)}">${highlighted}</code></pre>`,
    `</div>`,
  ].join('')
}

export default function MarkdownContent({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement | null>(null)

  const html = useMemo(() => {
    if (!content) return ''
    return marked.parse(content, { gfm: true, breaks: true, renderer }) as string
  }, [content])

  // 代码复制按钮：事件委托，避免每块代码单独绑定
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]')
      if (!btn) return
      const code = btn.parentElement?.querySelector('code')
      const text = code?.textContent ?? ''
      void navigator.clipboard?.writeText(text).then(() => {
        btn.textContent = '已复制'
        setTimeout(() => {
          btn.textContent = '复制'
        }, 1500)
      })
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [html])

  if (!content) return null
  return (
    <div
      ref={ref}
      className="md-content mt-1 text-sm leading-relaxed text-[var(--text)]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
