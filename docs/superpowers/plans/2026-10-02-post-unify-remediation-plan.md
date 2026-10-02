# 主干归一后修复与运维收口计划（2026-10-02）

> 依据：`docs/superpowers/plans/2026-09-28-architecture-refresh-and-optimization.md` 的路线图基线 +
> 2026-10-02 代码全面读取结果 + open-code-review（OCR）定向扫描结果。
> 生成 skill：`blueprint`（多会话/多 PR 施工计划；研究 → 设计 → 草拟 → 对抗性自检 → 登记）。
> 执行基线：`internal/main` = `gitea/main` = `d128843f`（2026-10-02 主干统一后）。
> 本文是**可执行计划**，不是免检通行证；每个 Step 开工时仍须按 `AGENTS.md` 总则 0.3/0.4 单独立契约。

---

## 一、路线图级任务契约

- **任务**：把 2026-10-02 代码读取与 OCR 扫描得到的候选缺陷，按“正确性优先、安全其次、运维再次、覆盖率最后”的顺序，拆成可独立验证、可回滚的施工步；集成分支 `codex/post-unify-remediation-2026-10-02` 上每步一个提交（高风险 Step 可单独开分支），绝不把多个不相关任务混入同一提交。
- **验收标准**：
  1. 每个 Step 有独立任务契约、文件级改动清单、验证命令、退出判据与回滚方式；
  2. 代码 Step 遵循 `AGENTS.md` 规则 1（最小化）+ 规则 2（备份/通读/验证/删备份）+ 规则 7（TDD）；
  3. 每步结束 `bunx tsc --noEmit` = 0，定向测试全绿；每个批次结束跑串行全量 `bun test --timeout 15000 ./tests` = 0 fail；
  4. 每步提交后推送 `internal <分支>`，禁止 force/改写已发布历史；
  5. 运维 Step 以真实系统证据（systemctl / git lfs / ls-remote / 冒烟输出）验收，不以“应该可以”替代；
  6. OCR 候选发现只有经复现红→绿后才升级为已确认缺陷，未复现项进入待裁清单。
- **改动清单（路线图级）**：本文件；后续各 Step 的文件清单见 §五。
- **不做项**：
  - 不在本计划轮次直接改 `main`（先分支，验收后再快进）；
  - 不重写 `docs/AXIOM-ARCHITECTURE.md` 全文，只做必要增量校准；
  - 不引入新依赖（git-lfs 属系统运维工具，不属运行时依赖）；
  - 不把 OCR 候选发现当成已确认缺陷直接批量修；
  - 不在运维 Step 中把 LAN 拓扑、凭据写入仓库（`AGENTS.md` 规则 11）。
- **验证命令（路线图级）**：见 §七；每 Step 另附定向命令。
- **风险/回滚**：代码 Step 一律以追加式 `revert` 回滚；运维 Step 各自带停用/恢复方案；数据面变更前先备份并记录 SHA256。

---

## 二、事实基线（2026-10-02 实测）

### 2.1 进度与仓库

| 项 | 实测 |
|---|---|
| 仓库 | `/run/media/listen/base/openclaw-fusion`（`/run/media/listen/base/Axiom` 只是迁移归档，不是代码仓库） |
| 远端 | `internal` = `gitea`，指向同一 Gitea 服务（按 `AGENTS.md` 规则 3：地址/端口/账号以本机 `git remote -v` 为准，不在本文复制） |
| 主干 | `main` = `codex/main-unify-2026-09-26` = `d128843f` |
| 分支一致性 | 13 个本地分支与远端同名分支 **13/13 SHA 全等** |
| 工作树 | 干净（0 行） |
| 远端 refs | 30 heads / 4 tags |
| 未并入 HEAD 的本地分支 | `codex/archive-experiments-2026-08-08`（2 提交）、`codex/retirement-consolidation-2026-09-23`（5 提交）；均已推送远端 |

### 2.2 架构快照

| 维度 | 实测 |
|---|---|
| 定位 | 确定性认知运行时（Runtime + World Model + Deterministic Cognitive System） |
| 规模 | 38 模块 / 452 文件 / 122,149 行 TS；471 个测试文件；4,686 用例 |
| MCP | 189 个去重工具；23 个 `*-tools.ts` 领域文件；`ToolRegistry` 双传输（stdio/HTTP） |
| 路由 | 36 个 `src/routes/*.ts`；声明式 `RouteRecord`；Trie + 请求缓存 |
| 核心链路 | `routes/chat.ts` → `services/chat.ts prepareChatContext()` → `model-router` → 幻觉校验 → 会话/Vault 归档 |
| 记忆 | `vault-manager` 单例 + `sqlite-memory` FTS5 + `deterministic-search`；写入走 tmp→SQLite→rename 原子发布 |
| 推理 | `dre/kernel.ts`（init/tick）→ `dre/engine.ts`（DataUnifier/Persona/Consciousness/Reasoning/Constraint/Actor/MentalModel）；`cognitive-pipeline.ts` 6 步闭环 |
| 安全 | `permissions` 能力内核 → `safe-fs.authorizePath` 唯一 I/O 执行点 → terminal 审批门 → docker/process 沙箱 → SSRF 守卫 |
| 运行时 | Bun 1.4.2；Rust sidecar 已于 2026-09-28 退役；Go `runtime-go` 保留 |

### 2.3 门禁终态（2026-10-02 实测）

| 门禁 | 结果 |
|---|---|
| `bunx tsc --noEmit` | rc=0 |
| `bun test tests/doc-contract.test.ts` | 35 pass / 0 fail |
| `bun test tests/unit/docs-consistency.test.ts` | 10 pass / 0 fail |
| `bun test tests/architecture-integrity.test.ts` | 25 pass / 0 fail |
| `bun run audit:runtime` | 16/16，0 警告 / 0 失败 |
| `bun test tests/docker-sandbox-mount.test.ts` | 27 pass / 2 skip / 0 fail |
| `bun test --timeout 15000 ./tests` | 4,619 pass / 67 skip / 0 fail（4,686 用例 / 471 文件，130.19s） |
| `bun run scripts/count-tools.mjs` | 189 个去重工具，0 重复 |
| `bun run arch:stats` | 38 模块 / 452 文件 / 122,149 行 |

