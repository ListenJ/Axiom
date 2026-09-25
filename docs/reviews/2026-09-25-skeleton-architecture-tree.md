# Axiom Runtime 骨架架构树（2026-09-25）

> 方法：基于 git 跟踪内容（`git ls-files`）+ 工作区状态注记 + 最近提交时间。数字 = 跟踪文件数（树内括号为 src 二级目录文件数）；"最后提交"为该子树最近一次 commit 日期。本树只描述**骨架**，逐文件深审由后续审计轮按此分母推进。
> 用途：①重审代码的分层地图；②砍除候选（§三）的定位锚点；③Laya 决策轮（§四）的选项来源。

## 一、分层架构树

```
Axiom Runtime (axiom-agent 4.0.0, Bun + TypeScript)
│
├─ 入口链（4 个可执行入口，launcher 作闸）
│   ├─ src/launcher.ts (431L) ── 子命令派发：server / mcp / tui / cli / bootstrap
│   ├─ src/main.ts (935L) ── HTTP+WS 服务宿主：Vault 挂载、安全中间件、健康检查
│   ├─ src/mcp/server.ts (+ server/ 38) ── MCP 协议面（189 工具注册）
│   ├─ src/cli.ts (1364L) + src/cli/ (7) ── CLI 面
│   └─ src/tui/ (2) ── 终端 UI（install-wizard 等）
│
├─ L1 认知与决策层
│   ├─ src/dre/ (54) ── 确定性推理引擎（constraint/runtime/pipeline/persona/actor/llm/system-resource）
│   ├─ src/decision/ (3) ── Laya System-1 分诊闸（laya-triage/laya-cli/audit-chain，2026-09 新增）
│   ├─ src/self-evolve/ (6) ── 自进化管线
│   └─ src/semantic/ (3) ── 语义辅助件
│
├─ L2 编排与 Agent 层
│   ├─ src/agents/ (39) ── 多 agent 协作（opencode-tool-agent/project-analyzer/risk-monitor 等）
│   ├─ src/computer-use/ (5) ── 计算机使用 agent
│   ├─ src/pi-agent/ (3) ── Pi Agent 代码工具适配
│   ├─ src/sandbox/ (4) ── 沙箱执行
│   ├─ src/terminal/ (2) ── 终端集成
│   └─ src/workers/ (3) ── worker 进程（pdf-worker 等）
│
├─ L2.5 采集与摄取带（重审轮 1 从 L2 重新归类：ARCHITECTURE.md 自述 crawl 为"数据采集管道"，
│        且 crawl/data-pipeline.ts:40 直引 memory/vault-manager 写库——语义上是 L4 的上游供给，不是 agent 编排）
│   └─ src/crawl/ (15) ── web fetch / unified-search / search-engines / html-to-markdown（knowledge 的摄取上游）
│
├─ L3 路由与模型接入层
│   ├─ src/router/ (20) ── O(1) 模型路由（model-router/registry/presets）
│   ├─ src/local-llm/ (3) ── 本地边缘模型客户端（edge-client/edge-embeddings/risk-screen）
│   └─ src/context/ (4) ── 上下文组装（context-manager）
│
├─ L4 知识与记忆层
│   ├─ src/kal/ (2) ── KAL 知识访问层（knowledge-access-layer，594L，zero-LLM 查询面）
│   ├─ src/kg/ (2) ── 知识图谱
│   ├─ src/knowledge/ (17) ── 知识管线（pipeline/collector/searcher/vision）
│   ├─ src/memory/ (16) ── Vault 记忆引擎（vault-manager/deterministic-search/sqlite-memory/bootstrap）
│   └─ src/db/ (7) ── SQLite 持久层（migrate 等）
│
├─ L5 接口与工具层
│   ├─ src/routes/ (36) ── HTTP 路由（chat 等）
│   ├─ src/tools/ (5) + src/plugins/ (2) + src/skills/ (3) ── 工具/插件/技能装配
│   ├─ src/ocr/ (2) ── OCR（tesseract.js，运行时依赖根目录 *.traineddata——未入库）
│   ├─ src/core/ (6) ── config-center/health-checker
│   └─ src/services/ (9) ── 领域服务（chat 等）
│
├─ L6 支撑与横切层
│   ├─ src/utils/ (51) ── logger/env/auth/rate-limiter/security/websocket 等
│   ├─ src/testing/ (15) ── 测试基建（tool-count 单一事实源、scheduler 等）
│   └─ src/components/ (9) / src/runtime/ (3)
│
├─ 评测面（两套并存）
│   ├─ src/agent-evals/ (22) ── runtime 评测 CLI（eval:runtime）
│   ├─ src/eval/ (7) + eval/ (395: semantic-equivalence 359 + semantic-validation 36，JSON 数据集)
│   └─ eval-results/ (22) ── 评测产物入库
│
├─ 测试面（443+184）
│   ├─ tests/ (443) ── bun test 主面（419 文件实测运行）
│   ├─ e2e/ (14) ── Playwright e2e
│   └─ e2e-visual/ (170: 168 PNG 基线) ── 视觉快照，105 个 LFS 对象全部在此
│
├─ 前端与多平台壳
│   ├─ frontend/ (170) ── React+Tauri 前端（最后 08-27；工作区 226M 含 node_modules）
│   ├─ src-tauri/ (23) ── Tauri 壳（最后 08-03；src/config 零引用；工作区 5.3G 其中 target/ 占 5.3G，已 ignore）
│   ├─ harmonyos/ (17) ── 鸿蒙端（最后 08-24；src/config/package 零引用）
│   ├─ runtime-go/ (122) ── Go 伴生服务（最后 09-13，活跃；32 位承诺承载方）
│   └─ native/ (21) ── Rust 本地模块（axiom-local/axiom-cloud）
│
├─ 运维与分发
│   ├─ scripts/ (66) ── 构建/打包/审计脚本（matrix/linux-bundles/runtime-audit/verify-artifacts）
│   ├─ config/ (11) + deploy/ (2) + .ci/ (2) + .github/ (3) + Dockerfile ×2
│   └─ dist/ ── 发布产物工作区（609M，已 ignore，不入骨架）
│
├─ 记忆库与知识库（数据面）
│   ├─ openclaw-memory/ (41) ── PARA 记忆库（入库；最后 09-22）
│   ├─ knowledge-base/ (10) ── 知识库内容
│   └─ axiom-memory/ + axiom-memory.db* ── 本地运行态记忆（未入库 122M+DB；与 openclaw-memory 并存 ⇒ 双记忆树）
│
└─ 工具状态（入库存疑）
    ├─ .superpowers/ (15) ── SDD briefs（过程文档）
    └─ .serena/ (2) ── 工具配置
```

