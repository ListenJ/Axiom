# 轮 7 全量审计：OCR 车道并行审查 + 规则 13 双清单重建（2026-10-12）

> 承接轮 1–6（`2026-09-25-audit-round*.md`）。本轮方法变更：变更面由 OCR（open-code-review v1.9.9 delegate 模式）做确定性选择与规则分组，10 个并行审查子代理按车道执行，主会话负责汇总、High 级独立复核（含证伪实验）、门禁实测与覆盖率账本。审查范围 `d8d5ab65..HEAD`（主干归一 tip → 当前 `8a8d9747`，243 条提交，2026-09-28 → 10-10 修复轮）。**本轮只读：未修改任何源码/测试/配置，未提交、未推送。**

---

## 一、覆盖率账本（规则 13.7-1）

### 1.1 变更面清单（Phase 0 代码文件清单）

| 面 | 数量 | 处置 |
|---|---|---|
| diff 总路径（`git diff --name-only d8d5ab65..HEAD`） | **361** | 115 added + 96 deleted + 150 modified（rename 检测开启后不变） |
| OCR reviewable（进入子代理审查） | 132 | 41A + 91M，按 10 车道全部分派 |
| OCR excluded：deleted | 44 | 删除面不产生新代码风险，登记即可 |
| OCR excluded：default_path（69 tests + 33 docs） | 102 | tests 面由 **Lane T** 补审（10 个最大新测试文件深审）；docs 面由 Lane E（敏感词扫描）+ 主张核查覆盖 |
| OCR excluded：unsupported_ext（50）+ binary（2） | 52 | `.env.example`/`uv.lock`/`bun.lock`/`.exe` 等非代码面 |
| **工具缺口（OCR preview 未枚举）** | **31** | **22 `native/`（Rust 原生引擎退役删除面，4864 行删除）+ 8 `deploy/systemd/`（systemd 单元新增面）+ 1 `docs/reports/`**。→ **已收口（本报告 §1.4）**：删除面零残留引用；deploy 面逐件审毕并入 §四 |

### 1.2 车道执行账本

| 车道 | 面 | 文件数 | findings | 状态 |
|---|---|---|---|---|
| lane1 | runtime-go（Go 搜索运行时） | 13 | 7（1H/3M/3L） | ✅ 13/13 |
| lane2 | runtime-embed + wind-mcp（Python） | 7 | 5（2M/3L） | ✅ 7/7 |
| lane3a | TS A1（decision/laya + daemon） | 11 | 10（2H/4M/4L） | ✅ 11/11 |
| lane3b | TS A2（dre/eval/kal/tool-face） | 11 | 13（1H/4M/8L） | ✅ 11/11 |
| lane4a | TS B1（core/memory/mcp） | 15 | 5（2M/3L） | ✅ 15/15 |
| lane4b | TS B2（router/runtime/routes/crawl） | 16 | 11（3M 确认/1M 反驳/7L） | ✅ 16/16（补齐回报） |
| lane5a | TS C1（scripts/knowledge/cli） | 18 | 4（2M/2L） | ✅ 18/18 |
| lane5b | TS C2（utils/semantic/main） | 19 | 4（1H/1M/2L） | ✅ 19/19 |
| lane6 | config/CI/sh/json | 22 | 11（2M/9L） | ✅ 22/22 |
| laneT | tests（模块 11 专项） | 10/70 | 12（1H/7M/4L） | ✅ 10/10 + 全量 70 概览 |
| 合计 | | **132 全深审** | **82 raw / 75 复核后** | 覆盖率 132/132 = **100%** |

### 1.3 主张清单覆盖率（规则 13.7-1 第二清单）

本轮主张核查 18 条（§三），覆盖 README 头部结构主张、门禁计数、进度声称三类；**未覆盖**：AXIOM-ARCHITECTURE.md 全文逐句提取（上轮轮 1–6 已覆盖大部分，本轮增量面为 §三所列）。主张核查覆盖率：**18/18 已裁定**（本轮范围定义内 100%）。

**按规则 13.8：车道清单已达 132/132 = 100%（含 §1.4 缺口收口）；工具面三项缺口（native 删除面 / deploy systemd / SSE 实证 / CUDA 实测）已在 §1.4 全部收口——**本轮达成"报告范围定义内"的全量覆盖**；遗留未覆盖面仅剩 §五中明确登记的非代码面（AXIOM-ARCHITECTURE.md 逐句提取，属轮 1–6 已大半覆盖的延续项）。**

