# 前端功能测试 / 体验优化 / 渲染审计项目完成计划

> 日期：2026-09-09 ｜ 状态：待用户批准关键决策（D1-D5）后开工
> 依据：本计划基于 2026-09-09 前端现状勘察（事实见 §0），并遵守 AGENTS.md 全部规则（TDD 垂直切片、操作留痕、双远端推送、无破坏性操作）。
> 时间口径：全部为 **相对工作日（D0 = 计划批准日）**，标注"规划参考"性质，不构成交付承诺；负责人为角色占位，批准时由用户落名。

## 0. 勘察事实（计划的地面）

| 事实 | 依据 |
|---|---|
| 前端栈：React 19 + react-router-dom + Zustand + Tailwind + Vite + TS + Vitest | frontend/package.json |
| 页面 ≥20（chat/search/code/agents/router/vault/kg/sessions/eval/plugins/trends/ocr/research/knowledge/proxies/providers/tokens/perf/git/settings） | frontend/src/App.tsx L76-L113 |
| E2E 设施已有：Playwright 配置（测试目录/浏览器/失败截图/CI 重试） | playwright.config.mjs |
| 视觉审核链已有：逐页 Playwright 截图 → SenseNova 视觉审核 → Markdown 报告 → CI 门禁（critical/major 阈值） | scripts/frontend-audit.ts、scripts/visual-audit.ts、docs/FRONTEND-VISUAL-REVIEW.md |
| 确定性像素级 diff（基线快照比对）未确认存在 | 勘察未见 toHaveScreenshot/Percy/BackstopJS 配置 |

结论：本计划对"视觉测试"做**双链互补**——存量 LLM 视觉审核链（语义级审美/层级评分）+ 新增 Playwright toHaveScreenshot（确定性像素 diff）。其余工作均为增量，不推倒重来。

## 1. 任务分解与时间轴

### 阶段 T1：测试基线与决策收敛（D0–D5）

| 任务 | 起–止 | 负责人 | 交付物 | 验收标准 |
|---|---|---|---|---|
| T1.1 决策点头脑风暴会（§2，D1–D2 间择时） | D1–D2 | 项目经理（用户担任）+ 前端负责人 + agent（议题/纪要） | 会议纪要 + D1-D5 决策文档（ADR 格式） | 5 个决策点全部有结论（采纳/否决/缓议+理由），落 docs/decisions/ |
| T1.2 Vitest 组件测试基线盘点 | D0–D3 | 前端负责人 | 现有用例清单 + 覆盖缺口报告 | 覆盖 20+ 页面的渲染冒烟（每页至少 mount 不抛错）缺口量化 |
| T1.3 像素 diff 基线建设（§3.2） | D2–D5 | 前端负责人 + agent | 20+ 页面 × 视口矩阵基线快照入库（LFS 或独立分支，按 D3 决策） | 全部页面基线生成，CI 可复跑，二次运行零 diff（确定性验证） |

### 阶段 T2：跨浏览器/跨设备测试与视觉回归门禁（D6–D12）

| 任务 | 起–止 | 负责人 | 交付物 | 验收标准 |
|---|---|---|---|---|
| T2.1 浏览器×视口矩阵执行 | D6–D8 | 前端负责人 | Chromium/Firefox/WebKit × desktop/tablet/mobile 报告 | 矩阵全绿或差异项全部入缺陷清单 |
| T2.2 视觉差异分类处置 | D8–D11 | 前端负责人 + QA | 缺陷清单（bug / 基线待更新 / 允许差异三类） | 每项差异有三分类标签与处置决定 |
| T2.3 CI 门禁接线 | D10–D12 | agent（仓库惯例：流程接线由 agent 执行） | PR 触发像素 diff + 既有 critical/major 审核阈值双门禁 | 故意引入 1px 差异可红、基线更新流程可绿（门禁自证） |

### 阶段 T3：渲染层级审计与性能优化（D10–D20，与 T2 并行）

