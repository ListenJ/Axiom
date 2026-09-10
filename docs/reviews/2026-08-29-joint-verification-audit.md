# 联合验证审计报告 v2 — 2026-08-29

> 性质：对 docs/reviews/2026-08-28-independent-full-audit.md（含第 7/8 节修复回写）的**修复声称验证** + **src 深读覆盖率收口**（上轮报告明示的阻塞项）。立场：怀疑优先，声称与实现分别核实。只诊断不修复。
> 基线：codex/self-evolving-agent @ ae952d2。

## 1. 审核覆盖率

- **A 段 修复声称验证**：报告 §7+§8 声称的修复，24 组抽查项（覆盖全部 28 项声明）逐一到 HEAD 核验：**24/24 证实，零虚假声称**（含延期项 H6/M3/L7/M13/M10 的如实标注）。test:full 实测 482 pass/0 fail 与声称一致。早期修复（W1-W10、W2/W6/W7/W9/W10）复核无回退。
- **B 段 src 深读收口**：3 组并行深读——B1 集成层 119/119（routes/mcp/services/tools/db/core/context/cli/kg/kal/根文件）、B2 学习层 115/115（agents/memory/router/self-evolve/eval/agent-evals/skills/runtime/pi-agent/workers）、B3 工具域层 112/112（utils/testing/knowledge/crawl/computer-use/sandbox/components/local-llm/tui/terminal/ocr）。
- **src 覆盖率：399/399 深读达成**（两轮合计；本轮新增深读约 250 文件，上轮深读文件做增量复核）。tests/docs 作为验证工具与声明源使用。
- **范围外（维持注明原因）**：frontend(170)/runtime-go(122)/src-tauri(23)/native(21)/plugins(63)/harmonyos(17)/openclaw-memory(41)/skills(19)/e2e(14)——独立外围组件，声明相关机械扫描已覆盖（向量库全树零命中）；node_modules/.git/构建产物排除；node_modules 内 @modelcontextprotocol/sdk 仅核对其注册行为。

## 2. 核心技术承诺核查（复测）

- **非向量化主路径**：【一致】维持——全树依赖与 import 零向量库（第二轮全树扫描复核），主检索链零 cosine/embedding；三处非主路径向量层定性不变（settings-search 设置页、context-manager 压缩辅助、consciousness 死代码）。
- **确定性**：【主链一致】——HEAD 上 5 个确定性测试文件（含新增 dre-retrieval-tie/kal-deterministic-order）**N=5 外环复测 5/5 全绿**；ThompsonRouter 随机属声明豁免（AXIOM-ARCHITECTURE.md:1308），B2 复核确认其不构成确定性违规。
- **zero-LLM 默认路径**：【一致】维持——KNOWLEDGE_USE_LLM 默认 false + fallbackTFIDF 确定性回退，B3 增量复核确认。

## 3. 声明 vs 实际对照总表（v2 增量）

上轮 13 行对照表全部维持，v2 新增/更新 3 行：

| # | 声明 | 出处 | 结论 | 证据 |
|---|------|------|------|------|
| 14 | "Idempotent by id"（skill-promoter 幂等） | consciousness/skill-promoter.ts:63 注释 | **不一致** | skipExisting 匹配无后缀 id（:72）但注册 id 带时间后缀（:103），恒不命中 |
| 15 | callOpenCode timeoutMs 有效 | opencode-tools/codegen.ts | **不一致** | AbortController 无人消费、spawn 无 signal 无 kill（:40-50），超时无效 |
| 16 | db_query "只读" | mcp/server/db-tools.ts:5-8 | 部分一致 | 仅前缀 startsWith("select") + 可写连接，依赖 bun:sqlite 首语句行为 |

## 4. 新发现问题清单（深读收口产生）

### High（5 项，全部附代码证据）
| # | 位置 | 问题 | 影响 |
|---|------|------|------|
| N-H1 | src/tools/read-tool.ts:47 + src/utils/permissions.ts:68 + src/mcp/server.ts:87 | MCP `read` 工具 `fs.readFile(path)` **零路径围栏**，permissions 敏感路径拦截仅覆盖 write/delete，read 可读 .env → 全部 API key/鉴权 token | 密钥泄露（tool-registry:71-73 "工具内部兜底"声明与实现不符） |
| N-H2 | src/mcp/tools/code-analysis.ts:501,412 | `npx eslint ... "${filePath}"` 未转义 / 仅转义双引号（`$()`、反引号仍被解释），shell:true 执行 | 命令注入 |
| N-H3 | src/utils/command-safety.ts:58 + mcp/tools/terminal.ts:92-94 | 白名单模式分隔符正则无 `\r\n`，`git status\nrm -rf /` 中 rm 不被提取为命令 token → safe 放行，`sh -c` 原样执行 | 白名单绕过（黑名单模式不受影响） |
| N-H4 | src/agents/consciousness/skill-promoter.ts:72,103,112-115 | 幂等检查 id 与注册 id 恒不相等 → 每反射周期重复注册 + writeFileSync 持久化 | SkillRegistry 与 axiom-memory 技能库无界重复增长 |
| N-H5 | src/agents/opencode-tools/codegen.ts:40-50,82 | 超时 abort 无消费方、spawn 无 signal/kill，stdout reader 永不返回 | 永久挂起 + 并发信号量泄漏（tryRelease 永不执行） |

