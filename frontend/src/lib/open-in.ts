/**
 * Open a workspace in external tools (VS Code / Cursor / file manager).
 *
 * 2026-09-28 桌面壳退役（src-tauri 删除，纯 Web 部署）：统一走锚点点击触发
 * 系统自定义协议（vscode://、cursor://、file:///），失败时 toast 提示。
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
 * 打开工作区：Tauri 端走 shell 插件 open() 异步唤起，失败时 toast 提示；
 * Web 端用锚点点击触发系统协议处理，失败时静默。
 * 返回是否成功发起；浏览器是否放行由系统策略决定。
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