### 1.4 缺口收口记录（报告初版后补齐，2026-10-12 第二轮）

| 缺口 | 收口方式 | 结论 |
|---|---|---|
| native/ 22 文件删除面 | `git diff --name-status` 确认 22/22 全为 D；全仓残留引用扫描（src/scripts/config/package/.github） | **零活跃引用**：仅 3 处历史注释（env.ts:185、outbound-fetch-baseline $comment、testing/index.ts 归档说明）+ `doc-contract.test.ts:750` 断言删除成立的正向守卫 + `scripts/build/matrix.ts:214` 构建移除注释。**删除面干净，登记关闭** |
| deploy/systemd 6 单元 + 1 安装脚本 | 逐件通读（axiom / axiom-dre / axiom-embed / wind-collect@.service + timer + install-wind-collect.sh） | 安全基线良好（NoNewPrivileges / ProtectSystem=full / ProtectHome=read-only / ReadWritePaths 白名单带 `-` 容错）；新增发现见 §1.5；wind-collect unit 的 `WIND_DAILY_CREDITS=270` 与 lane2 文档发现互证（unit 口径正确，脚本 docstring 错） |
| SSE cancel 不可达指控（lane4b） | /tmp 独立 Bun 实验（`sse_cancel_test.ts`）复刻 pipeline.ts 结构：pull+cancel+默认 HWM，客户端 3 事件后 abort | **反驳**：proxy `cancel()` 触发 1 次 → 上游 reader.cancel 完成 → 上游连接归零（remaining=0）。与 WHATWG Streams 规范一致；`421c8132` 修复机制成立。lane4b 该条指控不成立 |
| CUDA 确定性（规则 13.5 遗留项） | GPU 实测可用（RTX 3050 Ti 4096MiB / driver 615.78 / device=cuda:0）；独立端口起 uvicorn，同一批 5 条中文/混合文本 N=5 独立 HTTP 请求，SHA-256 逐字节比对 | **5/5 全一致**（`473ae16efa55f039…`，dim=1024，usage 恒 91 tokens）。CUDA 面确定性证据闭合；实验后服务已停、仓库零残留 |

### 1.5 缺口收口新增发现（并入 §四 账本）

- **M（deploy）**：全部 systemd 单元硬编码机器绝对路径 `/run/media/listen/base/openclaw-fusion` + `/home/listen/.bun`；`install-wind-collect.sh` 硬编码 REPO 且默认实例 `listen`——与 lane6 对 `mcp-servers.yaml` 的发现同类（机器绑定配置入库为规范面），换机即失效。
- **L（deploy）**：`axiom@.service` 跑 `bun dist/main.js` 而 `axiom-dre@.service` 跑源码 `bun run src/daemon/dre-daemon.ts`——同一部署面两种运行口径，dist 未构建时主服务挂、daemon 却能起，半可用状态难排查。
- **升级（router）**：复核 lane4b 时确认 `code-retrieval-router.ts` **全仓零导入者**（src/scripts/tests 均无消费）——不止 pi-agent 策略死代码，整个路由器未接线；pi-agent 分支唯一可达路径是 LLM 透传 `parsed.suggestedStrategy`（启发式永不产出该值）。与 retriever 未注入合并为一条 Medium。

---

## 二、确定性/可复现性专项（规则 13.7-2，置顶）

