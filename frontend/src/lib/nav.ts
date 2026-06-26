import type { LucideIcon } from 'lucide-react'
import {
  Home,
  MessageSquare,
  Search,
  Settings,
} from 'lucide-react'

export interface NavItem {
  id: string
  path: string
  label: string
  shortcut: string
  icon: LucideIcon
  mobilePrimary: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home',     path: '/',          label: 'Home',     shortcut: '1', icon: Home,          mobilePrimary: true },
  { id: 'chat',     path: '/chat',      label: 'Chat',     shortcut: '2', icon: MessageSquare, mobilePrimary: true },
  { id: 'search',   path: '/search',    label: 'Search',   shortcut: '3', icon: Search,        mobilePrimary: true },
  { id: 'settings', path: '/settings',  label: 'Settings', shortcut: ',', icon: Settings,      mobilePrimary: false },
]

export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((i) => i.mobilePrimary)