### 2.4 OCR 扫描覆盖与分级发现

**覆盖事实（不夸大）**：

| 扫描 | 覆盖 | 结果 |
|---|---|---|
| 全仓广扫 | 17 文件完成 / 803 文件因 provider 限流或工具调用错误失败 | 50 条评论后中止；未达全仓 100% |
| 核心扫描 | `src/core` | 7 条评论（config-center / settings-catalog） |
| RuntimeHost 扫描 | `src/runtime/host.ts`、`types.ts` | 6 条评论 |
| 关键路径扫描 | `main.ts`、`routes/chat.ts`、`services/chat*.ts`、`model-router.ts`、`knowledge/pipeline.ts` 等 | 20 条评论 |

**分级发现索引**（完整证据见 `/tmp/ocr-*.txt` 与本计划附录 A；OCR 评论是候选发现，需红→绿复现后才算确认）：

| 级别 | 位置 | 摘要 |
|---|---|---|
| critical（CI 硬化，非真实泄露） | `.github/workflows/visual-snapshot.yml:64,98` | `AXIOM_AUTH_TOKEN` 写死为占位符；经规则 11 核查是占位符，不是真实凭据 |
| high | `src/router/model-router.ts:433` | `llmCache` 未按 `!tools?.length` 门控，key 不含 tools → 工具调用响应可能污染缓存、破坏工具循环 |
| high | `src/router/model-router.ts:818` | 原生流已产出部分 delta 后失败会回退缓冲并重复产出整段内容；`fallbackUsed` 不准 |
| high | `src/router/model-router.ts:1187` | `preventDuplicateModels` 实际不生效（同步 map 对异步执行） |
| high | `src/core/config-center.ts:261` | 审计日志对敏感键记录原始值，未脱敏 |
| high | `src/core/config-center.ts:607` | `getConfig()` 绕过 ConfigCenter 单一事实源 |
| high | `src/core/config-center.ts:444` | `saveYaml()` 同步写文件，热重载/多进程下有阻塞与竞态 |
| medium | `src/main.ts:790` | `MAX_BODY_SIZE` 只查 `Content-Length`，chunked 可绕过 |
| medium | `src/main.ts:841` | metrics 用原始 `url.pathname` 作 label，高基数可致内存增长 |
| medium | `src/main.ts:850` | 500 错误响应未合并 `baseHeaders`，跨域头缺失 |
| medium | `src/knowledge/pipeline.ts:169` | `JSON.parse` 未剥离 markdown 代码围栏 |
| medium | `src/runtime/host.ts:179` | `error` 状态可能跳过 `initialize` 直接 `start` |
| medium | `src/runtime/host.ts:135` | 重复注册运行中的同 id Agent 会覆盖记录并孤立旧适配器 |
| medium | `src/runtime/host.ts:168` | 生命周期 check-then-await 无串行化，并发可双重初始化/停止 |
| medium | `src/services/chat-preflight.ts:207` | 用户输入原样插入 LLM 提示模板 |
| low | `src/runtime/types.ts:87,108`、`host.ts:59`、`chat-preflight.ts:83,152,163`、`settings-catalog.ts`、`scripts/serpapi-search.ts` 等 | 文档计数、类型别名、死状态、changed 标志、catch 类型等 |

### 2.5 未闭合项（承接 09-28 路线图）

| 项 | 状态 | 阻塞 |
|---|---|---|
| P1-2 systemd 常驻 | 未做 | 安装/启停需 root；`sudo -n` 不可用 |
| P1-3 runtime-go 拓扑 | 未做 | 实际取值属部署拓扑 `${LAN_*}`，规则 11 不入库 |
| P1-4 退役分支归档 | 清单已列，待用户裁 | 2 个分支含未并入提交但已推送远端 |
| git-lfs 二进制 | 缺失 | pre-push hook 拦截普通推送；`.git/lfs` 65M / 100 个 LFS 文件已在本地 |
| 全仓 OCR 覆盖 | 未达 100% | 智谱 provider 限流/工具调用错误；建议换 coding 模型 |
| 全仓硬编码阈值 | 约 95 处 `toBeLessThan(N)`，其中约 20 文件涉墙钟 | 需区分墙钟与计数/尺寸语义，逐批转换 |

---

## 三、目标与不做项

### 目标

1. 先把 **router 工具循环/流式正确性** 与 **ConfigCenter 敏感审计** 两类 high 缺陷修到可回归；
2. 补 **main.ts 请求面** 与 **RuntimeHost 生命周期** 的健壮性；
3. 把 **CI workflow** 与 **输入插值** 的安全硬化落到最小改动；
4. 在授权前提下闭合 **git-lfs / systemd / runtime-go / 分支归档**；
5. 用 coding 模型把 OCR 全仓覆盖率补到 ≥95%（或给出逐文件 skip 原因），并把新发现回灌本计划。

### 不做项

- 不修 OCR 未复现的 low 级风格项；
- 不在本计划内做 P2-1 embedding 提供方接入、P2-2 wiki_links 表、P2-3 EDGE_RISK_MONITOR 复核、P2-4 codeindex 独立库；
- 不重写 ARCHITECTURE.md 全文；
- 不把 OCR provider 密钥、LAN 拓扑、真实凭据写入仓库或文档。

---

## 四、依赖图与批次

