import type { LucideIcon } from 'lucide-react'
import {
  Home,
  Search,
  Code2,
  Folder,
  MessageSquare,
  Boxes,
  Cog,
  GitBranch,
  Settings,
} from 'lucide-react'

export interface NavItem {
  id: string
  path: string
  label: string
  shortcut: string
  icon: LucideIcon
  mobilePrimary: boolean
  /** Whether this page appears in navigation and routing for end users. */
  visible: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home',      path: '/',          label: '首页',   shortcut: '1', icon: Home,          mobilePrimary: true,  visible: true },
  { id: 'chat',      path: '/chat',      label: '对话',   shortcut: '2', icon: MessageSquare, mobilePrimary: true,  visible: true },
  { id: 'search',    path: '/search',    label: '搜索',   shortcut: '3', icon: Search,        mobilePrimary: true,  visible: true },
  { id: 'code',      path: '/code',      label: '代码',   shortcut: '4', icon: Code2,         mobilePrimary: true,  visible: true },
  { id: 'vault',     path: '/vault',     label: '知识',   shortcut: '5', icon: Folder,        mobilePrimary: false, visible: true },
  { id: 'providers', path: '/providers', label: '模型',   shortcut: '6', icon: Boxes,         mobilePrimary: false, visible: true },
  { id: 'settings',  path: '/settings',  label: '系统',   shortcut: '7', icon: Cog,           mobilePrimary: true,  visible: true },
  // 已移出一级导航，路由保留（后续并入系统 hub）；git 保留 g 快捷键
  { id: 'git',       path: '/git',       label: 'Git',    shortcut: 'g', icon: GitBranch,     mobilePrimary: false, visible: false },
  { id: 'tokens',    path: '/tokens',    label: 'Tokens', shortcut: '9', icon: Settings,      mobilePrimary: false, visible: false },
]

export const VISIBLE_NAV_ITEMS = NAV_ITEMS.filter((i) => i.visible)
export const MOBILE_NAV_ITEMS = VISIBLE_NAV_ITEMS.filter((i) => i.mobilePrimary)