## 二、Mermaid 分层图（数据流方向自上而下，依赖不回穿）

```mermaid
graph TD
    subgraph 入口
        L[path: launcher.ts] --> M[main.ts 服务宿主]
        L --> MCP[mcp/server.ts 189 工具]
        L --> CLI[cli.ts / tui/]
    end
    subgraph L1 认知决策
        DRE[dre/ 确定性推理] 
        DEC[decision/ Laya 分诊闸]
        SE[self-evolve/]
    end
    subgraph L2 编排
        AG[agents/ 39]
        CU[computer-use/ sandbox/ workers/]
    end
    subgraph L2.5 采集
        CR[crawl/ 摄取上游]
    end
    subgraph L3 模型接入
        R[router/ O(1) 路由]
        LL[local-llm/ edge 客户端]
        CX[context/]
    end
    subgraph L4 知识记忆
        KAL[kal/ zero-LLM 查询]
        KG[kg/]
        KN[knowledge/ 管线]
        MEM[memory/ Vault]
        DB[db/ SQLite]
    end
    subgraph L5 接口工具
        RT[routes/]
        TL[tools/ plugins/ skills/ ocr/]
    end
    subgraph L6 横切
        U[utils/ 51]
        TS[testing/]
    end
    M --> RT --> AG
    MCP --> TL
    AG --> R --> LL
    AG --> CX --> MEM
    AG --> KAL
    CR --> KN
    KAL --> KG
    KAL --> KN --> DB
    MEM --> DB
    DRE --> R
    DEC -. 只读核验动作 .-> M
    AG --> U
    CU --> AG
```

依赖方向观察（模块 1 预审）：`decision/` 只依赖 `utils/env` 与自身 runner —— 不回穿；`dre→router` 为唯一 L1→L3 直连；`kal` 不引 `agents`，无知识层反向依赖。待深审确认。

## 三、砍除候选（P1–P6，附证据）

