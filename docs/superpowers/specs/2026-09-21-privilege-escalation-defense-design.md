# 提权阻断模型：能力驱动的强制点与链路封堵（S3）

> 日期：2026-09-21 ｜ 状态：待评审
> 目标：在架构层面阻止提权（privilege escalation），并使"提权链路"无法被**新增**出来
> 前置：依赖 `2026-09-21-determinism-caliber-and-doc-contract-design.md` 的机器门形态（本设计的安全不变式同样进门）

---

## 0. 已核实的四条根因（事实）

### G1 守卫与工具是两套独立维护的名字表 ⇒ 新增/改名即静默脱管

| 证据 | 逐字 / 实测 |
|---|---|
| `src/agents/risk-monitor.ts:44-49` | `SCREENED_TOOLS` 键只有 `terminal_exec` / `fs_delete` / `fs_write` / `fs_move` |
| `src/agents/risk-monitor.ts:58-59` | `const spec = SCREENED_TOOLS[toolName]; if (!spec …) return null;` |
| `src/agents/risk-monitor.ts:83-84` | `if (!extracted) return "pass";` —— 未登记名字 ⇒ **直接放行** |
| `src/mcp/server.ts:76` | `for (const td of adaptTools([readTool, writeTool, queryTool])) registry.add(td);` |
| `src/tools/write-tool.ts:26` / `read-tool.ts:29` | 实际注册名是 `"write"` / `"read"` / `"query"` |
| `src/mcp/register-external-tools.ts:144,182,191,203` | 另一套 surface 才叫 `fs_write` / `fs_delete` / `fs_move` / `terminal_exec` |
| `grep -c isPathSafe src/tools/*.ts` | **0** —— 走 `adaptTool` 的三个工具无任何路径校验 |

→ 事实结论：`defaultToolGuard`（`src/mcp/tool-registry.ts:25-38,64-76`）对每个注册工具都会调用 `monitorToolPayload(tool.name, args)`，但对 `write` 恒返回 `"pass"`。**风险复核对真正暴露的写文件工具是空转的**，而 `src/tools/write-tool.ts:46-55` 直接 `fs.mkdir(dir,{recursive:true})` + `fs.writeFile(path, content)`。

同类名字表还另有三份，互相之间同样靠人工同步：`src/agents/execution-mode.ts:196-268`（分级 + `blockedTools` 白名单）、`src/mcp/scene-router.ts:209,226`（场景 → 工具名）、`src/routes/route-auth.ts:19-31`（`AuditableEvent` 名集合）。

### G2 路径校验只在入口做一次，且判定在**未规范化的字符串**上

| 证据 | 说明 |
|---|---|
| `src/mcp/tools/filesystem.ts:43-70` | `isPathSafe` = cwd 越界拒绝 + `DENIED_SEGMENTS` 正则黑名单（`.env`、`.git`、`data/*.db`、`data/model-config.json`），且是**文件私有函数**（8 个调用点全在本文件内） |
| `src/mcp/tools/filesystem.ts:222` | 列举类工具只对 root 调 `isPathSafe` |
| `src/mcp/tools/filesystem.ts:290-297` | 递归 `readFile` 逐行回显 `lines[i].trim().substring(0,200)`，子项不过检 ⇒ `.env` 内容可经递归遍历外泄（条件性：本仓 `git ls-files \| grep -c '^\.env$'` = 0，故为部署态风险） |
| `src/utils/permissions.ts:55-73` | `checkFilePermission` 用 `path.includes(p)` 对**原始字符串**判定；未 realpath、未解析符号链接、未处理 `..` |
| `grep -rn checkFilePermission src` | 调用方只有 `permission-middleware.ts:33`（仅 delete）、`routes/health.ts:249`（**只返回判定结果，不阻断**）、`routes/sandbox.ts:29`（仅命令）⇒ 无任何实际写路径经过它 |

→ 事实结论：存在**两个互不复用的路径守卫**（`isPathSafe` 局部、`checkFilePermission` 全局），且**没有一个在真正执行 I/O 的那一刻被调用**。

### G3 鉴权与缓存的顺序颠倒 ⇒ 缓存成为鉴权之外的第二条读取通道

