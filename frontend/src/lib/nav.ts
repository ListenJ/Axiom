import type { LucideIcon } from 'lucide-react'
import {
  Home,
  Search,
  Code2,
  Folder,
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
  { id: 'home',      path: '/',          label: 'Home',      shortcut: '1', icon: Home,         mobilePrimary: true,  visible: true },
  { id: 'search',    path: '/search',    label: 'Search',    shortcut: '3', icon: Search,       mobilePrimary: true,  visible: true },
  { id: 'code',      path: '/code',      label: 'Code',      shortcut: '4', icon: Code2,        mobilePrimary: true,  visible: true },
  { id: 'vault',     path: '/vault',     label: 'Vault',     shortcut: '5', icon: Folder,       mobilePrimary: false, visible: true },
  { id: 'settings',  path: '/settings',  label: 'Settings',  shortcut: '6', icon: Settings,     mobilePrimary: false, visible: true },
]

export const VISIBLE_NAV_ITEMS = NAV_ITEMS.filter((i) => i.visible)
export const MOBILE_NAV_ITEMS = VISIBLE_NAV_ITEMS.filter((i) => i.mobilePrimary)