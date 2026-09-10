# 审计强化迭代设计 — 联合审查结果针对性收口 — 2026-08-29

> **来源**：docs/reviews/2026-08-29-joint-verification-audit.md（联合审查：修复声称 24/24 证实 + src 399 文件深读 100% 收口，新发现 High 5 / Medium 18 / Low·Info 21）。
> **方法**：头脑风暴（architectural 路径）。本 spec 停在实现门槛——批准后进入 writing-plans。
> **原则**：安全优先、最小切片、每片 TDD 红绿、AGENTS 规则全程适用。

## 0. 方案选择（两案对比）

- **方案 A（推荐）：P0 安全先行 + P1 健壮 + P2 卫生三波次**。5 项新 High 全部是安全/挂起类（攻击面或稳定性），先清零；Medium 按域分片跟进；Low/Info 批量卫生收尾。优点：风险最高的暴露面最先消除，每波次后系统都处于可发布态；缺点：Low 拖后。
- **方案 B：按域一次清**（MCP 域一天、agents 域一天…）。优点：上下文切换少；缺点：High 与 Low 混排，安全暴露面消除被延后。
- **选择 A**。理由：N-H1（.env 窃取）与 N-H2/H3（命令注入）是 PUBLIC 仓库的真实攻击链，每多存在一天风险就多一天；Low/Info 不腐蚀正确性，天然适合最后批量。

## 1. P0 — 安全线（5 项新 High + 3 项紧邻 Medium，6 切片）

| 切片 | 内容 | 修复锚点 | TDD 要点 |
|------|------|---------|---------|
| P0-1 | MCP read/write/query 工具路径围栏 | read-tool.ts:47 加 isPathSafe 同款围栏（复用 mcp/tools/filesystem.ts 既有守卫语义：cwd 限制 + 父目录 realpath）；permissions.ts:68 敏感路径拦截纳入 read；write-tool.ts:38-45 同围栏。红线：不破坏 read 对 vault/data 的合法读取（用相对 cwd 口径） | 新增 tests/read-tool-fence.test.ts：读 .env 被拒（错误含 sensitive/blocked）、读 cwd 内合法文件通过；先红后绿 |
| P0-2 | code-analysis 命令注入消除 | code-analysis.ts:501/412 改**参数数组 spawn**（spawn(file, args) 免 shell），无法数组化的（npx 管道类）退化为严格白名单校验 filePath（存在性+扩展名+无 shell 元字符）；shell:true 一律移除 | 静态断言：code-analysis.ts 无 `shell: true`、spawn 为数组形态；行为测试：filePath 含 `$(...)` 被拒 |
| P0-3 | command-safety 换行归一 | command-safety.ts:58 分隔类正则补 `\r\n`（或 sanitizeCommand 前置 `input.replace(/\r?\n/g, "; ")` 归一为分号语句——**选后者**：语义等价且黑名单模式同步受益）；terminal.ts 执行前二次归一 | tests/command-safety-newline.test.ts：`git status\nrm -rf /` 在白名单模式被拒；先红后绿 |
| P0-4 | skill-promoter 幂等修复 | skill-promoter.ts:72 匹配改前缀判断 `s.id.startsWith(\`auto-${slug}\`)`（或注册 id 改稳定无后缀 + 冲突时递增序号——**选前缀匹配**，改动最小且兼容存量带后缀数据） | tests/skill-promoter-idempotent.test.ts：两次 promote 同模式 → registry 仅 1 条 + 磁盘 JSON 仅 1 条；先红后绿 |
| P0-5 | codegen 超时真正生效 | codegen.ts:40-50 spawn 接 AbortSignal（Bun.spawn 支持 signal）或超时后 proc.kill()；finally 确保信号量 tryRelease；timeoutMs 语义落实 | tests/opencode-codegen-timeout.test.ts：fake 挂起子进程 → 超时后 execute rejects 且信号量恢复（连续两次调用不被饿死）；先红后绿 |
| P0-6 | 紧邻 Medium 三件 | ①dre-backend.ts/kb-backend.ts 接 checkApiKey（对齐 server.ts:438-441 fail-closed 模式，默认回环时仍要求 token 或显式 env 豁免）；②browser-tools.ts 三处 cdpUrl 过 assertSafeCdpUrl（对齐 routes/agents.ts:213）；③docker-sandbox.ts 挂载目录校验（禁 /、宿主敏感目录）+ stdout 截断 1MB 对齐 process-sandbox | 各一片静态/行为测试 |

