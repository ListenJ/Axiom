# 视觉审核报告（SenseNova 视觉模型 + cowork-skills）— 2026-08-06

> 日期：2026-08-06 ｜ 基线 commit：`fa117e9`（master；本轮仅文档新增，代码未改动）
> 方法：接入 SenseNova `sensenova-6.7-flash-lite` 为 Codex 视觉模型 → 按 cowork-skills 的 `design-system`（对比度/排版/布局/一致性/可访问性）与 `visual-test-runner`（提交前视觉验证）方法 → 构建前端并用 Playwright 截取 13 张浅色 + 4 张暗色关键页截图 → 逐张送视觉模型结构化审核 → 关键声称用 DOM/代码/计算对比度复核（甄别幻觉）。
> 关联：docs/FRONTEND-REVIEW-2026-08-03.md、docs/ARCHITECTURE-REVIEW-2026-08-06.md、frontend/docs/FRONTEND-DESIGN.md

---

## 一、SenseNova 接入 Codex（已完成）

- `~/.codex/config.toml` 新增 `[model_providers.sensenova]`：`base_url = "https://token.sensenova.cn/v1"`、`wire_api = "chat"`、Bearer token 认证（修改前已备份至 `~/.codex/.codex-config-backup-20260806/`）。
- `~/.codex/cc-switch-model-catalog.json` 新增模型 `sensenova-6.7-flash-lite`：`input_modalities: ["text", "image"]`（视觉能力）、`supported_reasoning_levels: [none]`、`visibility: list`（已 JSON 校验，4 个模型共存）。
- 使用方式：重启 Codex 桌面端后可在模型列表选择；临时切为默认模型：`model_provider = "sensenova"`、`model = "sensenova-6.7-flash-lite"`。API 直连已实测可用（文本 + 图片输入均正常返回）。
- 已安装 cowork-skills 的 `design-system` 与 `visual-test-runner` 到 `~/.codex/skills/`。

## 二、审核执行

- 前端 `bun run build` 成功；本地代理（4180）服务 `frontend/dist` 并转发 API 到后端（18789），规避静态资源限流（见下 P0-3）。
- 截图：浅色 13 张（chat / chat-message / settings / search / sessions / vault / router / tokens / git / providers / perf / mobile-chat / mobile-settings）+ 暗色 4 张（chat / settings / sessions / tokens）。注：无头浏览器默认跟随系统为浅色，故补充暗色（项目默认）主题。
- 环境限制：沙箱外网不可达 Google Fonts（Inter/JetBrains Mono），截图用回退字体；不影响布局审核。

## 三、评分汇总（SenseNova 视觉模型）

| 页面 | 浅色 | 暗色 |
|---|---|---|
| 聊天首页 /chat | 7.0 | 6.2 |
| 聊天页（含消息） | 6.5 | — |
| 设置 /settings | 8.0 | 8.0 |
| 搜索 /search | 7.0 | — |
| 会话管理 /sessions | 8.1 | 7.8 |
| 记忆库 /vault | 6.5 | — |
| 模型路由 /router | 6.5 | — |
| Token 用量 /tokens | 7.0 | 8.5 |
| Git 面板 /git | 6.0 | — |
| 模型供应商 /providers | 0（鉴权裸文本，见 P0-2） | — |
| 性能 /perf | 7.0 | — |
| 移动端 /chat | 7.3 | — |
| 移动端 /settings | 5.8 | — |

总体：视觉语言统一（暖色强调 + 毛玻璃 + 卡片 + 圆角），暗色质感最佳（settings/tokens ≥8）；主要失分集中在 2 个 P0 功能级缺陷、侧栏对比度、顶栏重叠、移动端适配与空态。

## 四、已核实的真实缺陷（代码/DOM/数据证据）

### P0-1 全局 React 崩溃：侧栏渲染 git 分支对象
- 后端 `/api/git/branch` 返回 `branches: [{name,current,remote}]`（对象数组）；前端 `api.ts` 类型声明 `branches?: string[]`；`Sidebar.tsx:49` 状态类型 `string[]`、`:68` 直接赋值、`:410-418` 渲染 `{b}` 且 `key={b}` → React error #31 "Objects are not valid as a React child (found: object with keys {name, current, remote})"，错误边界"出错了"接管整页。
- 影响：任一页面在侧栏分支列表加载后即崩溃（实测 /chat 必现，providers 等页在数据加载后也现）。
- 修复建议：`branches.map(b => b.name)` 渲染 + `key={b.name}`，并把 `api.ts` 类型改为 `Array<{name,current,remote}>`（或后端改返字符串数组）。

### P0-2 未登录/鉴权失败 → /login 返回裸 JSON
- 访问需鉴权页面（如 /providers，R-007 `/models` 系 requireAuthToken）时，api.ts 401 拦截清 token 并跳 `/login?from=...`；但 `/login` 返回 `{"error":"Unauthorized"}` 裸 JSON（实测页面 body 即该 24 字符），用户看不到登录 UI。
- 修复建议：401 后展示 Login 页组件（SPA 内路由），或 /login 走 SPA fallback 返回 index.html，禁止直出 JSON；并给 providers 等页补加载/错误兜底。

