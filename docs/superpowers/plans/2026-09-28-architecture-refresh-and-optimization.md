# 架构梳理与下一步优化路线图（2026-09-28）

> 背景：主干归一收口（`internal/main` = `d8d5ab65`）后，用户指令「梳理当前项目架构和规划下一步优化」。
> 本文 = 架构现状基线（全部实测）+ 分级优化计划。执行时各任务按总则 0.3 单独立契约，本文是路线图不是免检通行证。

## 一、任务契约（路线图级）

- **任务**：①架构现状梳理（有据）；②优化项分级排序（P0/P1/P2）。
- **验收标准**：架构图与实测一致（数字可复现）；每个优化项带证据、动作、验收口径；不与 AGENTS.md/门禁冲突。
- **改动清单（文件级）**：本文档；后续各任务各自的改动在执行时另立契约。
- **不做项**：不动已推送历史；不重写 ARCHITECTURE.md 全文（增量校准）；不引入新依赖；不在路线图轮次顺手修任何 P0 项。
- **验证命令**：`bun test ./tests/doc-contract.test.ts`；`bun run scripts/count-tools.mjs`；`bunx tsc --noEmit`（执行任务时按各自门禁）。
- **风险/回滚**：纯文档 + 后续任务各自回滚点。

## 二、架构现状基线（2026-09-28 实测）

### 2.1 总量

| 维度 | 实测 |
|---|---|
| src/ | **38 模块 / 451 文件 / 121,591 行 TS** |
| 测试 | tests/ 490 文件，**4,664 用例**（串行全量 110–127s，0 红） |
| MCP 工具 | **189**（`src/testing/tool-count.ts` 单一事实源） |
| HTTP 路由 | 280+（Trie 路由 + 请求缓存） |
| 依赖面 | deps **9** + devDeps **3**（刻意极瘦） |
| 多语言 | Rust 15 文件（native/crates：cloud/local/route/search/shared）；Go 114 文件（runtime-go：modelclient/distrib + bin）；前端 React+Tauri 141 文件（xterm/zustand/framer-motion） |
| 门禁 | doc-contract 35、audit:runtime 16、architecture-integrity 25、count-tools 189、timer-unref-guard、hallucination-feedback、risk-monitor HardFloor 等 |

### 2.2 分层（architecture-integrity 门禁约束下的实际分层）

```
入口:    main.ts(v2.2 HTTP/WS 服务) · launcher.ts · cli.ts · mcp/server.ts(16 域文件)
叶子层:  constants · utils                    （不依赖任何 src 模块）
领域层:  memory(确定性检索) · knowledge(KAL/语义层) · kg · kal · dre(推理引擎 18.7K 行最大模块)
         router(模型路由/Thompson) · crawl · db · ocr · skills · tools · agents(12.5K)
         decision(全自动审计链) · semantic(语义表示 schema) · local-llm(llama.cpp MiniCPM5-1B)
         codeindex(本地 AST→SQLite 代码索引) · runtime(RuntimeHost) · computer-use · terminal(PTY 审批门)
         cron · sandbox · context · core · eval · agent-evals · self-evolve · pi-agent · testing
集成层:  mcp · routes                         （可引用所有领域层）
解耦层:  services                             （唯一允许双向引用，循环断路器）
```

### 2.3 数据面

| 库/存储 | 现状 |
|---|---|
| `data/agent.db` | 133.2MB，**freelist 30.7MB（23%）**；大头是 codeindex 产物（code_calls 41,605 + code_symbols 14,996 行）+ FTS 影子表；业务活数据很小（conversations 13、memory_notes 184、search_history 60） |
| `data/knowledge.db` / `token-usage.db` / `eval-registry.db` / `model-eval.db` | 0.1MB / 1.5MB / 健康 |
| `axiom-memory.db*`（仓库根） | vault 索引（+wal/shm，u2 同批还原） |
| 双 vault | `axiom-memory/` 122M（OBSIDIAN_VAULT_PATH）+ `openclaw-memory/` 32M |
| legacy 合并面 | model-outputs 100,440 件（含退役机 +28,780）、09-22 轮转日志、qoder 转录 199 件（archive/recovered-legacy-qoder-20260922/） |

### 2.4 安全面

capability 判定内核（`permission-middleware.checkToolPermission` 空能力即拒 + HardFloor 按声明能力推导）+ `path-safety` 锚点/越界确定性裁决 + `terminal` PTY 审批门 + docker/process 沙盒 + SSRF 守卫；灰区初筛 `EDGE_RISK_MONITOR` 默认关（LIMITATIONS #4，显式取舍）。

