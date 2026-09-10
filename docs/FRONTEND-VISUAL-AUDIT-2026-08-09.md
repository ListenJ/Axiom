# 前端视觉与交互审核及方案 C 实施报告 — 2026-08-09

> 日期：2026-08-09 ｜ 基线 commit：`ee065ad`（master）
> 方法：taste-skill / design-taste-frontend 的 audit-first 预检 + Vercel Web Interface Guidelines + 代码/DOM 证据复核；本项目是产品工作台而非落地页，因此只借用其审计清单和反模板原则，未按 landing-page 库重构页面。
> 状态：方案 C 已完成实施并通过 SenseNova 复评；本节报告先记录基线，文末补充实施结果。

## 摘要

- 前端 43 个测试文件、282 个用例全部通过；生产构建成功（Vite 6.4.3，6.50s）。
- 终端、右侧工具台、侧栏、Collapsible、斜杠命令菜单的主要进入/退出机制基本成立：终端关闭时卸载并关闭 PTY 会话；右栏桌面模式收起后使用 `inert` + `aria-hidden`；页面切换使用 `AnimatePresence mode="wait"`。
- 发现 3 个 P1 级问题：多处按钮/输入框只有 `outline-none` 没有可感知焦点环；终端恢复的高度未按当前视口上限钳制；移动端侧栏关闭后仍在 DOM 且可聚焦，且缺少 dialog 语义与焦点圈定。
- 发现若干 P2/P3 问题：侧栏工作区手风琴动画未尊重 `prefers-reduced-motion`；可见文案混用 `...` 与 `…`；日期/数字本地化格式不统一；无 Skip Link；帮助/审批弹窗无焦点管理。
- SenseNova 视觉模型本轮未复跑：当前会话没有 SenseNova API Key/provider 配置。已有 2026-08-06 的 SenseNova 视觉审核记录可作历史基线。

## 一、已验证的进入/退出机制

| 区域 | 状态 | 证据 |
|---|---|---|
| 终端开合 | 基本通过 | [Layout.tsx](frontend/src/components/layout/Layout.tsx:91) 用 `AnimatePresence` 控制；`TerminalPanel` 卸载时通过 [PtyTerminal.dispose](frontend/src/lib/pty-terminal.ts:100) 关闭 SSE 和 PTY 会话 |
| 右侧工具台 | 通过 | [RightToolbar.tsx](frontend/src/components/rightbar/RightToolbar.tsx:144) 桌面收起时 `inert` + `aria-hidden`；移动端使用 `AnimatePresence` 卸载抽屉 |
| 侧栏折叠 | 部分通过 | [Sidebar.tsx](frontend/src/components/layout/Sidebar.tsx:319) 桌面宽度折叠、移动端平移退出；但移动端关闭后仍可被键盘聚焦，见 P1-3 |
| Collapsible | 通过 | [Collapsible.tsx](frontend/src/components/ui/Collapsible.tsx:33) 使用 `height: auto` 动画、`aria-expanded`、`aria-controls`、`role="region"` |
| 斜杠命令菜单 | 通过 | [ChatComposer.tsx](frontend/src/components/chat/ChatComposer.tsx:104) 输入 `/` 即打开；支持方向键、Enter、Esc，命令执行后清空输入 |
| 页面切换 | 通过 | [Layout.tsx](frontend/src/components/layout/Layout.tsx:70) 全站统一 `mode="wait"`，并受 `useMotion` 开关控制 |

## 二、P1 问题

### P1-1 键盘焦点在多个交互控件上不可见

大量控件写了 `focus:outline-none`，但缺少 `focus-visible:ring-*`。键盘用户按 Tab 后无法判断焦点位置。

主要位置：

- [Tabs.tsx](frontend/src/components/ui/Tabs.tsx:51)：Tab 只有 `focus:outline-none`。
- [Chat.tsx](frontend/src/pages/Chat.tsx:49)：`canvasIconBtn` 共用样式无焦点环，影响右上工具按钮、终端/工具台按钮。
- [IdeOpenMenu.tsx](frontend/src/components/chat/IdeOpenMenu.tsx:24)：菜单项 3 处无焦点环。
- [ChatComposer.tsx](frontend/src/components/chat/ChatComposer.tsx:169)：附件、发送侧按钮、权限 radio 无焦点环；输入框本身有 `focus:shadow`，可保留。
- [Sidebar.tsx](frontend/src/components/layout/Sidebar.tsx:243)：搜索输入、折叠/关闭、新建对话、项目手风琴、账号按钮等十余处无焦点环。
- [TerminalPanel.tsx](frontend/src/components/terminal/TerminalPanel.tsx:172)：清空、关闭按钮无焦点环。
- [chat-panels.tsx](frontend/src/components/chat-panels.tsx:601)：聊天输入文本域只有 `focus:outline-none`。

