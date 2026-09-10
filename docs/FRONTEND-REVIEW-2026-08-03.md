# 前端针对性评审与跨平台技术路线（2026-08-03）

## 1. 结论摘要

- 当前前端已具备可运行的 Agent 工作台雏形：23 个路由页面、左侧导航 + 顶部 Header + 底部 StatsBar/BottomNav、覆盖式交互终端、HITL 权限审批、设置页 7 个分区、统一 motion 组件库（framer-motion）。
- 主要问题集中在**信息架构与反馈真实感**：导航平铺无分组、设置按钮图标错误（Bell）、侧边栏“系统在线”是静态写死、动效组件各自硬编码 duration/ease、设置页没有调试/诊断入口。
- 跨平台路线确认：**继续使用 React + Vite 单一 Web 代码库，用 Tauri 2 打包 Windows / Linux 桌面与 Android**；iOS 需要 macOS 构建链，本次明确不做。不引入 Flutter / React Native 重写，避免双栈维护成本。

## 2. 现状功能评审

### 2.1 信息架构与布局

| 区域 | 现状 | 问题 |
| --- | --- | --- |
| 侧边栏 | `w-60` 平铺 6 个可见项，底部静态“系统在线”卡片 | 无分组标题，不符合 Agent 控制台常见的“工作区/开发/知识/系统”分层；底部状态为写死文案，可能误导 |
| Header | 品牌 + 搜索 + 终端/快捷键/主题/摘要 + Git 徽标 | “设置”按钮使用 `Bell` 图标，语义错误（Bell 用于通知）；与摘要面板的 FileText 图标区分度不足 |
| 移动底栏 | 对话/搜索/代码/设置 4 项 | 与当前功能一致，保留 |
| 状态栏 | StatsBar 轮询 `/api/stats` | 正常，但健康状态没有统一入口 |
| 终端浮层 | fixed 底部覆盖式，slide-up 动画，桌面 `bottom-8`、移动端 `bottom-24` | 符合近期布局重排结论，保留 |

### 2.2 功能面

- 对话/搜索/代码/知识/模型/系统等核心页面路由完整，`/` 重定向 `/chat`。
- 交互终端：xterm + PTY 会话 + 审批门，主题随全局切换，属仓库内较成熟模块。
- HITL：`useApprovals` 订阅 `/ws`，`ApprovalModal` 全局渲染。
- 设置：7 个分区 + 语义搜索 + 前端镜像目录；模型管理、权限模式、网关配置均已接线后端。
- 动效：`FadeIn / Stagger / PageTransition / Pressable / Reveal` 均已尊重 `prefers-reduced-motion`，但**没有统一预设层与用户偏好**。

### 2.3 问题清单

| 级别 | 问题 | 位置 |
| --- | --- | --- |
| P1 | Header 设置按钮用 `Bell` 图标 | `frontend/src/components/layout/Header.tsx` |
| P1 | 侧边栏底部“系统在线/全部服务在线”为静态假状态 | `frontend/src/components/layout/Sidebar.tsx` |
| P1 | 导航平铺无分组，Agent 控制台 IA 缺失；Git/会话/Token 被隐藏 | `frontend/src/lib/nav.ts` |
| P2 | motion 组件各自硬编码 duration/ease，无统一预设与用户偏好（reduced/off） | `frontend/src/components/motion/*`、`ui/Button.tsx` |
| P2 | 设置页无“调试与检查”分区，健康检查仅散落在 Header/StatsBar | `frontend/src/pages/Settings.tsx` |
| P3 | `FRONTEND-DESIGN.md` 已声明 Motion tokens，但组件未消费统一预设 | `frontend/src/components/motion/*` |

## 3. 跨平台技术路线

### 3.1 决策

保持单仓库单前端栈：

```text
React 19 + Vite 6 + TypeScript + Tailwind 3 + Zustand 5 + framer-motion 12
        │
        ├─ Web（开发/部署：Vite dev server / 静态产物）
        └─ Tauri 2 壳（src-tauri/）
             ├─ Windows / Linux 桌面（bundle.targets: all）
             └─ Android（WebView + Tauri 插件，android.debugApplicationIdSuffix 已配置）
```

### 3.2 理由

- 现有代码已 100% 是 Web 技术栈，Tauri 2 配置已在 `src-tauri/tauri.conf.json` 就绪，`@tauri-apps/api` 与 `plugin-shell` 已在 `frontend/package.json`。
- React Native / Flutter 需要平行实现全部 23 页与交互终端/审批 UI，成本高且破坏单一代码库。
- iOS 应用需要 macOS + Xcode 签名链，按用户要求本次不做；前端按“Web-first”编写（responsive + touch），后续补齐 iOS 时仅增加 Tauri iOS 壳。
- 移动端验证点：BottomNav 4 项、终端浮层 `bottom-24`、触控目标 ≥44px、`pb-safe` 安全区。