| 任务 | 起–止 | 负责人 | 交付物 | 验收标准 |
|---|---|---|---|---|
| T3.1 组件树深度扫描 | D10–D12 | agent（确定性脚本） | 渲染层级深度/嵌套报告（>10 层组件清单） | 报告数字可复现（脚本入库，同输入同输出） |
| T3.2 渲染性能画像 | D12–D15 | 前端负责人 | React Profiler 火焰图 + 重渲染热点 Top10 | 热点清单附交互脚本（可复现的触发路径） |
| T3.3 优化实施（memo/虚拟化/拆层） | D15–D20 | 前端负责人 | 热点修复 PR 系列 | Top10 热点中 ≥6 项修复；目标页面交互帧率/提交耗时提升 ≥30%（以 T3.2 画像为基线，达标线在 D3 决策 D5 确认） |

### 阶段 T4：体验优化（D13–D24，与 T3 尾部并行）

| 任务 | 起–止 | 负责人 | 交付物 | 验收标准 |
|---|---|---|---|---|
| T4.1 体验测量先行 | D13–D15 | QA | 交互路径清单 + 响应耗时/错误率基线（Web Vitals + 自定义埋点） | 每条核心路径有前后可对比的量化基线 |
| T4.2 交互流程简化 | D15–D20 | 前端负责人 | 高频路径减步 PR（目标路径步数 −20%，依 D4 决策确认目标路径清单） | 路径步数前后对比表 + 像素回归全绿 |
| T4.3 响应速度提升 | D15–D20 | 前端负责人 | 懒加载/预取/请求合并 PR | 核心路径 P95 响应较 T4.1 基线提升 ≥30% |
| T4.4 错误提示优化 | D20–D24 | 前端负责人 + agent（文案审查） | 统一错误提示规范 + 全站提示改造 | 错误提示符合规范文档（可操作/可定位/无技术黑话），抽查 20 条通过 |
| T4.5 用户反馈闭环 | D22–D24 | 项目经理 | 反馈收集渠道 + 评价表 | 反馈进入 T5 验收输入 |

### 阶段 T5：收尾验收（D25–D28）

| 任务 | 起–止 | 负责人 | 交付物 | 验收标准 |
|---|---|---|---|---|
| T5.1 全量回归 | D25–D26 | QA | 全套测试报告（Vitest + Playwright + 像素 diff + 视觉审核） | 四链全绿 |
| T5.2 终局报告 | D26–D27 | agent | 验收报告（对齐 S-A4/S-A8 终局报告惯例） | 指标与 T1-T4 验收标准逐项对照，事实/判断分离 |
| T5.3 文档与复盘 | D27–D28 | 项目经理 | 使用文档 + 复盘纪要 | 复盘含"什么架构改动能预防此类问题"（规则 6 Phase 6 惯例） |

## 2. 关键决策点：头脑风暴会与决策文档

**边界声明（规则 10 直接异议）**：agent 无法替代真人召开会议，本计划的会议部分交付为——① 会前预分析（下表）；② 议程模板；③ 会后纪要整理与 ADR 落盘。会议本身由用户组织。

### 决策点预分析表（会前输入，会上逐条过）

| # | 决策点 | 执行路径 A | 执行路径 B | 潜在风险 | 应对 |
|---|---|---|---|---|---|
| D1 | 像素 diff 容差策略：0px 严格 vs 抗锯齿容差（maxDiffPixels/threshold） | 严格：误报高、维护重 | 容差：漏掉细微回归 | 基线噪声导致门禁狼来了 | 首轮用容差跑两周，统计误报率后再收紧；允许差异清单显式化 |
| D2 | 20 页面全量基线 vs 高频页面子集 | 全量：覆盖全、基线维护成本高 | 子集：轻、可能漏 | 低频页面回归逃逸 | 全量截图 + 分级门禁（高频页面硬门禁，低频周报级） |
| D3 | 基线快照存储：git LFS vs 独立基线分支 vs 产物库 | LFS：分支内直观 | 分支：主仓轻 | 仓库膨胀、clone 变慢 | 估算基线体积（D2 前实测）后定；>50MB 必须走 LFS 或分支 |
| D4 | 体验优化的目标路径清单与 −20% 步数口径 | 项目经理定 | 用户访谈数据定 | 优化了低价值路径 | 以 session 页/chat 页等真实使用频次为据，会上确认 |
| D5 | 渲染性能达标线（帧率/P95 提升 ≥30%）的测量口径 | Profiler 提交耗时 | Web Vitals（INP/LCP） | 口径不一导致"提升"不可比 | 两条口径都报，验收以 T3.2 画像同口径对比为准 |