### 2.5 检索面

默认 = SQLite FTS5 + 确定性关键词引擎（无向量计算）；可选语义层 = 同库 `knowledge_embeddings`（推送腿 + 扫描腿 + 删除同步两道安全闸，真实 bge-m3 端到端实测）；**发布默认零 embedding 候选**（SiliconFlow devOnly，用户自配才可用）。

## 三、问题面与优化计划

### P0 —— 正确性/卫生（成本低、防继续漂移）

| # | 项 | 证据 | 动作 | 验收 |
|---|---|---|---|---|
| P0-1 | **架构权威文档漂移** | `docs/ARCHITECTURE.md` 自称"唯一架构权威参考"但：统计表 70K 行 vs 实测 121.6K、1,170 tests vs 4,664；§2 模块树缺 8 模块（codeindex/decision/local-llm/terminal 提及 0 次）；§7 演进止于 07-11；§10 编排器仍是 Windows 叙事（现为本 Linux 机） | 增量校准：统计表改指向 `scripts/` 自动生成（防再漂移）；§2 补 8 模块一行职责；§10 拓扑改 Linux 编排器；演进表追加归一/迁移两条 | doc-contract 35/0；文档数字与 `find|wc` 复现一致 |
| P0-2 | **codeindex 索引系 Windows 检出生成** | agent.db code_symbols 14,996 行系旧 checkout 扫描产物，`code_index_meta` 待核路径前缀 | `code_index_meta` 核对；Linux 侧重扫（`codeindex` 入口）；重扫前不信任索引结果 | meta 记录 = 本机路径；抽查符号可解析 |
| P0-3 | **agent.db 膨胀** | freelist 30.7MB（23%） | 停机窗口 `VACUUM`（或 `VACUUM INTO` 轮换）；例行化：健康检查挂 freelist 阈值告警 | freelist < 5%；服务重启后冒烟过 |
| P0-4 | **F7 群聚族**（轮 6 指定下轮） | `services/tool-loop.test.ts` 为群聚中心（组合 4 红、单跑全绿，红集随运行漂移）；网络/计时敏感用例（GitHub 爬取、性能衰减）混入串行套件 | mock 纪律审计（mock.module/全局桩排查）；网络类用例加显式环境闸（无外网自动 skip 并登记） | 串行全量连续 3 次 0 红且无漂移 |
| P0-5 | `C:/` 空目录异物 | 仓库根 12K 空目录树（Windows 路径解包残留），未跟踪 | 删除（规则 4 例外：空目录），ops log 登记 | `ls C:` 不存在 |

> **执行状态（2026-09-29 本机复核；本表部分证据在写下时即已过期，以本块为准）**
>
> - **P0-1 ✅ 已落地**：§1 统计改为生成器 `bun run arch:stats`（单一事实源 `src/testing/arch-stats.ts`）+ `docs-consistency` **精确相等棘轮**（双向突变验证：改数字红、改格式也红）；§2 已补 8 模块；§10 已改 Linux 编排器；§7 已追加"主干归一/Rust 全退役""数据面校准"两行。校准当天该数字又漂 137 行，正是本棘轮要拦的形态。
> - **P0-2 ✅ 已解决**（另一会话 09-29 完成，本轮独立复核）：`code_index_meta` **无路径列**（"待核路径前缀"不成立）；索引重建于 2026-09-29T16:47，与当前树一致——删掉的 native 0 行 / 恢复的 `src/local-llm` 11 符号 / 新增 `laya-http.ts` 21 符号；16,615 符号中反斜杠与盘符路径 **0 条**（全为本机绝对 POSIX 路径）。
> - **P0-3 ✅ 已解决**：`freelist_count = 0`、29,870 页 × 4096 = 122.3MB（与文件大小一致）——09-29 已做 VACUUM 轮换并写入 §7；本轮无需再 VACUUM。
> - **P0-4 ✅ 本机验收通过（连续 3 次串行全量 0 红，4,686 用例 / 114–117s）**，且是**根因修复而非放宽阈值**：`tryGC()` 原查 `globalThis.gc`（Bun 下恒为 `undefined`）⇒ 空操作 ⇒ C.2 堆增量在 −3.7~+8.5MB 间漂移、全量套件下 2/3 轮假红；改用 Bun 原生 `Bun.gc(true)`（实测 16.6MB→0.1MB）后 delta **连续 5 次恒定 7.79MB**。另把 `extreme-stress.test.ts` 5 处硬编码墙钟断言改为 `perfBudget(strict, relaxed)`（strict 保留原值，专属性能门不变）。
>   **余项**：全仓仍有约 95 处硬编码 `toBeLessThan(N)`（其中约 20 个文件涉及墙钟计时）。本轮按证据驱动只改今日实测红过的两处，建议后续逐批转换、勿一次性大改（转换需先区分"墙钟"与"计数/尺寸"语义）。
> - **P0-5 ✅ 根因修复（原描述不准确）**：不是"Windows 路径解包残留"，而是**测试夹具活体生成**——`tests/unit/filesystem.test.ts` 用 `path.join("C:", "Windows", "Temp", ...)` 造"沙箱外"路径，在 POSIX 上退化为**仓内相对路径**，于是每次跑测试都会重建 `C:/Windows/Temp`（实测 mtime 与测试运行同步、0 文件）。已改：平台分支（POSIX 用 `os.tmpdir()`）+ **仓外断言**（退化即红，且在 mkdir 前拦下）+ 创建目录清理队列；突变验证：强制走 Windows 分支 ⇒ 响亮失败且零落盘。