### P0-3 静态资源被 API 限流（429）→ 页面资源加载失败
- `src/main.ts:601` 对全部请求（含 `/assets/*` 静态资源）执行 `apiLimiter`（默认 100 次/min/IP）；单页约 50+ 资源请求，多页浏览即触发 429 → JS/CSS 加载失败、页面空白/降级（实测 vault/router/tokens 等页 bodyLen=0 + 429 + CSS MIME 拒绝）。
- 修复建议：静态资源（`serveStaticFile` 命中路径）跳过限流，或把 assets 请求单独豁免；顺带核验 gzip 分支的 Content-Type 与 Vary 头（限流下 CSS 曾报 application/octet-stream）。

### P0-4 品牌残留 + 顶栏重叠 + 移动端桌面菜单
- `Header.tsx:117` 品牌字标仍为 **"OC"**（OpenClaw 残留，与 v4.0.0"全局重命名 Axiom"声明不符）；`:127/136/145/155` 渲染"文件/编辑/视图/帮助"桌面式系统菜单。
- 视觉模型多页报告顶栏"文件/编辑/视图/帮助"与品牌/内容重叠、标题截断（"Axio..."）；移动端 DOM 亦含该菜单（`OC | 文件 | 编辑 | 视图 | 帮助`）且"系统"文字溢出底栏安全区。
- 修复建议：`OC` → Axiom 字标；系统菜单仅桌面宽度展示（`lg:flex hidden`），移动端收敛进抽屉；修复顶栏重叠/截断。

### P1-1 暗色主题侧栏辅助文字对比度严重不足（客观数据）
- 浏览器计算：暗色下 `--text-muted` 与页面背景对比度 **1.05:1**（远低于 4.5:1）；`--text-muted` 用于"暂无场景…""无插件""工作区服务不可用""检查中…"等。
- 浅色下 17.56:1 正常；菜单文字对比度浅色 5.97 / 暗色 10.36 均合格（视觉模型"菜单不可读"不成立，属误报）。
- 修复建议：暗色主题调亮 `--text-muted`（建议 ≥ #9CA3AF 档，对比 ≥4.5:1）。

### P1-2 空态/占位反馈薄弱（多页一致）
- perf 页顶部直接暴露"HTTP 429"底层状态码；KPI 卡只有"——"无加载/空态/零值区分；右侧工具台大面积留白、页面重心上移（chat-message/router 等）；底部"任务 — / 智能体 — / 已完成 — / Tokens 0"占位符语义弱。
- 修复建议：错误文案用户化；KPI 区分骨架/空态/有值；右栏平衡内容密度；底部状态给默认值或"未连接"。

### P1-3 移动端排版
- 设置页"外观/强调色"说明文字被强制逐字换行（每字一行）；移动端保留桌面系统菜单；底栏"系统"文字溢出。
- 修复建议：移动端卡片文字容器加宽/`break-normal`，检查 `min-width` 与 `flex-wrap`。

### P2 细节（多页出现）
- Tab 文字换行："使用统计"→"使用统/计"、"会话列表"→"会话列/表"、"待审核"→"待审/核"（建议 tab 单行不换行 + 加宽）。
- tokens KPI 大数字多色（绿/橙/红/蓝）语义不统一，建议仅保留必要语义色。
- git 页"提交/推送"主次按钮层级接近；"— 0 个变更"破折号文案语义不明。
- 设置"动效强度"预览区留白偏大、"重播预览"悬空。

## 五、需人工复核项（疑似环境伪影或单次出现）

- 暗色 chat 视觉模型报"整体高斯模糊"——项目刻意使用毛玻璃/Aurora 模糊，可能被误读；请人工查看 `vision-review/dark-chat.png` 确认是否为真实文字模糊。
- 浅色 tokens 顶部"横向白色带"、sessions"顶栏残留痕迹"——疑似字体回退/渲染伪影。
- providers 页得分 0：已确认由 P0-2 鉴权裸文本导致，页面本体待修复后复评。
- 暗色"开启新对话"按钮计算对比度 1.13（渐变背景无法用 computed backgroundColor 精确还原）——建议人工复核暗色下按钮文字可见性。

## 六、优先修复清单

1. **P0** 修复 `Sidebar` git 分支对象渲染崩溃（侧栏按 `b.name` 渲染）。
2. **P0** 修复 401 → `/login` 裸 JSON（改 SPA 登录页 + 页面错误兜底）。
3. **P0** 静态资源豁免 API 限流；`OC` 字标 → Axiom；系统菜单移动端隐藏并修复顶栏重叠。
4. **P1** 暗色 `--text-muted` 提亮至 ≥4.5:1；Tab 不换行；perf/KPI/右栏空态与错误文案；移动端设置卡片文字换行。
5. **P2** 底部状态栏、按钮主次、KPI 颜色语义、留白平衡。