### 会议与决策文档机制

- **议程模板**（每决策点 15 分钟）：事实陈述（5min，引用勘察/测量数据）→ 路径辩论（7min，A/B 支持方各 2min + 自由 3min）→ 表决与记录（3min）。
- **纪要模板**：决策编号 / 与会人 / 讨论要点 / 最终决定 / 反对意见记录 / 行动项（负责人+截止 D 日）。
- **决策文档**：docs/decisions/ADR-NNN-<slug>.md，格式 = 背景 / 决定 / 理由 / 备选与否决理由 / 后果与回退条件（轻量 ADR）。
- ** agent 职责**：会前 48h 把预分析表 + 测量数据发与会人；会后 24h 内产出纪要与 ADR 草稿交用户签核。

## 3. 前端功能测试方案（视觉双链）

### 3.1 存量链（保留，不改动）：LLM 视觉审核

`bun run scripts/frontend-audit.ts` 逐页截图 → SenseNova 审核 → 报告 → CI 阈值门禁。负责"好不好看"的语义级判断（层级/排版/暗色主题/现代感评分）。

### 3.2 新增链：Playwright toHaveScreenshot 确定性像素 diff

- **矩阵**：3 浏览器（Chromium/Firefox/WebKit）× 3 视口（desktop 1440×900 / tablet 768×1024 / mobile 390×844）× 20+ 页面。
- **确定性保证**（零网络随机性）：禁动画（`reducedMotion: 'reduce'`）、禁 caret/闪烁（mask 动态区域）、固定时区与 dpr、字体就绪等待（document.fonts.ready）。
- **基线管理**：按 D3 决策落库；基线更新必须走 PR + 人工 diff 审阅（禁止无人审直接覆盖——防"测试追着 bug 跑"）。
- **与存量链分工**：像素 diff 管"变了没有"（回归），LLM 审核管"变得好不好"（质量）。双门禁互不替代。

### 3.3 功能测试补充

- Vitest + Testing Library：每页 mount 冒烟 + 关键交互（表单提交/状态切换）用例，垂直切片补齐（规则 7）。
- 既有 Playwright 功能用例保留，新增用例仅覆盖 T4.2 改造的路径。

## 4. 体验优化（测量先行，禁止拍脑袋改）

1. **T4.1 基线**：Web Vitals（LCP/INP/CLS）+ 核心路径耗时埋点 + 错误率。所有优化 PR 必须附前后对照数据，否则不合入。
2. **交互简化**：仅作用于 D4 确认的目标路径；每条路径减步前后各出一份 Playwright 步骤脚本作为证据。
3. **响应速度**：懒加载路由级 chunk（React.lazy 已在 App.tsx 使用，查漏扩展）、列表虚拟化（与 T3.3 共用）、请求合并与预取。
4. **错误提示**：先出规范文档（可操作：告诉用户下一步；可定位：错误码；人话：无堆栈术语），再全站改造；agent 负责文案扫描，人工终审。
5. **每项优化必须能回答规则 1 之问**："删掉它，验收标准是否仍成立"——不能回答的优化不做。

## 5. 渲染层级审计

1. **T3.1 深度扫描**（确定性脚本入库 scripts/frontend/render-depth-audit.ts）：基于 React 组件树（或 AST 静态扫描 JSX 嵌套）输出每页最大深度、>10 层组件清单；报告 JSON + Markdown 双份（对齐 eval 报告惯例）。
2. **T3.2 画像**：React Profiler 采集交互火焰图，输出重渲染 Top10（按提交耗时排序），每个热点附最小复现交互脚本。
3. **T3.3 优化工具箱**（按热点对症，不做无证据的投机优化）：
   - 深层嵌套：组件拆层/组合提取（flatten 提升可读性同时降 depth）；
   - 重渲染：React.memo + 稳定引用（zustand selector 化订阅）、列表虚拟化（@tanstack/react-virtual，引入前过 D 决策——新增依赖需计划覆盖，总则 0.6）；
   - 大列表：分页/窗口化。