| 实测 | 方法 | 结果 |
|---|---|---|
| Go 搜索引擎确定性 | `TestSearchDeterministicAcrossRepeats` × **5 个独立进程**（`-count=1` 逐次冷启动）× 进程内 10 次迭代，JSON 序列化逐字节比对 | **5/5 全绿**（0.075–0.081s/进程），tie-breaker "score desc, ID asc" 不依赖 shard 完成顺序 ✅ |
| Go 静态健康 | `go vet ./...`（go 1.27.1） | rc=0 干净 ✅ |
| TS KAL 查询确定性 | 仓库自带跨进程 harness `src/eval/kal-determinism.ts`（对 `data/agent.db` 只读、同一 QueryIntent、剔除 duration 按 nodeId+store 排序） | **runs=5, identical=true**（resultsInRun1=4, stores=[vault,kg,dre]）✅ |
| Go 并发基线 | `docs/reviews/2026-10-04-single-machine-concurrency-baseline.md`（bench count=3 + race + loadgen seed + searchd stats，环境/硬件/HEAD 全记录） | 与 10-03 计划 Step 1–7 执行结果链一致，属规则 13.5 合格的复现环境记录 ✅ |
| 隐性不确定性来源 | 排查结论：Go 侧 map 遍历序由 tie-breaker 显式消除；TS 侧 KAL 纯 SQLite；Rust `native/` 引擎已删除（§1.4 确认零残留） | ✅ 无遗留 |
| **CUDA embed 输出确定性（初版遗留 → 已收口）** | RTX 3050 Ti 实测（§1.4）：同一批 5 条文本 N=5 独立 HTTP 请求，SHA-256 逐字节比对 | **5/5 全一致** ✅——规则 13.5 三语言面（Go/TS/CUDA）全部闭合 |

**专项结论**：本轮新增的 Go 搜索运行时与 TS KAL 面**确定性证据充分**（双语言、双方法、跨进程）；唯一未覆盖的是 `runtime-embed` CUDA 推理输出的跨进程一致性——属模型推理面，当前仅在单机 systemd 部署使用，降级为"已知未验证"。

---

## 三、主张核查总表（规则 13.7-3）

| # | 主张（来源） | 裁定 | 证据 |
|---|---|---|---|
| C1 | 189 MCP 工具零重复（README/ARCHITECTURE） | **一致** | `bun run scripts/count-tools.mjs` 实测 189、duplicateTools=0；`src/testing/tool-count.ts` 单一事实源 |
| C2 | src/ 40 模块/454 文件/121,360 行；tests 498 | **一致** | `bun run scripts/count-arch-stats.mjs` 实测 454/121360/498/189，与 docs/ARCHITECTURE.md 逐字节相等 |
| C3 | doc-contract 35/0（ops log） | **一致** | 本轮实测 35 pass / 0 fail（916ms） |
| C4 | audit:runtime 16/16（ops log） | **一致** | 直接运行 `bun run scripts/runtime-audit.ts`：overall=pass，16/16/0 |
| C5 | tsc rc=0（ops log A2） | **一致** | 本地 tsc 5.3 `--noEmit` rc=0 |
| C6 | 全量 bun test 4721 pass / 0 fail（ops log a5d47659） | **一致（本轮复跑）** | `bun test --timeout 15000 ./tests` 实测 **4721 pass / 67 skip / 0 fail**，498 文件，91.87s，exit=0——与 ops log 逐字一致 |
| C7 | main 与远端三方一致 | **一致** | 本地 main = internal/main = internal 分支 = `8a8d9747`（ls-remote 实测） |
| C8 | 六道冒烟 SMOKE PASS（b83b8378） | **一致** | ops log 记录完整；本轮 lane6 发现门 6 判定逻辑仍有缺陷（400/401/500 计 PASS），见 P-F1 |
| C9 | "21 场景"（README L24） | **不一致** | `src/mcp/scene-router.ts DEFAULT_SCENES` 实测 **23** 个 id——文档落后于代码 2 个 |
| C10 | "8 Persona modes"（README） | **一致** | `src/dre/persona/types.ts PersonaMode` 恰好 8 值（plan/code/retrieve/reflect/audit/creative/research/general） |
| C11 | "6 个搜索引擎"（README 表） | **部分一致** | `search-engines.ts` 5 引擎（searxng/brave/tavily/serpapi/bing-html + duckduckgo 兜底）+ `search-engines-extra.ts` 含 jina/minimax——主文件与 README 表的"6 引擎环境变量表"口径需对齐，实际可用引擎数 ≥6 |
| C12 | Go 查询"10 次逐字节一致"（Step 4 记录） | **一致** | 本轮跨进程复跑 5×10 全绿 |
| C13 | Complex 488→56 allocs/op（Step 5） | **一致（数字来自记录，本轮未复跑 bench）** | 测试文件存在 `TestSearchComplexAllocBudget`（budget 80）作 CI 棘轮 |
| C14 | 189 工具数 = doc-contract 断言面 | **一致** | C1+C2 同源脚本互证 |
| C15 | "确定性认知运行时"整体定位（README 标题） | **一致（证据支撑）** | §二专项双语言实测 + zero-LLM 摄取管线（轮 6 已审） |
| C16 | LFS 105 对象远端齐（09-28 报告） | **未验证（本轮范围外）** | 未做 git lfs 远端复查 |
| C17 | outbound-fetch-baseline totals 24/29/4 | **一致** | lane6 独立核算通过（但 `$note` 仍写 23，文档漂移，L-F2） |
| C18 | Linux 部署 systemd 单元可用（deploy/ 新增 8 文件） | **无法验证** | 需真实 systemd 环境；本轮只读未部署，登记未验证项 |

