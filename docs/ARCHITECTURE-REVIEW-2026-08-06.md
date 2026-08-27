# 全仓整体合理性审查报告（2026-08-06）

> 日期：2026-08-06 ｜ 基线 commit：`fa117e9`（internal211/master，工作区干净）
> 方法：4 路并行只读子代理（后端核心 / 前端+壳 / 平台与基建 / 文档一致性）+ 关键证据人工复核
> 依据 skill：architecture（SOLID / KISS / YAGNI / 深模块）、code-review（正确性 / 安全 / 性能 / 可维护性 / 测试）
> 关联文档：docs/ARCHITECTURE-REVIEW-2026-08-04.md、docs/FRONTEND-REVIEW-2026-08-03.md、docs/RISK-REGISTER.md

---

## 一、最新进展（近 14 天）

- 提交 162 次（2026-07-25 → 08-06），主力作者 Sisyphus（总 472）+ ListenJ（总 80）。
- 主线是前端视觉/性能迭代：丝绸毛玻璃体系、Aurora 光斑、卡片玻璃、动画预设、消息编辑/重新生成、侧栏三段式、终端单实例、静态 gzip + assets 长缓存 + content-visibility。
- 08-04 四维架构审查的 P0/P1/P2 后端修复已全部落地并验证（意图五类映射、宪法注入聊天主路径、多引擎搜索通道、orchestrator stub 换真实调用、深研究接搜索）。
- 本机验证：`bun x tsc --noEmit` 通过（TSC_EXIT=0）；`bun test tests/architecture-integrity.test.ts` 22 pass / 0 fail。

## 二、总体结论

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 后端核心（src/） | 中 | 修复落地真实、错误处理集中、若干深模块质量高；但双实现 + 死代码 + 中心枢纽耦合 + 模式守卫失效四类结构债未收敛 |
| 前端（frontend/ + src-tauri/） | 良 | 08-03 审查项全部闭环、动效/单一来源/API 客户端质量高；但两个真实死端点 + Tauri 打包态 API 不可达 |
| 平台与基建（CI / 部署 / 多运行时） | 中 | 主服务可运行、降级设计好；但发布镜像空白页、CI E2E 必红、Rust 构建链损坏三个阻断项 |
| 文档与宣称一致性 | 中 | 维护纪律强，但版本六套口径、README 头部指标整体失真、三份"唯一权威"互斥、操作日志 hash 悬空 |

**总体判断：核心产品（Bun 网关 + React SPA + MCP 工具面）合理且健康，最近迭代方向（前端体验 + 08-04 修复）正确。"不合理"的部分集中在：① 发布/CI 链路（镜像不含前端、E2E 必失败、Rust 构建坏）② 多平台外围模块未决策（runtime-go / harmonyos 零接线）③ 结构债未收敛（双 orchestrator / 双 consciousness、模式守卫死代码、14+ 死模块）④ 文档数字大面积失真。**

## 三、Critical（阻断级，应优先处理）

1. **Docker 镜像不含前端 SPA → 生产空白页**：Dockerfile 三阶段只 `COPY public/`，无 frontend 构建步骤；`public/` 仅跟踪 `index.html`（.gitignore 忽略 `public/assets/`），index.html 引用的 hash 产物在干净 checkout 不存在；main.ts 静态根是 `./public`（src/main.ts:448）。→ 建议 Dockerfile 增加 frontend 构建 stage 并把 `frontend/dist` 拷入 `public/`（或静态根改指 `frontend/dist`）。
2. **CI E2E 步骤在干净 checkout 上必然失败**：`e2e/` 未被 git 跟踪（.gitignore:69，`git ls-files e2e` = 0）；ci.yml 跑 `bun run test:e2e` → scripts/run-e2e.cjs 对不存在目录抛 ENOENT，且硬编码 `playwright.exe`（Linux 无 .exe）。→ e2e/ 入库 + 平台无关路径。
3. **Rust native 构建链损坏**：native/Cargo.toml:32-34 在 `[workspace.dependencies]` 写 `optional = true`（Cargo 不允许），自 07-02 未修；package.json `native:build` 与 `build:all` 连带失败。→ optional 移到成员 crate 的 `[dependencies]`，CI 加 cargo check。
4. **前端死端点 `POST /api-keys/:provider/test`**：api.ts:611 调用，后端 src/routes/api-keys.ts:146-150 是 WIP 注释返回 null → 404，Providers 页"测试连接"必然失败。→ 补实现或前端禁用/移除该按钮。
5. **前端死端点 `GET /file-index`**：api.ts:493 + Code.tsx:75 + rightbar/panels.tsx:482 调用，后端无该路由 → 404 被 `.catch(() => [])` 静默吞掉。→ 补后端或改调 `/codegraph/status`，去掉静默吞错。
6. **执行模式守卫是死代码**：`executeWithModeGuard`（src/agents/execution-mode.ts:470-500）零调用方，Plan/YOLO 工具封锁对运行时实际不生效（08-04 P1"激活模式守卫"未落地）。→ 接线到 defaultToolGuard 或删除。

