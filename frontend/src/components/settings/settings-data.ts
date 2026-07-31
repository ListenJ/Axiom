/**
 * 设置目录前端镜像 — 与后端 /settings/catalog 契约一致
 *
 * 用途：
 *  1. 设置页分区渲染（图标、标题、默认展开）
 *  2. 后端语义搜索不可用时的客户端关键词兜底
 * 注意：label/desc/keywords 必须与 src/core/settings-catalog.ts 保持同步。
 */
import type { ComponentType } from 'react'
import {
  Palette, Settings2, Database, Box, Bot, Server, Globe,
} from 'lucide-react'

export interface SettingItem {
  key: string
  section: string
  label: string
  desc: string
  keywords: string[]
  type: 'toggle' | 'choice' | 'number' | 'text' | 'action' | 'display' | 'panel'
  source: 'app' | 'local' | 'chat' | 'backend'
}

export interface SettingSectionMeta {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  defaultOpen: boolean
}

export const SETTING_SECTIONS: SettingSectionMeta[] = [
  { id: 'appearance', label: '外观', icon: Palette, defaultOpen: true },
  { id: 'behavior', label: '对话与行为', icon: Settings2, defaultOpen: false },
  { id: 'data', label: '数据', icon: Database, defaultOpen: false },
  { id: 'models', label: '模型', icon: Box, defaultOpen: false },
  { id: 'agent', label: 'Agent 适配', icon: Bot, defaultOpen: false },
  { id: 'gateway', label: '网关', icon: Server, defaultOpen: false },
  { id: 'crawler', label: '抓取', icon: Globe, defaultOpen: false },
]

export const SETTINGS_CATALOG: SettingItem[] = [
  { key: 'appearance.theme', section: 'appearance', label: '主题', desc: '切换深色/浅色主题，选择后立即生效并持久化保存。', keywords: ['深色', '浅色', '夜间', '白天', '外观', '亮色', '暗色'], type: 'choice', source: 'app' },
  { key: 'appearance.intro', section: 'appearance', label: '开场动画', desc: '重新播放首页的勾勒入场动画，用于快速熟悉功能入口布局。', keywords: ['动画', '首页', '重播', '引导', '开场', 'intro'], type: 'action', source: 'app' },
  { key: 'behavior.notifications', section: 'behavior', label: '桌面通知', desc: '启用后，任务完成、审批请求、搜索结果等事件会弹出系统桌面通知。', keywords: ['提醒', '消息', '弹窗', '通知', 'notify'], type: 'toggle', source: 'local' },
  { key: 'privacy.safeMode', section: 'behavior', label: '隐私模式', desc: '本地优先：数据不离开设备。关闭后允许使用云端模型与外部服务。', keywords: ['隐私', '安全', '本地', '脱敏', '私有', '外发'], type: 'toggle', source: 'local' },
  { key: 'chat.showThinking', section: 'behavior', label: '显示思考过程', desc: '在对话中展开显示 Agent 的推理轨迹（reasoning trace），便于理解决策依据；默认关闭。', keywords: ['思考', '推理', 'reasoning', '过程', '轨迹', 'trace'], type: 'toggle', source: 'chat' },
  { key: 'chat.expandFileChanges', section: 'behavior', label: '展开文件修改', desc: '对话默认展开文件变更明细（新建/编辑/删除及 diff）；默认开启。', keywords: ['文件', 'diff', '变更', '修改', '展开'], type: 'toggle', source: 'chat' },
  { key: 'chat.expandToolCalls', section: 'behavior', label: '展开工具调用', desc: '对话默认展开每次工具调用的参数与结果细节；默认关闭，仅显示摘要。', keywords: ['工具', '调用', 'tool', '参数', '结果', '细节'], type: 'toggle', source: 'chat' },
  { key: 'chat.autoAcceptPermissions', section: 'behavior', label: '会话内自动接收权限', desc: '当前会话中 normal 级别的权限请求自动放行；high-risk 高风险操作始终要求手动确认，UI 无法绕过。', keywords: ['权限', '审批', '自动', '确认', '会话', 'HITL'], type: 'toggle', source: 'chat' },
  { key: 'permissions.autoAccept', section: 'behavior', label: '全局权限自动接收', desc: '后端全局权限模式：normal 级操作自动放行，high-risk 永远确认；与 /permissions/mode 一一对应，影响所有会话。', keywords: ['权限', '模式', 'HITL', '全局', '确认', 'auto'], type: 'toggle', source: 'backend' },
  { key: 'data.language', section: 'data', label: '界面语言', desc: '当前界面语言为简体中文，随系统区域设置；暂不支持运行时切换。', keywords: ['语言', '中文', '界面', 'locale', '简体'], type: 'display', source: 'app' },
  { key: 'data.storage', section: 'data', label: '数据存储', desc: '本地 SQLite 数据库 + Obsidian Vault 存储，可选远程同步；路径见 config/axiom.yaml。', keywords: ['存储', '数据库', 'vault', '同步', 'sqlite'], type: 'display', source: 'backend' },
  { key: 'data.cache', section: 'data', label: '清空 API 缓存', desc: '清除搜索与模型的临时缓存条目，释放内存与磁盘空间；不影响会话历史。', keywords: ['缓存', '清除', '清理', '空间', '临时'], type: 'action', source: 'app' },
  { key: 'models.manage', section: 'models', label: '模型管理', desc: '增删模型配置（名称/提供商/模型 ID/层级），改动即时生效；密钥以密文存储。', keywords: ['模型', '提供商', 'API', '添加', '删除', '配置'], type: 'panel', source: 'backend' },
  { key: 'agent.status', section: 'agent', label: 'Agent 可用状态', desc: '展示 OpenCode / Hermes / Kimi Code 等编码 Agent 的安装与可用状态，便于定位缺失组件。', keywords: ['agent', '智能体', '状态', 'opencode', 'hermes', 'kimi'], type: 'display', source: 'backend' },
  { key: 'gateway.port', section: 'gateway', label: '网关端口', desc: 'HTTP 服务监听端口，默认 18789；修改后需重启服务生效。', keywords: ['端口', '网关', '服务', '监听', 'port'], type: 'number', source: 'backend' },
  { key: 'gateway.bind', section: 'gateway', label: '绑定地址', desc: '默认绑定 127.0.0.1 仅本机可访问；公网部署必须配合反向代理与 TLS。', keywords: ['绑定', '地址', 'IP', '公网', '安全', 'bind'], type: 'text', source: 'backend' },
  { key: 'crawler.maxConcurrent', section: 'crawler', label: '最大并发抓取', desc: '控制搜索/爬取的最大并发数（默认 3），防止对目标站点造成压力。', keywords: ['并发', '爬取', '搜索', '限流', '压力', 'concurrent'], type: 'number', source: 'backend' },
]

export function getSectionMeta(id: string): SettingSectionMeta {
  return SETTING_SECTIONS.find((s) => s.id === id) ?? SETTING_SECTIONS[0]
}

/** 客户端关键词兜底（后端不可用时）：label/desc/keywords 子串 + 同义词命中 */
export function clientKeywordSearch(query: string): SettingItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored = SETTINGS_CATALOG.map((item) => {
    const text = [item.label, item.desc, ...item.keywords].join(' ').toLowerCase()
    let score = 0
    if (item.label.toLowerCase().includes(q)) score += 3
    else if (text.includes(q)) score += 2
    for (const kw of item.keywords) {
      if (kw.toLowerCase().includes(q) || q.includes(kw.toLowerCase())) score += 1.5
    }
    return { item, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item)
    .slice(0, 8)
}