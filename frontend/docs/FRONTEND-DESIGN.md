# Axiom Frontend Design System

> 状态：自 2026-07-20 起，前端目录正式纳入版本控制。
> 技术栈：React 18 + Vite + Tailwind CSS + Zustand。
> 本设计系统在既有 "Axiom Refined Dark Engineering" 风格基础上，借鉴 Material Design 3 的 token 化、自适应与人机工效原则，形成适合 AI Agent 控制台长期使用的设计框架。

---

## 1. 设计原则

### 1.1 可读性优先（Readability First）
- 暗色模式为默认，降低长时间注视 AI 输出带来的视觉疲劳。
- 正文行高 1.5，代码块行高 1.6，段落最大宽度 70ch。
- 三级文本层级：`--text` / `--text-secondary` / `--text-muted`，避免过多灰阶。

### 1.2 信息密度适中（Information Density）
- 控制台需要同时展示：对话、状态、指标、日志。
- 采用 **2-panel 或 3-panel 自适应布局**；大屏展示侧边栏，小屏折叠为底部导航。
- 卡片内边距 16–24px，列表项高度 48–56px，保证可点击区域。

### 1.3 反馈即时（Immediate Feedback）
- 所有交互 150ms 内给出视觉反馈。
- 加载状态使用骨架屏（ShimmerCard）或脉冲点（pulse-dot），避免生硬白屏。
- 错误、成功、警告统一使用 Toast 与语义色块。

### 1.4 减少认知负荷（Cognitive Load）
- 同一页面最多一个主行动按钮（FAB/Primary Button）。
- 使用图标 + 文字标签的导航，避免纯图标歧义。
- 复杂表单分步骤展示，当前步骤高亮，已完成步骤可回退。

---

## 2. Design Tokens

Tokens 统一放在 `frontend/src/styles/index.css` 的 `:root` 中，按 CSS Custom Properties 管理。禁止在组件中硬编码色值、字号或间距。

### 2.1 Color Roles（语义化命名）

| Token | 用途 | MD3 映射参考 |
|-------|------|-------------|
| `--bg` | 最底层背景 | `surface` |
| `--bg-secondary` | 侧边栏/面板背景 | `surface-container-low` |
| `--bg-tertiary` | 悬浮层/菜单背景 | `surface-container` |
| `--surface` | 卡片/输入框背景 | `surface-container-high` |
| `--surface-hover` | 悬停态 | — |
| `--surface-active` | 按下/激活态 | — |
| `--border` | 静态边框 | `outline-variant` |
| `--border-hover` | 悬停边框 | `outline` |
| `--border-strong` | 聚焦/强调边框 | — |
| `--text` | 主文本 | `on-surface` |
| `--text-secondary` | 次要文本 | `on-surface-variant` |
| `--text-muted` | 禁用/提示文本 | — |
| `--accent` | 高强调操作 | `primary` |
| `--accent-hover` | 悬停强调 | — |
| `--accent-soft` | 强调色淡底 | `primary-container` |
| `--danger` / `--success` / `--warning` / `--info` | 语义色 | `error` / `tertiary` / — |

### 2.2 Typography Scale

| 层级 | 用途 | 大小 | 字重 | 字距 |
|------|------|------|------|------|
| Display | 首页大数字 | 2.5rem | 700 | -0.02em |
| Headline | 页面标题 | 1.5rem | 600 | -0.01em |
| Title | 卡片标题/区块标题 | 1.125rem | 600 | 0 |
| Body Large | 主要正文 | 1rem | 400 | 0 |
| Body Medium | 次要正文 | 0.875rem | 400 | 0.01em |
| Label | 按钮/标签/徽章 | 0.75rem | 500 | 0.02em |

### 2.3 Spacing System（8dp 网格）

| Token | 值 | 用途 |
|-------|-----|------|
| `--space-1` | 4px | 图标与文字间距 |
| `--space-2` | 8px | 紧密内联间距 |
| `--space-3` | 12px | 小组件间隙 |
| `--space-4` | 16px | 卡片内边距/列表项间隙 |
| `--space-5` | 20px | 区块间距 |
| `--space-6` | 24px | 页面内容内边距 |
| `--space-8` | 32px | 大区块间距 |
| `--space-10` | 40px | 章节间距 |

### 2.4 Shape & Elevation

| Token | 值 | 用途 |
|-------|-----|------|
| `--radius-sm` | 6px | 标签/小按钮 |
| `--radius-md` | 12px | 卡片/输入框 |
| `--radius-lg` | 16px | 对话框/大按钮 |
| `--radius-full` | 9999px | 胶囊按钮/头像 |
| `--shadow-sm` / `--shadow` / `--shadow-md` / `--shadow-lg` | — | 按 elevation 层级使用 |