## 2. P1 — 健壮与正确性（Medium 15 项，5 切片）

| 切片 | 内容 |
|------|------|
| P1-1 prompt-pool 模板失配（B2-M1） | 修正替换 pattern 与模板逐字对齐（含 "## Context" 行）；模板改为单一常量由 pattern 派生，杜绝再漂移；测试：注入 context/user_input 后 system prompt 含内容且无 `{{#if` 残留 |
| P1-2 self-evolve 教训回读（B2-M2） | list() 合并 vault 已持久化教训（启动时按 LESSON_PREFIX 扫描回填内存索引）；测试：写→新实例→list 可见 |
| P1-3 external 评测沙箱（B2-M3） | 生成的 Python 落盘后经 docker-sandbox（P0-6 已加固）执行；docker 不可用时降级为"拒绝执行并标记 skipped"（不静默直跑）；测试：无 docker 时 skipped 而非执行 |
| P1-4 thompson 观测治理（B2-M4） | obs 内存/DB 双侧裁剪（保留最近 500 条）；空 arms 时 route() 返回确定性降级（首 arm 或 null 策略）而非抛错；测试：1000 次反馈后 obs ≤500；空 arms route 不抛 |
| P1-5 proxy-fetch + 基础设施批（B3-M 组） | CONNECT Content-Length 对齐（Buffer 用 byteLength）、头值 CRLF 过滤、重定向跨域剥离 Authorization/Cookie、响应体上限（默认 10MB 可配）；logger 文本路径过 SECRET_VALUE_RE；redis 断线复位 promise + RESP 失步防护（断开重连）；cache.clear 带命名空间前缀；限流 Map cleanup 定时调度接线；agent-trace complete/fail 删除 activeTraces 条目；document-ingest redirect:"manual" + 逐跳 isSafeUrl。每项独立小测试 |

## 3. P2 — 卫生批（Low/Info 21 项，2 切片）

- P2-1：B1/B2 Low 批（SSE cancel 清理、memory-api 死条件、cache-router/kg.ts 陈旧注释与缺省路径、TRUST_PROXY_HEADERS 首项改全链校验、transport close、chat 判成功改精确、hermes key 依赖解耦、memory-gate maxWritesPerDay 生效、pi-code-engine 分支修正、skill-quality.json 原子写+绝对路径）。
- P2-2：B3 Low 批（graceful-shutdown 计时复位、logger 轮转 renameSync→异步等 end、env readInt 严格解析+钳制、permissions .env 精确匹配、read-optimizer executor 断言、install-wizard 0600、security-monitor 告警去重）。

## 4. 非目标

- 外围 9 棵树（frontend/runtime-go/src-tauri/native/plugins/harmonyos/openclaw-memory/skills/e2e）维持范围外。
- M10 云端降级上下文序列化、W5/W8 FTS 缩窄重立项、M13 dre→crawl（归入 SearchPort 重立项）——独立专项，不在本迭代。
- 不做"重写 permissions 层为能力系统"类重构（收益/成本不成立，守卫修补足够）。

## 5. 验收清单

- [ ] P0 全部 6 切片红→绿，安全 High 清零
- [ ] P1 5 切片红→绿；P2 2 切片完成
- [ ] `bun run test:full` 全绿且 ≥482；`bunx tsc --noEmit` 0
- [ ] 联合审查报告 §4 每项回写处置（同 §7/§8 惯例）
- [ ] operations-log 每提交一条（hash 回填）
- [ ] 密钥面复核：read .env 被拒、logger 文本输出无明文 key（grep 夹具测试）

## 6. 风险与回滚

- P0-1 围栏可能误伤合法路径（vault 绝对路径场景）——测试先行覆盖合法读取面；回滚=还原围栏 diff。
- P1-5 proxy-fetch 改动是全仓网络底座——逐项独立提交，任一项可单独 revert。
- P0-3 换行归一可能影响合法多行命令——terminal 工具本就以单命令为语义，多行归一为分号不破坏（测试覆盖 `git status\nrm` 拒绝 + `echo a\necho b` 归一后语义保持）。