### Medium（18 项，摘要）
- **B1**：routes/terminal:34-36、health:16-18、git:26-28 二次因子注释称 fail-open 实为 fail-closed（git commit/push 门形同虚设）；dre-backend:35-43/kb-backend:54-62 HTTP 后端零鉴权（MCP_HOST=0.0.0.0 时全裸）；db_query 只读弱实现；write-tool:38-45 任意写 + permissions 敏感表 Unix 中心化。
- **B2**：prompt-pool.ts:454-476 模板失配（"## Context" 行致替换永不命中，orchestrator:755/803/851 等动态上下文静默丢失+残留占位符垃圾）；self-evolve/index.ts:36-76 教训只写不回读（重启闭环记忆清零，与注释声明不符）；agent-evals/external.ts:45-53 LLM 生成代码无沙箱直接执行；thompson-router.ts:237-242 观测无界增长且 main.ts 空 arms 时 route 抛错。
- **B3**：logger.ts:201 文本路径未过 SECRET_VALUE_RE（JSON 路径已脱敏）；proxy-fetch CONNECT Content-Length 错位(:477-491)/CRLF 头注入(:481-485)/重定向重发凭证(:624-708)/响应体无上限(:556-576)；redis-client.ts:363-369 断线后 promise 不复位永久失效 + :313-321 RESP 失步；cache.ts:307 clear() 清全部命名空间；security.ts:125/rate-limiter.ts:33 限流 Map 无清理调度；docker-sandbox.ts:57-58 挂载无校验+默认不限网络+stdout 未截断；browser-tools.ts:28,69,130 cdpUrl 未过 assertSafeCdpUrl；document-ingest.ts:157 重定向 SSRF 残窗；agent-trace.ts:23,45-59 activeTraces 无界。

### Low/Info（合并 21 项）
B1：pipeline SSE 无 cancel 清理、memory-api 死条件、cache-router 陈旧 PG 注释、kg.ts 缺省库路径不一致、TRUST_PROXY_HEADERS 首项直信、transport 不 close、chat includes("error") 判成功；B2：hermes 硬依赖 SILICONFLOW key、memory-gate maxWritesPerDay 未生效、pi-code-engine model 分支可疑、skill-quality.json 相对路径非原子；B3：graceful-shutdown 计时不复位/unhandledRejection 全停、logger 轮转 Windows renameSync、env readInt 宽松、permissions .env 子串误伤、read-optimizer executor 静默绕过/批量均分、install-wizard .env 0644、ssh StrictHostKeyChecking=no、security-monitor 重复告警；Info：consensus activeVotes、curator 打标数、prompt-pool hitRate 虚高/伪 xxh3、tool-pool NaN、skill-registry 阈值失效、fillTemplate $& 未转义等。

## 5. 未验证/范围外项
同 v1 第 5 节口径：外围 9 棵树（理由如上）；node_modules 内部；真实硬件 VRAM 实测；bun.lock 逐包核对。

## 6. 总体结论
1. **修复声称 24/24 证实**——两轮修复迭代可信，无虚假回写。
2. **核心技术承诺全部维持**（非向量化一致/确定性主链 5×5 全绿/zero-LLM 一致）。
3. **src 399 文件深读 100% 达成**，覆盖收口产生了 5 项新 High——集中在**安全面**（MCP read 任意读、命令注入×2、幂等破坏、超时失效），共同模式：工具层"内部兜底"与 permissions 层的防护假设落空。
4. 按判定标准（覆盖率 100%+未覆盖项注明原因+模块 7 明确结论+High 附证据+对照表无空缺）：**本次联合审核已完成**。

---

## 7. 强化迭代修复回写（2026-08-29，spec 2026-08-29-audit-hardening-design.md 方案 A，9 任务完成）