### 2.5 Motion

| Token | 值 | 用途 |
|-------|-----|------|
| `--duration-fast` | 150ms | 悬停、按下 |
| `--duration-normal` | 220ms | 展开、切换 |
| `--duration-slow` | 320ms | 页面过渡 |
| `--ease-out` | cubic-bezier(0.16, 1, 0.3, 1) | 进入 |
| `--ease-in` | cubic-bezier(0.4, 0, 1, 1) | 退出 |

---

## 3. 人机工效规范（Ergonomics & Accessibility）

### 3.1 触摸目标
- 所有可点击元素最小 44×44px；主按钮/导航项建议 48×48px。
- 列表项高度 ≥ 48px，文字与图标居中对齐。
- 相邻可点击元素间距 ≥ 8px，避免误触。

### 3.2 响应式断点

| 断点 | 宽度 | 布局 |
|------|------|------|
| Compact | < 600px | 底部导航 + 单列内容 |
| Medium | 600–1024px | 左侧 rail（72px）+ 内容区 |
| Expanded | 1024–1440px | 左侧 sidebar（240px）+ 内容区 |
| Large | > 1440px | 左侧 sidebar + 内容区居中，最大宽度 1440px |

### 3.3 键盘与焦点
- 所有交互元素支持 `Tab` 顺序。
- `:focus-visible` 使用 2px accent ring + 2px 偏移。
- 模态框打开时焦点锁定，ESC 关闭。

### 3.4 减少动画（Reduced Motion）
- 尊重 `prefers-reduced-motion: reduce`。
- 在该模式下，所有动画时长设为 0.01ms，骨架屏停止 shimmer。

### 3.5 对比度
- 主文本与背景对比度 ≥ 4.5:1。
- 大号文字/图标对比度 ≥ 3:1。
- 错误信息不使用纯红色文字，需配合背景色块或图标。

---

## 4. 组件架构

```
frontend/src/components/
├── ui/                 # 原子组件（Button, Input, Tabs, Toast...）
├── layout/             # 布局组件（Layout, Header, Sidebar, BottomNav）
├── chat-panels.tsx     # Chat 专用复合组件
├── chat-sessions-sidebar.tsx
├── chat-utils.ts
├── provider-sections.tsx
└── index.ts            # 公共导出
```

### 4.1 原子组件约定
- 放在 `components/ui/`，每个组件一个文件 + 一个测试文件。
- 使用 TypeScript interface 定义 props，禁止 `any`。
- 样式优先使用 Tailwind utility + design token，避免内联样式。

### 4.2 页面组件约定
- 放在 `pages/`，每个页面对应一个路由。
- 页面不直接调用 API，统一通过 `frontend/src/lib/api.ts`。
- 页面只负责组合组件与状态，复杂逻辑下沉到 `hooks/` 或 `state/`。

### 4.3 状态管理
- 全局状态使用 Zustand，按领域拆分 store（`useApp`, `useChatPrefs`）。
- 避免在原子组件中直接修改全局状态；通过 props 回调或 hook 封装。

---

## 5. 页面与路由

当前 23 个页面按功能域分组：

| 域 | 页面 |
|----|------|
| 核心 | Home, Chat, Sessions |
| 知识 | Vault, Search, Knowledge, KG, Research |
| 代码 | Code |
| Agent | Agents, Router, Trends |
| 系统 | Providers, Settings, Proxies, OCR, Eval, Perf, Plugins, Tokens |

导航使用 **sidebar（大屏）+ bottom-nav（小屏）** 双模式，由 `Layout.tsx` 根据窗口宽度切换。

---

## 6. API 契约

前端所有后端调用通过 `frontend/src/lib/api.ts` 统一封装。新增端点时必须：

1. 在 `api.ts` 中定义方法、请求类型、响应类型。
2. 确保后端对应路由返回统一包装格式 `{ success: true, data: ... }` 或 `{ error: ... }`。
3. 对 401 响应统一处理：清除本地 token 并跳转登录。
4. 敏感操作（写 vault、安装插件、修改 API key）需先获取 `confirmationId`，再二次提交。

详见 `docs/api-audit-report.md` 与后端 `src/routes/confirmation.ts` 的二次确认机制。

---

## 7. 与 Material Design 3 的关系

本项目未采用 `@material/web`，而是基于 Tailwind 的自定义设计系统。以下 MD3 原则被主动采纳：

