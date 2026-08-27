# 工具链稳定性审核报告 — 2026-08-11

> 审核范围：D:\openclaw-fusion 后端（bun 为核心的 测试/构建/类型检查 工具链）
> 审核方式：只读实验（bun 1.3.14 / node v24.18.0 / npm 11.16.0，Windows PowerShell）
> 结论速览：**bun 1.3.14 本身稳定；全量 `bun test tests/` 变红根因是 bun:test 的 `mock.module` 进程级跨文件泄漏 + 2 个网络依赖用例 + 3 个性能敏感断言。加 `--parallel`/`--isolate` 即可根治 13/14 失败，无需迁移 vitest。**

## 一、现状核查（事实 + 数据）

### 1. package.json 脚本与依赖（事实）
- 后端所有脚本均以 `bun run` / `bun test` / `bun build` 启动；`test` = `bun test tests/`；`lint` = `tsc --noEmit`；`test:e2e` 已是 node（scripts/run-e2e.cjs）。
- 根 devDependencies 极简：`typescript`、`@types/bun`、`@playwright/test`；**根目录无 vitest / jest / jsdom**（node_modules 实测均不存在）。
- 锁文件为 `bun.lock`（bun 1.2+ 文本锁），无 package-lock.json。

### 2. bun:test 使用面（162 个测试文件，全部递归统计）
| 指标 | 数量 | 说明 |
|---|---|---|
| 从 `bun:test` import | **162/162（100%）** | npm/Node 原生 runner 完全无法直接运行 |
| `mock.module`（bun 独有，进程级全局注册） | **实际调用仅 5 文件** | consciousness、internal-agent-budget、minimax、services-chat(×5)、self-evolve/reflection-induce(×2)；另有 3 文件仅注释提及 |
| `spyOn` | 12 文件 | vitest 有 `vi.spyOn` 等价物，机械改写 |
| `mock(` | 3 文件 | vitest `vi.fn()` 等价 |
| `toHaveBeenCalled*` | 1 文件 | 兼容 |
| `mock.restore` | 11 文件 | 兼容 |
| Bun.* 运行时 API（Bun.serve/Bun.write/Bun.file/Bun.sleepSync） | 7 文件 | 迁 vitest 需换 node:http / node:fs |
| DOM 依赖（bunfig.toml `[test] dom=true` 提供） | 仅 2 文件 | dashboard-home、ocr-page；vitest 需 jsdom 环境 |

### 3. bun 1.3.14 稳定性实验（本机实测）
| 实验 | 结果 |
|---|---|
| 目标小组（self-evolve/router/services/tool-loop） | **34/34 通过，342ms** |
| 默认全量 `bun test tests/`（即 `npm test` 实际执行） | **2300 通过 / 28 跳过 / 14 失败，126s** |
| `bun test --isolate tests/` | **2309 通过 / 28 跳过 / 5 失败，141s** |
| `--parallel=4` 受污染子集（11 文件） | **60/60 通过，703ms** |
| `--parallel` 无参（2 文件污染对） | 12/12 通过，318ms |
| 各失败文件单独复跑 | 全部通过（仅 GitHub trending 网络用例除外） |

**失败归因（证据链）**：
- 默认全量 14 失败中 **13 个 = `mock.module` 跨文件泄漏**：internal-agent-budget.test.ts 的 `mock.module(src/router/model-router.js)` 在同一进程内污染后续文件——复现：`bun test tests/internal-agent-budget.test.ts tests/model-router.test.ts` → model-router 2 个用例失败（`TypeError: texts.map`），单独跑 8/8 通过；加 `--isolate` / `--parallel` 后 12/12 通过。skill/tool-loop/chat-stream 等失败同源于此（依赖文件执行顺序，表现为“同批结果漂移”）。
- 1 个 = 网络依赖：`discoverGitHubRepos`（tests/knowledge/sources/github-trending.test.ts）抓 https://github.com/trending，沙箱无外网 → 5s 超时（单独跑也失败）。
- `--isolate` 后剩余 5 失败 = 2 个 GitHub trending 网络用例（github-trending + knowledge/pipeline 的 trending 用例，30s 超时）+ 3 个性能/时序敏感用例（缓存 50k 衰减比、Cache LRU 风暴、PCDA 升级；单独跑均通过，全量时因进程内并发争抢误报；本次验证还叠加了并发跑前端 vitest 加剧争抢）。

