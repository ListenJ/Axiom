# 前端审美修复 Implementation Plan（2026-08-11）

**Goal:** 修复前端 P0 批（默认主题 / Plugins 崩溃 / 语义色 / BottomNav / key 冲突 / 状态真实性），使应用默认深色、无崩溃、无隐形按钮，为后续动态背景与移动端治理建立基线。

**Architecture:** 前端为 React 19 + Vite + Tailwind + zustand + framer-motion。修复遵循「token 驱动、最小 diff、测试先行的垂直切片」：每项改动一个文件为主，改前备份，改后跑 vitest + tsc，最后真实渲染验证。

**Tech Stack:** TypeScript 5.3 / React 19 / Tailwind（CSS 变量 token 体系）/ vitest / Playwright（真实渲染，备用 in-app Browser）。

---

### Task 1: 默认主题修复（F1）

**Files:**
- Modify: `frontend/src/state/useApp.ts:57-61`（readInitialTheme 默认 'dark'）
- Modify: `frontend/index.html`（内联脚本按 localStorage 预置 data-theme，消除 FOUC）
- Test: `frontend/src/state/useApp.test.ts`（新增：无 localStorage 时默认 dark；有 'light' 时保持 light）

**Step 1: 写失败测试**（在 useApp.test.ts 增加用例）
```ts
it('defaults to dark when no stored theme', () => {
  localStorage.removeItem('axiom:theme')
  useApp.setState({ theme: 'dark' as never }) // reset
  expect(useApp.getState().theme).toBe('dark')
})
```
（注：zustand store 初始值在模块加载时已定，测试改为验证 readInitialTheme 行为需导出该函数；更稳妥做法：把 readInitialTheme 导出并在测试中直接断言。）

**Step 2: 运行确认失败**
Run: `cd frontend && bun test src/state/useApp.test.ts` → 期望失败（当前返回 'system'）。

**Step 3: 实现**
- `readInitialTheme` 无存储/未知值 → 返回 `'dark'`（保留 'system' 作为显式用户选择）。
- `index.html` <head> 顶部加内联脚本：读 `localStorage['axiom:theme']`，'light' 设 light，否则 dark（与 readInitialTheme 同规则），并在 `<meta name="theme-color">` 前执行。

**Step 4: 验证**
Run: `cd frontend && bun test src/state/useApp.test.ts` → PASS；`cd frontend && bunx tsc --noEmit` → PASS。

**Step 5: 提交**（随批次提交，见 Task 7）

---

### Task 2: Plugins 崩溃修复（F2）

**Files:**
- Modify: `frontend/src/pages/Plugins.tsx`（marketplace 状态形状守卫 + badge 防御）
- Test: `frontend/src/pages/Plugins.test.tsx`（新增：marketplace 返回字符串时不崩溃）

**Step 1: 写失败测试**（Plugins.test.tsx 中 mock endpoints.marketplace.list 返回 HTML 字符串，渲染组件断言不抛错）
**Step 2: 运行确认失败** → 当前渲染抛 TypeError。
**Step 3: 实现**
- 在 Promise.allSettled 回调：`if (m.status === 'fulfilled' && m.value && typeof m.value === 'object') setMarketplace(m.value as ...)`，否则保持默认空结构；
- Tabs badge 改为 `(marketplace.skills?.length ?? 0) + (marketplace.mcpServers?.length ?? 0)`。
**Step 4: 验证** → 测试 PASS；lint PASS。
**Step 5: 提交**

---

### Task 3: Button danger/success hover 修复（F3）

**Files:**
- Modify: `frontend/src/components/ui/Button.tsx:29,31`
- Modify: `frontend/src/components/chat-panels.tsx:404`（失败徽标）

**Step 1: 现状复现**：暗色下 danger/success hover = 白底白字。
**Step 2: 实现**
- Button：`danger` hover 改为 `hover:bg-[var(--danger)] hover:text-[var(--on-accent)]`（暗色 danger=#fff、on-accent=#000 → 黑字白底可读；浅色 danger=#111、on-accent=#fff → 白字黑底可读）。success 同理。
- chat-panels 徽标：`bg-[var(--danger-soft)] text-[var(--danger)] border border-[var(--danger)]`（去实底白字）。
**Step 3: 验证**：lint + 相关测试（components/chat-panels 若有测试）。
**Step 4: 提交**

---

### Task 4: BottomNav 定位修复（F4）

**Files:**
- Modify: `frontend/src/components/layout/BottomNav.tsx:23-35`

**Step 1: 实现**：NavLink className 加 `relative`，激活指示条保持 `absolute -top-px`；图标区 `h-6`→`h-7` 并保证点击区 min-h。
**Step 2: 验证**：lint；真实渲染（in-app Browser 或 Playwright）移动视口检查指示条位置。
**Step 3: 提交**

---

### Task 5: 迷你聊天 key 修复（F5）

**Files:**
- Modify: `frontend/src/components/rightbar/panels.tsx:736`

**Step 1: 实现**：`const nextIdRef = useRef(1)`（需要时 import useRef），替换 `const nextIdRef = { current: 1 }`；或复用 `chat-utils.nextId()`。
**Step 2: 验证**：lint；连续发送两条消息无 duplicate key 告警（真实渲染）。
**Step 3: 提交**

---

### Task 6: Router / Code 状态真实性

**Files:**
- Modify: `frontend/src/pages/Router.tsx:63`（默认 '未知'，仅当有任一成功值才用该值）
- Modify: `frontend/src/pages/Code.tsx:133`（status 按 ok/error/unknown 映射 accent）

**Step 1: 写失败测试**（如无现成测试则用真实渲染断言）：
- Router：三接口全 rejected 时页面路由状态显示「未知」而非 ok。
- Code：status='error' 时 StatCard accent 为 danger（若 StatCard 可测）。
**Step 2: 实现**（最小 diff）。
**Step 3: 验证**：lint + 测试。
**Step 4: 提交**

---

### Task 7: 验证与提交（批次）

**Step 1:** `cd frontend && bun test`（全量前端测试）→ 全绿。
**Step 2:** `cd frontend && bunx tsc --noEmit`（或 root `bun run lint`）→ 干净。
**Step 3:** 真实渲染验证（in-app Browser / Playwright）：
- /chat 默认深色；/plugins 无崩溃；暗色 hover 可读性人工核验（截图）。
**Step 4:** 按 AGENTS.md 规则 2 删除 .tmp/backups 对应备份。
**Step 5:** docs/operations-log.md 追加记录（含 commit hash 回填）。
**Step 6:** `git add <仅本任务文件>` → commit → `git push internal211 codex/frontend-aesthetic-repair`。
