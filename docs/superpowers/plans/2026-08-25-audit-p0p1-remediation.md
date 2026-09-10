# 审计 P0+P1 整改实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地规格书《2026-08-25-audit-p0p1-remediation-design.md》：修复审计 P0 安全红线与 P1 正确性共约 30 项，四语言区全绿。

**Architecture:** 五域并行子代理施工（Go / Rust+Python / TS-安全 / TS-编排KAL / TS-DRE基础设施），文件所有权制防写冲突；每域独立 TDD 红绿；主控跑集成门禁后按域提交推送。

**Tech Stack:** Bun+TypeScript、Go 1.26、Rust(cargo 1.97)、Python(FastAPI，无本地解释器)、bun:test。

## Global Constraints

- 每个域代理修改任何文件前：先复制到 `.tmp/backups/<相对路径>`（规则2）；验证通过后删除自己的备份。
- 只做本任务最小改动（规则1）；不顺手重构。
- MCP 工具名集合不得变化：改完 registry 相关代码后动态计数必须仍为 188/0 重名。
- 测试先行：每个行为改动先写失败测试再实现（规则7）。
- 禁止：`git push --force`、`git reset --hard`、`git clean -f`（规则9）。所有提交由主控执行。
- 验证命令一律在仓库根 `D:\openclaw-fusion` 运行；Go/Rust 子命令在各自子目录。

---

## 域① Go（runtime-go）

### Task G1: HTTP token 中间件

**Files:**
- Create: `runtime-go/internal/httpauth/auth.go`
- Create: `runtime-go/internal/httpauth/auth_test.go`
- Modify: `runtime-go/cmd/searchd/main.go`、`cmd/agentd/main.go`、`cmd/pcdad/main.go`（挂中间件）

**Interfaces:**
- Produces: `httpauth.WriteGuard(envKey string, isWrite func(*http.Request) bool) func(http.Handler) http.Handler`
  - env 未配置该 key：写请求返回 `403 {"error":"write endpoint disabled: set <envKey>"}`，读放行。
  - 已配置：请求头 `X-Axiom-Token` 经 `crypto/subtle.ConstantTimeCompare` 匹配方放行写。

- [ ] Step1 备份三个 main.go 到 `.tmp/backups/runtime-go/cmd/*/main.go`。
- [ ] Step2 写失败测试：表驱动覆盖 未配置env+POST→403、配置env+正确头→200、错误头→403、GET恒200。
- [ ] Step3 `cd runtime-go; go test ./internal/httpauth/...` 确认 RED（包不存在）。
- [ ] Step4 实现 auth.go：

```go
package httpauth

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
)

func WriteGuard(envKey string, isWrite func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isWrite(r) {
				next.ServeHTTP(w, r)
				return
			}
			token := os.Getenv(envKey)
			if token == "" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "write endpoint disabled: set " + envKey})
				return
			}
			got := r.Header.Get("X-Axiom-Token")
			if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				http.Error(w, `{"error":"invalid token"}`, http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

- [ ] Step5 测试 GREEN。Step6 三个 main.go 用各自 envKey（`SEARCHD_AUTH_TOKEN`/`AGENTD_AUTH_TOKEN`/`PCDAD_AUTH_TOKEN`）包裹 mux；isWrite 判定：方法非 GET/HEAD 即写。
- [ ] Step7 `go build ./... && go vet ./... && go test ./internal/httpauth/...` 全绿。

### Task G2: pprof 门控

**Files:** Modify `runtime-go/internal/search/httpapi.go:44-48`
- [ ] Step1 备份。Step2 将 5 行 pprof HandleFunc 移入 `if os.Getenv("DEBUG_PPROF") == "1" { ... }`。
- [ ] Step3 `go build ./... && go test ./internal/search/...` 绿。

### Task G3: persist 静默失败补观测 + pcdad 信号修复

**Files:** Modify `runtime-go/internal/pcda/persist.go:288,303`、`runtime-go/cmd/pcdad/main.go:105-119`
- [ ] persist 两处 `_ =` 改为捕获 err 并经本包既有日志途径输出 `pcda.persist.snapshot_failed` / `pcda.persist.wal_sync_failed`（跟随文件现有日志风格）。
- [ ] pcdad：删除第二个阻塞 `<-sig`；改为 ServeAll 返回后直接执行最终快照+WAL关闭并退出；信号 ctx 取消即触发返回（signal.NotifyContext 语义）。
- [ ] `go build ./... && go vet ./... && go test ./internal/pcda/...` 绿。
- [ ] 在 runtime-go/README.md 末尾追加「鉴权与调试」小节：三个 TOKEN env 与 DEBUG_PPROF 的说明（集群部署须为各节点配置对应 TOKEN）。

---

## 域② Rust + Python

### Task R1: query.rs 单引号 panic 守卫

**Files:** Modify `native/crates/search/src/query.rs:27-28`；同文件 `#[cfg(test)] mod tests` 追加用例
- [ ] Step1 备份 query.rs。Step2 写失败测试：

