# 审计强化迭代实施计划（P0×6 / P1×5 / P2×2 → 9 执行任务）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清零联合审查新发现（High 5 / Medium 18 / Low·Info 21），P0 安全线先行，每片 TDD 红绿独立提交。

**Architecture:** 9 个串行执行任务（同工作区 git 提交需串行，禁并行），每任务 = 审计子代理模式：备份→通读→最小改→验证→删备份→留痕→提交推送。切片内容、修复锚点、TDD 要点已在 spec 第 1-3 节逐项给出，执行者必须同时读 spec 与本计划。

**Tech Stack:** Bun 1.3.14 / TypeScript strict / bun:test / zod。

**Spec:** `docs/superpowers/specs/2026-08-29-audit-hardening-design.md`（方案 A：P0 安全先行）。发现证据：`docs/reviews/2026-08-29-joint-verification-audit.md` 第 4 节。

## Global Constraints

- 分支 `codex/self-evolving-agent`；每任务 `git add <仅本任务文件>` → commit → `git push internal211 codex/self-evolving-agent`（AGENTS 规则 3）。
- 每任务：备份 `.tmp/backups/<相对路径>` → 通读全文 → 最小改动 → `bunx tsc --noEmit` 0 + 相关测试全绿 → 删备份（规则 2）。
- 每提交前 `docs/operations-log.md` 追加条目（日期 2026-08-29，hash 用 **bun 脚本唯一锚点**回填——禁止 sed 全局替换，已有两次事故教训）。
- 不回退既有修复（W 系/H 系/M1-M14 修复为基线）；不改控制流语义除非本计划明示；PRD 红线：P0-1 围栏不得破坏 cwd 内合法读写。
- 测试基线：`bun run test:full` 当前 482 pass / 0 fail，每任务完成后相关域测试全绿，最终不低于 482+新增。

---

### Task 1: P0-1 read/write 路径围栏 + permissions 纳 read
- Modify: `src/tools/read-tool.ts`（:47 fs.readFile 前加围栏）、`src/tools/write-tool.ts`（:38-45 同）、`src/utils/permissions.ts`（:68 敏感拦截 operation 集合纳入 "read"）
- Test: `tests/read-tool-fence.test.ts`（新建）：读 .env 被拒（错误含 sensitive/blocked）、cwd 内合法文件通过、写任意路径被拒
- 红线：vault/data 相对 cwd 口径合法读不被误伤
- 验证：新测试红→绿 + tests/security-fixes.test.ts tests/unit/filesystem.test.ts 全绿

### Task 2: P0-2 code-analysis 注入消除 + P0-3 换行归一
- Modify: `src/mcp/tools/code-analysis.ts`（:501/:412 spawn 数组化/白名单校验 filePath，移除 shell:true）、`src/utils/command-safety.ts`（sanitizeCommand 前置 `\r?\n`→"; " 归一，spec P0-3 选定方案）、`src/mcp/tools/terminal.ts`（执行前二次归一）
- Test: `tests/command-safety-newline.test.ts`（`git status\nrm -rf /` 白名单拒、`echo a\necho b` 归一语义保持）+ code-analysis 静态断言（无 shell:true、spawn 数组形态、filePath 元字符拒）
- 验证：红→绿 + tests/tools-v3.test.ts 等既有测试全绿

### Task 3: P0-4 skill-promoter 幂等 + P0-5 codegen 超时
- Modify: `src/agents/consciousness/skill-promoter.ts`（:72 改前缀匹配 `auto-${slug}`）、`src/agents/opencode-tools/codegen.ts`（:40-50 spawn 接 AbortSignal 或超时 kill + finally tryRelease）
- Test: `tests/skill-promoter-idempotent.test.ts`（两次 promote 同模式 → registry 与磁盘 JSON 各仅 1 条）、`tests/opencode-codegen-timeout.test.ts`（挂起 fake → 超时 rejects 且信号量恢复、连续两次不被饿死）
- 验证：红→绿 + tsc 0

### Task 4: P0-6 紧邻 Medium 三件
- Modify: `src/mcp/dre-backend.ts`（:35-43 接 checkApiKey，对齐 server.ts:438-441 fail-closed）、`src/mcp/kb-backend.ts`（:54-62 同）、`src/mcp/server/browser-tools.ts`（:28/:69/:130 cdpUrl 过 assertSafeCdpUrl）、`src/sandbox/docker-sandbox.ts`（:57-58 挂载目录校验禁 / 与宿主敏感目录 + stdout 截断 1MB）
- Test: 各一静态/行为小测试（backend 无 token 返回 401/503、cdpUrl 恶意值被拒、挂载 / 被拒）
- 验证：红→绿 + tsc 0