| 证据 | 说明 |
|---|---|
| `src/core/http-router.ts:220-233` | `cacheKey = \`${method}:${pathname}:${url.search}\``；GET 先查缓存 `return cached` |
| `src/core/http-router.ts:236` | `this.match()`（路由处理，含路由内 `requireAuthToken`）在缓存命中之后才执行 |
| `src/core/http-router.ts:264-268` | `record.meta?.cacheable !== false && status < 400` ⇒ 默认缓存；`grep cacheable src tests` 只命中 `:25`/`:265` ⇒ **没有任何一条 GET 路由声明不缓存** |
| `src/utils/cache.ts:189-207` | L1 存对象引用，无 clone ⇒ 命中即返回同一响应体 |
| `src/routes/api-keys.ts:51-52` | 全路由 `requireAuthToken`（第二因子存在），`:86-87` 返回 `listProviderStatus()` |

→ 结论（判断 + 未实测）：对受第二因子保护的路由，**先缓存后鉴权**意味着一次由持有 token 者触发的成功响应，可被**无 token 的同 key 请求**取回。缓存键不含身份维度。⚠ 诚实标注：本机无 `node_modules`/`bun test` 未能起服务实测二次返回体，`bodyUsed` 行为待实现阶段实测。

### G4 本地回环默认免鉴权，且豁免开关默认开

| 证据 | 说明 |
|---|---|
| `src/main.ts:531-535` | `const ALLOW_LOCAL_BYPASS = readBool("AXIOM_ALLOW_LOCAL_BYPASS", true);` + "Local (loopback) requests skip auth for E2E tests and local development." |
| `src/utils/auth-check.ts:5-9,:16-18` | 对端地址取自 `server.requestIP`（不可用 Host 头伪造），未配 token 时远程 fail-closed —— 该文件实现是**正确的** |
| `src/main.ts:400-404` | CORS 默认仅 `http://localhost:PORT` / `http://127.0.0.1:PORT`（非 `*`） |

→ 判断（不外推）：`main.ts` 的全局 `checkApiKey` 对回环放行，但敏感路由另有 `routes/route-auth.ts:37-50 requireAuthToken` 作为第二因子，浏览器驱动不了该 header。风险面因此收敛为**未挂第二因子的回环可达路由**（审计已见 `/models`、`/sandbox/status`、`/plugins*` 等）与 SSRF 读通道（`src/tools/read-tool.ts:69-71` `fetch(path)` 无协议/宿主白名单，`source:"web"`）。**本设计不声称存在"任意网页直接拿 shell"**。

---

## 1. 设计原则：从"枚举名字"改为"能力 + 每跳强制"

黑名单之所以反复失效（G1–G4 是四个实例，再加一条黑名单会长出第五个），是因为三条不变式从未成立：

- **I1 无声明不可注册**：工具必须声明它需要的**能力**（capability），守卫由能力推导，与名字无关。未声明 ⇒ `registry.add()` 抛错、启动失败。
- **I2 强制点贴近特权操作本身**：路径/命令判定发生在**实际执行 I/O 的那一行**，而不是入口或调用方。入口校验不计分。
- **I3 安全决策不可被缓存/复用/绕过身份**：鉴权先于任何返回缓存内容的分支；缓存键含主体身份；跨主体命中在类型上不可能。

再加一条**防链路产生**的元规则：

- **I4 组合放大必须可见**：单次授权不等于链式授权。`读敏感 → 写可执行 → 下次执行` 这类跨调用序列由 `src/agents/risk-monitor.ts` 的 `reviewSequence(call, {onEscalate})` 裁决：按 principal 分桶、滑动窗口内高影响能力（`HIGH_IMPACT`）计数达 `SEQUENCE_BURST_LIMIT`、或命中 `CHAIN_PAIRS` 中登记的"前一步 → 这一步"配对，即返回 `require-approval`，且**回环不豁免**（审批通道内不得出现回环地址判定，S-7 锁死）。

## 2. 组件与接缝（复用既有件，不新建平行体系）