裁定汇总：一致 14、部分一致 1（C11）、不一致 1（C9）、无法验证/未验证 2（C16、C18）。

---

## 四、分模块问题清单（规则 13.7-4，82 条 findings 经主会话复核后的裁决版）

### 4.1 High（子代理报 6 条，复核后维持 3 条 + 降级 3 条）

| ID | 级别 | 位置 | 问题 | 复核结论 |
|---|---|---|---|---|
| **H1** | High | `src/decision/laya-http.ts:231-242` | `acquireSlot` 把 maxConcurrency 误用作"批量 POST 数"闸：计数覆盖整个 postJson（含退避重试最长 3×batchTimeout），契约并发硬顶 8 是条目级——两 worker 分块时在飞条目可达 2×500，跨调用叠加可达 8×limit。且测试（`tests/decision/laya-http.test.ts:165`）只断言请求体自报的 concurrency 字段，限流失效时恒绿 | **确认**（源码复核：`inflight` 计数围绕 postJson 全程；测试复核：自报字段断言） |
| **H2** | High | `src/decision/laya-calibrate.ts:148-163` | hitRate 分母 `effective = list.length - noDistribution`，但分子只数"有分布且 choice===expected"：choice 缺失而 probabilities 存在的用例两头都不进（L137 只查 probabilities），命中率被拉低、门槛建议被扭曲；与 L204 judgeDrift 的 missing 判据不对齐 | **确认**（源码复核：分子分母口径确实不对称） |
| **H3** | High | `tests/unit/runtime-host-lifecycle.test.ts:118-120`（AC-5 后半） | 用 `readFileSync('src/runtime/host.ts')` 对实现源码文本断言（not.toContain/正则）——断言私有实现而非行为，重构即误报、行为回归仍假绿，且依赖 cwd=仓库根 | **确认**（源码复核：AC-4/AC-5 与 config-center-hardening 同型，共 3 处 source-grep 断言） |
| ~~lane3b-H1~~ | ~~High→Low~~ | `src/dre/runtime/capability-isolation.ts:48-49` | "stdin write 未 await 导致 EPIPE unhandled rejection 崩溃" | **实验证伪**：Bun 1.4.2 `proc.stdin` 为 FileSink，write 返回 boolean 非 Promise；对已退出 worker 写入 + kill 中途写入两变体均无崩溃。子代理套用了 Node 流语义。降级 Low（跨运行时可移植性提示） |
| ~~lane1-H1~~ | ~~High→Medium~~ | `runtime-go/internal/search/engine.go:373-376` | "取消检查在 wg.Wait() 后丢弃已完成合并结果，HTTP 层映射 500" | **源码确认但降级**：丢弃路径真实存在（已完成的 tops 被丢弃返回 ctx.Err()）；但触发窗口是"取消与完成竞争的毫秒级边缘"，且故障模式是"该报超时时多等一拍"而非数据错误——HTTP 语义瑕疵（500 vs 504），非正确性缺陷 |
| ~~lane5b-H1~~ | ~~High→Medium~~ | `src/utils/redis-client.ts:119-127` | "AUTH/SELECT 与应用命令共用 FIFO 队列，open 竞争窗口内凭据/SELECT 错位" | **机制确认但降级**：竞争窗口仅在"应用层在 connect() resolve 前"就发起 get/set 时存在——但 `connect()` 是客户端唯一入口且 AUTH/SELECT 在 connect() 内 await 完成后才返回，正常调用方拿到的连接已握手指令完成。仅当未来有人在 open 回调前置位 `connected=true` 前泄漏连接引用才触发；当前无此调用路径。保守 Medium（握手状态机化仍是正确加固方向） |