```
Batch A（正确性/安全，可并行 3 线程）
  Step 1 ──→ Step 2          （同一文件 model-router.ts，必须串行）
  Step 3                     （main.ts）
  Step 4                     （config-center.ts）

Batch B（健壮性，可并行 3 线程）
  Step 5                     （runtime/host.ts）
  Step 6                     （knowledge/pipeline.ts + services/chat-preflight.ts）
  Step 7                     （.github/workflows/*.yml）

Batch C（运维，需授权/环境，可并行）
  Step 8  git-lfs
  Step 9  systemd
  Step 10 runtime-go 拓扑
  Step 11 分支归档

Batch D（覆盖率与棘轮，依赖 A+B 完成）
  Step 12 全仓 OCR 覆盖 + 测试阈值棘轮
```

**并行原则**：同一文件/模块禁止并行编辑；`model-router.ts` 的 Step 1/2 串行；其余 Step 文件集合互不重叠。每个批次结束跑一次串行全量门禁，批次内部 Step 只跑定向测试 + tsc。

**模型档位**：Step 1–4 用最强模型（缓存、并发、安全语义易错）；Step 5–7 用默认模型；Step 8–11 需人工/ops 介入；Step 12 默认模型 + coding 模型跑 OCR。

---

## 五、步骤明细

### Step 1 — Router 工具调用缓存正确性

| 字段 | 值 |
|---|---|
| 级别 | T2（单文件 + 回归测试） |
| 优先级 | P0-High |
| 模型档 | strongest |
| 依赖 | 无；必须排在 Step 2 之前 |
| 可并行 | 与 Step 3/4 并行 |

**背景与证据**：OCR high `src/router/model-router.ts:433`——`llmCache` 只在 `effectiveTemperature === 0 && attempt === 0` 门控，未检查 `!tools?.length`；`llmCacheKey` 不含 tools 定义。工具调用响应常为 `content: null` 并带 `toolCalls`，一旦写入缓存，后续同消息但期望工具调用的请求会命中该缓存，拿到缺少 `toolCalls/thinking` 的响应，工具循环静默失效。

**任务契约**
- 任务：让确定性 LLM 缓存对“带工具请求”安全失效。
- 验收标准：
  - AC-1：带 `tools` 的请求既不读也不写 `llmCache`；
  - AC-2：不带 tools 的 `temperature=0` 请求缓存命中行为不变；
  - AC-3：新增回归用例证明“先工具调用、后同消息带工具请求”不会命中坏缓存；
  - AC-4：若未来要缓存工具调用，cache key 必须包含 tools 规范化摘要且保留 `toolCalls/thinking`（本轮可只做禁用 + 注释）。
- 改动清单（文件级）：`src/router/model-router.ts`、`tests/llm-cache.test.ts`、`tests/router/chat-stream-tools.test.ts`（按实际断言面择一或新增）。
- 不做项：不改语义缓存（`cacheFirstRoute` 已正确门控）；不改 provider caller。
- 验证命令：`bun test tests/llm-cache.test.ts tests/router/chat-stream-tools.test.ts`；`bunx tsc --noEmit`。
- 风险/回滚：缓存命中率可能略降（预期，正确性优先）；回滚为 revert 本提交。

**退出判据**：AC-1~3 全绿 + tsc 0 + 定向测试 0 fail。

---

### Step 2 — Router 原生流回退/永久失败/去重一致性

| 字段 | 值 |
|---|---|
| 级别 | T2（单文件 + 回归测试） |
| 优先级 | P0-High |
| 模型档 | strongest |
| 依赖 | Step 1（同一文件 `model-router.ts`） |
| 可并行 | 与 Step 3/4 并行 |

**背景与证据**：OCR high `model-router.ts:818`（已产出 delta 后静默回退会重复内容、`fallbackUsed` 错报）、high `:1187`（`preventDuplicateModels` 实际不生效）、medium `:935`（永久失败未同步到 `chatStream`）、low `:495`（持久化用原始 temperature 而非 effectiveTemperature）。

**任务契约**
- 任务：统一 `execute()` 与 `chatStream()` 的失败语义，修复流式重复与去重失效。
- 验收标准：
  - AC-1：原生流在**已产出任意 token** 后失败，抛出/下发 `error` 并终止本轮流，**不得回退缓冲重发整段**；仅当本轮尚未产出任何 token 时才允许回退 buffered；
  - AC-2：`chatStream` 复用 `isPermanentFailure` / `isModelBlacklisted`，永久失败不烧满重试；
  - AC-3：`batchExecute({ preventDuplicateModels: true })` 真正串行排除已用模型，或用例证明替代实现等价；
  - AC-4：`getModelOutputStore().persist` 写入 `effectiveTemperature`；
  - AC-5：`fallbackUsed` 与实际路径一致。
- 改动清单（文件级）：`src/router/model-router.ts`、`tests/model-router.test.ts`、`tests/router/chat-stream-native-breaker.test.ts`、`tests/router/provider-native-stream-tools.test.ts`、`tests/router/executeWithRole-endpoint.test.ts`。
- 不做项：不重构整个 `chatStream`；不改 breaker 算法；不改 provider 协议。
- 验证命令：上述定向测试 + `bunx tsc --noEmit`。
- 风险/回滚：流式中断语义变化可能影响前端；需在 Step 2 内补一条 SSE 契约用例；回滚为 revert。

**退出判据**：AC-1~5 全绿 + 定向测试 0 fail + tsc 0。

---

### Step 3 — main.ts 请求体/指标/错误头加固

| 字段 | 值 |
|---|---|
| 级别 | T2（单文件 + 回归测试） |
| 优先级 | P1-Medium（安全） |
| 模型档 | strongest |
| 依赖 | 无 |
| 可并行 | 与 Step 1/2/4 并行 |

**背景与证据**：OCR medium `src/main.ts:790`（chunked 绕过 `MAX_BODY_SIZE`）、`:841`（metrics 高基数）、`:850`（500 响应缺 `baseHeaders`）。