| 单元 | 位置 | 接口（小） | 承担 |
|---|---|---|---|
| `Capability` | `src/utils/permissions.ts`（扩） | `"internal" \| "fs.read" \| "fs.write" \| "fs.delete" \| "fs.glob" \| "net.outbound" \| "proc.exec" \| "cfg.write" \| "db.write" \| "mcp.external"` | 能力词表，唯一权威。刻意**不含**"读取凭据"档：`~/.axiom/axiom-secrets/` 与 `.env` 是执行锚点，无可授权路径，无声明即不可得（I1），故无需为它留档位 |
| `decideCapability(check)` | 同上（新，纯函数） | `({capability, target, principal?}) → {allow, reason?}` | 唯一授权决策点；I1/I2 的判定内核。只做字符串/规则判定，realpath 与逐跳符号链接解析由 `safeFs` 在 I/O 点完成后传入已规范化目标 |
| `safeFs` | `src/utils/safe-fs.ts`（新，薄） | `readFile/writeFile/readDir/move/remove` 五法 + `authorizePath` 复用 | 每次调用内部 realpath + `decideCapability`，I2 的执行点；越界与锚点抛 `CapabilityDeniedError` |
| `ToolDef.capability` | `src/mcp/tool-registry.ts` | `readonly Capability[]`，必填 | `add()` 未声明即抛（S3 / I1）；守卫按能力而非名字 |
| 身份化缓存键 | `src/core/http-router.ts` | `cacheKey` 增 `principal` 段 | I3 |
| 能力覆盖门 | `tests/capability-invariants.test.ts` | 与 D 系列同族 | 见 §4 |

判断（规则 8）：`safeFs` 与 `decideCapability` 各有 ≥2 个真实调用方（MCP 工具面 + HTTP 路由面；`src/tools/*` 与 `src/mcp/tools/filesystem.ts` 两套实现），不是投机抽象。`checkFilePermission` 保留为 `decideCapability` 的兼容外壳，不并行维护第二套判定。

## 3. 提权链路封堵矩阵

| # | 链路 | 现防线为何失效 | 新防线（可判定） |
|---|---|---|---|
| L1 | 工具写文件 → `~/.bashrc` / `.git/hooks/pre-commit` / `crontab` / `systemd --user` unit → 下次 shell/服务启动即提权 | `write` 工具无 `isPathSafe`（G1+G2）；`SCREENED_TOOLS` 不认这个名字 | `write-tool` 声明 `fs.write` 且只经 `safeFs.writeFile` 落盘（沙箱根固定为 `process.cwd()`，调用方的 `roots` 只能收窄不能放宽）；realpath + 逐跳判定；**执行锚点清单**（shell rc / hooks / cron / systemd / sudoers / `authorized_keys` / `.env` / `data/model-config.json`）进入 `DENIED_SEGMENTS` 单一来源，L1 用例逐条断言被拒 |
| L2 | 递归列举 → 子项越过 `isPathSafe` → `.env` 凭据回显 → 经 `net.outbound` 外发 | 只对 root 过检（G2） | `safeFs.readDir` 逐项判定；`net.outbound` 默认拒绝非白名单宿主，且**外发与读取需同一 principal 的两个能力**，序列由 I4 复核 |
| L3 | `read` 工具 `source:"web"` `fetch(path)` → SSRF 打 `127.0.0.1:PORT`（免鉴权面）/ 内网元数据 | 无协议/宿主白名单 | `net.outbound` 判定含 `file:` / `127.*` / `169.254.*` / RFC1918 拒绝，默认仅 https + 显式 allowlist；测试用本地假服务证明被拦 |
| L4 | 改名/包装绕守卫：`write` → `my_write`，或 `fs_write` 再包一层 | 守卫按 `tool.name` 查表（G1） | `registry.add()` 强制 `capability` 字段；类型层不可省略；D 门断言"注册表内每个工具有 capability 且 `SCREENED_TOOLS` 已删除" |
| L5 | MCP 子进程工具名 `mcp_${server}_${tool}`（`src/mcp/client-connector.ts:141-148`）绕过父侧守卫 | 名字变了，能力没变 | 包装时继承/显式声明 capability；守卫读 capability |
| L6 | 回环免鉴权扩大面（本机任何进程 = 全 API） | `ALLOW_LOCAL_BYPASS` 默认 true（G4）；实施中另发现 `src/mcp/server.ts` 有**第二处**无条件把 `isLocalAddress()` 当免鉴权用 | 默认改为 false；E2E 显式注入 `=1`；启动时若 `=1` 且绑定非回环 ⇒ `logger.warn` + `security.alert` 审计（不静默）；并列入口由 S-6 的静态扫描锁定为"同一开关的唯一来源" |
| L7 | 缓存旁路鉴权 | 先查缓存后匹配（G3） | 鉴权前置于缓存查；`cacheable` 默认 `false`，路由须显式声明可缓存；缓存键含 principal；用例：A 取 `/api-keys` → B（无 token）请求同 key 必须 401 且拿不到 body |
| L8 | 审批/豁免开关"忘记设置即关闭"（含无订阅者/无 token 时的降级） | `tool-registry.ts:25-38` 有 WS 时 fail-closed（✅ 已正确）；`command-gate.ts:66-75` **空值 → `"off"`** | PTY 审批模式默认改为 `risky`（非 `off`），未知值按 `strict`；默认值登记在 `config/security-defaults.json`（声明侧）+ `src/utils/security-defaults.ts`（运行侧），由 **S-6** 锁定一致；无审批 handler ⇒ 超时自动拒绝 |
| L9 | 高危工具池被前端 `poolFilter` 改名绕开（审计 tool-pool Medium） | 名字白名单在前端可选 | capability 判定在服务器侧 `decideCapability`，`poolFilter` 只影响可见性不影响授权 |
| L10 | 模型自行把执行模式切到 `yolo` ⇒ 关掉 HITL（实施期新增：切模式工具本身就是提权跳板） | `set_mode` 无门禁，切换后审批通道整体失效 | `src/mcp/server/mode-tools.ts`：目标为 `yolo`（含回退目标）时必须经审批，未获批准保持当前模式 |

