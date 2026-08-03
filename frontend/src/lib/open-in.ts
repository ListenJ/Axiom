/**
 * Open a workspace in external tools (VS Code / Cursor / file manager).
 *
 * 优先使用自定义协议（vscode://、cursor://、file:///），不依赖尚未注册的
 * Tauri shell 插件；浏览器与 Tauri WebView 均可通过锚点点击触发系统协议处理。
 */

export type OpenTarget = 'vscode' | 'cursor' | 'file-manager'

/** 归一化打开路径：反斜杠转正斜杠、去掉尾部斜杠与 ./ 前缀。 */
export function normalizeOpenPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

function buildIdeUrl(scheme: 'vscode' | 'cursor', path: string): string {
  const p = normalizeOpenPath(path)
  // POSIX 绝对路径去掉开头的 /，使 URL 解析出的 pathname 就是原始路径。
  return `${scheme}://file/${p.startsWith('/') ? p.slice(1) : p}`
}

export function buildVscodeUrl(path: string): string {
  return buildIdeUrl('vscode', path)
}

export function buildCursorUrl(path: string): string {
  return buildIdeUrl('cursor', path)
}

export function buildFileManagerUrl(path: string): string {
  const p = normalizeOpenPath(path)
  return p.startsWith('/') ? `file://${p}` : `file:///${p}`
}

/**
 * 用锚点点击触发系统协议处理（自定义协议 + file://）。
 * 返回是否成功发起；浏览器是否放行由系统策略决定，失败时静默。
 */
export function openWorkspaceIn(target: OpenTarget, path: string): boolean {
  const url =
    target === 'vscode'
      ? buildVscodeUrl(path)
      : target === 'cursor'
        ? buildCursorUrl(path)
        : buildFileManagerUrl(path)
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  return true
}
