# 审计 Round 8 — 会话自审（修复 diff 回归检查）

> **日期**: 2026-10-13
> **范围**: `3ac08931^..HEAD` — round-7 修复全量 diff 的自审
> **动机**: PCDA-Check 阶段 — 验证 round-7 的 82 项修复是否引入新问题
> **方法**: 5 路并行 subagent 审查 33 个可审文件（+860/-1002 行）
> **结论**: 9 findings → 7 fixed / 1 safe / 1 design-choice → 零回归

---

## 审计范围

| 指标 | 值 |
|------|-----|
| 审查 commit 区间 | `3ac08931^..f6a08ba0` |
| 可审文件数 | 33 |
| 净变化 | +860 / -1002 行 |
| 审查路数 | 5（并行 subagent） |
| 模型 | codearts/GLM-5.2 |

---

## Findings 清单

### F1 [HIGH] — releaseItems 级联唤醒只唤醒半数等待者

| 字段 | 值 |
|------|-----|
| 文件 | `src/decision/laya-http.ts` |
| 行号 | releaseItems() cascade-wake loop |
| 严重度 | HIGH |
| 状态 | **FIXED** (commit f6a08ba0) |

**问题**: `for (let i = 0; i < waiters.length; i++)` 配合 `waiters.shift()` 只唤醒半数等待者——`i++` 和 `length--` 在中间收敛，跳过后半部分。

**修复**: 改为 `while (waiters.length > 0)` drain-all 模式，确保所有等待者被唤醒。

**验证**: `tests/decision/laya-http.test.ts` 76/0 pass。

---

### F2 [MEDIUM] — openEvents() SSE 超时中断整个 fetch（含 body stream）

| 字段 | 值 |
|------|-----|
| 文件 | `src/daemon/client.ts` |
| 行号 | openEvents() |
| 严重度 | MEDIUM |
| 状态 | **FIXED** (commit f6a08ba0) |

**问题**: `AbortSignal.timeout(this.timeoutMs)` 在 timeoutMs 后中止整个 fetch，包括 body stream——SSE 连接被切断，无法持续接收事件。

**修复**: 改用手动 `AbortController` + `setTimeout`，在 `fetch()` resolve（headers 收到）后 `clearTimeout`，body stream 不受超时影响。

---

### F3 [MEDIUM] — mind-tools forward 模式声称忽略 engineProvider 但实际捕获

| 字段 | 值 |
|------|-----|
| 文件 | `src/mcp/server/mind-tools.ts` |
| 行号 | registeredEngineProvider 赋值 |
| 严重度 | MEDIUM |
| 状态 | **FIXED** (commit f6a08ba0) |

**问题**: 警告信息说 forward 模式忽略 `engineProvider`，但 `registeredEngineProvider = opts?.engineProvider ?? null` 无条件捕获了它。

**修复**: `const registeredEngineProvider = (opts?.forward ? null : opts?.engineProvider) ?? null;` — forward 模式显式置 null。

---

### F4 [MEDIUM] — dre-daemon catch 块无服务端日志，栈丢失

| 字段 | 值 |
|------|-----|
| 文件 | `src/daemon/dre-daemon.ts` |
| 行号 | catch block |
| 严重度 | MEDIUM |
| 状态 | **FIXED** (commit f6a08ba0) |

**问题**: catch 块直接返回错误给客户端，无 `logger.error` 调用——服务端日志缺失，栈无法追溯。同时未防护非 Error 抛出。

**修复**: 在返回前加 `logger.error(...)`；非 Error 抛出用 `err instanceof Error ? err.message : String(err)` 防护。

---

### F5 [MEDIUM] — pipeline reader.cancel() 异步拒绝未捕获

| 字段 | 值 |
|------|-----|
| 文件 | `src/routes/pipeline.ts` |
| 行号 | idle-timeout handler |
| 严重度 | MEDIUM |
| 状态 | **FIXED** (commit f6a08ba0) |

