# 全仓深度代码审核报告

> 时间：2026-10-14 ｜ 范围：`src/` 全部 455 个非测试 `.ts` 文件 / 121,734 行、`scripts/` 门禁脚本、`tests/` 完整性抽样
> 方法：静态模式普查（真实 grep/AST 级扫描）+ 逐条读证 + 可复现探针；**不采信未经验证的推断**
> 基线：`bun run test:full` → 4,673 用例 / 4,606 pass / 67 skip / **0 fail** / 125.8s

---

## 0. 方法与诚实声明

本次审核先用 workflow 扇出 5 个维度子代理（正确性/安全/错误处理/契约漂移/并发），**5 个全部返回 null（超时）**。该结果不能解读为"代码干净"——机制失败 ≠ 无缺陷。故改为直接实证审计：每条发现必须有可复现证据或实际代码引用；无法验证的一律不报。

审核过程中修正过一次自身误判（见 §3 发现 4 的严重度降级说明），保留该记录以标明口径。

---

## 1. 发现汇总

| # | 严重度 | 位置 | 问题 | 证据强度 |
| --- | --- | --- | --- | --- |
| 1 | **high** | `src/computer-use/frontend-audit.ts:136` + `scripts/frontend-audit.ts:61` | 前端审计门**假绿**：全部页面截图失败仍 exit 0 通过 | 现场复现 |
| 2 | **high** | `src/mcp/tool-registry.ts:56` + `src/utils/security-defaults.ts` | 安全开关登记表不完备 → 声明的 fail-closed 口径对 4 个开关失效 | 运行时代码实测 |
| 3 | **medium** | `docs/ARCHITECTURE.md:17` + `tests/unit/docs-consistency.test.ts:114` | §1 基线测试文件数漂移 11，且棘轮门只覆盖该行 3 项统计中的 1 项 | 生成器 vs 文档对拍 |
| 4 | **low-medium（潜在）** | `src/dre/runtime/meta-cognitive-loop.ts:180,265`；`src/utils/read-optimizer.ts:98` | 容器无淘汰上限；当前输入基数有界故**未实际泄漏** | 探针复现 + 基数溯源 |

---

## 2. 发现详情

### 发现 1（high）— 前端审计门假绿：捕获全失败仍判通过

**证据链**

- `src/computer-use/frontend-audit.ts:136`：页面捕获失败时 `if (r.error) { totals.issues++; continue; }` —— 只累加 `issues`，**不进入任何严重度计数**。
- `scripts/frontend-audit.ts:61-63`：`computeBlockingSeverity(report.totals, blockOn)` 只读 `critical/major/minor` → `process.exit(blocking > 0 ? 1 : 0)`。
- 现场复现（`bun run audit:frontend`，playwright 不可用）：

```
[FrontendAudit] failed /chat {...}   （9 个页面全部 failed）
| 页面数 | 通过 | 有问题 | Critical | Major | Minor | Info |
|   9   |  0  |   9   |    0     |   0   |   0   |  0   |
[FrontendAudit] block-on=critical blocking=0     ← exit 0，判为通过
```

**后果**：基础设施故障（playwright 缺失、网关未起、全站白屏）与"9 页全部干净"在门禁层面**不可区分**。报告显示"有问题 9"却全零严重度，属自相矛盾的输出。

**修复建议**：`totals` 增加 `errored` 计数，并把"捕获覆盖率为 0"纳入阻断条件：

```ts
// src/computer-use/frontend-audit.ts
const totals = { ..., errored: 0 };
if (r.error) { totals.errored++; total.issues++; continue; }
// scripts/frontend-audit.ts
const captured = report.totals.pages - report.totals.errored;
if (captured === 0) { console.error("0 页成功捕获——门禁不可判绿"); process.exit(2); }
```

---

### 发现 2（high）— 安全开关登记表不完备，声明的 fail-closed 口径未覆盖 4 个开关

**声明的口径**（`config/security-defaults.json` `_readme`）：

> 「豁免/审批类开关**未配置时一律按安全侧解释**，配置错误不得成为提权入口。」