1. **Token 化**：颜色、字号、间距、形状、动效全部抽象为 CSS Custom Properties。
2. **语义化颜色**：使用 `primary` / `on-primary` / `surface-container` 等角色命名，支持主题切换。
3. **自适应布局**：按窗口大小在 sidebar / rail / bottom-nav 之间切换。
4. **触摸目标**：所有交互元素 ≥ 44×44px，列表项 ≥ 48px。
5. **减少动画**：支持 `prefers-reduced-motion`。

以下 MD3 特性**暂不引入**，以保持项目既有视觉风格：

- Dynamic color（从壁纸取色）。
- 完全圆角（项目使用 6–16px 受控圆角）。
- Spring-based motion（项目使用 cubic-bezier 过渡）。

---

## 8. 验收标准

- [ ] 新增组件/页面必须全部使用 design token，无硬编码色值。
- [ ] 所有可点击元素最小 44×44px，列表项最小 48px 高。
- [ ] 响应式布局在 375px / 768px / 1440px 三种宽度下无横向滚动、无重叠。
- [ ] 打开 `prefers-reduced-motion: reduce` 后动画基本消失。
- [ ] `npm run lint`（tsc --noEmit）通过。
- [ ] `npm run test`（若存在）通过。

---

## 9. 后续改进项

| 优先级 | 任务 |
|--------|------|
| P1 | 将现有 CSS token 拆分为 `tokens.css` + `base.css` + `utilities.css`，减少 `index.css` 体积。 |
| P1 | 为 `components/ui/` 所有组件补充 accessibility 属性（aria-label、role）。 |
| P2 | 引入 CSS container queries 替代部分 JS 窗口监听。 |
| P2 | 建立组件文档/Storybook 或至少 `*.stories.tsx`。 |
| P3 | 评估是否引入 `@material/web` 部分组件（如 slider、switch）替代自研组件。 |

---

## 10. AXIS Monochrome — 黑白设计系统（2026-08-07 定稿）

> 依据用户约束 + `frontend-design` / `brand-guidelines` / `web-design-guidelines` / `grill-me` skills 确定。
> 核心：朴素黑白、无静态渐变、无分割线（留白分隔）、外壳/工作区用阴影分隔、单小 Logo、光流丝绸背景（小色差）。

### 10.1 设计原则

- **朴素黑白**：亮/暗模式仅使用黑、白、灰阶；禁用暖色与彩色。语义状态用「亮度阶梯 + 图标 + 文案」表达（刻意取舍）。
- **无静态渐变**：表面 / 按钮 / Logo 一律纯色；唯一渐变来自动态「光流」丝绸背景（小色差、缓慢漂移）。
- **无分割线**：侧边栏区块间用留白分隔（`px-3` + `pb-3`）；外壳与工作区用投影分隔，无描边线。
- **单 Logo**：品牌只出现于顶栏（24px 标记 + Axiom 文字）；侧栏顶部仅保留折叠/关闭工具条。

### 10.2 主题 Token（暗 / 亮）

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `--bg` | `#0A0A0A` | `#FFFFFF` | 最底层 / 工作区背景 |
| `--shell-bg` | `#0E0E0E` | `#F5F5F5` | 外壳（侧栏/顶栏/底栏） |
| `--surface` | `#161616` | `#F0F0F0` | 卡片 / 输入框 |
| `--surface-high` | `#1F1F1F` | `#E6E6E6` | 悬浮层 |
| `--surface-highest` | `#2A2A2A` | `#DADADA` | 弹出层 |
| `--text` | `#FFFFFF` | `#111111` | 主文本 |
| `--text-secondary` | `#B5B5B5` | `#555555` | 次要文本 |
| `--text-muted` | `#8A8A8A` | `#777777` | 辅助 / 禁用提示 |
| `--border` | `#262626` | `#E0E0E0` | 输入框 / 表格发丝线 |
| `--accent` | `#FFFFFF` | `#111111` | 强调色（主题反转） |
| `--on-accent` | `#000000` | `#FFFFFF` | 强调色上文字 |
| `--accent-soft` | `rgba(255,255,255,.1)` | `rgba(17,17,17,.06)` | 选中态淡底 |

### 10.3 语义色（亮度阶梯，状态靠图标 + 亮度表达）

| Token | Dark | Light |
|---|---|---|
| `--danger` | `#FFFFFF`（最亮） | `#111111`（最深） |
| `--success` | `#D4D4D4` | `#3A3A3A` |
| `--warning` | `#A8A8A8` | `#5E5E5E` |
| `--info` | `#7A7A7A` | `#7A7A7A` |
| `*-soft` | 白 0.06–0.14 | 黑 0.06–0.08 |

### 10.4 按钮状态矩阵（Button State Matrix）