## 四、Warning（重要）

### 后端
- **两套 orchestrator 并存**：`agents/orchestrator.ts`（715 行，仅 MCP orchestrator-tools 消费）vs `router/task-orchestrator.ts`（TUI 消费），语义不同。
- **model-router 仍是中心枢纽**：12 个文件跨 10+ 层直接导入；`services/router.ts` facade（18 行 re-export）仅 2 个消费方。
- **14+ 非入口文件零引用**：runtime-audit.ts、crawl/concurrent-search.ts、crawl/html-to-markdown.ts、dre/runtime/verification-engine.ts、memory/enhanced-watcher.ts、router/code-retrieval-router.ts、services/cache-router.ts、utils/db-guard.ts、utils/error-handler.ts、utils/permission-middleware.ts、utils/concurrency/bounded-queue.ts、knowledge/index.ts、knowledge/sources/index.ts、runtime/index.ts、testing/index.ts、workers/index.ts。
- **64 个单例 getter**；黑板 key 无命名空间契约（`grep:<id>`、`task:<hash>`、`consciousness:self_state` 互相可见可覆盖）。
- **Skill 只进 GLM 改写器 system，不进最终 LLM prompt**；AGENTS.md 运行时零读取（src 内 0 命中）。
- **分层倒挂**：memory/file-watcher.ts:20 依赖 services/index；routes/agents.ts 直连 6 个 agent 模块。
- **双 consciousness 均接线**：agents/consciousness（主进程启动）与 dre/consciousness/stream.ts（DRE 引擎）并存；`recommendedRole` 在 HTTP 路径未使用（双份意图→角色映射易漂移）。

### 前端
- **Tauri 打包态 API/WS 不可达**：api.ts baseURL 为相对路径 ''、useApprovals wsUrl 取 window.location.host；打包后 origin 是 Tauri 资产协议，fetch/ws 打不到 127.0.0.1:18789。→ `isTauri()` 时显式切 `http://127.0.0.1:18789` 并统一收口。
- **页面过胖**：Chat.tsx 649、search-panels.tsx 783、chat-panels.tsx 642、rightbar/panels.tsx 624、Settings.tsx 515。
- **重复实现**：Sessions.tsx 本地重写 formatTime/formatTokens（chat-utils.ts 已导出）；Git.tsx 绕过 typed endpoints（api.get/post 直调 + 类型缺 shortHash）。
- **useMotion 三档偏好未全链路**：Layout/RightToolbar/HelpModal 仍直接 useReducedMotion；Sidebar.tsx:531 硬编码 duration。
- **"桌面通知"设置是空壳**：只写 localStorage 无人读，设置文案却承诺系统通知。
- **15+ 页面零测试**：Chat/Settings/Sessions/Search/Git/Code/Vault/Providers 等（42 测试文件集中在 lib/ui/state/motion + 3 页）。