```rust
#[test]
fn single_quote_token_does_not_panic() {
    let plan = QueryPlan::parse("\"");
    assert!(plan.exact_phrases.is_empty());
    let plan2 = QueryPlan::parse("\"exact phrase\"");
    assert_eq!(plan2.exact_phrases, vec!["exact phrase".to_string()]);
}
```

- [ ] Step3 `cd native; cargo test -p oc-search single_quote` 确认 RED（panic）。
- [ ] Step4 条件改为 `part.len() >= 2 && part.starts_with('"') && part.ends_with('"')`。Step5 同命令 GREEN。

### Task R2: cloud CORS 收敛

**Files:** Modify `native/crates/cloud/src/main.rs:145`
- [ ] Step1 备份。Step2 `CorsLayer::permissive()` 替换为按 env `AXIOM_CLOUD_CORS`（逗号分隔，默认 `http://localhost:18789,http://127.0.0.1:18789`）构造 `AllowOrigin::list`；解析失败项忽略并 tracing::warn。
- [ ] Step3 `cargo check -p axiom-cloud` 绿。

### Task R3: 凭据退出 argv

**Files:** Modify `src/native-bridge.ts:72-92`（spawn args 构造处）
- [ ] Step1 备份。Step2 删除 `--database-url/--redis-url` 的 argv 推入；在 spawn 对象显式传 `env: { ...process.env }`（Bun.spawn 默认继承，保留显式以固化意图）。cloud 侧 clap `env = "DATABASE_URL"/"REDIS_URL"` 自动读取进程环境——若 REDIS_URL 默认值依赖 argv 缺省路径，改为 Rust 侧 `Option<String>` + 代码内默认。
- [ ] Step3 `bunx tsc --noEmit` 绿；grep 确认 bridge 内不再出现 `--database-url`。

### Task P1: pdf-worker 加固

**Files:** Modify `scripts/pdf-worker/app.py`
- [ ] Step1 备份。Step2 文件头部新增常量与纯函数（完整代码）：

```python
import ipaddress
import socket
from urllib.parse import urlparse

_MAX_DOWNLOAD_BYTES = int(os.environ.get("PDFWORKER_MAX_BYTES", str(50 * 1024 * 1024)))
_BLOCKED_HOSTS = {"localhost", "metadata.google.internal", "169.254.169.254"}

def _is_private_url(url: str) -> bool:
    """True = 必须拒绝（私网/环回/链路本地/保留段/非 http(s)/解析失败）。"""
    try:
        p = urlparse(url)
        if p.scheme not in ("http", "https"):
            return True
        host = p.hostname or ""
        if host.lower() in _BLOCKED_HOSTS:
            return True
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return True
        return False
    except Exception:
        return True
```

- [ ] Step3 三种 task_type 抓取前：`if _is_private_url(url): raise HTTPException(403, "blocked url")`。
- [ ] Step4 mineru 调用改数组形式：
```python
cmd = ["mineru", "--cpu=true", "--pdf", str(pdf_path), "--output-dir", str(output_dir)]
proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
```
- [ ] Step5 下载体上限：url 分支用 `resp.aiter_bytes()` 累计超限即中断；b64 分支解码前校验 `len(payload_b64) * 3 // 4 > _MAX_DOWNLOAD_BYTES` 拒绝。
- [ ] Step6 tasks dict 淘汰：写入前 `while len(tasks) >= 500: 弹出最旧的已完成项`（dict 保序）。
- [ ] Step7 若 `uv --version` 可用则 `uv run python -m py_compile scripts/pdf-worker/app.py`；否则逐行人工复核并在报告中注明验证方式受限。

---

## 域③ TS-安全

### Task S1: 高危端点二因素 token

