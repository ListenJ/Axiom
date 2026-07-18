# 操作日志（Operations Log）

> 按 `AGENTS.md` 规则 5：每次提交记录一条，提交一次记录一次。
> 字段：时间 / 任务 / 工具 / 操作 / 验证 / Commit。
> 约定：条目随代码同提交入库，Commit 字段先写初稿 hash 并注明 amend，
> 推送后的最终 hash 以 `git log` 为准（amend 仅补录本行，不再单独更正）。

---

## 2026-07-18 01:09 +0800 — 建立 runtime 底层规则

- **任务**：将用户制定的五条底层规则（最小化施工 / 备份-验证 / git 提交 / 删除即归档 / 操作留痕）落地为仓库级强约束。
- **工具**：Write、Bash(git)（本任务规模小，未拆分子代理）。
- **操作**：
  - 新建 `AGENTS.md`（五条 runtime 强约束规则）。
  - 新建 `docs/operations-log.md`（本日志）。
- **验证**：文件写入后回读确认内容完整。
- **Commit**：`0283702`（已推送 `internal211/main`；初稿 `b93ef74` 经 amend 补录本条，本条 hash 更正见紧随其后的更正提交）。

---

## 2026-07-18 10:32 +0800 — 深度分析薄弱点并修复两个 P0

- **任务**：深度分析全项目薄弱点并修复。基于 `docs/REVIEW-2026-07-17.md` + 2 个并行 explore 子代理（认证核实、前端扫描；另 3 个子代理因 API 配额 403 未运行，改由本地工具完成：tsc、全量 bun test、定向 grep）。
- **工具**：Agent(explore)×2、Read、Grep、Edit、Bash(bun test / tsc / curl 冒烟)。
- **发现**：
  - 🔴 P0-1 认证绕过：`main.ts` `isLocal` 判定用 `new URL(req.url).hostname`（即客户端可伪造的 `Host` header），`Host: localhost` 可免认证调用全部 API（HTTP 与 WebSocket 均受影响）。比评审推测的 XFF 向量更直接。
  - 🔴 P0-2 启动崩溃：`env.ts:288` `for (const warning of result.warnings) result.warnings.push(warning)` 边遍历边追加 → 无限循环；任何启动警告（如 token <32 字符、未知 AXIOM_ 变量）都会使内存膨胀至 ~26GB 后 Bun panic。本机两次复现（相同 panic 地址）。
  - 🟠 次要：`.json`/`.txt` 后缀免认证可泄露动态路由（如 `/traces/<id>.json`）；`startsWith("/ws")` 前缀过宽；`rate-limiter.ts` 限流键信任可伪造的 `x-real-ip`。
  - 基线（未修，非本任务引入）：tsc 4 个错误（auto-updater ×2、boundary-extreme.test ×2）；bun test 6 个失败（console.* 超限、process.env 违规 ×2、E2E Vault ×3、WorldState ×1）；前端中危 2 项（401 无统一处理、响应拦截器误存 token）。
- **修复（备份→读全文→最小改动→验证→删备份）**：
  - `src/main.ts`：`isLocal` 改用 `server.requestIP(req)` socket 对端地址（新增 `isLocalAddress()`，覆盖 127.0.0.1/::1/::ffff:127.0.0.1）；新增 `AXIOM_ALLOW_LOCAL_BYPASS` 开关（默认开，同主机反代时设 0）；`startsWith("/ws")` → `=== "/ws"`（2 处）；静态豁免改用 `AUTH_EXEMPT_EXTS`（剔除 .json/.txt）；限流传入 socket IP。
  - `src/utils/rate-limiter.ts`：`RateLimitMiddleware` 增加可选 `ip` 参数，优先使用服务端传入的 socket 地址。
  - `src/utils/env.ts`：删除 env.ts:288 的伪循环行（无限循环根因）。
  - `.env.example`：补充 `AXIOM_ALLOW_LOCAL_BYPASS` 部署说明（评审 P0-2 文档项）。
- **验证**：
  - tsc：4 个基线错误，0 新增；`tests/env.test.ts` 12/12 通过；`architecture-integrity` 20/22（2 个失败为基线）。
  - 单元复现：`validateEnv` 在触发警告时 2ms 返回（修复前死循环）。
  - 实机冒烟（HOST=0.0.0.0 + 短 token，同时验证两修复）：伪造 `Host: localhost` 经 LAN IP 无 token → 401（修复前绕过）；正确 token → 200；错误 token → 401；`/health` 公共路径 200；`/traces/x.json` 401；真实静态资源 200；WS 无 token 401；回环 socket 豁免正常（`/vault/stats` 200）。