**任务契约**
- 任务：把请求体限制、指标基数与错误响应头收敛到确定行为。
- 验收标准：
  - AC-1：写方法缺 `Content-Length` 或值非法时返回 **411**；`Content-Length` 合法但大于 `MAX_BODY_SIZE` 时返回 **413**；chunked 大体积请求不得进入路由 handler；
  - AC-2：metrics path label 使用路由模板/归一化路径，UUID/数字段不产生无界 series；
  - AC-3：500 响应合并 `baseHeaders`；新增用例断言 CORS 头存在；
  - AC-4：既有正常请求/错误请求行为不变（回归）。
- 改动清单（文件级）：`src/main.ts`、`tests/unit/runtime-metrics.test.ts`、按需新增 `tests/unit/gateway-body-limit.test.ts`。
- 不做项：不改路由分发；不改 metrics 存储实现；不引入反向代理限流。
- 验证命令：`bun test tests/unit/runtime-metrics.test.ts tests/e2e-runtime.test.ts`；`bunx tsc --noEmit`。
- 风险/回滚：411 语义可能影响依赖 chunked 的客户端；本轮按 AC-1 明确 411/413，若实施中发现既有客户端依赖 chunked，暂停并回 Plan 重新裁决，不擅自放宽。

**退出判据**：AC-1~4 全绿 + tsc 0。

---

### Step 4 — ConfigCenter 敏感审计与单一事实源

| 字段 | 值 |
|---|---|
| 级别 | T2（单文件 + 回归测试；若改 async 落盘则升 T3） |
| 优先级 | P0-High（安全） |
| 模型档 | strongest |
| 依赖 | 无 |
| 可并行 | 与 Step 1/2/3 并行 |

**背景与证据**：OCR high `config-center.ts:261`（审计日志存原始敏感值）、`:607`（`getConfig()` 绕过 ConfigCenter）、`:444`（`saveYaml()` 同步写）；medium `:474`（`resolveEnvVars` 畸形输入）。

**任务契约**
- 任务：让敏感配置审计可脱敏、配置读取单一事实源、落盘不阻塞事件循环。
- 验收标准：
  - AC-1：`set()` 对 `schema.sensitive` 键的 `oldValue/newValue` 只记录脱敏值；新增用例断言审计日志不含明文 secret；
  - AC-2：`getConfig()` 全部经 `ConfigCenter.getString/getNumber`；新增用例证明 YAML/ENV/runtime 三种来源一致；
  - AC-3：`saveYaml()` 改为“临时文件 + rename 原子写”，**保持同步签名**以避免不必要的 API 变更；async 化不在本轮范围；
  - AC-4：`${VAR` 等畸形输入不抛异常，按字面/默认值处理；
  - AC-5：`checkType` 未知类型不返回 `{valid:true}`，改为 fail-closed。
- 改动清单（文件级）：`src/core/config-center.ts`、`tests/env.test.ts`、`tests/utils/env-runtime-vars.test.ts`、按需新增 `tests/unit/config-center-audit.test.ts`。
- 不做项：不重写 ConfigCenter；不改 schema 字段名；不引入新配置依赖。
- 验证命令：上述定向测试 + `bunx tsc --noEmit`。
- 风险/回滚：`getConfig()` 口径变化可能影响主入口；用回归用例锁旧行为；回滚为 revert。

**退出判据**：AC-1~5 全绿 + tsc 0。

---

### Step 5 — RuntimeHost 生命周期串行化与状态机修复

| 字段 | 值 |
|---|---|
| 级别 | T2（单模块 + 回归测试） |
| 优先级 | P1-Medium |
| 模型档 | default |
| 依赖 | 无 |
| 可并行 | 与 Step 6/7 并行 |

**背景与证据**：OCR medium `runtime/host.ts:179`（error 状态可跳过 initialize 直接 start）、`:135`（重复注册运行中 Agent 孤立旧适配器）、`:168`（生命周期无串行化）；low `:59`（scheduler running Set 只写不读）、`types.ts:87`（文档写 6 个方法，实际 4 必需）、`types.ts:108`（destroy 不接 ctx）。

**任务契约**
- 任务：让 Agent 生命周期在并发与错误状态下保持确定。
- 验收标准：
  - AC-1：`state === "error"` 时 `startAgent` **拒绝并返回明确错误**，不得跳过 initialize；
  - AC-2：重复注册 running Agent 时 **拒绝并要求先 `stopAgent`**，不得孤立适配器；
  - AC-3：同一 Agent 的 start/stop 串行化（per-agent in-flight promise 或队列），并发用例证明只 initialize/start/stop 一次；
  - AC-4：文档改为“最少 4 个必需方法 + 2 个可选”；`destroy(ctx?)` 设计在 ops log 记录裁决（改或明确保留原因）；
  - AC-5：默认 scheduler 的 `running` Set 删除或暴露，`complete(id, result)` 签名对齐。
- 改动清单（文件级）：`src/runtime/host.ts`、`src/runtime/types.ts`、`tests/unit/resolved-host-guard.test.ts`、`tests/e2e-runtime.test.ts`、按需新增 `tests/unit/runtime-host-lifecycle.test.ts`。
- 不做项：不改 `RuntimeHostOptions` 注入面；不改具体 Agent 适配器。
- 验证命令：上述定向测试 + `bunx tsc --noEmit`。
- 风险/回滚：拒绝重复注册是行为收紧；如现有调用方依赖覆盖语义，需先列调用点；回滚为 revert。

**退出判据**：AC-1~5 全绿 + tsc 0。

---

### Step 6 — Knowledge / Chat-Preflight 输入健壮性

| 字段 | 值 |
|---|---|
| 级别 | T2（两文件 + 回归测试） |
| 优先级 | P1-Medium |
| 模型档 | default |
| 依赖 | 无 |
| 可并行 | 与 Step 5/7 并行 |

**背景与证据**：OCR medium `knowledge/pipeline.ts:169`（未剥离 LLM 代码围栏）、medium `services/chat-preflight.ts:207`（用户输入原样插值）、low `chat-preflight.ts:163`（changed 恒 true）、low `:152`（intent 标签与 agentName 冲突）、low `:83`（normalizeEdge duck-typing 误判）。

