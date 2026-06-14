import type { LucideIcon } from 'lucide-react'
import {
  Home,
  MessageSquare,
  Search,
  Code2,
  Bot,
  Compass,
  Folder,
  Network,
  Activity,
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
  { id: 'home',     path: '/',          label: 'Home',     shortcut: '0', icon: Home,         mobilePrimary: true  },
  { id: 'chat',     path: '/chat',      label: 'Chat',     shortcut: '1', icon: MessageSquare, mobilePrimary: true  },
  { id: 'search',   path: '/search',    label: 'Search',   shortcut: '2', icon: Search,       mobilePrimary: true  },
  { id: 'code',     path: '/code',      label: 'Code',     shortcut: '3', icon: Code2,        mobilePrimary: true  },
  { id: 'agents',   path: '/agents',    label: 'Agents',   shortcut: '4', icon: Bot,          mobilePrimary: true  },
  { id: 'router',   path: '/router',    label: 'Router',   shortcut: '5', icon: Compass,      mobilePrimary: false },
  { id: 'vault',    path: '/vault',     label: 'Vault',    shortcut: '6', icon: Folder,       mobilePrimary: false },
  { id: 'kg',       path: '/kg',        label: 'KG',       shortcut: '7', icon: Network,      mobilePrimary: false },
  { id: 'perf',     path: '/perf',      label: 'Perf',     shortcut: '8', icon: Activity,     mobilePrimary: false },
  { id: 'settings', path: '/settings',  label: 'Settings', shortcut: '9', icon: Settings,     mobilePrimary: false },
]

export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((i) => i.mobilePrimary)