## 七、附：截图与逐页审核原文

- 截图：`C:\Users\18336\.codex\visualizations\2026\08\06\019fd6a3-70a6-7600-beb3-9c8e1066f085\vision-review\*.png`（浅色 13 + 暗色 4）
- 逐页审核原文：同目录 `reviews/*.md`（每页含"总体评分 / 做得好的点 / 问题 / 一句话总结"）
- 本次仅新增本文档，未改动任何代码；P0/P1 修复建议按 AGENTS.md 规则另开任务执行。

---

# 第二轮：修复落地 + SenseNova 复评（2026-08-06 晚）

> 基线：首轮报告（上）。本轮把首轮 P0/P1 建议落地为代码，重新构建并复评。

## 八、本轮修复（含首轮 8 文件验证 + 本轮 6 文件）

1. **React #31 崩溃**：`Sidebar` git 分支按 `b.name` 渲染（类型改为对象数组）。
2. **401 → /login 裸 JSON**：`/login` 加入后端 SPA_ROUTES 白名单。
3. **静态资源 429 白屏**：`src/main.ts` 新增 `isStaticAsset()`，SPA 静态资源豁免 API 限流（连续 150 次静态资源请求全 200，API 路径仍正确 429）。
4. **`OC` 字标 / 系统菜单移动端**：Header 字标改 AX，系统菜单 `lg:flex hidden` 移动端隐藏。
5. **移动端设置单字竖排（首轮 P1-3，实测 P0）**：主题/强调色卡片文字容器 `min-w-[10rem] sm:min-w-0`，强制在窄屏换行到独立行；DOM 探针确认竖排元素归零，SenseNova 复评移动端设置 5→9.5。
6. **AX 徽标与"开启新对话"渐变背景从未渲染（首轮"需人工复核"项，实测 P0）**：`bg-[var(--accent-gradient)]` 把渐变当背景色（无效，computed background-image=none），浅色下 `--on-accent` 近白文字直接落在米色背景上近乎不可见；改为 `bg-[image:var(--accent-gradient)]`（与 Button.tsx 一致）。探针确认渐变已渲染；浅色 chat 复评 7.5→8.5。
7. **Google Fonts 被 CSP 拦截**：`style-src`/`font-src` 放行 fonts.googleapis.com / fonts.gstatic.com，Inter/JetBrains Mono 恢复加载（控制台无 CSP 错误）。
8. **StatCard 标签对比度**：`--text-muted`（浅色 3.85:1）→ `--text-secondary`（5.9:1）。
9. **底部状态栏可读性**：`text-2xs`→`text-xs`；移动端 `flex-wrap`+`gap-4`+`whitespace-nowrap` 修"已完成 68"断行（探针：各 项 h=18 单行）。
10. **perf 错误文案 / Tabs 不换行 / 外观卡片 flex-wrap**：随首轮修复一并验证。

## 九、复评评分（视口截图，避免全页拼接伪影）

| 页面 | 首轮 | 复评 v6 | 终评 v7 |
|---|---|---|---|
| 浅色 chat | 7.5 | 7.2* | 8.5 |
| 浅色 settings | 7.8 | 9.0 | 8.0 |
| 浅色 tokens | 6.5 | 6.5 | 8.0 |
| 浅色 providers | 8.5 | 8.0* | — |
| 移动端 chat | 6.2 | 8.5 | 8.0 |
| 移动端 settings | 5.0 | 9.5 | 8.5 |
| 暗色 chat | 7.5 | — | 7.0 |
| 暗色 settings | 9.0 | — | — |

*：v6 首跑为全页拼接图，几何探针证实"顶栏重叠/底栏遮挡"均为拼接伪影（brand/H1 相交面积=0、docH=900）；v7 起改为视口截图。

## 十、残留低优先项（本轮未改，供后续）

- 侧栏信息密度（MCP/插件说明行距）、空态引导（tokens 趋势图"暂无数据"仅一行文字）、输入框 placeholder 对比度、底部导航图标抽象度、"检查中…"全角省略号、KPI 多色语义——均为 P2/观感级。
- 后端测试 5 项 HEAD 已存在失败（Chat.tsx 650 行、Sidebar py-2.5、EventBus 并发、GitHub 网络超时），与本轮无关，另开任务处理。

## 十一、本轮截图与审核原文

- 截图：同目录 `vision-review/v4-*`、`v5-*`、`v6-*`、`v7-*.png`（v4/v5 全页，v6/v7 视口）。
- 逐页原文：`vision-review/reviews-v4/`、`reviews-v6/`、`reviews-v7/*.md`。
- 本轮提交：见 `docs/operations-log.md` 最新条目（含 Commit hash）。