**任务契约**
- 任务：让外部输入与 LLM 输出解析都走显式、可回归的边界。
- 验收标准：
  - AC-1：`structureWithGLM` 解析前剥离 ```json/``` 围栏；新增用例覆盖“围栏 JSON / 纯 JSON / 坏 JSON”三条路径；
  - AC-2：用户输入插入提示模板前做转义/定界，新增用例证明含 `"`、`{}`、指令文本时 JSON 模板不被破坏；
  - AC-3：快路径 `changed` 按实际改写结果计算；
  - AC-4：edge label 与 keyword label 冲突时不得产出“标签 A + agentName B + confidence 取大”的自相矛盾结果；给出确定合并规则；
  - AC-5：`normalizeEdge` 用 `client` 属性判别，不因 fake 有 `enabled` 误判。
- 改动清单（文件级）：`src/knowledge/pipeline.ts`、`src/services/chat-preflight.ts`、`tests/knowledge/pipeline.test.ts`、`tests/unit/knowledge-pipeline.test.ts`、`tests/chat-preflight-parallel.test.ts`、`tests/intent-enhancer.test.ts`。
- 不做项：不改意图分类关键词表；不改 prompt optimizer 主流程；不引新依赖。
- 验证命令：上述定向测试 + `bunx tsc --noEmit`。
- 风险/回滚：escape 规则可能改变边缘模型输出分布；用回归用例锁 fallback 行为；回滚为 revert。

**退出判据**：AC-1~5 全绿 + tsc 0。

---

### Step 7 — CI Workflow 安全与可靠性加固

| 字段 | 值 |
|---|---|
| 级别 | T1（CI 配置 + 静态校验） |
| 优先级 | P2-Medium（安全硬化） |
| 模型档 | default |
| 依赖 | 无 |
| 可并行 | 与 Step 5/6 并行 |

**背景与证据**：OCR critical `visual-snapshot.yml:64,98`（占位 token；经规则 11 核查为占位符，非真实泄露）、high `:30`（缺 permissions）、medium `:48`（Windows 缺 shell）、`:34/:66`（缺 timeout）、low `:12`（缺 concurrency）。仓库 `origin` GitHub 禁止推送，本 Step 只改文件、不触发外部 CI。

**任务契约**
- 任务：把 CI workflow 的凭据来源、权限、shell、超时、并发收敛到最小安全集。
- 验收标准：
  - AC-1：`AXIOM_AUTH_TOKEN` 改为 `${{ secrets.AXIOM_AUTH_TOKEN }}`（或每轮 `openssl rand -hex 16` 生成，二者择一）；文件内不再出现固定 token 字面量；
  - AC-2：workflow 顶层加 `permissions: contents: read`（需要 artifact 的 job 单独按需提升）；
  - AC-3：Windows job 的 bash 语法步骤加 `shell: bash`（或改写为 PowerShell）；
  - AC-4：各 job 加 `timeout-minutes`；`on` 加 `concurrency` + `cancel-in-progress`；
  - AC-5：YAML 可解析（`bun -e`/`yaml` 解析或 `actionlint` 若可用）。
- 改动清单（文件级）：`.github/workflows/visual-snapshot.yml`、`.github/workflows/ci.yml`、`.github/workflows/frontend-audit.yml`、`docs/operations-log.md`。
- 不做项：不推送 origin；不改 CI 业务逻辑；不新增第三方 Action。
- 验证命令：`bun -e 'import YAML from "yaml"; for (const f of [...]) YAML.parse(await Bun.file(f).text())'`；`bun test tests/doc-contract.test.ts`。
- 风险/回滚：secrets 在 fork PR 不可用，若视觉门需要 token 需设 fallback；回滚为 revert。

**退出判据**：AC-1~5 全绿 + doc-contract 35/0。

---

### Step 8 — git-lfs 安装与 LFS 面复验

| 字段 | 值 |
|---|---|
| 级别 | T3（系统运维 + 凭据/数据面） |
| 优先级 | P1-运维 |
| 模型档 | 人工/ops |
| 依赖 | 用户授权 sudo/包管理器 |
| 可并行 | 与 Step 9/10/11 并行 |

**背景与证据**：`git-lfs` 不在 PATH；`.git/hooks/pre-push` 因 LFS 未安装拦截普通推送；`.git/lfs` 65M；100 个 LFS 跟踪 PNG 已是真实像素（非指针）。

**任务契约**
- 任务：恢复 git-lfs 工具链，使普通 `git push`（不带 `--no-verify`）可用。
- 验收标准：
  - AC-1：`git lfs version` 正常；
  - AC-2：`git lfs ls-files | wc -l` = 100，且抽样 PNG `file` 识别为 PNG，不是 LFS 指针；
  - AC-3：一次不含 LFS 变更的普通 `git push internal <分支>` 成功（退出码 0，无 hook 报错）；
  - AC-4：`git lfs env` 指向 internal/gitea 端点，无废弃端点引用。
- 改动清单（文件级）：无仓库文件；`docs/operations-log.md` 记录。
- 不做项：不删 `.git/lfs`；不改 `.gitattributes`；不向 origin 推送 LFS。
- 验证命令：`git lfs version`；`git lfs ls-files | wc -l`；`git lfs env`；`git push internal <分支>`。
- 风险/回滚：安装系统包需 root；不安装则继续用 `--no-verify` 仅限“无 LFS 变更”的提交，并在 ops log 明确记录。

**退出判据**：AC-1~4 全绿。

---

### Step 9 — P1-2 systemd 常驻

| 字段 | 值 |
|---|---|
| 级别 | T3（部署/运维） |
| 优先级 | P1-运维 |
| 模型档 | 人工/ops |
| 依赖 | root/sudo 授权 + 目标部署路径 |
| 可并行 | 与 Step 8/10/11 并行 |