**Files:** Modify `src/routes/terminal.ts:29-39`、`src/routes/git.ts`(push 与 commit handler 入口)、`src/routes/health.ts`(POST /config 与 POST /permissions/mode handler 入口)
- [ ] Step1 备份四个文件。Step2 扩展 tests/route-auth.test.ts：新增用例「terminal create 无二层 token 且 AXIOM_SECOND_FACTOR_TOKEN 配置时 403」「配置+正确头通过」等（RED）。

```ts
// 断言形态（对齐既有 fake ctx 模式）
it("/terminal/session requires second factor", async () => {
  process.env.AXIOM_SECOND_FACTOR_TOKEN = "t-secret";
  const res = await handleTerminalCreate(fakeCtx({ method: "POST", pathname: "/terminal/session" }));
  expect(res?.status).toBe(403);
});
```

- [ ] Step3 实现：各 handler 在路由匹配后立即插入

```ts
const authErr = requireAuthToken(ctx);
if (authErr) return authErr;
```

requireAuthToken 所读 env 统一为 `AXIOM_SECOND_FACTOR_TOKEN`（如现函数读其他键名，改其默认读取或加参数，保持 sandbox.ts 调用点兼容）。
- [ ] Step4 定向测试 GREEN；`bunx tsc --noEmit` 绿。

### Task S2: CSWSH 修复

**Files:** Modify `src/utils/ws-auth.ts`
- [ ] Step1 备份 + 扩展 tests/ws-auth.test.ts（RED）：
  - 本地 + 无 Origin 头 → 放行（curl/ws 客户端）
  - 本地 + Origin 同源（origin 的 host:port == 请求 host:port）→ 放行
  - 本地 + Origin 跨源 + 无 token → 拒绝
  - 本地 + 跨源 + 合法 token 子协议 → 放行
- [ ] Step2 实现：WsAuthInput 增加 `origin?: string | null` 与 `host?: string`；checkWsUpgradeAuth 本地分支改为上述四态判定（URL 解析失败一律拒绝带 Origin 的升级）。
- [ ] Step3 GREEN + tsc 绿。主控集成阶段确认 main.ts 升级调用点透传了 origin/host（若无则补传——main.ts 归域③所有）。

### Task S3: git 参数注入根治

