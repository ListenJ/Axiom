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
  BarChart3,
  Puzzle,
  Database,
  TrendingUp,
  ScanText,
  Microscope,
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
  { id: 'sessions', path: '/sessions',  label: 'Sessions', shortcut: '8', icon: Database,     mobilePrimary: false },
  { id: 'eval',     path: '/eval',      label: 'Eval',     shortcut: '9', icon: BarChart3,    mobilePrimary: false },
  { id: 'plugins',  path: '/plugins',   label: 'Plugins',  shortcut: '0', icon: Puzzle,       mobilePrimary: false },
  { id: 'trends',   path: '/trends',    label: 'Trends',   shortcut: 't', icon: TrendingUp,   mobilePrimary: false },
  { id: 'ocr',      path: '/ocr',       label: 'OCR',      shortcut: 'o', icon: ScanText,     mobilePrimary: false },
  { id: 'research', path: '/research',  label: 'Research', shortcut: 'r', icon: Microscope,   mobilePrimary: false },
  { id: 'perf',     path: '/perf',      label: 'Perf',     shortcut: '-', icon: Activity,     mobilePrimary: false },
  { id: 'settings', path: '/settings',  label: 'Settings', shortcut: '=', icon: Settings,     mobilePrimary: false },
]

export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((i) => i.mobilePrimary)