**背景与证据**：`deploy/systemd/axiom.service` 已在库，但该模板与当前 Linux 机不匹配（事实核对 2026-10-02）：
- `Description=OpenClaw AI Agent`、`Documentation=https://github.com/ListenJ/openclaw-fusion`、`SyslogIdentifier=openclaw` 仍为旧品牌；
- `User=%I` 只对 `axiom@.service` 模板单元成立；当前文件名 `axiom.service` 下 `%I` 为空，作为系统服务安装会失败；
- `WorkingDirectory=/opt/openclaw-fusion`、`EnvironmentFile=/opt/openclaw-fusion/.env`、`ExecStart=/usr/local/bin/bun run dist/main.js` 与本机路径（仓库 `/run/media/listen/base/openclaw-fusion`，bun `/home/listen/.bun/bin/bun`）不一致；
- `ProtectSystem=strict` + `ReadWritePaths` 只写了 `/opt/...`，未覆盖实际 `data/`、`axiom-memory/`、`.tmp/`、日志路径。
2026-09-29 ops log 同时记录 `sudo -n` 不可用，故本 Step 仍未执行。

**任务契约**
- 任务：把 Axiom 服务落成 systemd 常驻并开机自启；先修正模板与当前机器的路径/用户/品牌不一致。
- 验收标准：
  - AC-1：单元文件采用 `axiom@.service` 模板（`User=%I`），安装为 `axiom@listen`；`systemd-analyze verify` 通过；
  - AC-2：`WorkingDirectory` / `ExecStart` / `EnvironmentFile` 指向实际部署路径；`ProtectSystem=strict` 的 `ReadWritePaths` 覆盖实际 `data/`、`axiom-memory/`、`.tmp/`、日志路径；
  - AC-3：`systemctl status axiom@listen`（或 `axiom`）= active (running)，`systemctl is-enabled` = enabled；重启机器可自拉起；
  - AC-4：`GET /health` = ok，`GET /api/audit/diagnostics` = 200；
  - AC-5：EnvironmentFile 指向部署实际路径，凭据不落仓库。
- 改动清单（文件级）：`deploy/systemd/axiom.service`（或重命名为 `axiom@.service`）、`deploy/systemd/README`（如新增安装说明）、`docs/operations-log.md`。
- 不做项：不改应用代码；不把真实 env 文件入库。
- 验证命令：`systemctl status axiom`；`systemctl is-enabled axiom`；`curl -fsS http://127.0.0.1:18789/health`。
- 风险/回滚：`systemctl disable --now axiom` 回滚；保留原启动方式。

**退出判据**：AC-1~4 全绿。

---

### Step 10 — P1-3 runtime-go 拓扑与冒烟

| 字段 | 值 |
|---|---|
| 级别 | T3（部署/网络） |
| 优先级 | P1-运维 |
| 模型档 | 人工/ops |
| 依赖 | 用户提供 `${LAN_*}` 实际拓扑（规则 11 不入库） |
| 可并行 | 与 Step 8/9/11 并行 |

**背景与证据**：部署脚本仍为迁移前 `${LAN_*}` 占位语义；真实取值属部署拓扑，不入库。

**任务契约**
- 任务：按新拓扑重配 runtime-go 节点并做连通冒烟。
- 验收标准：
  - AC-1：modelclient 连通冒烟通过（health + 一次真实推理或最小请求）；
  - AC-2：拓扑取值只存在部署侧 env/本地凭据目录，仓库内零明文；
  - AC-3：失败回退路径有日志证据。
- 改动清单（文件级）：部署脚本（按需）、`docs/operations-log.md`。
- 不做项：不把 LAN 地址写入仓库；不改 Go 业务代码。
- 验证命令：部署侧 modelclient 冒烟命令 + `git grep` 确认仓库无 LAN 明文。
- 风险/回滚：保留旧拓扑配置备份，失败可回退。

**退出判据**：AC-1~3 全绿。

---

### Step 11 — P1-4 退役分支归档

| 字段 | 值 |
|---|---|
| 级别 | T3（git 引用操作，规则 4/9） |
| 优先级 | P1-运维 |
| 模型档 | 人工/ops |
| 依赖 | 用户裁定 2 个未并入分支的处置 |
| 可并行 | 与 Step 8/9/10 并行 |

**背景与证据**：13 个本地分支；10 个已完全并入 HEAD；`codex/archive-experiments-2026-08-08`（2 提交）、`codex/retirement-consolidation-2026-09-23`（5 提交）含未并入提交但均已推送远端。

**任务契约**
- 任务：按规则 4 把已并入/已裁决分支收敛到归档分支，减少本地噪声。
- 验收标准：
  - AC-1：10 个 0 未并入提交的分支按清单处置（归档分支 `codex/archive-2026-10-02` 或直接本地删除，二者按规则 4 记录）；
  - AC-2：2 个未并入分支在用户裁定后：要么并入归档分支、要么保留；
  - AC-3：远端分支不动（可追溯）；本地 `git branch` 数量下降；
  - AC-4：归档分支已推送 internal，且 `git ls-remote` 可见。
- 改动清单（文件级）：git refs + `docs/operations-log.md`；如需记录，新增 `docs/reviews/2026-10-02-branch-archival.md`。
- 不做项：不删远端分支；不 force/不改写历史。
- 验证命令：`git branch`；`git ls-remote internal refs/heads/codex/archive-2026-10-02`；`git rev-list --count HEAD..<归档分支>`。
- 风险/回滚：本地删除已推送分支无数据风险；归档分支是追加式，可随时恢复本地分支。

**退出判据**：AC-1~4 全绿 + 用户确认。

---

### Step 12 — 全仓 OCR 覆盖 + 测试阈值棘轮

| 字段 | 值 |
|---|---|
| 级别 | T2/T3（验证 + 测试基础设施） |
| 优先级 | P2 |
| 模型档 | default + coding 模型 |
| 依赖 | Step 1–7 完成（在修复后的树上重扫） |
| 可并行 | 否（验证性收尾） |