- **Commit**：`ad17ea6`（已推送 `internal211/main`；初稿 `ee03634` 经 amend 补录本条）。

---

## 2026-07-18 10:58 +0800 — 清零基线：tsc 4 错误 + 6 个测试失败全部修复

- **任务**：继续完善——修复上一轮记录的既有基线问题（tsc 4 错误、bun test 6 失败）。
- **工具**：Read、Grep、Edit、Bash(bun test / tsc / node 统计脚本、最小复现探针)。
- **修复（备份→读全文→最小改动→验证→删备份）**：
  - `src/knowledge/auto-updater.ts`：`logger.error(msg, {error: ...})` 对象字面量误作 Error 参数（TS2353 ×2）→ 改传 `err instanceof Error ? err : new Error(String(err))`。
  - `tests/stress/boundary-extreme.test.ts`：`atom.metadata`/`payload` 为 unknown 导致的 2 处类型错误 → 加类型断言（仅测试内）。
  - `src/routes/models.ts`（5 处）、`src/knowledge/pipeline.ts`（1 处）、`src/knowledge/sources/github-trending.ts`（1 处）：`process.env` 直读 → `readString()`（架构约束 Test 2）。
  - `tests/architecture-integrity.test.ts` Test 16：console.* 违规 225 处全部位于 `cli/commands/*.ts`（CLI 用户可见输出，与白名单内 cli.ts 同一契约）→ 白名单放行 `cli/commands/` 前缀，并将阈值从 ≤200 收紧为 **0**（防回流）。
  - `tests/merge-stress.test.ts`：WorldState 为跨文件单例，`context-engine`/`dre-core-modules` 两文件残留的 "b1" belief 使计数 501≠500 → 测试开头清零 `mental.beliefs/goals` 再计数。
  - `tests/consciousness.test.ts`：Bun 1.3.14 的 `mock.module` 原地改写模块命名空间且多轮 mock/restore 后无法还原，fakeVault 泄漏到后运行的 `e2e-runtime.test.ts`（×3 失败）→ 文件加载时捕获原始导出引用到 `REAL_VAULT_EXPORTS`，`afterAll` 显式重新注册真实导出。（用 .tmp 最小探针复现并验证机理后修复，探针已删。）
- **验证**：tsc 0 错误（原 4）；架构测试 22/22（原 20）；**全量 bun test 1077 pass / 0 fail / 28 skip**（原 6 失败）； consciousness+e2e 组合 49/49。
- **Commit**：`b00e98f`（已推送 `internal211/main`；初稿 `0bb9ae4` 经 amend 补录本条）。

---

## 2026-07-18 11:30 +0800 — 前端安全/可靠性小修 + 认证逻辑抽取与回归测试（P0-3）

- **任务**：继续完善——处理剩余中低危项，并为 P0 认证修复补自动化回归防线。
- **工具**：Read、Edit、Bash(tsc / bun test / curl 冒烟)、AskUserQuestion（api.ts 决策，后台待答）。
- **修复（备份→读全文→最小改动→验证→删备份）**：
  - `frontend/src/pages/Research.tsx`：第三方来源链接 `<a href={s.link}>` 无协议校验（可注入 `javascript:` URL）→ 仅放行 `^https?://`，否则 href 为 undefined（锚点变不可点击）。
  - `frontend/src/components/PipelineIndicator.tsx`：`es.onerror = () => es.close()` 废掉了 EventSource 自带重连（一次瞬断永久失效）→ 删除该 handler，恢复浏览器自动重连。
  - `src/utils/auth-check.ts`（新建）：从 `main.ts` 抽出 `isLocalAddress()` + `checkApiKey()` 纯逻辑（apiKey 改为参数传入），main.ts 改为导入调用——行为零变化，可独立单测。
  - `tests/auth-check.test.ts`（新建，9 项）：回环识别、fail-closed、公共路径、**P0 回归（伪造 Host:localhost 的远程请求必须 401）**、.json/.txt 动态路由不豁免、/ws 精确匹配、x-api-key/Bearer 凭据。