### 4.2 Medium（28 条，按模块归组）

**router/runtime 面（3，lane4b 补齐）**
- `code-retrieval-router.ts:131-136` DI 改造后 retriever 全仓无注入点，"pi-agent" 策略成死代码（selectStrategy 永不返回该分支）——有形状无行为
- `model-router.ts:743-745` nativeEmitted 声明在 attempt 局部：原生流已产出部分 delta 后失败重试同模型 → 同一 SSE 流上重复内容（与注释目标矛盾）；应提升到 per-model 层
- `dynamic-model-assigner.ts:308-320` eval provider 仅在 /eval/assign 与 CLI 入口注入；定时刷新（每 6h runAssignment）等其余调用方静默得到空报告，行为随请求顺序漂移

**decision/laya 面（4）**
- `laya-calibrate.ts:245-249` 校验只报第一条非法命题即退出（批量校验风格不一致）
- `laya-http.ts` precheck/parse/同序校验全占闸位（与 H1 同根）
- `dre-daemon.ts:201-202` /dre/tool handler 无 try/catch，MCP 侧拿不到结构化错误（周边端点均包了）
- `daemon/client.ts:106-112` openEvents() 建连无超时（health 有 30s 超时，事件流建连阶段无保护可无限挂起）

**dre/registry 面（4）**
- `dre/kernel.ts:206-217` stopTickLoop 与 sleep() 的窗口竞争（唤醒丢失需等满 interval）
- `dre/kernel.ts:242-244` shutdown 快照 _inFlightTicks 后到达的手动 tick 不被等待
- `capability-registry.ts:235` registerDynamicProvider 浅拷贝 provider 后注册，副本语义未声明
- `dre-tools.ts:198-219` 大批 MCP handler 无统一错误包装（与 dre_write_knowledge 的处理不一致）

**core/memory/mcp 面（3）**
- `config-center.ts:190-192,638-646` getNumber 对 null/空串归 0，getConfig() 多数字段无 `|| default` 兜底（同族仅 maxConcurrent 有）——YAML 显式空值时 obsidianApiPort=0 / requestDelay=0（无节流）/ max_body_size=0（全 413）风险面
- `sqlite-memory.ts:651-660` archiveNotePath：wiki_links 改名与 memory_notes UPDATE 未包同一事务，部分失败产生悬空链接
- `config-center.ts:207-211`（复核上调）maskValue 对 9-11 字符敏感值保留首尾 4+4，最多泄露 73%——审计日志面向低权限读者，短 token 掩码强度不足

**scripts/data 面（3）**
- `scripts/collect-knowledge.ts:264-265` readExistingTier 自建 vault 路径口径与 VaultManager 双源（"防降级覆盖"契约依赖此路径，分叉即 KEEP 失效）
- `scripts/ingest-wind-raw.ts:71-74` dates/values 独立数组无等长钳制，错位期数静默渲染 "-"
- `scripts/collect-knowledge.ts:372-374`（降级保留）[finance] 硬编码日志前缀

**python/runtime-embed 面（2）**
- `runtime-embed/server.py:150-155` EMBED_ALLOW_CPU 在默认 EMBED_REQUIRE_CUDA=1 下是 no-op，错误提示误导用户
- `runtime-embed/server.py:137` count_tokens 同步阻塞事件循环（encode 已正确 threadpool，此处遗漏）

**config/CI 面（2）**
- `mcp-servers/wind-mcp/run_daily.sh:33-38` 无 `set -e` 且无条件 exit 0——采集失败对监控不可见（cron 数据链静默丢数）
- `config/mcp-servers.yaml:58-76` akshare/wind command 硬编码本机绝对路径 `/run/media/listen/...`——换机即静默失效

**test-env 面（4，laneT）**
- `dre-tools-behavior.test.ts:22-39` beforeAll 改 3 个 env + 删 DEEPSEEK_API_KEY，afterAll 只删 1 个（跨文件泄漏 + 不可逆删除）
- `dre-daemon.test.ts:27-33,192-203` 两处 afterAll 漏恢复 DATABASE_PATH/DRE_AUTO_TICK
- `laya-drift.test.ts:17-21` / `laya-calibrate.test.ts:11-15` afterEach 只 delete 不恢复 LAYA_DECISION_URL（同目录 laya-http.test.ts 的 ENV_KEYS 快照是正确范本）
- 上述与历史 resource-sync flaky 簇同型——单一共享 helper 可整体消除