> 编号说明：本表的 L6/L8 在实施期对调为"L6=回环扩大面、L8=审批/豁免开关默认值"，与代码注释、`tests/capability-invariants.test.ts` 及 `docs/SECURITY-MEASURES.md` 的引用保持一致；L10 为实施中发现的第十条链路。

## 4. 安全不变式进门（与 S2 的 D 系列同族，进 `test:full`）

| 规则 | 命题 |
|---|---|
| **S-1** | `src/mcp/tool-registry.ts` 中不存在以 `tool.name` 为键的守卫表；`SCREENED_TOOLS` 命中数 = 0 |
| **S-2** | 所有 `registry.add({...})` 调用点的对象字面量含 `capability`（静态解析 `src/**/*.ts`） |
| **S-3** | `src/tools/*.ts` 与 `src/mcp/tools/*.ts` 中裸 `fs.writeFile/readFile/readdir` 命中数 = 0（必须经 `safeFs`） |
| **S-4** | `http-router.ts` 中 `cache.get` 在 `this.match()` 之前不存在；`cacheable` 默认值为 `false` |
| **S-5** | `DENIED_SEGMENTS` / 执行锚点清单为单一来源（全仓命中 1 个定义点），且含 `crontab`、`systemd`、`.bashrc`、`hooks/`、`authorized_keys`、`sudoers` |
| **S-6** | 审批/豁免类开关的默认值全部安全侧（`AXIOM_ALLOW_LOCAL_BYPASS` = false、`AXIOM_PTY_APPROVAL_MODE` ≠ off），登记在 `config/security-defaults.json` 并与 `src/utils/security-defaults.ts` 逐项一致；全仓使用 `isLocalAddress()` 的服务端入口必须同时引用 `localBypassEnabled()`（否则即第二处无条件豁免） |
| **S-7** | 同一 principal 的连续特权调用被 `reviewSequence` 升级为审批（I4：单次都合规不等于链式合规），且回环地址不构成豁免维度 |

## 5. 分阶段实施（每阶段独立可验证，不跨阶段夹带）