### P0 安全线（6 切片，全部红→绿）
| 项 | 状态 | Commit | 说明 |
|----|------|--------|------|
| N-H1 MCP read 任意读 | ✅ | 804ec12 | isPathSafe 导出为唯一语义源，read/write 双围栏 + permissions 纳 read；tests/read-tool-fence 10 pass |
| 循环回归（N-H1 引入） | ✅ | aac3247 | isPathSafe/resolvePath 迁 utils/path-safety.ts 消除 tools<->mcp 循环；architecture-integrity 复绿 |
| N-H2 命令注入 | ✅ | 8580e95 | 4 处 spawn 数组化 + validateFilePathForCommand 元字符白名单，shell:true 清零 |
| N-H3 换行绕过 | ✅ | 8580e95 | sanitizeCommand 入口 \r?\n→"; " 归一 + terminal 二次归一 |
| N-H4 幂等破坏 | ✅ | 7e465c9 | `id === auto-slug \|\| startsWith("auto-slug-")`（尾连字符防 foo/foobar 歧义） |
| N-H5 codegen 挂起 | ✅ | 7e465c9 | spawn 接 AbortSignal（Bun 实测 328ms 内杀进程）+ releaseSemOnce 防双重释放 |
| M-dre/kb 零鉴权 | ✅ | f385143 | 两 backend 接 checkApiKey（与 server.ts 逐字对齐，回环豁免保留） |
| M-cdpUrl 未校验 | ✅ | f385143 | 三处入参过 safeCdpUrl（169.254/192.168/file: 均拒） |
| M-docker-sandbox | ✅ | f385143 | 挂载白名单 + networkAccess 默认禁网（opt-in）+ stdout 1MB 截断 |

### P1 健壮（5 切片）
| 项 | 状态 | Commit | 说明 |
|----|------|--------|------|
| M1 模板失配 | ✅ | 2289e4b | context+user_input 两处对齐，三块常量单一事实源；渲染无残留 |
| M2 教训不回读 | ✅ | dbdbad7 | restoreLessonsFromVault（listNotePaths+readNote 原生能力），list() 惰性回读 |
| M3 评测无沙箱 | ✅ | 68321a3 | 统一经 SandboxProvider（默认 docker，禁网），不可用 fail-closed skipped 绝不直跑；环境注记：镜像需 python3 |
| M4 thompson 无界 | ✅ | 68321a3 | 500 条/arm 内存+DB 增量裁剪；空 arms 降级不抛；顺带修复观测 INSERT 缺 created_at 潜伏静默失败 |
| M-proxy-fetch×4 | ✅ | 17ef904/8b0fef8 | Content-Length byteLength、CRLF 过滤、跨域剥凭证、10MB 上限（env 可覆盖） |
| M-logger 泄密 | ✅ | fcd2ffd | 文本路径过 SECRET_VALUE_RE |
| M-redis 死实例 | ✅ | 9c4c171 | 断线复位 + RESP 半包续读 |
| M-cache.clear | ✅ | 1e2ab88 | SCAN+按前缀 DEL 替代 flushdb |
| M-限流无清理 | ✅ | 705974d | 60s 调度（unref）接线两模块 |
| M-trace 无界 | ✅ | 10304b4 | complete/fail 即出表 |
| M-ingest 重定向 | ✅ | ecfd214 | redirect:"manual" 逐跳 isSafeUrl（5 跳上限） |

### P2 卫生（20/20 Low 项）
| 批 | Commit | 内容 |
|----|--------|------|
| B1/B2（11 项） | c385e2f / 854a43a | SSE cancel、死条件修正、陈旧注释、缺省库路径统一、XFF 取末项、transport close、chat 精确判成功、hermes 去 key 硬门、daily 限流生效、pi-code 分支删除、skill-quality 原子写+绝对路径 |
| B3（9 项） | 5f59a3a | shutdown 计时复位+rejection 阈值化、轮转等 close、readInt 严格+钳制、.env 精确段匹配、read-optimizer fail-fast+均分合并移除、.env 0600、告警去重、ssh 标注 |
| Info | — | 维持观察不施工（operations-log 声明） |

**回归验证（2026-08-29）**：`bun run test:full` **566 pass / 0 fail / 70 文件**（基线 482 + 强化新增 84，含白名单补录 prompt-pool-template 与 self-evolve-lessons-restore）；`bunx tsc --noEmit` 0。architecture-integrity 含循环断言全绿。
**遗留注记**：①checkApiKey PUBLIC_PATHS 含 "/" 的既有豁免面（server.ts 同源，非本轮引入）建议单列评估；②外部评测镜像需含 python3（环境配置项）；③组合批跑 isPermanentFailure 模块图错误为预存（import 图零变更佐证），test:full 白名单外，已记录。
