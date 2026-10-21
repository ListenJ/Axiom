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
  Activity, Palette, Settings2, Database, Box, Bot, Server, Globe, Search, Shield,
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
  { id: 'search', label: '搜索', icon: Search, defaultOpen: false },
  { id: 'security', label: '安全', icon: Shield, defaultOpen: false },
  { id: 'crawler', label: '抓取', icon: Globe, defaultOpen: false },
  { id: 'diagnostics', label: '调试与检查', icon: Activity, defaultOpen: false },
]

export const SETTINGS_CATALOG: SettingItem[] = [
  { key: 'appearance.theme', section: 'appearance', label: '主题', desc: '切换深色/浅色主题，选择后立即生效并持久化保存。', keywords: ['深色', '浅色', '夜间', '白天', '外观', '亮色', '暗色'], type: 'choice', source: 'app' },
  { key: 'appearance.motion', section: 'appearance', label: '动效强度', desc: '控制界面动画强度：跟随系统、减少动画或完全关闭；影响页面过渡、折叠与按压反馈。', keywords: ['动画', '动效', '过渡', '减少', '关闭', 'motion', 'reduced'], type: 'choice', source: 'app' },
  { key: 'appearance.accent', section: 'appearance', label: '强调色', desc: '界面强调色预设（琥珀/天青/紫罗兰/翡翠/玫瑰/靛蓝），深色浅色各自适配，选择后立即生效。', keywords: ['颜色', '强调', '主题色', 'accent', '色板', '自定义'], type: 'choice', source: 'app' },
  // 2026-10-22：这两个是**前端本地外观偏好**（层级配色 / 面板透明度），后端 catalog 不包含它们。
  // 之前 UI 里有控件、catalog 里没有条目 ⇒ 客户端兜底搜索永远搜不到，且 handleSearchSelect 的
  // 高亮 key 与目录脱节（永不命中）。补进目录后高亮与兜底搜索都能工作。
  { key: 'appearance.layer', section: 'appearance', label: '层级配色', desc: '为不同信息层级（外壳/面板/浮层）选择沉稳或高对比的配色方案。', keywords: ['层级', '配色', '颜色', '对比', '外壳', '面板'], type: 'choice', source: 'app' },
  { key: 'appearance.panelOpacity', section: 'appearance', label: '面板透明度', desc: '调整浮层/侧栏面板的背景不透明度，兼顾可读性与空间感。', keywords: ['透明度', '不透明', '面板', '浮层', '背景', 'opacity'], type: 'choice', source: 'app' },
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
  // 2026-10-22 补齐（前后端目录漂移修复）：以下 5 条在后端 src/core/settings-catalog.ts 中存在，
  // 前端此前缺分区与条目 ⇒ 设置搜索命中后点击无任何可见反馈（“点不动”）。此处按后端契约同步。
  { key: 'search.engines', section: 'search', label: '搜索引擎池', desc: '管理用于联网检索的引擎：匿名引擎（DuckDuckGo / Bing / 维基 / arXiv / Crossref / Hacker News 等）无需 Key 即可用；标有「需 Key」的服务（Tavily / Brave / Jina / Google CSE / Serper）填入密钥后启用。改动写回 config/web-search.yaml。', keywords: ['搜索', '引擎', 'search', 'engine', 'duckduckgo', 'bing', 'tavily', 'brave', '匿名', '免key'], type: 'panel', source: 'backend' },
  { key: 'search.searxng', section: 'search', label: 'SearXNG 自建实例', desc: '自建元搜索引擎：聚合多家上游、不受第三方限流与条款影响，是搜索池的首选通道。开启「安装时自动部署」会随产品在本机拉起本地实例（默认 127.0.0.1:8080）；未部署时该引擎自动跳过，不影响其他引擎。', keywords: ['searxng', '自建', '元搜索', '实例', '部署', '8080', '聚合'], type: 'panel', source: 'backend' },
  { key: 'search.aggregate', section: 'search', label: '结果聚合与缓存', desc: '控制返回条数、单引擎候选数、单引擎超时、URL 去重、相同查询的缓存时长与相关性过滤阈值。缓存可显著减少对外请求；超时过短会让慢引擎（如 arXiv）总是拿不到结果。', keywords: ['聚合', '条数', '超时', '缓存', '去重', '相关性', 'aggregate', 'ttl'], type: 'panel', source: 'backend' },
  { key: 'search.policy', section: 'search', label: '抓取礼貌策略', desc: '对目标站点的请求约束：是否遵守 robots.txt、最大并发数、同一站点请求间隔与 User-Agent。默认面向低并发个人/研究用途；调高并发可能触发对方封禁。', keywords: ['robots', '并发', '限流', '间隔', 'ua', '礼貌', '爬取'], type: 'panel', source: 'backend' },
  { key: 'security.approver', section: 'security', label: '高危操作审批模型', desc: '沙箱执行高危命令（如 rm -rf、mkfs 等）时，由一个独立模型复核后才放行。审批模型跟随你的模型配置：只配一个模型时系统直接用它；配多个时可在此指定专门审批模型，不指定则按 review → decision 角色顺序自动挑选。审批人不可用时 fail-closed 一律拒绝。', keywords: ['审批', '审稿', '高危', '沙箱', 'approver', 'review', '模型', 'rm -rf', 'fail-closed'], type: 'panel', source: 'backend' },
  { key: 'crawler.maxConcurrent', section: 'crawler', label: '最大并发抓取', desc: '控制搜索/爬取的最大并发数（默认 3），防止对目标站点造成压力。', keywords: ['并发', '爬取', '搜索', '限流', '压力', 'concurrent'], type: 'number', source: 'backend' },
  { key: 'diagnostics.health', section: 'diagnostics', label: '服务健康检查', desc: '检查网关、沙箱、OCR、代码图谱与 Agent 等核心服务的可用状态，帮助定位故障模块。', keywords: ['健康', '检查', '诊断', '服务', '状态', 'health'], type: 'display', source: 'backend' },
  { key: 'diagnostics.runtime', section: 'diagnostics', label: '运行环境', desc: '识别 Web / Tauri 桌面 / Android 运行环境与视口、触控等平台信息，用于跨平台排障。', keywords: ['环境', '运行', '平台', 'tauri', 'android', 'web', '跨平台'], type: 'display', source: 'app' },
  { key: 'diagnostics.snapshot', section: 'diagnostics', label: '诊断快照', desc: '一键汇总运行环境与服务检查结果为可复制的文本，便于提交到问题反馈。', keywords: ['快照', '导出', '复制', '反馈', '诊断', 'snapshot'], type: 'action', source: 'app' },
  { key: 'perf.runtime', section: 'diagnostics', label: '性能指标', desc: '运行时 CPU / 内存 / RPS / P95 与原生模块统计，定位性能瓶颈。', keywords: ['性能', 'cpu', '内存', 'rps', '延迟', '指标', 'perf'], type: 'panel', source: 'backend' },
  { key: 'tokens.usage', section: 'diagnostics', label: 'Token 用量', desc: '近 7 天模型调用、Token 消耗与缓存命中率统计。', keywords: ['token', '用量', '消耗', '缓存', '调用', '统计'], type: 'panel', source: 'backend' },
  { key: 'router.status', section: 'diagnostics', label: '模型路由', desc: '模型路由健康状态、Token 使用与路由状态检查。', keywords: ['路由', 'router', '健康', '模型', '状态'], type: 'panel', source: 'backend' },
  { key: 'proxies.status', section: 'diagnostics', label: '代理状态', desc: '出站代理配置与活跃状态（只读），用于爬取通道排障。', keywords: ['代理', 'proxy', '爬取', '出站', '状态'], type: 'panel', source: 'backend' },
  { key: 'eval.results', section: 'diagnostics', label: '模型评估', desc: '模型评估结果、动态分配与模型清单，可触发快速评估。', keywords: ['评估', 'eval', '模型', '得分', '分配'], type: 'panel', source: 'backend' },
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