| # | 候选 | 证据 | 说明 |
| --- | --- | --- | --- |
| P1 | `lightpanda-linux/`、`media-tools/`、`python_libs/` | 三个目录 **0 个跟踪文件**（纯工作区）；lightpanda-linux=126M 浏览器下载缓存（可重建，src 有 15 处引用属运行时下载目标，**目录本身可清**）；media-tools=2 个个人 PowerShell 脚本（与 Axiom 无关，误入工作区）；python_libs=空目录 | 工作区卫生，非仓库内容 |
| P2 | `src-tauri/`（跟踪 23 文件） | 最后提交 2026-08-03（近 8 周停更）；`src/`、`config/`、`package.json`、`scripts/` **零引用**；`tauri:dev` 在 frontend 内找不到壳（断链），`tauri:build` 经 `cd ..` 回根**原本可用**（执行记录更正：此前"脚本断链"只对 dev 成立） | 停更平台壳 |
| P3 | `harmonyos/`（跟踪 17 文件） | 最后提交 2026-08-24；src/config/package/docs/ARCHITECTURE **零引用** | 停更平台 |
| P4 | 根目录未跟踪散件：`ai-daily-*.md`×4、`mcp-test*.log`、`tmpwebapp*.log`、`axiom-memory.db*` 运行态在根 | 全部 gitignored/未跟踪；会话日志与测试日志堆在根 | 根卫生；axiom-memory.db 是**在用**运行态（health checks.database），只宜挪位或保持 |
| P5 | `.superpowers/`（15）+ `.serena/`（2） | 过程性 brief/工具配置入库 | 工具状态入库存疑，量小 |
| P6 | 生成物：`src-tauri/target`（5.3G）、`dist/`（609M） | 已 ignore、可确定性重建 | 规则 4 例外允许直接删，但 dist 是发布链工作区，删除后需重建 |
| P7 | 双记忆树：`axiom-memory/`（未跟踪 122M）vs `openclaw-memory/`（跟踪 41 文件）+ `axiom-memory.db` | 两套 PARA 结构并存 | **用户数据，禁入自动决策**——仅登记，交人 |

## 四、Laya 决策轮（P1–P5 + 护栏）

> 口径：候选逐条出 `choice` 题（选项=处置），Laya 在 `triage` 域作答（它唯一可问的域）；margin < 0.15 ⇒ ESCALATE（模型拿不准→交人）。**砍除动作本身不在 REVERSIBLE_ACTIONS 注册**——`--run` 下必落"无对应可执行动作⇒ESCALATE"，即：Laya 的裁定只产出**处置决定记录**，任何实际删除必须经人。另设 1 条 `engineering` 域护栏题证明"自动链不会去删文件"。spec：`docs/decisions/laya/prune-triage.json`。

### 4.1 实跑结果（2026-09-25，真模型 bf16/CUDA，`bun run decide:laya -- --spec docs/decisions/laya/prune-triage.json`）

| 决策 | 裁定 | Laya 选择 | margin | 含义 |
| --- | --- | --- | --- | --- |
| P1 工作区残留（lightpanda-linux/media-tools/python_libs） | **AUTO** | `delete_now` | 0.198 | Laya 决定：清掉 |
| P2 src-tauri 停更平台壳 | **AUTO** | `archive_then_cut` | 0.298 | Laya 决定：归档分支保留后从工作树砍除 |
| P3 harmonyos 停更平台 | **AUTO** | `archive_then_cut` | 0.295 | Laya 决定：同上 |
| P4 根目录散件 | ESCALATE | (倾向 relocate_now) | **0.089 < 0.15** | 模型拿不准 ⇒ 交人 |
| P5 工具状态入库（.superpowers/.serena） | ESCALATE | (倾向 untrack_now) | **0.006** | 模型几乎完全拿不准 ⇒ 交人 |
| P7 双记忆树 | ESCALATE | — | — | `engineering` 领域封杀：连模型都不问（用户数据） |
| 护栏：执行删除动作 | ESCALATE | — | — | `engineering`+`external_write`：**证明自动链不会去删文件** |

**施工中的两次形状发现**（首次用 choice 题过真模型）：laya 真库契约要求①每道题必带 `instructions`；②choice 的选项字段叫 `criteria`（label→描述），不是早期 TS 类型写的 `options`——choice 此前只在 fake runner 单测里跑过。已对照 `laya/agent.py _check_question` 源码修正 `LayaQuestion` 类型、单测夹具与本 spec。