1. **P0 门先红**：写 `tests/capability-invariants.test.ts`，S-1…S-6 全部为红（这是紧反馈回路，AGENTS 规则 6 Phase 1）。
2. **P1 单点封堵**：`safeFs` + `decideCapability` + 执行锚点清单落地；`write-tool`/`read-tool`/`filesystem.ts` 改接；L1/L2/L3 用例转绿。
3. **P2 能力驱动守卫**：`ToolDef.capability` + `add()` 默认拒绝 + 删 `SCREENED_TOOLS`；L4/L5/L9 转绿。
4. **P3 顺序与身份**：鉴权前置于缓存、`cacheable` 默认 false、缓存键含 principal；L7 转绿。
5. **P4 默认值收紧**：`ALLOW_LOCAL_BYPASS` 默认 false、PTY 审批默认 `risky`；L6/L8 转绿；同步改测试与文档。
6. **P5 文档回填**：`docs/SECURITY-MEASURES.md` 六层模型补"层间独立性"反例小节（现状宣称"单层失效不导致系统失守"与 G1–G4 矛盾），并把 §3 矩阵作为新章节；受 S1/S2 门约束。

**破坏性变更清单（需用户知晓）**：P3 使全部 GET 默认不缓存（性能回归风险，需显式声明 `cacheable`）；P4 使既有本地免 token 工作流与 PTY `off` 用法失效（E2E 需注入 env）；P2 使未声明能力的第三方插件工具注册失败（改为启动期显式报错）。

**实施结果（2026-09-22 回填，与设计的偏差如实记录）**：

- P0–P5 全部落地，门为绿：`bun test tests/capability-invariants.test.ts`、`bun run test:docs`、`bun run test:arch`、`bun run lint`。
- 设计内偏差 1：S-6 的登记表最初计划复用 `config/nondeterminism.json` + D5，实际新增 `config/security-defaults.json` + 运行侧 `src/utils/security-defaults.ts`，由 S-6 独立锁定（D5 只管非确定组件，混用会让"安全开关"与"概率组件"两类默认值互相遮蔽）。
- 设计内偏差 2：D5 曾要求 `isEdgeEnabled("EDGE_RISK_MONITOR")` 以字面量出现在 `src/agents/risk-monitor.ts`，实施中把开关名抽成常量触发红灯，已按"改代码不改门"的原则还原。
- 设计内偏差 3：原计划"每条 L# 用例断言留下 audit 事件"未全数落实——`safeFs` 与 `registry.add()` 的拒绝以**抛错/返回值**表达，`security.alert` 只出现在序列复核升级与"豁免+非回环绑定"两处配置风险（见 `docs/SECURITY-MEASURES.md` 2.7.5）。
- 未覆盖：`plugins/` 不在 `tsconfig` 覆盖内，插件工具的能力声明只被静态门扫描、不被类型检查；其余未封堵项见 `docs/SECURITY-MEASURES.md` 2.7.5 表。

## 6. 测试策略（规则 7 垂直切片）

- 每个 L# 链路一条对抗用例，形态固定：起最小 harness → 发起该链路的第一步 → 断言被拒且留下 `audit` 事件；先红后绿，一条一条来。
- `safeFs` 用真实文件系统（tmpdir + 符号链接 + `..` + 大小写/Unicode 变体），不 mock（对齐用户既有偏好：测真实行为）。
- 回归面：既有 `tests/settings-search.test.ts`、`tests/*e2e*`、`architecture-integrity` 必须保持全绿。
- 无法本机验证的（需 Docker 沙箱、Go/Rust sidecar、GPU）显式记入"未验证项"，不声称完成（AGENTS + 审核纪律）。

## 7. 范围外

OS 级隔离加固（seccomp/namespace/SELinux）、多用户身份体系、密钥托管方案改造（`~/.axiom/axiom-secrets/` 保持既有）、前端权限 UI 重设计、`archive/` 归档。

## 8. 事实 / 判断 / 未实测 分离（规则 10）

- **事实**：G1–G4 表中所有 `文件:行` 与 grep 计数，本轮实测取得。
- **判断**：I1–I4 抽象、`safeFs` 接缝选择、P0–P5 顺序、破坏性变更评估。
- **推测/未实测**：L7 缓存二次返回的实际响应体行为（无运行环境实测）；L2 的 `.env` 外泄为**部署态条件性**（本仓不追踪 `.env`）；L3 SSRF 的实际内网可达性依赖部署网络；本机无 `node_modules`，`bun run lint` 与全套测试可运行性待实现阶段确认（`tests/architecture-integrity.test.ts` 已实测 22 项全绿，说明多数测试可跑）。