**背景与证据**：全仓 OCR 仅 17 文件完成 / 803 失败；约 95 处硬编码 `toBeLessThan(N)`，约 20 文件涉墙钟；P2-5 测试并行化因跨文件单例/桩污染需谨慎。

**任务契约**
- 任务（12a）：用 coding 模型重跑全仓 OCR，产出覆盖率 ≥95% 或逐文件 skip 原因，新增发现回灌本计划。
- 任务（12b）：把已实证红过的墙钟阈值改用 `perfBudget(strict, relaxed)` 双口径；评估按目录分片并行，不改门禁语义。
- 验收标准：
  - AC-1：OCR 覆盖报告含 `total_files / reviewed_files / skipped_files / coverage_rate`，skip 逐条原因；
  - AC-2：新发现按 critical/high/medium/low 分级，critical/high 有可复现证据；
  - AC-3：12b 转换后的测试连续 3 次全量 0 fail；strict 模式 `AXIOM_PERF_ASSERT=1` 仍保留原阈值；
  - AC-4：并行化探索若引入，必须先证明跨文件单例污染已消除，否则不开启。
- 改动清单（文件级）：`docs/reviews/2026-10-02-ocr-full-coverage.md`、`tests/stress/*.test.ts`、`scripts/*`（按需）。
- 不做项：不为“以后可能需要”改测试框架；不一次性大改 95 处阈值；不改门禁语义。
- 验证命令：
  ```bash
  # 12a：provider/模型按 Q3 裁决后执行；key 只从本地凭据目录读取，不回显
  ocr scan --audience agent --repo . --concurrency 4 --timeout 15 \
    --exclude 'eval/semantic-equivalence/annotations/**,**/*.map,**/*.min.js,runtime-go/bin/**,plugins/kb-dsh/backend/server.js,**/*.traineddata' \
    --output /tmp/ocr-full-final.txt --background "Axiom post-remediation full architecture review"
  # 12b：连续 3 次全量 + strict 性能门
  bun test --timeout 15000 ./tests
  AXIOM_PERF_ASSERT=1 bun run test:perf
  ```
- 风险/回滚：OCR 会消耗 token/额度，需用户确认 provider；测试阈值改动用 revert。

**退出判据**：AC-1~4 全绿 + 覆盖率报告落库。

---

## 六、全局施工约束

1. 规则优先级按 `AGENTS.md` 总则 0.1：安全/不可逆 > 数据完整/可追溯 > 正确性/验证 > 范围/最小化 > 风格。
2. 每个 Step 开工前按总则 0.4 冻结任务契约；T2 在回复内冻结，T3 落盘。
3. 规则 2：改已存在文件前备份到 `.tmp/backups/` 并通读全文；验证通过后删除备份。
4. 规则 3：每步只暂存本步文件；`git add <文件>` → `git commit` → `git push internal <分支>`；禁止向 `origin` 推送。
5. 规则 5：每步提交前在 `docs/operations-log.md` 追加一条记录；hash 未知先占位，提交后追加回填提交。
6. 规则 7：代码 Step 先写失败用例（红）→ 最小实现（绿）→ 回归；纯文档/CI/运维 Step 不强制 TDD。
7. 规则 9：禁止 `push --force`、`reset --hard`、`clean -f`、`branch -D`、已发布历史 amend/rebase。
8. 规则 11：真实凭据只放 `~/.axiom/axiom-secrets/`；文档/ops log/commit message 只记名称与处置，不回显明文。
9. 规则 12：每步执行 PCDA；Check 不通过先删多余改动，不扩大范围。
10. LFS：安装 git-lfs 前，只有“本次提交不含 LFS 变更”时才可用 `--no-verify`；必须在 ops log 记录原因。
11. 门禁：每个 Step 跑 `bunx tsc --noEmit` + 定向测试；批次结束跑串行全量；no fail 才算完成。
12. 批次并行：同一文件/模块禁止并行编辑；`model-router.ts` Step 1/2 串行。

---

## 七、验收总表

| Step | 验收证据 | 批次门禁 |
|---|---|---|
| 1 Router cache | 定向测试 0 fail；坏缓存回归用例红→绿 | tsc + 定向 |
| 2 Router stream/dedup | 定向测试 0 fail；SSE 不重复；fallbackUsed 准确 | tsc + 定向 |
| 3 main.ts | 定向测试 0 fail；chunked 大体积被拒；指标基数受控；500 有 CORS | tsc + 定向 |
| 4 ConfigCenter | 定向测试 0 fail；审计无明文；三来源一致；畸形 env 不抛 | tsc + 定向 |
| 5 RuntimeHost | 定向测试 0 fail；并发 start/stop 各一次；error 不启动 | tsc + 定向 |
| 6 Knowledge/Preflight | 定向测试 0 fail；围栏 JSON 可解析；输入转义；intent 自洽 | tsc + 定向 |
| 7 CI workflow | YAML 解析通过；无固定 token；permissions/shell/timeout/concurrency 到位 | doc-contract |
| 8 git-lfs | `git lfs version`；100 文件；普通 push 成功 | 运维证据 |
| 9 systemd | `systemctl status` active；`is-enabled`；/health ok | 运维证据 |
| 10 runtime-go | modelclient 冒烟通过；仓库无 LAN 明文 | 运维证据 |
| 11 分支归档 | 归档分支可追溯；本地分支收敛；远端不动 | git 证据 + 用户确认 |
| 12 OCR/棘轮 | 覆盖率 ≥95% 或逐条 skip；连续 3 次全量 0 fail | 全量门禁 |

**批次边界全量门禁命令**：

```bash
bunx tsc --noEmit
bun test tests/doc-contract.test.ts
bun test tests/unit/docs-consistency.test.ts
bun test tests/architecture-integrity.test.ts
bun run audit:runtime
bun test --timeout 15000 ./tests
bun run scripts/count-tools.mjs
bun run arch:stats
```

---

## 八、对抗性评审记录