建议：按钮类统一补 `focus-visible:ring-2 focus-visible:ring-[var(--accent)]`；文本输入类保留现有 `focus:ring` 或 `focus:shadow`。

### P1-2 终端高度恢复未按视口上限钳制

[TerminalPanel.tsx](frontend/src/components/terminal/TerminalPanel.tsx:26) 从 `localStorage` 恢复高度时只校验 `>= MIN_HEIGHT`，没有校验 `MAX_HEIGHT_RATIO`；[拖拽期间](frontend/src/components/terminal/TerminalPanel.tsx:55) 才会钳制到 `window.innerHeight * 0.6`。

后果：在宽屏窗口保存过 1000px 高度，之后在小窗口/缩放浏览器打开终端，可能首次进入就占满大半屏，直到用户拖一次才会修正。

建议：`readInitialHeight` 在读取时同时校验当前视口上限；窗口 `resize` 时也重新钳制已恢复的高度。

### P1-3 移动端侧栏关闭后仍可聚焦，缺少 dialog 语义

[Sidebar.tsx](frontend/src/components/layout/Sidebar.tsx:319) 移动端关闭时仅通过 `-translate-x-full` 移出屏幕，没有 `inert` 或 `aria-hidden`。侧栏内按钮仍留在 Tab 顺序中，键盘用户会“走进”屏幕外的导航；打开时也没有 `role="dialog"` 和焦点圈定。

对比：右栏已正确处理关闭态，[RightToolbar.tsx](frontend/src/components/rightbar/RightToolbar.tsx:152) 使用 `inert`。

建议：移动端关闭时给 `<aside>` 加 `inert`/`aria-hidden`；打开时补充 `role="dialog"`、初始焦点与焦点圈定；`Esc` 关闭。

## 三、P2 问题

### P2-1 工作区手风琴不尊重 reduced motion

[Sidebar.tsx](frontend/src/components/layout/Sidebar.tsx:545) 的工作区会话折叠动画固定使用 `duration: 0.22`，没有像 Collapsible/Layout 一样读取 `useReducedMotion()` 或全局 `useMotion()`。

建议：与 Collapsible 一致，在 `prefers-reduced-motion` 或全局动效关闭时降为瞬态切换。

### P2-2 可见文案省略号与本地化格式不统一

可见字符串仍混用 ASCII `...`：

- [Git.tsx](frontend/src/pages/Git.tsx:194)：`输入提交信息...`
- [Providers.tsx](frontend/src/pages/Providers.tsx:162)：`搜索 provider...`
- [Sidebar.tsx](frontend/src/components/layout/Sidebar.tsx:600)：`检查中...`
- [Sessions.tsx](frontend/src/pages/Sessions.tsx:80)：截断 `...`
- [Sessions.tsx](frontend/src/pages/Sessions.tsx:124)：session id 截断 `...`
- [provider-hub-sections.tsx](frontend/src/components/provider-hub-sections.tsx:159)：模型名截断 `...`

日期/数字格式化部分使用 `toLocaleString()` 默认 locale，部分使用 `'zh-CN'`，散落在多个页面：

- [Sessions.tsx](frontend/src/pages/Sessions.tsx:69)：`toLocaleDateString('zh-CN')`
- [Git.tsx](frontend/src/pages/Git.tsx:250)：`toLocaleString('zh-CN', { month: 'short', ... })`
- [provider-hub-sections.tsx](frontend/src/components/provider-hub-sections.tsx:234)：`toLocaleTimeString('zh-CN')`
- [Tokens.tsx](frontend/src/pages/Tokens.tsx:123)、[Eval.tsx](frontend/src/pages/Eval.tsx:203)：另一套 `toLocaleDateString()`

建议：统一为 `Intl.DateTimeFormat('zh-CN', ...)` 工具模块，数字显示统一 locale；可见省略号统一用 `…`。

### P2-3 斜杠命令菜单的关闭按钮与 option 语义

[SlashCommandMenu.tsx](frontend/src/components/chat/SlashCommandMenu.tsx:45) 的关闭按钮使用 `×` 文本且无焦点环；`role="option"` 落在 `<button>` 上而不是列表项，键盘语义可以更规范。

建议：关闭按钮改用图标组件并补 `focus-visible:ring`；菜单改为 `role="listbox"` + `role="option"` 的标准组合（可用 `ul/li` 包裹），或至少补 `aria-activedescendant`。

## 四、P3 问题