**engine.go（2，降级保留）**
- 取消丢弃已完成结果 + httpapi 500/504 语义（§4.1 lane1-H1）
- `engine.go:227` `idx, _ := BuildIndex(...)` 忽略新增的 error 返回（变量遮蔽式忽略，注释断言"cannot fail"非保证）

### 4.3 Low（37 条，摘要分组）

- **hardcode 类（7）**：api-key-store L79 端口写死、capability-isolation L43 "bun" 二进制写死、install-systemd L20 用户实例写死、mcp-servers.yaml 机器路径（与 Medium 重）、dre-tools buildHttpHandlers ×4 重复构建、kernel.ts 5000 双写、main.ts/cli.ts/mcp-server.ts import 间顶层副作用 ×3（同根同修）
- **文档漂移类（5）**：outbound-fetch-baseline $note 23≠24、engine.ts:616 getDb JSDoc 张冠李戴、daily_collect WIND_DAILY_CAP 文档vs WIND_DAILY_CREDITS 实际、querybin.go 死代码+欺骗性注释（"experiments"路径不存在）、README 场景数（入 C9）
- **测试断言类（9）**：dre-tools 形状断言恒真/条件跳过、laya-http 退避时序未验证+429 分支无用例、redis-auth 无 try/finally、config-center '.tmp' 近恒真、persona_switch 条件断言等
- **CI/安全加固类（6）**：3 workflows 的 actions:write 未使用、GITHUB_ENV echo 模式 ×4、smoke-linux kill-by-port 误伤面
- **性能/内存（4）**：kernelProposals 无界增长、eval.go NOT 热路径堆分配、modelclient probeAll 慢轮次静默跳过、searchd Shutdown 后未 Close idle conns
- **其他（6）**：frontend package-lock.json 未随 tauri 移除再生、laya-triage baseUrl="" 静默回退、postJson stack 深度、admitCapability 只验首个契约、semantic-index 代理对截断、pcdad submit 失败路径 ReleaseCycle

---

## 五、未验证/无法访问项清单（规则 13.7-5）

| 项 | 原因 | 建议补验方式 |
|---|---|---|
| ~~lane4b 全组~~ | ~~子代理超时未回报~~ | ✅ 已补齐回报并复核（16/16，11 findings 入册） |
| ~~native/ 退役删除面~~ | ~~OCR preview 未枚举~~ | ✅ §1.4 收口：22/22 全 D、零活跃引用 |
| ~~deploy/systemd 8 文件~~ | ~~同上~~ | ✅ §1.4/§1.5 收口：逐件审毕，新增 1M+1L |
| ~~runtime-embed CUDA 输出确定性~~ | ~~需 GPU 多进程实测~~ | ✅ §1.4 收口：RTX 3050 Ti N=5 SHA-256 全一致 |
| ~~C6 全量 bun test 复跑~~ | — | ✅ 已完成：4721 pass / 67 skip / 0 fail（§三 C6） |
| lane4b 反驳项登记 | 其 `pipeline.ts cancel() 不可达` 指控经 /tmp 实验反驳（§1.4）；其余 findings 全部入册 | — |
| C16 LFS 105 对象 | 范围外（git 数据面，非代码面） | `git lfs ls-files` + 远端对账 |
| C18 systemd 单元真机可用性 | 只读约束（本机已有部署实例运行，避免干扰） | 受控环境 `systemd-analyze verify` + 冒烟 |
| AXIOM-ARCHITECTURE.md 逐句主张提取 | 轮 1–6 已覆盖大部分，本轮增量面为 §三 18 条 | 下一轮按 13.2 续提 |

---

## 六、总体结论（规则 13.7-6，逐条引用前述条目）

**项目推进度判定（用户核心问题）**：主线推进**健康且活跃**——§三 C1–C5/C7 五项门禁/一致性主张全部实测复现（189 工具、454 文件/121,360 行、doc-contract 35/0、audit:runtime 16/16、tsc rc=0、main 三方同步）；§一账本显示归一后 243 条提交完成了 7 个计划文档的落地；§二确定性专项双语言全绿；§四问题清单**无 Critical**。修复轮的工程质量整体成立。与之对照：会话工作区根的 `RESTORE-STATUS-2026-09-28.md` 已严重过期（其"未闭合项"在 ops log 2026-10-10 前已全部闭合），任何后续恢复/进度判断都应以 ops log 与本轮报告为准。