> blueprint 要求计划在定稿前经过最强模型对抗性评审。本计划尝试委派只读子代理评审，但子代理在 3 分钟时限内未返回；已在上下文内执行同等自检，并将发现直接并入本计划。以下为自检结论（按 blueprint 检查表）：

| 检查项 | 发现 | 处置 |
|---|---|---|
| 完整性：OCR critical/high/medium 是否全部映射 | 全部映射；low 项明确排除 | §2.4 索引 + 各 Step |
| 依赖正确性 | Step 1/2 同文件必须串行；其余 Step 文件集合不重叠 | §四依赖图 + Step 1/2 |
| 同文件并行冲突 | Step 1/2 已在计划中显式串行；Step 3/4/5/6/7 文件互斥 | 已修正 |
| 过度施工 | Step 4 async 化、Step 7 新增 Action、Step 12 一次性改 95 处阈值均属过度 | 已改为原子同步、不新增 Action、按证据逐批转换 |
| 不可验证 AC | Step 2/3/4/5 原有多处“二者择一” | 已改为单一确定行为（见各 Step） |
| 阻塞条件 | Step 8 需安装 git-lfs（用户态二进制或 sudo）；Step 9 需 sudo；Step 10 需 LAN 值；Step 11 需用户裁定；Step 12 需 OCR 额度 | §十 Q1–Q4 + 各 Step |
| AGENTS.md 合规 | 分支/提交/ops log/备份/TDD/禁止 force 均已写入 | §六 |
| **修正发现（自检新增）** | `deploy/systemd/axiom.service` 品牌/`User=%I`/路径/ReadWritePaths 全部过期，原 Step 9 的“模板已在库”不足以保证可安装 | 已重写 Step 9 背景与 AC |
| **修正发现（自检新增）** | 原 §九 Q1–Q3 属可自行裁决的实现细节，不应作为用户阻塞 | 已移入各 Step 并保留 Q1–Q4 为真实用户决策 |

**评审结论**：计划在补齐上述修正后达到“可冷启动执行”标准；Step 8–11 的 blocked 条件必须在开工前由用户解除，否则不得标记完成。

## 九、计划变更与回滚协议

- **计划冻结**：本文件提交后即冻结 Step 清单与依赖图；新增 Step、改依赖、扩改动面必须更新本文件并在 ops log 记录原因。
- **Step 拆分**：同一 Step 发现跨模块/跨风险面时，拆成子 Step（`Step N.a` / `N.b`），不把无关改动混入同一提交。
- **Step 跳过**：因环境阻塞（root/LAN/额度）无法执行时，标记 `blocked` 并记录阻塞条件，不降级为“已完成”。
- **回滚**：代码 Step 用追加式 `git revert <commit>`；运维 Step 用停用/恢复命令；数据面先备份 + SHA256 对账。
- **完成定义**：只有“实际 diff 与冻结清单一致 + 验证命令真实输出 + ops log 条目 + commit hash + 推送目标 + 未决项”六项齐全才算完成。

---

## 十、需用户裁定的问题

**用户已裁决（2026-10-02）**：

| # | 问题 | 裁决 | 对计划的影响 |
|---|---|---|---|
| Q1 | 2 个含未并入提交的本地分支：归档还是保留？ | **接受推荐**：并入 `codex/archive-2026-10-02` 后删本地，远端保留 | Step 11 解除阻塞，可按规则 4 执行 |
| Q2 | git-lfs / systemd 需 sudo，是否授权安装？ | **接受推荐**：授权在安全窗口安装 git-lfs 与 systemd 单元 | Step 8/9 解除授权阻塞，仍需实际执行窗口 |
| Q3 | 全仓 OCR 用哪个 coding 模型？ | **接受推荐**：使用已验证可用的 SenseNova `deepseek-v4-flash`（智谱 `glm-4.7-flash` 在扫描中工具调用不稳定，改用 SenseNova） | Step 12a 解除 provider 阻塞 |
| Q4 | runtime-go `${LAN_*}` 实际拓扑值由谁提供？ | **待提供**：用户提供部署侧值，不入库 | Step 10 保持 blocked，未提供前不执行 |

**计划内已裁决（不再询问）**：工具请求不缓存（Step 1）、`saveYaml` 原子同步（Step 4）、RuntimeHost 拒绝 error 启动/重复注册（Step 5）、原生流失败按 AC-1 终止（Step 2）、body 限制用 411/413（Step 3）。

---

## 附录 A：OCR 发现索引（可复现）

| 来源 | 路径 | 内容 |
|---|---|---|
| 核心扫描 | `/tmp/ocr-core-scan.txt` | 7 条（config-center / settings-catalog） |
| RuntimeHost 扫描 | `/tmp/ocr-test2-sensenova.txt` | 6 条（host/types） |
| 关键路径扫描 | `/tmp/ocr-critical-sensenova.txt` | 20 条（main / pipeline / router / chat-preflight） |
| 全仓广扫（部分） | OCR session `8909d4ec-4173-4994-881e-74276f3a91a4` | 17 文件 / 50 条后中止 |
| OCR CLI | `~/.local/share/ocr/node_modules/.bin/ocr` v1.12.11 | provider：SenseNova `deepseek-v4-flash`；智谱 `glm-4.7-flash` 连接可用但工具调用不稳定 |

## 附录 B：基线复现命令

```bash
cd /run/media/listen/base/openclaw-fusion
git rev-parse HEAD internal/main gitea/main
git status --porcelain=v1
bunx tsc --noEmit
bun test tests/doc-contract.test.ts
bun test tests/unit/docs-consistency.test.ts
bun test tests/architecture-integrity.test.ts
bun run audit:runtime
bun test --timeout 15000 ./tests
bun run scripts/count-tools.mjs
bun run arch:stats
```

---

> 执行本计划时，先读 `AGENTS.md` 总则 0.1–0.3，再按 Step 冻结任务契约。
> 本文件是路线图，不是免检通行证；每个 Step 的改动范围以该 Step 的冻结清单为准。