4. **验收**：Top10 热点 ≥6 项修复 + 目标页面同口径指标提升 ≥30% + 像素回归全绿（优化不得改变视觉）。

## 6. 沟通机制与资源需求

- **节奏**：每日站会纪要（异步文字，≤5 行）；每阶段末（D5/D12/D20/D28）阶段评审会（纪要 + ADR 归档）。
- **通道**：缺陷与任务走仓库 issue/任务清单；决策走 ADR；验证证据走 ops log（规则 5）。
- **资源需求**：前端负责人 1（核心）、QA 1（兼职可）、agent（脚本/测试/留痕/报告，已具备）；环境：Playwright 浏览器矩阵 CI 时长配额、（D3 若选 LFS）LFS 存储配额。
- **升级路径**：验收标准冲突或规则间冲突 → 按总则 0.6 停机请求用户决策，不得自行扩大范围。

## 7. 风险登记册

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 像素基线噪声（动画/字体/时区） | 高 | 门禁失信 | §3.2 确定性清单前置 + D1 容差决策 + 允许差异显式清单 |
| 基线体积膨胀拖慢 clone | 中 | 开发体验 | D3 提前实测体积，>50MB 走 LFS/分支 |
| 渲染优化引入视觉回归 | 中 | 返工 | 所有优化 PR 过像素 diff 门禁（视觉不变为硬约束） |
| 新增依赖（虚拟滚动库）未批先引 | 低 | 违反总则 0.6 | 依赖清单在 D 决策会统一过审 |
| 时间轴滑期 | 中 | 承诺失信 | 时间轴为规划参考；滑期走阶段评审重新排期，不静默延迟 |

## 8. 红线对照（AGENTS.md）

规则 1（每阶段最小改动，优化项可删性检验）｜规则 2（改前备份→验→删）｜规则 3+5（每任务一次 ops log + 双远端推送）｜规则 7（测试垂直切片，禁止先铺满测试再实现）｜规则 8（测量/门禁脚本走确定性函数 + 注入假件）｜规则 9（无 force/reset；基线分支管理同样禁强删）｜规则 10（本计划已标注事实/判断分离与会议边界异议）｜规则 11（无密钥入库）。

---

**批准门槛**：本计划经用户批准 + D1–D5 决策点会议结论落盘后，T1 阶段方可开工（计划未冻结不得动工，总则 0.4）。

## 附录 A：T1.3 任务契约（像素基线建设）