### 平台 / 基建
- **runtime-go 零接线**：三守护进程（pcdad :9101 / agentd :9102 / searchd :9103）在 src/.ci/deploy/docker-compose 全无引用；4 次提交（最后 07-28）——质量高但未集成，需决策接线 or 归档。
- **CI 不覆盖 frontend / cargo / go / build matrix**；docker-compose 3001 映射无监听者；/native/* 只有降级路径测试无真实 sidecar 集成测试。
- **eng.traineddata（5.2MB）与 .server-pid.txt 被跟踪但 .gitignore 声明忽略**；Dockerfile.lightpanda COPY lightpanda-linux（未跟踪）干净 checkout 必失败。
- **e2e 只测 UI 壳 + 全量 mock**，不起 Bun 后端 → C1 空白页无回归网；CI 缓存 key 用 `bun.lockb`（实际 bun.lock）。

### 文档
- **版本六套口径**：v3.1（README/AXIOM-ARCHITECTURE）/ 4.0.0（package.json/CHANGELOG）/ 0.1.0（tauri.conf.json）/ v2.3（窗口标题 + main.ts:147）/ 2.9.2（mcp/server.ts:61,422）/ v4.1（EDGE-LLM）；main.ts 自身 147 vs 759 行矛盾。
- **README 头部指标失真**：93 tests → 实测 ~2,418 it/test；133 MCP → ~166；0 fail → 快照 6 fail；21 场景 → 23。
- **"唯一权威"三份互斥**：AXIOM-ARCHITECTURE.md（133 vs 145 内部矛盾）/ ARCHITECTURE.md / PROJECT-GUIDE.md 各称唯一权威且数字互斥。
- **operations-log 审计断裂**：128 个唯一 hash 中 19 个悬空（amend 前对象）；最近 8+ 条引用的 hash 与 git log 对不上且标注"已推送"不实；372KB 过肥；近 20 条首字符被制表符替换损坏。
- **RISK-REGISTER 未随 08-04 审查刷新**（最后 08-02）；R-016/R-024 MITIGATED 无后续排期；汇总行与表格矛盾（R-005/006 表内 CLOSED，汇总写 MITIGATED）。
- **环境变量三套口径**（.env.example / env.ts registry / 实际 ~69 个 readString）；README 引擎表列出 Brave/Tavily/Jina 但代码 0 实现；`/kg/relationships`、`/kg/path`、`vram_status` 为死示例。

## 五、Positive Notes

- **08-04 修复逐项验证全部落地**：route-table 五类映射、宪法注入、多引擎搜索、orchestrator 真实调用、深研究接搜索（Boole 逐文件复核 ✓）。
- **深模块亮点**：internal-agent（4 方法小接口全委托 router）、dispatcher（有界并发 + 防重复模型）、tool-pool（per-model 信号量）、unified-search（多引擎 + LRU/SQLite 缓存 + 重排）、provider-caller（payload 上限/超时）、constitution（纯函数小接口）、pty-terminal（adapter 注入）、api.ts（拦截器 + SSE + 降级）、native-bridge（优雅降级 503 + 关闭钩子）。
- **前端单一来源治理好**：shortcuts / nav / motion-presets / 会话入口收敛；zustand 无泄漏；278 测试卫生好。
- **后端错误处理闭环**：main.ts 全局 catch + createErrorResponse + toAxiomError；any 仅 9 处。
- **安全基线扎实**：RISK-REGISTER P0 全 CLOSED、.gitignore 覆盖面优秀、Dockerfile 安全加固（非 root / cap_drop / read_only）、HITL + WS 鉴权闭环。
- **e2e 用例质量高**：9 spec / 32 用例，无 skip/only，mock 边界清晰。

## 六、优先修复清单（建议排序）

1. **P0 发布链路**：Dockerfile 加前端构建 stage；e2e/ 入库 + run-e2e 平台无关；native/Cargo.toml optional 修复 + CI cargo check。
2. **P0 可见功能**：补/删 `/api-keys/:provider/test` 与 `/file-index`；Tauri 打包态 baseURL/WS 收口到 `http://127.0.0.1:18789`。
3. **P1 后端结构债**：激活或删除 executeWithModeGuard；orchestrator 二选一（保留 task-orchestrator，agents/orchestrator 按规则 4 归档）；model-router 扇入收敛到 services。
4. **P1 文档一致性**：统一版本口径（package.json 为单一事实源）；刷新 README/AXIOM 头部指标；修复 operations-log 悬空 hash 与损坏行；RISK-REGISTER 补 08-04 项。
5. **P2 外围模块决策**：runtime-go / harmonyos 接线或归档；14+ 死模块按规则 4 归档。
6. **P2 前端**：Chat 状态机抽 hook + 补页面测试；Sessions 去重；useMotion 全链路；桌面通知接线或降级。

---

## 七、子审查报告

四路子代理详细证据（file:line）已并入上文；逐条核对可检索以下文件：
- 后端核心：src/agents/orchestrator.ts、src/router/task-orchestrator.ts、src/router/model-router.ts、src/services/chat.ts、src/agents/execution-mode.ts、src/memory/blackboard.ts
- 前端：frontend/src/lib/api.ts、frontend/src/pages/Chat.tsx、frontend/src/components/search-panels.tsx、src-tauri/tauri.conf.json
- 平台：Dockerfile、.github/workflows/ci.yml、.gitignore、native/Cargo.toml、scripts/run-e2e.cjs
- 文档：README.md、docs/AXIOM-ARCHITECTURE.md、docs/ARCHITECTURE.md、docs/operations-log.md、docs/RISK-REGISTER.md