**问题**: `void reader.cancel("idle-timeout")` 在 try/catch 中，但 `cancel()` 返回 Promise——异步拒绝不会被 try/catch 捕获，导致 unhandled rejection。

**修复**: 改为 `reader.cancel("idle-timeout").catch(() => {})`。

---

### F6 [LOW] — pipeline done 分支 controller.close() 缺 try/catch

| 字段 | 值 |
|------|-----|
| 文件 | `src/routes/pipeline.ts` |
| 行号 | done branch |
| 严重度 | LOW |
| 状态 | **FIXED** (commit f6a08ba0) |

**问题**: `done` 分支的 `controller.close()` 未包 try/catch——idle timer 可能已关闭 controller，二次 close 抛错。

**修复**: 包 try/catch 忽略已关闭错误。

---

### F7 [LOW] — kernel _shutdownStarted 永不重置

| 字段 | 值 |
|------|-----|
| 文件 | `src/dre/kernel.ts` |
| 行号 | startTickLoop() |
| 严重度 | LOW |
| 状态 | **FIXED** (commit f6a08ba0) |

**问题**: `_shutdownStarted` 在 `shutdown()` 中置 true 但 `startTickLoop()` 中从不重置——kernel 重启后永久拒绝 tick。

**修复**: 在 `startTickLoop()` 开头加 `this._shutdownStarted = false;`。

---

### F8 [LOW] — kernel tick-loop 竞争条件

| 字段 | 值 |
|------|-----|
| 文件 | `src/dre/kernel.ts` |
| 行号 | tick loop catch |
| 严重度 | LOW |
| 状态 | **SAFE** — 无需修复 |

**分析**: tick-loop 的 Promise 链在 shutdown 后可能触发一次额外 tick，但该 tick 的 `.catch()` 已捕获异常并记录日志，不会导致未处理拒绝或崩溃。竞态窗口存在但已被 `.catch()` 兜底。

---

### F9 [MEDIUM] — calibrate misses 数组不含 no-distribution 场景

| 字段 | 值 |
|------|-----|
| 文件 | `src/decision/laya-http.ts` |
| 行号 | calibrate() misses array |
| 严重度 | MEDIUM |
| 状态 | **DESIGN CHOICE** — 不修复 |

**分析**: 审计 H2 有意将"无分布"场景排除在 misses 数组之外——misses 仅记录"有分布但校准失败"的情况。"无分布"是合法终态，不应计为 miss。此为设计决策，非缺陷。

---

## 修复验证

| 检查项 | 结果 |
|--------|------|
| `tsc --noEmit` | rc=0 ✓ |
| 变更文件测试 (76 tests) | 76 pass / 0 fail ✓ |
| kernel/pipeline/arch 测试 (185 tests) | 185 pass / 0 fail ✓ |
| 全量后端测试 (4873 tests) | 4869 pass / 4 fail / 67 skip |
| 预存失败对比 | 修改前同样 4 fail — **零回归** ✓ |

### 预存 flaky tests（非本次引入）

1. `[T4-②] browser-tools cdpUrl 守卫` — 5s timeout，需浏览器环境
2. `S5 Actor ask/NACK/超时风暴 800 并发` — 全量负载下 30s timeout，单独跑 3/3 pass (~108ms)
3. `docs-consistency Task16 ARCHITECTURE.md §1` — 全量负载下 stats 生成竞态
4. `chat-title` (frontend) — `localStorage is not defined`（bun test 无 DOM）

---

## 处置摘要

| 严重度 | 总数 | 修复 | 安全 | 设计选择 |
|--------|------|------|------|----------|
| HIGH   | 1    | 1    | 0    | 0        |
| MEDIUM | 5    | 4    | 0    | 1        |
| LOW    | 3    | 2    | 1    | 0        |
| **合计** | **9** | **7** | **1** | **1** |

**零回归确认**: 修改前后全量测试均为 4 fail / 67 skip / 4873 tests — 失败集相同，无新增失败。