- **验证**：tsc 后端+前端均 0 错误；全量 bun test **1086 pass / 0 fail**（新增 9 项认证测试）；抽取后实机冒烟 5/5（回环豁免 200、伪造 Host 401、正确 token 200、.json 路由 401、静态资源 200）。
- **未动**：`frontend/src/lib/api.ts` 两个中危（401 清 token、token 拦截器）——该文件有用户未提交改动；用户已决策：跳过，待其提交 WIP 后再修。
- **版本化说明**：`.gitignore:114` 声明 `frontend/`（前端未使用），`Research.tsx`、`PipelineIndicator.tsx` 未被跟踪且被忽略，本次前端修复仅落盘未入库（已通过前端 tsc 验证）；是否将前端正式纳入版本控制待用户决定。
- **Commit**：`9569e51`（amend 补录本条后推送 `internal211/main`；仅后端文件 + 本日志）。

---

## 2026-07-18 14:45 +0800 — 命令注入面消除 + redis-client 潜在 bug + 测试脆弱断言

- **任务**：继续完善——浅层安全补扫与 P3 小项。
- **工具**：Read、Grep、Edit、Bash(tsc / bun test / git show 补备份)。
- **修复（备份→读全文→最小改动→验证→删备份）**：
  - `src/cli.ts`（diag --fix）：`execSync(check.fix)` 经 shell 执行命令字符串 → 改为 `fs.mkdirSync(dir, {recursive:true})`（fix 串为 health-checker 内部生成的 `mkdir -p <dir>`），彻底移除 child_process 调用。注：这是仓库中唯一一处 execSync。
  - `src/utils/redis-client.ts`：**`Bun.connect` 返回 Promise 但未 await**——`this.socket` 实际是 Promise，所有命令 `write` 静默无效（被 4 处 `as any` 掩盖）→ 重构 `_connect()`（await + Promise.race 超时），socket 类型改为 `Socket`，4 处 `as any` 全消除。Redis 为可选组件（REDIS_URL 未配置），故该 bug 从未显现。
  - `tests/mcp-cognitive-integration.test.ts`：`totalDurationMs` 断言 `>0` 在热路径下必 flaky（performance.now 亚毫秒 + Math.round 可舍入为 0，用户新增测试文件改变 JIT 预热后确定性触发）→ 改断言"已测量且非负"。
  - 排查确认 `computer-use-agent.ts` 的 `as any` 仅存在于注释；`websocket.ts` 已有 MAX_WS_CLIENTS=100 上限（评审 P3-1/P3-10 均系过时结论）。
- **验证**：tsc 0 错误（仅用户 WIP `audit-logger.ts:218` 语法错误，未动）；redis 测试 3/3；全量 **1086 pass / 1 fail**（唯一 fail = 用户 WIP 文件 `tests/audit-logger.test.ts` 加载带语法错误的 audit-logger.ts，与本次改动无关）；cognitive_loop 组合/单跑均通过。
- **Commit**：`92632b6`（amend 补录本条后推送 `internal211/main`）。

---

## 2026-07-18 19:00 +0800 — CodeGraph shell 分词/注入修复 + 密钥泄露审计（P2-7 闭环）

- **任务**：继续完善——追查全量测试中的 CodeGraph "too many arguments for 'query'" 报错，补做安全扫描。
- **工具**：Read、Grep、Edit、Bash(bun -e 实证 / tsc / bun test)。
- **修复（备份→读全文→最小改动→验证→删备份）**：
  - `src/memory/codegraph-index.ts`：`runCodegraph` 用 `spawn(bin, args, {shell:true})`，shell 把含空格的查询分词（"Write bubble sort in Python" → 5 个位置参数报错），且查询可来自 LLM/用户输入 → **命令注入面**。修复：`getCodegraphBin` 优先解析 `node_modules/.bin/codegraph.exe`（Windows 免 shell）；`shell` 仅在 `.cmd/.bat` 时启用，且该路径下逐参数加引号。
  - 密钥泄露审计（评审 P2-7）：全量 grep 确认 logger 调用只出现密钥**名称**与"未配置"警告，无任何密钥值插值；`auto-updater.ts:242` 打印的 config 仅含调度参数（无密钥）。结论：无泄露路径，无需引入 redactSecrets。
- **验证**：多词查询实测 3 条结果无报错（修复前必现 "too many arguments"）；tsc 0 错误（除用户 WIP audit-logger）；全量 **1086 pass / 1 fail**（唯一 fail 仍为用户 WIP），套件中 CodeGraph 警告消失。
- **Commit**：`bf1ff46`（amend 补录本条后推送 `internal211/main`）。
