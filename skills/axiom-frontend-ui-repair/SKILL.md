---
name: axiom-frontend-ui-repair
description: Axiom 前端 UI 修复与设计系统守则。当要修改 frontend/src 下的 React/Tailwind 界面、修复视觉/可访问性/动效问题、或按 Axiom 设计系统（AXIS Monochrome + Deep Space Console 暗色）实施改动时使用。确保改动符合 token 体系、双主题、动效纪律与无障碍标准，避免设计漂移。
---

# Axiom 前端 UI 修复守则

> 配套权威文档：frontend/docs/FRONTEND-DESIGN.md（设计定稿）、frontend/src/styles/index.css（设计 token）
> 强制约束：AGENTS.md 规则 1（最小施工）/ 规则 2（备份）/ 规则 3（提交）/ 规则 11（凭据本地化）

## 1. 动手前（必做）

1. 通读目标文件**全文**（禁止凭片段改）。
2. 修改前备份到 `.tmp/backups/`（保留相对路径）。
3. 对照以下守则逐条检查目标区域，判断是否命中。

## 2. 设计系统守则（改动必须符合）

### 2.1 Token 优先
- 颜色只用 CSS 变量（`var(--bg / --surface / --text / --accent / --border / --danger ...)`) 或 Tailwind 映射类（`bg-surface`, `text-text-muted`）。**禁止硬编码 hex/rgba** 进组件（lib/accents.ts 是唯一的主题化例外）。
- 间距走 8dp 网格（`--space-*` 或 tailwind spacing）；圆角走 `--radius-*`。

### 2.2 语义色（monochrome 亮度阶梯）
- danger/success/warning/info 在暗色/浅色均为亮度阶梯（不依赖色相）。
- **禁止**语义色实底 + 白色文字的组合（暗色下 danger=#fff → 白字白底隐形）。正确做法：实底时配 `var(--on-accent)`，或 soft 底 + 描边 + 语义色文字。
- 状态必须有「非亮度冗余」：图标 / 描边 / 文案，至少一种与颜色并存。

### 2.3 主题机制
- 主题状态唯一来源：`useApp.theme`（zustand），实际生效值用 `resolveTheme(theme)`。
- 默认主题为 **dark**（无存储/未知值时），用户显式选 system/light 才跟随。
- index.html 必须在首帧前内联脚本按 localStorage 预置 `data-theme`，消除 FOUC。
- **禁止**在组件里按 `theme === "dark"` 硬判断（system 模式下会错）；用 `resolveTheme`。
- Login 页与 Layout 内页面必须同一主题机制，不允许割裂。

### 2.4 动效纪律
- 动效参数单一事实来源：`frontend/src/lib/motion-presets.ts`。禁止组件内硬编码 duration/easing。
- 动态背景/装饰动画：**只动 transform 与 opacity**；禁用大面积实时 `filter: blur()` 动画；动画层 ≤4 层；所有动画层声明 `will-change: transform, opacity`。
- 必须支持 `prefers-reduced-motion`（已有 data-motion 机制：off/reduced 时静态渲染）。
- 页面切换/弹层过渡必须「丝滑」：framer-motion 预设 + 220-320ms 节奏，避免生硬跳变。

### 2.5 可访问性与触摸
- 可读文本最小 **12px**（`text-xs`）；`text-2xs`（10px）只允许纯装饰/徽标，且对比度 ≥4.5:1。
- 触摸目标 ≥ **44px**（`min-h-11 min-w-11` 或 padding 外扩）；小控件必须可点。
- 焦点可见：`focus-visible:ring-2 ring-[var(--accent)]`；按钮必须是 `<button>`（禁止 div role=button）。
- 每个页面有唯一 h1；导航/工具栏有 heading 层级；图标按钮有 aria-label/title。
- 错误/警告态必须可感知：警示色/图标/操作入口三选二，禁止只用灰色小字。

### 2.6 空态/加载态/错误态
- 空态 = 图标 + 标题 + 说明 + **下一步动作**（新建/导入/诊断按钮）。
- 加载态用 Skeleton 但**必须最终结束**；永久占位不是加载态（禁止「假骨架」）。
- 错误态给出具体原因 + 恢复路径。

### 2.7 卡片与组件一致性
- 卡片语言二选一，同一页面不得混用：玻璃卡（ShimmerCard，无边框）或描边卡（border + surface-hover）。
- 组件复用 `components/ui`（Button/Input/Tabs/Toast/EmptyState）；**禁止**在页面手写等价组件。
- 删除重复实现前先 grep 零引用确认；文档（FRONTEND-DESIGN.md）与代码必须一致。

## 3. 验证清单（改完必跑）

- [ ] `cd frontend && bun test`（或目标测试文件）全绿
- [ ] `cd frontend && bunx tsc --noEmit`（或 root `bun run lint`）干净
- [ ] 真实渲染核验（Playwright / in-app Browser）：目标页面无 console error；双主题各截一张
- [ ] 无新增硬编码色值/模型名/baseUrl；无新增真实凭据占位以外的内容
- [ ] 按 AGENTS.md 规则 2 删除备份；按规则 5 记录 operations-log

## 4. 修复流程速查

1. 定位：grep 目标问题 → 读全文 → 对照守则 2.x 确认命中项。
2. 备份：复制到 .tmp/backups/<相对路径>。
3. 修复：最小 diff，优先改 token/组件层（一处修复全站受益）。
4. 验证：守则 3 清单。
5. 提交：git add 仅本任务文件 → commit → push internal211。