**Files:** Modify `src/mcp/tools/terminal.ts`(executeCommand)、`src/mcp/tools/git.ts`(全部字符串拼参调用点)、`src/utils/command-safety.ts`(黑名单补充)
- [ ] Step1 备份三文件。Step2 command-safety.test 追加 RED 用例：`sanitizeCommand('git commit -m "$(id>p)"')` → unsafe；含反引号、`%VAR%` 同理。
- [ ] Step3 executeCommand 增加可选第三形态：当传入 `args: string[]` 时走 `Bun.spawn([cmd, ...args], {cwd, timeout, stdout:"pipe", stderr:"pipe"})` 非 shell 路径，返回结构不变。
- [ ] Step4 git.ts 中 commit -m / diff <file> / log --author/--since/--grep / blame <file> 全部迁移数组通道；黑名单追加 `/\$\(/`、/`/、`/%[A-Za-z_]\w*%/` 三模式（仅影响遗留字符串通道）。
- [ ] Step5 定向 GREEN + tsc 绿。

### Task S4: 前端市场链接协议白名单

**Files:** Modify `frontend/src/pages/Plugins.tsx:437,489,516`
- [ ] 三处 href 改为 `href={/^https?:\/\//i.test(u) ? u : undefined}`（对齐 search-panels.tsx:405）；`frontend` 目录 `bunx tsc --noEmit` 绿。

---

## 域④ TS-编排与KAL

### Task O1: 模式门控接线 + 键名扩展（tool-registry.ts 单文件所有权）

**Files:** Modify `src/mcp/tool-registry.ts`、新增 `tests/unit/tool-mode-gate.test.ts`
- [ ] Step1 备份。Step2 RED 测试：设 executionMode 为 plan 后 runTool("fs_write") 必须抛阻断错误；agent 模式下 destructive 工具触发 approval-bridge spy（注入 fake bridge，resolve rejected→抛错）；yolo 直通。
- [ ] Step3 先通读 execution-mode.ts 实际导出 API（canExecute/blockedTools/needsApproval），在 defaultToolGuard 权限硬底线之前插入模式检查分支；审批经 approval-bridge 既有请求接口，超时拒绝语义不变。硬底线正则扩为 `/^(path|file|filePath|target|destination|source|from|to|repoPath|cwd|dir)$/i`。
- [ ] Step4 GREEN + `bun run scripts/count-tools.mjs` 仍 188/0 + tsc 绿。

### Task O2: orchestrator 超时与确认闭环

**Files:** Modify `src/agents/orchestrator.ts`；扩展 `tests/orchestrator.test.ts`
- [ ] RED：fake agent.execute 永挂 + task.timeout=50 → 结果 failed 且 error 含 "timeout"；requireConfirmation=true 时 approval 被拒 → 任务不执行。
- [ ] 实现：executeTask 包 Promise.race（timer 清理）；确认分支调 approval-bridge（复用 S1 同一 env 体系外的既有桥接 API），拒绝/超时→failed result 不执行。

### Task O3: KAL 四修（F1/F2/F4/F5）

**Files:** Modify `src/kal/knowledge-access-layer.ts`；扩展 `tests/kal-references.test.ts`
- [ ] RED 四例：①tagFilter=["a"] 过滤生效；②真实 `.md` 路径笔记的入链可查（createNodeId 往返）；③存在 kg_edge(单数表) 边时 getReferences 可见；④vault 恒 0.8 不再无条件压库（归一化后同分排序稳定）。
- [ ] 实现：
  - F2：vault 腿生成结果时同步构建 `nodeIdToPath` Map；getReferences vault 分支用它反查原始路径再调 getWikiBacklinks。
  - F1：queryVault 结果映射后按 parseTags(row.tags) 包含全部 tagFilter 过滤（对齐 sqlite-memory.ts:254 语义）。
  - F4：引用查询改 UNION：

```sql
SELECT source, target, type FROM kg_edges WHERE source = ? OR target = ?
UNION ALL
SELECT src_node, dst_node, relation FROM kg_edge WHERE src_node = ? OR dst_node = ?
LIMIT 50
```

  （单数表不存在时 catch 吞掉该腿并 debug 日志。）
  - F5：merge 前按 store 分组求 maxScore，score/maxScore 归一化后再排序。
- [ ] GREEN + kal-references 全绿 + tsc 绿。

### Task O4: Actor 有界邮箱 + Scheduler 代数守卫

**Files:** Modify `src/dre/actor/system.ts`、`src/dre/runtime/scheduler.ts`、`src/dre/kernel.ts`；扩展 `tests/dre-core-modules.test.ts`、`tests/unit/scheduler.test.ts`
- [ ] ActorInstance 构造接受 `mailboxCapacity=256`；receive 溢出丢最旧并 `droppedCount++`（每 100 次降采样 warn）；getState 暴露 droppedCount。
- [ ] Scheduler Task 增加 `gen: number`；preemptOne 中 `task.gen++`；kernel dispatch 时快照 gen 并在 complete 回传；complete 发现 running 无此 id 或 gen 不匹配 → `logger.warn("[Scheduler] stale complete ignored")` 且不入队重执行副作用（任务已在队列由新 gen 承接）。
- [ ] 各自定向测试 GREEN。

### Task O5: web-search 路由钳制消毒

**Files:** Modify `src/routes/search.ts`；扩展 `tests/routes/search-route.test.ts`
- [ ] RED：num=9999 请求返回条数 ≤30 且字段长度受限于 sanitize 常量；vault limit=10000 → ≤100。
- [ ] 实现：`num = Math.min(Number(...) || 10, 30)`；结果过 `sanitizeSearchResultsForContext`；vault limit 同法钳 100。

---

## 域⑤ TS-DRE与基础设施

### Task D1: canRun=false 时禁止直发 llama.cpp

**Files:** Modify `src/dre/system-resource.ts`(暴露 canRunLocal 至 getStatus)、`src/dre/llm/client.ts`;扩展 `tests/unit/clamp-max-tokens.test.ts`
- [ ] RED：manager 注入可用内存 100MB → generate() 抛 retriable=false LLM_ERROR（消息含 "insufficient resources"），且未发起 fetch（spy fetch 计数 0）。
- [ ] 实现：client 构造已持 manager 引用处，generate/chat/streamGenerate 公共入口统一 `assertBudgetAvailable()`；getStatus 增加 `canRunLocal: boolean` 字段（既有判定逻辑复用，不改阈值）。

### Task D2: nvidia-smi 可选探测插件

**Files:** Create `src/dre/system-resource-probe.ts`；Create `tests/unit/vram-probe.test.ts`
- [ ] 接口：`parseNvidiaSmiOutput(text: string): number | null`（取第一个 GPU 的 `memory.free` MiB 整数）；`startVramProbe(opts?: { intervalMs?: number; exec?: (args: string[]) => Promise<{ stdout: string }> }): () => void`，默认 exec 走 `nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits`；成功则 `getResourceBudgetManager().updateResource({ availableMemory: mb })`；env `AXIOM_VRAM_PROBE=1` 才允许启动，否则返回 no-op stop。
- [ ] RED→GREEN：纯函数表驱动（正常输出/多卡/异常文本）；probe 用注入 fake exec 断言 updateResource 生效与停止后不再轮询。
- [ ] main.ts 是否挂载留给主控集成决策（默认不挂，保持零行为变化；仅在 probe 模块导出并由 env 触发——main.ts 归域③，故本任务不改 main.ts，集成阶段一行接线由主控完成）。

### Task D3: 解除 dre→router 类型循环

**Files:** Modify `src/dre/constraint-injection.ts:15`
- [ ] 删除 `import type { ChatMessage } from "../router/provider-caller.js"`；文件内定义结构化最小类型 `interface DreChatMessage { role: string; content: string }` 并将使用点改名替换（结构性兼容，无需 router 侧改动）。
- [ ] `bun test tests/architecture-integrity.test.ts` 中 dre↔router 循环断言转绿（其余失败项由 D4/O1/S 组合解决）。

### Task D4: logger text 路径脱敏

**Files:** Modify `src/utils/logger.ts:191-198`；扩展 `tests/logger-redact.test.ts`
- [ ] RED：text 格式输出包含 context 中密钥值 → 应为 `[REDACTED]`。
- [ ] 实现：ctxStr 构造前过 `redactContext`；嵌套对象维持现状（登记局限）。

### Task D5: snapshot 二进制保真 + 部分失败聚合

**Files:** Modify `src/mcp/tools/workspace-snapshot.ts:187-206`；扩展 `tests/unit/workspace-snapshot-guard.test.ts`
- [ ] RED：夹具含二进制字节（0xFF 0x00 等）的文件 restore 后逐字节相等；两文件其一失败 → success:false + errors 数组含失败路径。
- [ ] 实现：`execFileSync("git", [...])` 去掉 encoding 得 Buffer → `fs.writeFile(dst, buf)`；收集 failures，循环结束 `success: failures.length===0`。

### Task D6: cli/setup console 合规

**Files:** Modify `src/cli/setup.ts` 或 `tests/architecture-integrity.test.ts`（二选一，以测试现行断言为准）
- [ ] 先读 tests/architecture-integrity.test.ts 中 console 断言的豁免机制与当前失败清单：若 TUI 向导类文件应豁免→把 `cli/setup.ts` 加入测试豁免清单（改测试需在提交信息说明理由）；否则将该文件 console.* 替换为本仓 logger。任一路径完成后该项断言绿。

---

## 集成与交付（主控）

- [ ] M1 五域代理回收报告 → 主控复跑全局门禁：`bunx tsc --noEmit`；`bun test ./tests`；`cd runtime-go && go build ./... && go vet ./... && go test ./internal/...`；`cd native && cargo test -p oc-search && cargo check --workspace`；动态计数 188；architecture-integrity 全绿。
- [ ] M2 文档收口（主控亲改）：README 版本统一 v4.0.0、乱码角色表修复、v2.9.2-COMPREHENSIVE-REPORT 断链移除、LIMITATIONS modelclient 表述更正（“默认占位符，运行期报错”）、tool-classifications vram_status 条目删除、ARCHITECTURE 补中文分词边界句。
- [ ] M3 卫生归档（规则4）：`.server-pid.txt` → `archive/root/.server-pid.txt` + ARCHIVE-LOG 记录 + `git rm`；`tmp-toctou-target/` 本地删除（untracked，记录日志即可）；`src/context/rate-distortion-compressor.ts.header` 归档同流程。
- [ ] M4 按域五次提交（每次先 ops-log 占位→commit→push internal211 codex/self-evolving-agent→回填 hash 小提交）。