**执行边界**：以上 3 条 AUTO 仅为**处置决定记录**——`REVERSIBLE_ACTIONS` 未注册任何删除动作，`--run` 下必落"无对应可执行动作 ⇒ ESCALATE"。实际砍除（归档分支 + git rm）须人批准后另行施工。

## 五、重审轮 1 起步：模块 1 架构一致性（2026-09-25）

> 方法：入口链实读 + L3/L4 import 面全扫 + ARCHITECTURE.md 模块清单双向核对。以下每条带证据；这是按本树推进深审的**第一刀**，非完成态。

| # | 裁定 | 证据 |
| --- | --- | --- |
| M1-1 | **Low｜6 个 src 模块存在但 ARCHITECTURE.md 模块清单零提及**：`agent-evals/`(22 文件)、`codeindex/`、`computer-use/`(5)、`decision/`(3)、`semantic/`(3)、`terminal/`(2) | `grep -c "<dir>/" docs/ARCHITECTURE.md` = 0 ×6；模块清单见该文档 §目录树段 |
| M1-2 | **自查撤回两条**：曾判 `constants/`、`cron/` "文档有代码无"——实况 `src/constants/timeouts.ts` 与 `src/cron/scheduler.ts`(7.8K) 都存在，是我 uniq 输出 head 截断造成的误读。文档清单**无缺项** | `ls src/constants src/cron` |
| M1-3 | **树分类修正**：`crawl/` 从 L2 编排移入 L2.5 采集带——ARCHITECTURE.md 自述其为"数据采集管道"，且 `crawl/data-pipeline.ts:40` 直引 `memory/vault-manager`（采集写库），语义上是 L4 上游 | 本文档 §一 已改 |
| M1-4 | **Pass｜知识/路由层无反向依赖**：`src/kal` `src/kg` `src/memory` `src/knowledge` `src/router` `src/local-llm` `src/context` 内零 `../agents` `../routes` `../mcp` 引用；`crawl` 零 `../knowledge` `../agents` 反依赖（无循环） | 全目录 grep，见 ops log 命令 |
| M1-5 | **Pass｜kal 依赖面最小**：`knowledge-access-layer.ts` 仅 import `bun:sqlite` + `utils/logger` + 自身 `node-id` —— zero-LLM 查询面的静态证据再加一层 | `knowledge-access-layer.ts:16-18` |
| M1-6 | **Info｜knowledge→crawl 两条边是文档化摄取方向**（`document-reader.ts:12` html-to-markdown、`collector.ts:1` DataPipeline），随 M1-3 归类后不再是"跨层回穿" | `document-reader.ts:12`、`collector.ts:1` |
| M1-7 | **Pass｜decision/ 零回穿**：仅 `utils/env` 与自身 runner | 上轮已证，本轮复核 |

**下刀计划**（轮 2）：入口链细读（launcher.ts 431L 的派发面 + main.ts 935L 的中间件链）→ L1 dre/（54 文件，确定性引擎）→ L3 router/（20 文件）。

## 六、执行记录与待办（2026-09-25 03:30 更新）

**已执行**（归档分支 `codex/archive-2026-09-25` = c916de27 先行落地，ARCHIVE-LOG.md 逐项留痕）：
- P1 ✅ lightpanda-linux（126M 缓存，可重建）与 python_libs（空）直接删；media-tools 两个个人脚本**归档至 `archive/media-tools/`**（不可重建内容走可逆形态）。
- P2 ✅ `git rm -r src-tauri` + `tests/tauri-integration.test.ts`（被测面随壳移除）+ package.json 三个 tauri 脚本 + matrix.ts 的 tauri 目标。
- P3 ✅ `git rm -r harmonyos`。
- P4 ✅ 根散件：4 份 ai-daily 会话日志归档至 `archive/root-scatter-2026-09-25/`，3 份可重建日志删除；`axiom-memory.db*` 与 `*.traineddata` **保留**（在用运行态）。
- P5 ✅ 拆分处置：`.serena/` 退出跟踪（纯本机工具状态，文件留盘 + gitignore）；`.superpowers/` **保留跟踪**（交接 brief）。
- P7 ⛔ 未动（用户数据，禁自动处置）。

**待办**：P4/P5 的最终归置若用户另有想法可再裁；深审轮 2 按树推进（入口链细读 → dre/ → router/）。