### 4. 类型检查与构建（事实）
- `bunx tsc --noEmit`：6.5s，0 错误（干净）。
- `bun run build`：527 模块打包，87ms，exit 0（dist/main.js 2.27MB）。

### 5. 前端已稳定在 npm+vitest（事实）
- frontend/package.json：`test` = vitest v4.1.9（jsdom）。
- 实测 `npm run test:run`：**43 文件 / 284 测试全通过，41s**（scrollTo 等 jsdom 提示为良性）。
- 现状：后端 bun:test 与前端 vitest **双栈并存**。

### 6. 源码编译选项（事实）
- `native/` = Rust workspace（axiom-local / axiom-cloud，tokio/rusqlite/redis 等），性能关键模块，与 TS 测试栈无关。
- `runtime-go/` = Go 组件（cmd/internal），独立。
- `bun build --compile` 可出单文件可执行（当前 build 仅 `--outdir`，未用 compile）。
- tsc 只做 `--noEmit` 类型检查；产物由 bun build 负责（87ms 级）。

### 7. CI 核查（事实）
- .github/workflows/ci.yml 与 .ci/run.sh 均用 bun；CI 只跑 `test:full`（**显式文件白名单**，恰好绕开了 internal-agent-budget/model-router/services-chat/long-running-memory 等文件）→ **CI 绿而本地 `bun test tests/` 红，两者不一致**，白名单外文件在 CI 零覆盖。
- CI 缓存键用 `**/bun.lockb`，仓库实际为 `bun.lock` → **缓存永远不命中**（小 bug）。
- CI 固定 `BUN_VERSION: "1.3"`，与本机 1.3.14 一致（钉了主版本，未钉精确补丁；package.json 无 `packageManager`/`engines`）。

## 二、风险
1. **mock.module 进程级泄漏** → 本地全量红、且失败随文件顺序/并行度漂移（不可复现性最强）；CI 白名单掩盖回归，白名单外 20+ 文件零覆盖。
2. **性能断言脆弱**：缓存 50k 衰减比 <3x、LRU 风暴、PCDA 时序在全量共享进程/并发争抢下误报；CI 的 test:full 未覆盖这些文件，等于“报不了错也查不了真”。
3. **网络依赖用例**：GitHub trending 抓取无外网时挂 5~30s 超时；CI 有网可过但抓取本身易被 GitHub 限流，属 flaky-by-design。
4. **npm 无兜底**：`npm test` 只是 shell 到 `bun test`；bun 缺失/损坏时无替代 runner。
5. **双栈心智成本**：前端 vitest / 后端 bun:test，mock 语义与 API 不同。

## 三、三个候选方案对比
| 维度 | A. 保持 Bun + 固定版本（推荐） | B. npm + vitest 迁移 | C. 源码编译 / 其他运行时 |
|---|---|---|---|
| 解决 13 个 mock 泄漏 | ✅ 一条 flag（`--parallel` 隐含 `--isolate`） | ✅ 默认每文件隔离 worker | ❌ 与测试无关 |
| 改动量 | 脚本 2~3 行 + CI 键 + 网络/性能用例微调，**零测试改写** | import 改写 162 文件 + 5 文件 mock.module→vi.mock（**注意 hoisting 语义差异**）+ 12 spyOn→vi.spyOn + 3 mock→vi.fn + 7 文件 Bun.*→node:http/fs + 2 文件 jsdom + 根目录新增 vitest/jsdom 依赖 | bun build --compile 可出单文件，但不解决测试稳定性；native/rust、runtime-go 是独立加速组件 |
| 成本 | 约 1~2 小时 | 约 0.5~1 天 + 回归风险 | N/A |
| 风险 | bun:test 生态小众；升级 bun 需回归 | vi.mock hoisting 与 bun mock.module 运行时注册语义不同（5 文件需逐个验证）；Bun.serve 4 文件需改 node:http；性能断言基线变化 | deno 引入第三种运行时收益为零，不必要 |