| 变体 | Dark normal→hover→active | Light normal→hover→active | Disabled / Focus |
|---|---|---|---|
| **Primary**（每页≤1） | 白底黑字 → `#E6E6E6` → `#D4D4D4` | 黑底白字 → `#333` → `#000` | Dark `#2A2A2A`/`#6E6E6E`；Light `#E0E0E0`/`#9A9A9A`；Focus 2px 主题反转 ring + 2px offset |
| **Secondary** | 边框 `#3A3A3A` 灰字 → 白 8% → 白 14% | 边框 `#C8C8C8` 深灰 → 黑 5% → 黑 10% | 灰字 + 浅边框 |
| **Ghost** | 灰字 `#B5B5B5` → 白 8% → 白 14% | 灰字 `#555` → 黑 5% → 黑 10% | `#555` / `#AAA` |
| **Danger** | 白字 + 白边框 50% → 白 14% → 白 20% | 黑字 + 黑边框 40% → 黑 8% → 黑 12% | 同 Ghost 禁用 |

### 10.5 外壳与工作区（阴影分隔，无描边）

- 暗色：shell `#0E0E0E`（略亮）/ canvas `#0A0A0A`（略暗）；`--shell-shadow`（右 10px）与 `--shell-shadow-bottom`（底 4px）。
- 浅色：shell `#F5F5F5` / canvas `#FFFFFF`；`--shell-shadow` `rgba(0,0,0,.26)`、bottom `rgba(0,0,0,.18)`。
- 侧栏区块间仅留白（`px-3` + `pb-3`）；顶栏/侧栏/底栏无 `border-b/t/r`。

### 10.6 光流丝绸背景（silk light flow）

- `.silk-aurora` 三条斜向线性光带（100° / 80° / 95°），暗色峰值 `rgba(255,255,255,.13–.16)`、浅色黑墨 `rgba(0,0,0,.11–.14)`，`blur(30px)`，22s / 28s / 34s 缓慢漂移动画（`light-flow-a/b/c`）。
- 静态丝绸纹理仅保留双向斜纹 + 微噪点（无径向高光）。
- 毛玻璃表面（shell / canvas / card）保持 backdrop-filter 磨砂透出光流。

### 10.7 强调色系统

- 唯一「墨色」预设（暗 = 纯白、亮 = 墨黑）；运行时不再用 JS 覆盖 `--accent`（删除彩色预设，`accents.ts` 仅保留 mono）。
- 设置页强调色卡片改为静态墨色展示。

---

## 11. No-Block Glass — 直接背景设计（2026-08-07 定稿）

> 依据参考图 + `sensenova-u1-fast` 生成亮/暗设计图稿 + SenseNova 审核（`vision-review/mockup-light.png`、`mockup-dark.png`）。

### 11.1 设计原则

- **无卡片实心块**：工作区元素（卡片/容器/统计格）去掉实心色块，直接浮在背景上；背景丝绸光流成为唯一“面”。
- **工作区高模糊**：画布 `backdrop-filter: blur(24px)`（更高模糊比例），内容在高度磨砂的背景上清晰可读。
- **输入框加高 + 圆形图标发送**：输入条 `h-14`（单行），发送/停止为 40px 圆形图标按钮（无文字）。
- **顶栏收缩**：`h-12`（原 h-14），将空间让渡给工作区；侧栏顶部同步 h-12。
- **亮色去纯黑**：亮色强调色 `#111` → `#333`（深灰，仍 ≥12:1），避免大按钮呈“黑色实心块”；新对话主按钮改胶囊（rounded-full）。

### 11.2 表面 Token（直接背景化）

| Token（暗色） | 值 |
|---|---|
| `--bg-secondary` | rgba(17,17,17,.12) |
| `--bg-tertiary` | rgba(26,26,26,.18) |
| `--surface` | rgba(22,22,22,.28) |
| `--surface-high/hover` | rgba(31,31,31,.25) |
| `--surface-highest/active` | rgba(42,42,42,.3) |
| `--canvas-bg-raised` | transparent |
| `.canvas-surface` | blur(24px) |
| `.canvas-raised` | blur(16px) + 透明底 |
| `.card-glass` | background: transparent（保留细边框） |

浅色同步半透明（rgba 白 0.3–0.55）。

### 11.3 审批

- U1-fast 图稿审核：亮色 5/5 达标（无卡片块/输入框/圆形发送/薄顶栏/留白）；暗色高质量。
- 实现终审：**亮色 8.5 / 暗色 8**（SenseNova）；DOM 验证输入 56px、发送圆角 9999、顶栏 48px。