### Task 5: P1-1 prompt-pool 模板对齐 + P1-2 self-evolve 教训回读
- Modify: `src/agents/prompt-pool.ts`（:454-476 pattern 与模板逐字对齐，模板改单一常量由 pattern 派生）、`src/self-evolve/index.ts`（:36-76 list() 合并 vault 已持久化教训，启动扫描 LESSON_PREFIX 回填）
- Test: prompt 含 context 且无 `{{#if` 残留；写→新实例→list 可见。先红后绿
- 注意：prompt-pool 消费方 orchestrator.ts:755/803/851、component-bootstrap.ts:36、mcp/prompt-tools.ts:17 行为变化须回归

### Task 6: P1-3 评测沙箱 + P1-4 thompson 治理
- Modify: `src/agent-evals/external.ts`（:45-53 经 docker-sandbox 执行，docker 不可用 → skipped 不直跑）、`src/router/thompson-router.ts`（:237-242 obs 内存/DB 裁剪至最近 500 条常量；空 arms route 返回确定性降级不抛错）
- Test: 无 docker 时 skipped；1000 次反馈后 obs ≤500；空 arms route 不抛。先红后绿
- 验证：tests/thompson-stress.test.ts 等既有测试不破坏

### Task 7: P1-5 proxy-fetch + 基础设施批
- Modify: `src/utils/proxy-fetch.ts`（CONNECT Content-Length 用 byteLength、头值 CRLF 过滤、重定向跨域剥离 Authorization/Cookie、响应体上限默认 10MB 可配）、`src/utils/logger.ts`（:201 文本路径过 SECRET_VALUE_RE）、`src/utils/redis-client.ts`（断线复位 promise + RESP 失步防护）、`src/utils/cache.ts`（clear 带命名空间前缀）、`src/utils/security.ts`+`rate-limiter.ts`（cleanup 定时调度接线）、`src/utils/agent-trace.ts`（complete/fail 删 activeTraces）、`src/knowledge/document-ingest.ts`（redirect:"manual" + 逐跳 isSafeUrl）
- Test: 每项独立小测试（7 组）；先红后绿
- 验证：tests/crawl/ tests/redis-client.test.ts 全绿；**逐项独立提交便于单独 revert**（本任务允许多 commit）

### Task 8: P2-1 + P2-2 卫生批
- Modify: B1/B2 Low 批（routes/pipeline.ts SSE cancel、routes/memory-api.ts 死条件、services/cache-router.ts + cli/commands/kg.ts 陈旧注释与缺省路径、main.ts TRUST_PROXY_HEADERS 全链校验、mcp/server.ts transport close、routes/chat.ts 判成功精确化、hermes-agent key 解耦、memory-gate maxWritesPerDay 生效、pi-code-engine 分支修正、skill-quality.json 原子写+绝对路径）+ B3 Low 批（graceful-shutdown 计时复位、logger 轮转 renameSync→等 end、env readInt 严格+钳制、permissions .env 精确匹配、read-optimizer executor 断言、install-wizard 0600、security-monitor 告警去重）
- Test: 静态/行为小测试按仓库惯例；先红后绿或行为无变化时给出前后对比证据
- 验证：tsc 0 + 相关域测试全绿

### Task 9: 收尾（主会话执行）
- `bun run test:full` 全量（≥482）；联合审查报告 §4 逐项回写处置（第 9 节惯例）；operations-log 收口条目；总结

## Self-Review 记录
1. Spec 覆盖：spec §1 P0-1..P0-6 → Task 1-4；§2 P1-1..P1-5 → Task 5-7；§3 P2 → Task 8；§5 验收 → Task 9。无缺口。
2. 占位符：无 TBD；全部锚点来自审计报告证据行号。
3. 类型/接口一致性：围栏复用 filesystem isPathSafe 语义（不新增导出）；checkApiKey 对齐 server.ts 既有签名；assertSafeCdpUrl 为 routes/agents.ts:213 既有函数（Task 4 执行者需确认其导出位置并 import）。
4. 执行方式：9 任务串行（同工作区 git 串行约束），子代理逐任务执行。