**但按规则 13.8 的口径声明**：车道清单 132/132 = 100%，工具面三项缺口（native 删除面 / deploy systemd / SSE 实证 / CUDA 实测）已全部收口（§1.4）——**本轮达成"报告范围定义内"的全量覆盖**。严格意义的"全仓审计完成"仍差两项延续项（§五）：AXIOM-ARCHITECTURE.md 逐句主张提取（轮 1–6 已大半覆盖）、C16/C18 非代码面。

**修复优先级建议（不在本轮执行，供用户裁决）**：第一梯队 H1（laya 并发闸语义+自报字段测试）与 H2（calibrate 分子分母口径）——两者都在已投产的 decision 链路上且互相掩盖；并列第一梯队 lane4b 补齐的 router 三连：**code-retrieval-router 全仓零消费（含 pi-agent 策略死代码与 retriever 死注入）+ nativeEmitted SSE 内容重复 + eval provider 空报告漂移**——三者同属"内核收敛后依赖装配"回归类，且都无测试能抓住；第二梯队 config-center getNumber 兜底（413 风险面）、run_daily.sh 静默 exit 0（cron 数据链）、smoke 门 6 恒 PASS（P-F1，门禁自述与实现不符）、pipeline 300s 空闲超时回归（僵尸连接聚积）、systemd 机器绑定路径（§1.5，与 mcp-servers.yaml 同修）；第三梯队 env 泄漏 helper（4 文件同修）与 source-grep 断言清理（H3，同型 3 处）。

**方法论登记**：①OCR delegate 模式的 preview 在 rename-heavy diff 上会漏路径（本轮 361 vs 330）——覆盖率账本必须用 `git diff` 独立闭合，不能直接采信 preview 的 reviewable+excluded 总数；②子代理 High 级 findings 必须主会话复核：本轮 6 条 High 中 2 条维持、3 条降级（1 条实验证伪）——复核率 50% 维持率说明"精度优先"约束下的 High 仍需编排者把关；③EPIPE 证伪实验（Bun FileSink 语义）应作为该文件的修正知识入库，避免后续审查重复误报。

---

## 附：本轮门禁实测汇总（证据）

| 门禁 | 命令 | 结果 |
|---|---|---|
| doc-contract | `bun test tests/doc-contract.test.ts` | 35 pass / 0 fail（916ms） |
| audit:runtime | `bun run scripts/runtime-audit.ts` | overall=pass，16 通过/0 警告/0 失败 |
| tsc | `./node_modules/.bin/tsc --noEmit`（本地 5.3） | rc=0 |
| count-tools | `bun scripts/count-tools.mjs` | 189，duplicateTools=0，exit=0 |
| arch-stats | `bun scripts/count-arch-stats.mjs` | srcFiles 454 / srcLines 121360 / testFiles 498 / mcpTools 189 |
| go vet | `go vet ./...`（runtime-go，go 1.27.1） | rc=0 |
| go 确定性 | `go test -run TestSearchDeterministicAcrossRepeats -count=1` ×5 进程 | 5/5 ok |
| KAL 确定性 | `bun src/eval/kal-determinism.ts` | runs=5 identical=true |
| 全量 bun test | `bun test --timeout 15000 ./tests` | **4721 pass / 67 skip / 0 fail**（498 文件，91.87s，exit=0） |
| 敏感扫描 | diff 凭据模式 grep | 2 命中均为 ops log 自指占位串（非凭据）；私网地址集中在 ops log/部署脚本/测试夹具（既定口径内） |
| SSE cancel 实证 | /tmp 独立 Bun 实验（§1.4）：客户端 abort → proxy cancel() 触发 1 次、上游连接归零 | lane4b 指控反驳，`421c8132` 修复机制成立 |
| CUDA 确定性 | RTX 3050 Ti，bge-m3，同批 5 文本 N=5 独立请求 SHA-256 比对（§1.4） | 5/5 逐字节一致（`473ae16efa55f039…`） |
