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
  BookCheck,
  Globe,
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
  { id: 'chat',      path: '/chat',      label: 'Chat',      shortcut: '2', icon: MessageSquare, mobilePrimary: true,  visible: true },
  { id: 'search',    path: '/search',    label: 'Search',    shortcut: '3', icon: Search,       mobilePrimary: true,  visible: true },
  { id: 'code',      path: '/code',      label: 'Code',      shortcut: '4', icon: Code2,        mobilePrimary: true,  visible: true },
  { id: 'agents',    path: '/agents',    label: 'Agents',    shortcut: '5', icon: Bot,          mobilePrimary: true,  visible: true },
  { id: 'router',    path: '/router',    label: 'Router',    shortcut: '6', icon: Compass,      mobilePrimary: false, visible: true },
  { id: 'vault',     path: '/vault',     label: 'Vault',     shortcut: '7', icon: Folder,       mobilePrimary: false, visible: true },
  { id: 'kg',        path: '/kg',        label: 'KG',        shortcut: '8', icon: Network,      mobilePrimary: false, visible: true },
  { id: 'sessions',  path: '/sessions',  label: 'Sessions',  shortcut: '9', icon: Database,     mobilePrimary: false, visible: true },
  { id: 'eval',      path: '/eval',      label: 'Eval',      shortcut: 'e', icon: BarChart3,    mobilePrimary: false, visible: true },
  { id: 'plugins',   path: '/plugins',   label: 'Plugins',   shortcut: 'p', icon: Puzzle,       mobilePrimary: false, visible: true },
  { id: 'trends',    path: '/trends',    label: 'Trends',    shortcut: 't', icon: TrendingUp,   mobilePrimary: false, visible: false },
  { id: 'ocr',       path: '/ocr',       label: 'OCR',       shortcut: 'o', icon: ScanText,     mobilePrimary: false, visible: true },
  { id: 'research',  path: '/research',  label: 'Research',  shortcut: 'r', icon: Microscope,   mobilePrimary: false, visible: true },
  { id: 'knowledge', path: '/knowledge', label: 'Review',    shortcut: 'k', icon: BookCheck,    mobilePrimary: false, visible: true },
  { id: 'proxies',   path: '/proxies',   label: 'Proxies',   shortcut: 'x', icon: Globe,        mobilePrimary: false, visible: false },
  { id: 'perf',      path: '/perf',      label: 'Perf',      shortcut: '-', icon: Activity,     mobilePrimary: false, visible: false },
  { id: 'settings',  path: '/settings',  label: 'Settings',  shortcut: '=', icon: Settings,     mobilePrimary: false, visible: true },
]

export const VISIBLE_NAV_ITEMS = NAV_ITEMS.filter((i) => i.visible)
export const MOBILE_NAV_ITEMS = VISIBLE_NAV_ITEMS.filter((i) => i.mobilePrimary)