/**
 * Chat-level preferences store (Zustand + localStorage persistence).
 *
 * 这些开关对应用户请求的可配置功能：
 *  - showThinking:    思考过程细节显示/隐藏
 *  - expandFileChanges: 文件修改明细的展开/折叠
 *  - autoAcceptPermissions: 权限自动接收/手动确认
 *  - permissionLevel: 输入框三级 Agent 权限（只读 / 询问 / 自动）
 *
 * 注意：autoAcceptPermissions 仅影响"normal"级别操作；"high-risk"
 * 操作（rm -rf /、mkfs 等）由后端 permissions.ts 强制确认，UI
 * 无法绕过。
 */
import { create } from 'zustand'

export type PermissionLevel = 'read' | 'ask' | 'auto'

export interface ChatPrefs {
  /** 显示思考过程细节（reasoning trace） */
  showThinking: boolean
  /** 默认展开文件修改明细 */
  expandFileChanges: boolean
  /** 权限自动接收（仅对 normal 级别生效，high-risk 永远需要确认） */
  autoAcceptPermissions: boolean
  /** 输入框三级 Agent 权限等级（只读 / 询问 / 自动） */
  permissionLevel: PermissionLevel
  /** 默认展开每个会话内的工具调用细节 */
  expandToolCalls: boolean

  setShowThinking: (v: boolean) => void
  setExpandFileChanges: (v: boolean) => void
  setAutoAcceptPermissions: (v: boolean) => void
  setPermissionLevel: (v: PermissionLevel) => void
  setExpandToolCalls: (v: boolean) => void
  toggleShowThinking: () => void
  toggleExpandFileChanges: () => void
  toggleAutoAcceptPermissions: () => void
  toggleExpandToolCalls: () => void
}

const KEYS = {
  showThinking: 'axiom:chat:showThinking',
  expandFileChanges: 'axiom:chat:expandFileChanges',
  autoAcceptPermissions: 'axiom:chat:autoAccept',
  permissionLevel: 'axiom:chat:permissionLevel',
  expandToolCalls: 'axiom:chat:expandToolCalls',
} as const

function readBool(key: string, fallback: boolean): boolean {
  if (typeof localStorage === 'undefined') return fallback
  const v = localStorage.getItem(key)
  if (v === null) return fallback
  return v === 'true'
}

function writeBool(key: string, v: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(key, String(v))
}

function readPermissionLevel(fallback: PermissionLevel): PermissionLevel {
  if (typeof localStorage === 'undefined') return fallback
  const v = localStorage.getItem(KEYS.permissionLevel)
  return v === 'read' || v === 'ask' || v === 'auto' ? v : fallback
}

export const useChatPrefs = create<ChatPrefs>((set, get) => ({
  showThinking: readBool(KEYS.showThinking, false),
  expandFileChanges: readBool(KEYS.expandFileChanges, true),
  autoAcceptPermissions: readBool(KEYS.autoAcceptPermissions, false),
  permissionLevel: readPermissionLevel('ask'),
  expandToolCalls: readBool(KEYS.expandToolCalls, false),

  setShowThinking: (v) => {
    writeBool(KEYS.showThinking, v)
    set({ showThinking: v })
  },
  setExpandFileChanges: (v) => {
    writeBool(KEYS.expandFileChanges, v)
    set({ expandFileChanges: v })
  },
  setAutoAcceptPermissions: (v) => {
    writeBool(KEYS.autoAcceptPermissions, v)
    set({ autoAcceptPermissions: v })
  },
  setPermissionLevel: (v) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEYS.permissionLevel, v)
    // 三级权限与后端自动接收布尔态同步：自动 => true，询问/只读 => false
    writeBool(KEYS.autoAcceptPermissions, v === 'auto')
    set({ permissionLevel: v, autoAcceptPermissions: v === 'auto' })
  },
  setExpandToolCalls: (v) => {
    writeBool(KEYS.expandToolCalls, v)
    set({ expandToolCalls: v })
  },
  toggleShowThinking: () => get().setShowThinking(!get().showThinking),
  toggleExpandFileChanges: () => get().setExpandFileChanges(!get().expandFileChanges),
  toggleAutoAcceptPermissions: () => get().setAutoAcceptPermissions(!get().autoAcceptPermissions),
  toggleExpandToolCalls: () => get().setExpandToolCalls(!get().expandToolCalls),
}))