### P1 —— 部署/运维就绪（本机刚迁移，把"能跑"变"常跑"）

| # | 项 | 动作 | 验收 |
|---|---|---|---|
| P1-1 | **LINUX-SMOKE 六道冒烟** | 按 `deploy/LINUX-SMOKE.md` 以真实运行态执行（`scripts/smoke-linux.sh --mode=docker` 或裸 Bun），记录进 ops log | 六道门禁全过；结果贴 ops log |
| P1-2 | systemd 常驻 | `deploy/systemd/axiom.service` 落地（EnvironmentFile 指向 /opt 路径按部署调整）+ 开机自启 | `systemctl status` active；重启后自拉起 |
| P1-3 | runtime-go 节点更新 | 部署脚本原指向 Windows 编排器/旧节点；按 `${LAN_*}` 新拓扑重配 | modelclient 连通冒烟 |
| P1-4 | **计划第 8 步：退役分支归档** | 13 本地分支中已并入 main 的按规则 4 移入 `codex/archive-*` 归档分支（ku/doc-caliber 等），清单先列后裁 | `git branch` 收敛；归档分支可追溯 |

### P2 —— 能力/性能（按需启动，单项另立契约）

| # | 项 | 依据 | 说明 |
|---|---|---|---|
| P2-1 | embedding 提供方接入 | 发布默认零语义召回（SiliconFlow devOnly；LIMITATIONS #6） | 用户自配端点，或 local-llm 侧起本地 bge-m3 服务；接入后跑 `lexical-vs-semantic-recall` 基准 |
| P2-2 | `wiki_links` 持久化表 | LIMITATIONS #1（跨存储引用未闭环） | vault wiki-link 图落 SQLite + 增量维护 |
| P2-3 | EDGE_RISK_MONITOR 灰区复核 | LIMITATIONS #4 | 评估默认关闭的灰区风险敞口，给出开/关建议与实测 |
| P2-4 | codeindex 索引库独立 | codeindex 产物占 agent.db 大头（56K 行） | 评估迁独立 `codegraph.db`（archive/.codegraph 旧例），agent.db 回归纯业务库 |
| P2-5 | 测试并行化探索 | 串行 127s；但 F7 证明跨文件单例/桩污染真实存在 | 谨慎：先 P0-4 收口再评估按目录分片，不动门禁语义 |

### 执行序与不做项

- **序**：P0-5 → P0-1 → P0-3 → P0-2 → P0-4 → P1-1 → P1-4 → P1-2 → P1-3 → P2 按需（每项开工时按总则 0.3/0.4 单独立契约）。
- **不做项**：不动已推送历史（规则 9）；不在本路线图轮次顺手执行任何单项；不引入新依赖；ARCHITECTURE.md 只增量校准不重写。

## 四、证据基线（本文数字的复现命令）

```
find src -name '*.ts' | wc -l; find src -name '*.ts' | xargs wc -l | tail -1
find tests -name '*.ts' | wc -l; bun test --timeout 15000 ./tests | tail -3
bun run scripts/count-tools.mjs
bun -e 'import{Database}from"bun:sqlite";const db=new Database("data/agent.db",{readonly:true});
  console.log(db.query("PRAGMA page_count").get(), db.query("PRAGMA freelist_count").get())'
```