**登记表实际只覆盖 2 个开关**：`AXIOM_ALLOW_LOCAL_BYPASS`、`AXIOM_PTY_APPROVAL_MODE`。

**门禁无完备性检查**：`tests/capability-invariants.test.ts:524` 的 S-6 断言只做「`SECURITY_DEFAULTS` 中每个已登记项 == JSON 登记」——**未登记的开关对门禁完全不可见**。

**未登记且 fail-open 的 4 个安全开关**（`.env.example` 自陈）：

| 开关 | `.env.example` 原文 | 登记 |
| --- | --- | --- |
| `AXIOM_ENFORCE_MODE_APPROVAL` | 「默认 0 保持现行为」 | ❌ |
| `AXIOM_SECOND_FACTOR_TOKEN` | 「未配置时相关写路由 fail-open 放行」 | ❌ |
| `EDGE_RISK_FAIL_CLOSED` | 「默认 0 保持 fail-open 不阻断」 | ❌ |
| `AXIOM_ALLOW_REMOTE_CDP` | 「默认 0 拒绝非回环」（此项默认安全侧，但未登记） | ❌ |

**审批门实测**（运行时代码，非推断）：

```
mode = agent
needsApproval("terminal_exec") = true      ← 模式系统声明"需审批"
canExecute("terminal_exec").allowed = true
env AXIOM_ENFORCE_MODE_APPROVAL = undefined
```

`src/mcp/tool-registry.ts:56-65`：

```ts
if (executionMode.getMode() !== "yolo" &&
    readString("AXIOM_ENFORCE_MODE_APPROVAL") === "1" &&   // ← 未设即短路
    executionMode.needsApproval(toolName)) { ... }
```

**后果**：默认 `agent` 模式下，`terminal_exec` 等 caution/destructive 工具**不会触发审批**。`MODE_CONFIGS.agent.requireApproval = true`（`src/agents/execution-mode.ts:64`）因而是一枚**误导性死标志**——读该配置会得出"审批已开"的相反结论。同一 fail-open 类口径与 `AXIOM_ALLOW_LOCAL_BYPASS`（已按安全侧修过）不一致，属回归性缺口。

**修复建议**：
1. 把 4 个开关全部登记进 `SECURITY_DEFAULTS` + `config/security-defaults.json`；
2. S-6 增加**完备性断言**：扫描 `.env.example` 中带 fail-open/审批语义的开关，未登记即红；
3. `AXIOM_ENFORCE_MODE_APPROVAL` 未配置时按安全侧解释（enforce），或删除 `MODE_CONFIGS.*.requireApproval` 以免双事实源。

---

### 发现 3（medium）— §1 基线漂移，且棘轮门只覆盖该行的 1/3 统计

**对拍结果**

| 统计项 | 生成器实测（`archStats()`） | `ARCHITECTURE.md:17` 声明 | 门禁覆盖 |
| --- | --- | --- | --- |
| 测试文件数 | **499** | **488** | ❌ 未断言 |
| 用例 / pass | 4,673 / 4,606（本次实跑） | 4,725 / 4,658 | ❌ 未断言 |
| src 模块/文件/行 | 41 / 455 / 121,734 | 41 / 455 / 121,734 | ✅ 已断言 |

`tests/unit/docs-consistency.test.ts:114-120` 只匹配 `\*\*(\d+) 模块 \/ (\d+) 文件 \/ ([\d,]+) 行\*\*`，故同一行内的测试文件数与用例数**从未被校验**。测试文件数已漂移 11。

文档自身在 `:158` 声明「用例数一律以实跑输出为准，**不在本文手抄**」，但 `:17` 恰恰手抄了——政策与内容自相矛盾。

**修复建议**：把断言扩到 `testFiles`（生成器已提供该字段，零成本）；`:17` 的用例数改为指向实跑输出的引用，不手抄。

---

### 发现 4（low-medium，潜在）— 容器无淘汰上限

**探针复现**（合成高基数输入）：

```
发布 500 条互异事件：
  bridgeA.seenLessons = 500
  bridgeD.trackedPatterns = 500
```

