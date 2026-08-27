/**
 * ChatComposer — 聊天输入栏（从 pages/Chat.tsx 拆出，保持页面 < 600 行）
 *
 * 结构：附件行 + 输入行（附件/输入框/发送/模型选择圆环）+ 三级 Agent 权限。
 * 受控组件：value/onChange/sending 由父级传入，send/stop 由父级实现。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Send, Square, Paperclip, Image as ImageIcon, FileText, X,
  ShieldOff, ShieldQuestion, ShieldCheck,
  Search, Code2, GitBranch, Clock, Puzzle, Cog, TerminalSquare, PanelRight, Keyboard, Moon,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { ModelPicker, type ModelOption, type ReasoningEffort } from '@/components/chat/ModelPicker'
import SlashCommandMenu, { type SlashCommand } from '@/components/chat/SlashCommandMenu'
import { useApp } from '@/state/useApp'

export type PermissionLevel = 'read' | 'ask' | 'auto'

export interface ChatAttachment {
  id: string
  name: string
  size: number
  kind: 'image' | 'file'
}

interface ChatComposerProps {
  value: string
  onChange: (v: string) => void
  sending: boolean
  disabled: boolean
  models: ModelOption[]
  selectedModel: string
  reasoningEffort: ReasoningEffort
  onModelSelect: (modelId: string, effort?: ReasoningEffort) => void
  onSend: () => void
  onStop: () => void
  attachments: ChatAttachment[]
  onAttach: (files: FileList | File[]) => void
  onRemoveAttachment: (id: string) => void
  permissionLevel: PermissionLevel
  onPermissionLevelChange: (level: PermissionLevel) => void
}

const PERMISSIONS: Array<{
  id: PermissionLevel
  label: string
  icon: typeof ShieldOff
  title: string
}> = [
  { id: 'read', label: '只读', icon: ShieldOff, title: '只读：Agent 仅分析，不执行写操作' },
  { id: 'ask', label: '询问', icon: ShieldQuestion, title: '询问：每次操作前手动确认' },
  { id: 'auto', label: '自动', icon: ShieldCheck, title: '自动：低风险操作自动放行（高风险仍确认）' },
]

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ChatComposer({
  value,
  onChange,
  sending,
  disabled,
  models,
  selectedModel,
  reasoningEffort,
  onModelSelect,
  onSend,
  onStop,
  attachments,
  onAttach,
  onRemoveAttachment,
  permissionLevel,
  onPermissionLevelChange,
}: ChatComposerProps) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const slashRef = useRef<HTMLDivElement | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const navigate = useNavigate()
  const setTerminalOpen = useApp((s) => s.setTerminalOpen)
  const openRightTool = useApp((s) => s.openRightTool)
  const setHelpOpen = useApp((s) => s.setHelpOpen)
  const toggleTheme = useApp((s) => s.toggleTheme)

  const slashCommands: SlashCommand[] = [
    { id: 'search', label: '/search', description: '搜索知识库与代码', icon: <Search size={14} />, run: () => navigate('/search') },
    { id: 'code', label: '/code', description: '代码索引与检索', icon: <Code2 size={14} />, run: () => navigate('/code') },
    { id: 'git', label: '/git', description: 'Git 状态与提交', icon: <GitBranch size={14} />, run: () => navigate('/git') },
    { id: 'sessions', label: '/sessions', description: '历史会话', icon: <Clock size={14} />, run: () => navigate('/sessions') },
    { id: 'plugins', label: '/plugins', description: 'Skill / MCP 市场', icon: <Puzzle size={14} />, run: () => navigate('/plugins') },
    { id: 'settings', label: '/settings', description: '系统设置', icon: <Cog size={14} />, run: () => navigate('/settings') },
    { id: 'terminal', label: '/terminal', description: '打开终端', icon: <TerminalSquare size={14} />, run: () => setTerminalOpen(true) },
    { id: 'tools', label: '/tools', description: '打开右侧工具台', icon: <PanelRight size={14} />, run: () => openRightTool('summary') },
    { id: 'help', label: '/help', description: '键盘快捷键', icon: <Keyboard size={14} />, run: () => setHelpOpen(true) },
    { id: 'theme', label: '/theme', description: '切换深色 / 浅色主题', icon: <Moon size={14} />, run: () => toggleTheme() },
  ]

  const slashToken = value.startsWith('/') ? value.split(/\s+/)[0] ?? '' : ''
  const slashOpen = !sending && !slashDismissed && slashToken.length > 0
  const slashQuery = slashToken.slice(1).toLowerCase()
  const visibleCommands = slashOpen ? slashCommands.filter((c) => c.label.slice(1).toLowerCase().includes(slashQuery)) : []
  const activeIndex = Math.min(slashIndex, Math.max(0, visibleCommands.length - 1))

  const runCommand = (cmd: SlashCommand) => {
    setSlashIndex(0)
    setSlashDismissed(true)
    onChange('')
    cmd.run()
  }

  // 点击面板外部收起命令菜单（输入继续保留，供用户继续编辑）
  useEffect(() => {
    if (!slashOpen) return
    const onDoc = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) {
        setSlashDismissed(true)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [slashOpen])

  // 自适应高度：内容增长时向上扩展（最高 40vh），清空后回落到基准高度
  const autosize = useCallback(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = Math.max(74, Math.floor(window.innerHeight * 0.4))
    el.style.height = Math.min(el.scrollHeight, max) + 'px'
  }, [])
  useEffect(autosize, [value, autosize])

  return (
    <div ref={slashRef} className="relative sticky bottom-0 z-20 flex flex-col gap-2 p-3 sm:gap-2.5">
      <SlashCommandMenu
        open={slashOpen}
        query={slashQuery}
        commands={visibleCommands}
        selectedIndex={activeIndex}
        onPick={runCommand}
        onClose={() => setSlashDismissed(true)}
      />
      {/* 附件 chips：图片/文档预览（可移除） */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="flex max-w-60 items-center gap-1.5 rounded-full bg-[var(--surface)] py-1 pl-2 pr-1 text-2xs text-[var(--text-secondary)] shadow-[var(--shadow-sm)]"
            >
              {a.kind === 'image' ? (
                <ImageIcon size={12} className="shrink-0 text-[var(--accent)]" />
              ) : (
                <FileText size={12} className="shrink-0 text-[var(--text-muted)]" />
              )}
              <span className="truncate">{a.name}</span>
              <span className="shrink-0 text-[var(--text-muted)]">{formatSize(a.size)}</span>
              <button
                type="button"
                onClick={() => onRemoveAttachment(a.id)}
                aria-label={`移除 ${a.name}`}
                title="移除附件"
                className="press flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 sm:gap-3">
        {/* 附件添加（图片/文档，支持多选） */}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-label="添加附件"
          onChange={(e) => {
            if (e.target.files?.length) onAttach(e.target.files)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label="添加附件"
          title="添加附件（图片 / 文档）"
          className="press flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Paperclip size={17} />
        </button>

        <textarea
          ref={taRef}
          id="home-input"
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setSlashDismissed(false)
            setSlashIndex(0)
          }}
          onKeyDown={(e) => {
            if (slashOpen && visibleCommands.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSlashIndex((i) => (i + 1) % visibleCommands.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashIndex((i) => (i - 1 + visibleCommands.length) % visibleCommands.length)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                runCommand(visibleCommands[activeIndex] ?? visibleCommands[0]!)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setSlashDismissed(true)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          placeholder="输入消息…（Enter 发送 · Shift+Enter 换行）"
          aria-label="消息输入框"
          rows={1}
          className="text-shadow-readable min-h-[4.6rem] max-h-[40vh] min-w-0 flex-1 resize-none overflow-y-auto rounded-2xl border-0 bg-transparent px-4 py-3.5 text-sm leading-relaxed text-[var(--text)] outline-none transition-shadow placeholder:text-[var(--text-secondary)] focus:shadow-[0_0_0_2px_var(--accent-ring)]"
        />
        {sending ? (
          <Button
            type="button"
            onClick={onStop}
            variant="secondary"
            aria-label="停止生成"
            className="shrink-0 !size-11 !rounded-full !p-0"
            icon={<Square size={18} />}
          />
        ) : (
          <Button
            onClick={onSend}
            disabled={disabled}
            aria-label="发送"
            className="shrink-0 !size-11 !rounded-full !p-0 !shadow-[var(--shadow)]"
            icon={<Send size={20} />}
          />
        )}
        {/* 模型选择圆环（右下角）+ 思考强度弹窗 */}
        <ModelPicker
          models={models}
          selectedModel={selectedModel}
          effort={reasoningEffort}
          onSelect={onModelSelect}
        />
      </div>

      {/* 三级 Agent 权限等级（只读 / 询问 / 自动） */}
      <div className="flex items-center gap-2 px-1">
        <div
          role="radiogroup"
          aria-label="Agent 权限等级"
          className="flex items-center gap-0.5 rounded-full bg-[var(--surface)] p-0.5 shadow-[var(--shadow-sm)]"
        >
          {PERMISSIONS.map((p) => {
            const Icon = p.icon
            const active = permissionLevel === p.id
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onPermissionLevelChange(p.id)}
                title={p.title}
                className={`press flex h-7 items-center gap-1 rounded-full px-2.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  active
                    ? 'bg-[var(--accent)] font-medium text-[var(--on-accent)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                <Icon size={11} />
                {p.label}
              </button>
            )
          })}
        </div>
        <span className="text-xs text-[var(--text-muted)]">Agent 权限</span>
      </div>
    </div>
  )
}