## 四、推荐方案与落地步骤（按性价比排序）
**P0（今天可做，1~2h）——不迁移，修脚本与用例：**
1. package.json：`"test": "bun test --parallel tests/"`（隐含 `--isolate`，根治 13 个 mock 泄漏失败）；`test:full`/`test:core` 同步加 `--parallel`。
2. 修复 CI 缓存键 `**/bun.lockb` → `**/bun.lock`。
3. package.json 增加 `"packageManager": "bun@1.3.14"`（+ engines）钉死版本；升级时单独全量回归。

**P1（稳健化）：**
4. 网络依赖用例（github-trending、knowledge/pipeline 的 trending 用例）：无 `GITHUB_TOKEN` 或外网探测失败时快速 skip（短超时 3~5s），避免 5~30s 挂死。
5. 性能断言（缓存 50k 衰减、LRU 风暴、PCDA 升级）移入 `test:perf` 专用进程（已有 perf-benchmark 模式），或放宽阈值并独立跑——避免全量进程内误报。
6. CI 的 test:full 扩为 `bun test --parallel tests/`（P0 后应绿；网络用例按 P1 处理），消除“CI 绿本地红”与白名单零覆盖。

**P2（可选，统一栈）：**
7. 若团队决定统一 vitest（方案 B），建议先跑 P0-P1 2~4 周收集 bun 稳定性数据后再决策；迁移可用 codemod 先机械改 import，再人工处理 5 个 mock.module 文件。

## 五、需要用户决策的点
1. 是否接受“保持 bun + `--parallel` 脚本修复”路线（推荐）？还是直接投入 vitest 迁移？
2. bun 版本策略：钉 1.3.14 不动，还是升级到最新（需全量回归验证）？
3. 网络依赖用例：是否接受“无 GITHUB_TOKEN / 外网不可达即 skip”的处理方式？
4. CI 是否切换为 `bun test --parallel tests/`（全量 162 文件，约 2.5~3 分钟，含网络用例）替代 test:full 白名单？

## 六、实验记录（证据）
| # | 命令（均提权运行，沙箱子进程 EPERM 属环境限制非 bun 问题） | 结果 |
|---|---|---|
| 1 | `bun --version` / `node --version` / `npm --version` | 1.3.14 / v24.18.0 / 11.16.0 |
| 2 | `bun test tests/self-evolve/ tests/router/ tests/services/tool-loop.test.ts` | 34/34 通过，342ms |
| 3 | `bun test tests/`（默认全量） | 2300/28/14，126s |
| 4 | `bun test --isolate tests/` | 2309/28/5，141s |
| 5 | `bun test --parallel=4`（11 文件污染+性能子集） | 60/60 通过，703ms |
| 6 | `bun test tests/internal-agent-budget.test.ts tests/model-router.test.ts`（无 flag） | 10/2 失败：TypeError: texts.map |
| 7 | 同 6 + `--isolate` / `--parallel` | 12/12 通过 |
| 8 | `bun test tests/knowledge/sources/github-trending.test.ts`（单独） | 2/1：外网超时 5s（环境性） |
| 9 | `bun test tests/edge-cases/long-running-memory.test.ts`（单独） | 9/9 通过（含 50k 衰减） |
| 10 | `bunx tsc --noEmit` | 0 错误，6.5s |
| 11 | `bun run build` | 527 模块，87ms，exit 0 |
| 12 | `cd frontend && npm run test:run` | 43 文件 / 284 测试通过，41s |

> 说明：本次审核未修改任何仓库文件（除本报告外），未做任何 git 操作。
