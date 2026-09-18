import type { LucideIcon } from 'lucide-react'
import {
  Search,
  Code2,
  Folder,
  MessageSquare,
  Boxes,
  Cog,
  GitBranch,
  Settings,
  Clock,
} from 'lucide-react'

export type NavSectionId = 'workspace' | 'knowledge' | 'dev' | 'system'

export interface NavSection {
  id: NavSectionId
  label: string
}

export interface NavItem {
  id: string
  path: string
  label: string
  shortcut: string
  icon: LucideIcon
  mobilePrimary: boolean
  /** Whether this page appears in navigation and routing for end users. */
  visible: boolean
  /** Sidebar grouping section. */
  section: NavSectionId
}

export const NAV_SECTIONS: NavSection[] = [
  { id: 'workspace', label: '工作区' },
  { id: 'knowledge', label: '知识与模型' },
  { id: 'dev', label: '开发' },
  { id: 'system', label: '系统' },
]

export const NAV_ITEMS: NavItem[] = [
  { id: 'chat',      path: '/chat',      label: '对话',   shortcut: '1', icon: MessageSquare, mobilePrimary: true,  visible: true, section: 'workspace' },
  { id: 'search',    path: '/search',    label: '搜索',   shortcut: '2', icon: Search,        mobilePrimary: true,  visible: true, section: 'workspace' },
  { id: 'code',      path: '/code',      label: '代码',   shortcut: '3', icon: Code2,         mobilePrimary: true,  visible: true, section: 'workspace' },
  { id: 'vault',     path: '/vault',     label: '知识',   shortcut: '4', icon: Folder,        mobilePrimary: false, visible: true, section: 'knowledge' },
  { id: 'providers', path: '/providers', label: '模型',   shortcut: '5', icon: Boxes,         mobilePrimary: false, visible: true, section: 'knowledge' },
  { id: 'git',       path: '/git',       label: 'Git',    shortcut: 'g', icon: GitBranch,     mobilePrimary: false, visible: true, section: 'dev' },
  { id: 'sessions',  path: '/sessions',  label: '会话',   shortcut: '7', icon: Clock,         mobilePrimary: false, visible: true, section: 'system' },
  { id: 'tokens',    path: '/tokens',    label: 'Tokens', shortcut: '9', icon: Settings,      mobilePrimary: false, visible: true, section: 'system' },
  { id: 'settings',  path: '/settings',  label: '系统',   shortcut: '6', icon: Cog,           mobilePrimary: true,  visible: true, section: 'system' },
]

export const VISIBLE_NAV_ITEMS = NAV_ITEMS.filter((i) => i.visible)
export const MOBILE_NAV_ITEMS = VISIBLE_NAV_ITEMS.filter((i) => i.mobilePrimary)