`src/dre/runtime/meta-cognitive-loop.ts:180`（`seenLessons` Set）、`:265`（`patterns` Map）、`src/utils/read-optimizer.ts:98`（`rateLimiters` Map，key = `${agentId}:${resource}`）均**只增不删**。

**严重度诚实降级说明**：初审时据探针判为"真实泄漏"。追查基数来源后修正——`lessons`/`issues` 仅由 `src/dre/consciousness/stream.ts:268-326` 的 3 个硬编码触发器产出（无 LLM 自由文本路径），实际唯一值约 5 条 lesson / 4 类 issue 形态，**当前基数有界，未构成实际泄漏**。探针用合成互异文本，夸大了现实风险。

**残留风险**：容器设计无上限，一旦 lesson 转为 LLM 生成自由文本、或 `agentId`/`resource` 基数增长，即转为真实泄漏。

**修复建议**：三处加 LRU/FIFO 上限（如 `seenLessons` 保留最近 1,000 条、`patterns` 1,000 条），或加周期清理。

---

## 3. 已验证干净的维度（含证据，非"未检查"）

| 维度 | 结论 | 证据 |
| --- | --- | --- |
| `eval` / `new Function` | 0 处 | 全仓 grep 无命中 |
| 命令注入 | 无未受控面 | `shell:true` 仅 3 处：`mcp/tools/terminal.ts` 常量命令、`routes/marketplace.ts` 命令来自服务端 `config/marketplace.yaml` 白名单（请求只传 `id`） |
| SSRF 防护 | 实现扎实 | `utils/url-safety.ts` 覆盖协议白名单、回环、RFC1918、`169.254`、IPv6 ULA/link-local、IPv4-mapped、整数/八/十六进制 IP 变体，并有 DNS 解析后二次校验 |
| 路由鉴权 | 双层且无缺口 | 中央门 `main.ts:674` 覆盖全部请求；`requireAuthToken` 为敏感路由的纵深防御 |
| 回环免鉴权 | fail-closed 正确 | `security-defaults.ts` 未配置即关；非回环绑定 + 开启时输出暴露告警并留痕 |
| 空 catch | 122 处，均可接受 | 逐个抽查：安全关键的两处（`auth-check.ts:73`、`url-safety.ts:76`）均为 fail-safe（解析失败 = 更严格） |
| 定时器泄漏 | 无 | 全部 `.unref()` 或幂等守卫（如 `rate-limiter.ts:310` `if (timer) return`） |
| 无界增长（模块级/实例级） | 0 | 模块级容器只写不清仅 1 处（`stmtCache`，键为 SQL 常量，有界） |
| 测试完整性 | 无语义问题 | 67 skip 全部为平台/环境条件跳过，无"恒跳过"伪装 |
| 确定性 | 有强制门 | `DETERMINISM_HASH` 由 `tests/rigorous/determinism-repro.test.ts` 跨进程比对强制 |
| LLM 返回值转型 | 有兜底 | `dre/pipeline/pipeline.ts:251` 虽 `as unknown as`，但下游 `|| "reject"` / `|| 0` / `|| []` fail-safe |
| 全量测试 | 0 fail | 4,673 用例 / 4,606 pass / 67 skip / 125.8s |

---

## 4. 建议处置顺序

1. **发现 1**（假绿门禁）：改造成本极低、直接决定后续所有前端回归的可信度——**优先**。
2. **发现 2**（审批 fail-open）：安全面实质缺口，且修法已在同仓 `AXIOM_ALLOW_LOCAL_BYPASS` 上有先例可循。
3. **发现 3**（文档漂移）：一条断言即可闭合，防止 §1 继续失真。
4. **发现 4**（容器上限）：当前不泄漏，可择机加固；若引入 LLM 生成 lesson 则必须先做。

---

## 5. 复核方式

```bash
bun run test:full                    # 4,673 用例，0 fail
bun run audit:frontend               # 观察截图失败时的退出码（发现 1）
bun -e 'const{executionMode}=require("./src/agents/execution-mode.js");console.log(executionMode.needsApproval("terminal_exec"))'  # true（发现 2）
bun -e 'const{archStats}=require("./src/testing/arch-stats.js");console.log(archStats().testFiles)'  # 499 vs 文档 488（发现 3）
```