- [index.css](frontend/src/styles/index.css:1343) 已定义 `.skip-link`，但 `index.html`/Layout 中没有实际 Skip Link，`<main>` 也没有 `id`/`tabIndex`。
- [HelpModal.tsx](frontend/src/components/ui/HelpModal.tsx:32) 与 [ApprovalModal.tsx](frontend/src/components/ApprovalModal.tsx:80) 有 `role="dialog"`/`aria-modal`，但没有初始焦点、焦点圈定和 Esc 统一处理（HelpModal 依赖全局 Esc，ApprovalModal 无）。
- [Header.tsx](frontend/src/components/layout/Header.tsx:114) 移动端菜单按钮无 `focus-visible:ring`。

## 五、测试与构建基线

- `npm run test:run`：43 files / 282 tests 全部通过。
- `npm run build`：`tsc -b && vite build` 通过，`dist` 产出正常。
- 沙箱内首次执行出现 `esbuild spawn EPERM` 与 `tsconfig.tsbuildinfo EPERM`，提权后均通过；这属于沙箱写入/进程限制，不是代码失败。
- 当前 `http://127.0.0.1:18789/marketplace` 返回 200，后端 `/marketplace` 路由已在 [routes/index.ts](src/routes/index.ts:373) 注册。

## 六、SenseNova 视觉复评缺口

本轮无法完成 SenseNova `sensenova-6.7-flash-lite` 视觉复评，原因：

- 当前 `~/.codex/config.toml` 没有 SenseNova provider。
- 仓库 `src/scripts` 没有可直接调用的 SenseNova 脚本。
- 本会话没有可用的 API Key。

已有历史记录：[VISUAL-REVIEW-2026-08-06.md](docs/VISUAL-REVIEW-2026-08-06.md) 含此前 17 张截图与逐页评分。用户提供 Key 后，可复用 `https://token.sensenova.cn/v1/chat/completions` 的 OpenAI 兼容接口，对 `.tmp/visual-shots/*.png` 重新做真实视觉审核。

## 七、建议修复范围（待确认）

1. 方案 A（推荐先做）：P1 全部，即焦点可见性、终端高度钳制、移动端侧栏可访问性。
2. 方案 B：A + P2，即 reduced motion、文案/本地化、斜杠菜单语义。
3. 方案 C：B + P3，即 Skip Link、弹窗焦点管理、Header 移动端焦点。

在用户确认范围前，本报告不包含任何业务代码修改。

---

# 方案 C 实施完成（2026-08-09）

## 八、已落地修改

### P1

- 键盘焦点：Tabs、Chat 图标按钮、IdeOpenMenu、ChatComposer、Sidebar、TerminalPanel、chat-panels、SlashCommandMenu、Header 等控件补齐 `focus-visible:ring`。
- 终端高度：恢复高度时按当前视口 `60%` 上限钳制，窗口 resize 时同步重钳制；终端挂载/连接后自动聚焦。
- 移动侧栏：关闭态加 `inert` + `aria-hidden`，打开态补 `role="dialog"`/`aria-modal`，支持焦点圈定与 Esc 关闭。

### P2

- 工作区手风琴动画接入 `useReducedMotion`。
- 可见省略号统一为 `…`；新增 `frontend/src/lib/format.ts`，统一日期、时间、数字格式化。
- 斜杠命令菜单改为标准 `listbox`/`option` 结构，关闭按钮改为图标并补焦点环。

### P3

- 新增 Skip Link 与 `main#main` 焦点目标。
- HelpModal/ApprovalModal 接入 `useFocusTrap`，打开时聚焦、关闭后恢复焦点。

### SenseNova 复评后追加

- 终端浮层在桌面端避开侧栏，不再遮挡左侧导航底部。
- 右侧工具台收窄到 `22rem`，增加画布内遮罩、图标文字标签。
- 侧栏折叠态隐藏工作区错误/空态长文本，避免竖排单字。
- 市场页 Skill/MCP/目录为空时显示空态引导。

## 九、SenseNova 终评

| 截图 | 评分 |
|---|---|
| 聊天主页 | 9.0 |
| 终端打开 | 9.0 |
| 右侧工具台 | 9.0 |
| 桌面侧栏折叠 | 9.0 |
| 移动侧栏抽屉 | 9.0 |
| 斜杠命令菜单 | 10.0 |
| 设置折叠框 | 10.0 |
| Skill/MCP 市场 | 9.0 |

## 十、验证

- `frontend npm run lint` 通过。
- `frontend npm run test:run`：43 files / 282 tests 通过。
- `frontend npm run build` 通过，`bun run build:frontend` 已同步 `public/`。
- Playwright 交互回归：8/8 通过，覆盖 19 条路由、终端、侧栏、右栏、折叠框、斜杠菜单、市场页。
- SenseNova 视觉复评结果存于 `.tmp/sensenova-review-2026-08-09.md`（不入库）。
