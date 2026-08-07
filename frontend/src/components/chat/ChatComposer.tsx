/**
 * ChatComposer — 聊天输入栏（从 pages/Chat.tsx 拆出，保持页面 < 600 行）
 *
 * 结构：输入框 + 发送/停止 + 模型选择圆环（右下角）与思考强度弹窗。
 * 受控组件：value/onChange/sending 由父级传入，send/stop 由父级实现。
 */
import { Send, Square } from 'lucide-react'
import { Button } from '@/components/ui'
import { ModelPicker, type ModelOption, type ReasoningEffort } from '@/components/chat/ModelPicker'

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
}: ChatComposerProps) {
  return (
    <div className="sticky bottom-0 z-20 flex items-end gap-2 p-3 sm:gap-3">
      <textarea
        id="home-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSend()
          }
        }}
        placeholder="输入消息…（Enter 发送 · Shift+Enter 换行）"
        aria-label="消息输入框"
        rows={1}
        className="text-shadow-readable h-14 min-w-0 flex-1 resize-none rounded-xl border-0 bg-transparent px-4 py-3 text-sm text-[var(--text)] outline-none transition-shadow placeholder:text-[var(--text-secondary)] focus:shadow-[0_0_0_2px_var(--accent-ring)]"
      />
      {sending ? (
        <Button
          type="button"
          onClick={onStop}
          variant="secondary"
          aria-label="停止生成"
          className="shrink-0 !size-10 !rounded-full !p-0"
          icon={<Square size={18} />}
        />
      ) : (
        <Button
          onClick={onSend}
          disabled={disabled}
          aria-label="发送"
          className="shrink-0 !size-10 !rounded-full !p-0"
          icon={<Send size={18} />}
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
  )
}