### 3.3 保留约束

- 不在 React 侧依赖 Node/系统 API，所有原生能力走 Tauri command 或后端 HTTP。
- 权限/终端/沙箱逻辑仍在后端，前端只消费 HTTP + SSE，Web 与桌面/移动行为一致。

## 4. 本次改造范围

1. 统一动画流程：`lib/motion-presets.ts` 预设层 + `state/useMotionPrefs.ts` 偏好 + `hooks/useMotion.ts` 开关，motion 组件/Button/Collapsible 全部消费；设置页新增“动效强度”与实时预览。
2. 设置页新增“调试与检查”分区：运行环境检测、6 项服务探测、诊断快照复制；同步后端 `src/core/settings-catalog.ts` 契约。
3. 导航重构：`NAV_SECTIONS` 分组（工作区/开发/知识/系统），Git/会话/Token 归位可见，侧边栏按组渲染；Header 设置按钮图标修复；侧边栏底部健康状态接真实 `/health`。
4. 验证：前端 `tsc --noEmit` + `vitest run`；后端设置目录相关测试；操作留痕并推送 `internal211/master`。

## 5. 后续建议（不在本次范围）

- P3 巡检：`StatsBar` 缓存率 emoji（💾）改为 lucide 图标，统一视觉语言。
- ~~路由级 `PageTransition` 目前各页面自行包裹，后续可在 Layout `Outlet` 处统一挂载。~~（已于 2026-08-03 收口轮完成，见第 6 节）
- 设置页分区由硬编码 Collapsible 改为 `SETTING_SECTIONS` 驱动的可配置渲染，减少重复。

## 6. 评审收口轮（2026-08-03 下午，已全部落地并推送）

按"外壳（顶栏系统菜单 + 左栏）/ 画布（聊天区 + 右栏）"分层模型，对评审后残留缺口做收口：

1. **右栏收口聊天页**：`RightToolbar` 从全局 Layout 移入 Chat 页组件树（`cc50db9`），仅聊天区可见，视觉归属画布层。
2. **快捷键单一注册表**：新增 `frontend/src/lib/shortcuts.ts`（声明式注册表 + `matchShortcut`/`shortcutLabel`），useGlobalHotkeys / Header 菜单 / HelpModal 三处硬编码统一消费，HelpModal 补齐 Ctrl+\`、Shift+T 等缺口（`fe2f8e8`）。
3. **会话入口三合为一**：外壳侧栏会话浮层为唯一入口，列表渲染 `chat-title.ts` 自动标题（`sessionListTitle` 回退 id 截断）；Chat 内嵌会话侧栏与鱼眼导航归档删除（`204e721`）。
4. **open-in 走 Tauri 原生**：src-tauri 注册 `tauri-plugin-shell` + `shell:allow-open` 权限，`bundle.targets` 收窄为 nsis/deb/appimage（排除 macOS）；`open-in.ts` 增加 `isTauri()` 分支，Tauri 用 plugin-shell `open()`，Web 保留协议 URL，失败弹 toast 降级（`b8d893b`）。
5. **动画流程统一**：路由级过渡收口到 Layout（`useLocation` + `AnimatePresence mode="wait"`，消费 `MOTION_PRESETS.pageEnter` 与 `useMotion` 三档），各页 `.fade-in` 与 PageTransition 封装移除；新增 `--canvas-hover` token 修正画布工具栏 hover 用外壳色问题；`.glass*` 硬编码 slate 蓝灰改暖棕 token（`8dad563`）。
6. **终端单实例 + 死代码归档**：右栏 terminal 面板改为引导打开全局浮层（Ctrl+\` 同一路径），全应用仅 Layout 浮层一份 PTY 实例；TracePanel / PipelineIndicator / GitStatusBadge / intro 开场动画归档删除，Settings"重播开场动画"入口与前后端目录条目同步移除（`d0d88ad`）。

设置页"调试与检查"分区经复核已满足需求（运行环境识别 + 服务探针 + 诊断快照），本轮未新增。

**验证**：`frontend npm run ci`（tsc + 268 vitest 用例 + build）全绿；`bun test tests/tauri-integration.test.ts` 25 用例、`tests/settings-search.test.ts` 13 用例全绿。e2e（playwright）因本机后端 18789 未运行未执行；`cargo check` 受 `native/Cargo.toml` 预存工作区清单错误阻塞（与本轮无关，待单独修复）。
