import { VISIBLE_NAV_ITEMS } from './nav'

/**
 * 键盘快捷键单一注册表（single source of truth）。
 * 消费方：useGlobalHotkeys（匹配分发）、Header 菜单（按键标注）、HelpModal（清单渲染）。
 * 导航类快捷键从 lib/nav.ts 派生，nav.ts 不反向依赖本模块。
 */

export type ShortcutCategory = 'global' | 'nav' | 'menu'

export interface Shortcut {
  id: string
  /** 展示用按键标签，如 `Ctrl+``、`Shift+T`。 */
  label: string
  /** 匹配的 e.key 值（可含别名，如 '`' / 'Backquote'）。 */
  keys: string[]
  /** 描述（HelpModal 展示）。 */
  description: string
  category: ShortcutCategory
  /** 要求按下 Ctrl 或 Cmd(meta)。 */
  ctrlOrMeta?: boolean
  /** 要求不按 Ctrl / Cmd(meta)。 */
  noCtrlMeta?: boolean
  /** 要求按下 Shift。 */
  shift?: boolean
  /** 要求不按 Alt。 */
  noAlt?: boolean
  /** nav 类快捷键的跳转路径。 */
  path?: string
}

/** 判断按键事件是否命中某条快捷键定义。 */
export function matchShortcut(s: Shortcut, e: KeyboardEvent): boolean {
  if (!s.keys.includes(e.key)) return false
  if (s.ctrlOrMeta && !(e.ctrlKey || e.metaKey)) return false
  if (s.noCtrlMeta && (e.ctrlKey || e.metaKey)) return false
  if (s.shift && !e.shiftKey) return false
  if (s.noAlt && e.altKey) return false
  return true
}

export const GLOBAL_SHORTCUTS: Shortcut[] = [
  {
    id: 'theme',
    label: 'Shift+T',
    keys: ['T'],
    shift: true,
    description: '切换深色 / 浅色主题',
    category: 'global',
  },
  {
    id: 'terminal',
    label: 'Ctrl+`',
    keys: ['`', 'Backquote'],
    ctrlOrMeta: true,
    description: '打开 / 关闭终端栏',
    category: 'global',
  },
  {
    id: 'search-slash',
    label: '/',
    keys: ['/'],
    noCtrlMeta: true,
    description: '聚焦搜索',
    category: 'global',
  },
  {
    id: 'search-ctrl-k',
    label: 'Ctrl/Cmd+K',
    keys: ['k'],
    ctrlOrMeta: true,
    description: '聚焦搜索',
    category: 'global',
  },
  {
    id: 'help',
    label: '?',
    keys: ['?'],
    noCtrlMeta: true,
    description: '打开 / 关闭帮助对话框',
    category: 'global',
  },
  {
    id: 'escape',
    label: 'Esc',
    keys: ['Escape'],
    description: '关闭对话框或失焦',
    category: 'global',
  },
]

export const NAV_SHORTCUTS: Shortcut[] = VISIBLE_NAV_ITEMS.map((item) => ({
  id: `nav-${item.id}`,
  label: item.shortcut,
  keys: [item.shortcut],
  noCtrlMeta: true,
  noAlt: true,
  description: `打开 ${item.label}`,
  category: 'nav' as const,
  path: item.path,
}))

export const SHORTCUTS: Shortcut[] = [...NAV_SHORTCUTS, ...GLOBAL_SHORTCUTS]

/** 按 id 取展示用按键标签（Header 菜单标注用）；未知 id 抛错。 */
export function shortcutLabel(id: string): string {
  const s = SHORTCUTS.find((x) => x.id === id)
  if (!s) throw new Error(`unknown shortcut id: ${id}`)
  return s.label
}