```
任务: 建设确定性像素 diff 基线——页面 × 浏览器 × 视口矩阵快照 + 独立 snapshot 配置（复用既有 e2e 基础设施）
开工前置: D1（容差默认值）与 D2（页面范围）会议结论；D3 以实测数据驱动（见验收 3，无需会前拍板）
改动清单（文件级）:
  1. playwright.snapshot.config.mjs（新）——独立配置，不动既有 playwright.config.mjs：
     projects = chromium/firefox/webkit × 视口 {desktop 1440×900 / tablet 768×1024 / mobile 390×844}；
     testDir ./e2e 且 testMatch 仅 *snapshot*（与功能用例隔离）；
     确定性 use：reducedMotion:"reduce"、固定 deviceScaleFactor 与 timezoneId、
     screenshot:"off"（快照仅由 toHaveScreenshot 产生）；
     baseURL 沿用 http://localhost:18789（后端生命周期复用 scripts/run-e2e.cjs，不改动）
  2. e2e/visual-snapshot.spec.ts（新）——页面清单从 src/computer-use/frontend-audit.ts 的
     DEFAULT_AUDIT_PAGES 导入（单一事实源，禁止复制清单）；每页：goto → 后端就绪等待 →
     document.fonts.ready → toHaveScreenshot（动态区域 mask 清单 + D1 容差参数）
  3. .gitignore（修订）——在 e2e/*.png 规则上增加基线快照目录例外（e2e/**/*-snapshots/ 入库）；
     首轮基线落库后实测总体积，>50MB 时回退 D3 备选（git LFS 或独立基线分支），实测数据落 ops log
验收标准:
  1. --update-snapshots 首跑生成基线，数量 = 页面数 × 3 浏览器 × 3 视口，逐项可数
  2. 二跑零 diff（确定性自证）；临时注入 1px 样式差异 → 红；还原 → 绿（门禁自证）
  3. 基线 PNG git ls-files 可见，总体积实测数字写入 ops log（D3 决策证据）
  4. 既有功能 e2e（默认 config）回归全绿——存量行为零影响
  5. 动态区域 mask 清单作为交付物随基线提交（首轮运行后迭代补齐）
不做项: 不改 playwright.config.mjs 与既有功能用例；不接 CI 门禁（T2.3 范畴）；不动 LLM 审核链
验证命令: npx playwright test -c playwright.snapshot.config.mjs（×2 验确定性）;
  npx playwright test（回归）; git ls-files "e2e/**/*-snapshots/**" 计数; du 实测体积
风险/回滚: ①动态内容噪声（时间戳/列表顺序）→ mask 清单迭代 + 必要时测试态数据固定；
  ②基线体积 → 实测驱动 D3；回滚 = revert 提交 + 删基线目录（纯新增，无历史包袱）
```

## 附录 B：T3.1 任务契约（渲染层级深度扫描脚本）

```
任务: 确定性渲染层级深度扫描脚本——frontend/src/**/*.tsx 的 JSX 嵌套深度审计，产出 >10 层热点清单
开工前置: 无（不依赖 D1-D5；纯本地零网络零 LLM）
口径决策（契约内冻结，判断）: T3.1 只做「单文件 AST 静态 JSX 嵌套深度」——确定性高、实现小、
  直接回答"哪几处嵌套过深"；「跨文件组件引用图深度」裁剪为后续可选（T3.2 Profiler 若证实
  组件树深度是瓶颈再补，避免投机实现——规则 1/8）。运行时深度归 T3.2。
改动清单（文件级）:
  1. scripts/frontend/render-depth-audit.ts（新）——
     纯函数核心 scanJsxDepth(source: string): { maxDepth: number; hotspots: Array<{line,depth}> }
     （小接口大实现，测试面即函数面）；实现用 typescript 包 createSourceFile 遍历
     JsxElement/JsxSelfClosingElement 嵌套（零新增依赖——typescript 已在依赖树）；
     CLI 薄封装：glob frontend/src/**/*.tsx → 每文件深度 + 全仓 Top 清单；
     报告双份：JSON（reports/，ignore 内）+ Markdown 摘要（>DEPTH_WARN=10 层清单，文件:行号）
  2. tests/frontend/render-depth-audit.test.ts（新，bun test 对齐仓库测试惯例）——
     夹具字符串用例：浅嵌套/深嵌套/自闭合/Fragment/条件渲染/空源/语法错误容错；
     TDD 垂直切片（RED→GREEN 逐用例）
验收标准:
  1. bun test tests/frontend/ 绿，夹具深度数字精确匹配
  2. 对 frontend/src 全量跑两次输出 diff 为空（确定性可复现）
  3. 报告含 >10 层组件清单（文件:行号），可直接作为 T3.3 优化输入
  4. npx tsc --noEmit 零错；零新增依赖（package.json 无 diff）
不做项: 不做运行时插桩与 Profiler（T3.2）；不修改任何前端组件（T3.3）；不引入新依赖；
  跨文件引用图深度（后续可选，需回 Plan 补契约）
验证命令: bun test tests/frontend/render-depth-audit.test.ts;
  bun run scripts/frontend/render-depth-audit.ts（×2 diff）; npx tsc --noEmit
风险/回滚: JSX 语法长尾（泛型组件/可选链子元素）→ 测试夹具覆盖主要形态，
  未覆盖形态进"不做/后续"并如实记录；回滚 = revert（纯新增文件）
```
