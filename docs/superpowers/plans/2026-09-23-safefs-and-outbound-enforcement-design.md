# C/D 强制面设计：`safeFs` 扩面 与 `net.outbound` 收口

> **状态：待裁决。** 本文只给现状证据、可选方案、影响面与回滚路径，**不含实现**。
> 基线：路线线 `codex/s3-on-main-2026-09-22`（`de5a1f7d`）+ AGENTS v1.6，落点分支 `codex/runtime-safefs-outbound-design`。
> 来源：`docs/SECURITY-MEASURES.md` §2.7.5「未封堵项（如实记录，不声称完成）」中的 C 组（safeFs 扩面）与 D 组（`net.outbound` 强制面）。

## 0 摘要与推荐

| 组 | 推荐 | 为什么是它 | 需要你裁决什么 |
|---|---|---|---|
| **C** | **C-3 薄工厂绑定根**（`safeFsFor(policy)`，4 个写点各自绑定声明根，吞错处同时显式化） | 不动 `safeFs` 公共面 ⇒ 9 个既有消费者零回归；又不另起第二份符号链接判定（§2.7.5 点名的顾虑） | 落点是否允许在 cwd 之外（决定根模型）；选 C-3 还是 C-2 |
| **D** | **D-3 收 1 处自证旁路 + 装棘轮门**，D-2 的分档待白名单形态再谈 | 不需要先定政策就能关掉那条有注释自证的完全无守卫出网路径；而"裸 `fetch` 一律禁止"实测涉及 **25 个文件**，属大规模清扫，只能用棘轮拦增量 | 是否接受分两步；allow-list 用 env / `config/` 文件 / config-center |

两个都不建议一上来做"全量强制"（C-2 / D-1）：它们的收益是口径统一，代价是同时改公共接口面与 18 个调用方行为，在没有可信绿度基线（见 §1）的时候，回归无法与噪声区分。

## 1 开工前基线（本机三门实测，2026-09-23）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `bun x tsc --noEmit` | **exit 0** ✅ |
| 运行时审查 | `bun run audit:runtime` | **overall=pass，16/16，0 警告 0 失败** ✅ |
| 全量测试 | `bun run test` | **4236 pass / 34 skip / 28 fail，exit 1** ❌（4298 tests / 414 files / 114.38s） |

工具链现在三条线都能本机真跑：`bun 1.3.14`（恰好等于 `ci.yml` 钉的 `BUN_VERSION`，09-14 记的漂移已不存在）、`go1.26.0`（≥ `runtime-go/go.mod` 要求的 1.25.0）、`cargo 1.97.1`。

那 28 条红的分类（**未逐条深查，分类依据见括注**）：

| 类别 | 条数 | 判据状态 | 依据 |
|---|---|---|---|
| doc-contract D1–D12 | **13** | **假红**（已查明机制） | 该门的 POSIX 分隔符排除式在 Windows 失效，把 §2.7.5 豁免的 D 层历史留痕算进规范面：88 命中里 86 条在 `docs/`，`AGENTS.md`/`README.md`/`.env.example` 命中 0。详见对账报告 §8.3 |
| `S-3 safeFs 符号链接` | 2 | **本机不可验证** | `EFAULT: bad address in system call argument, rm 'src/link-to-hooks'` —— Windows 下建/删符号链接受限。未留下残file（`git status` 干净） |
| `O1a plan 封禁` / `O1c 键名扩展` | 2 | **真缺陷（夹具）** | 见 §4，夹具路径跨平台语义相反 |
| `LLMClient` 网络类 | 4 | 环境性 | 含 57.5s、19.3s 超时，离线网络所致 |
| 性能/压力类（Mega 500、E.4 延迟分位、C.5 层管道、AtomEngine 5000、CognitivePipeline throughput） | 5 | **绝对值不可信** | 本机核时与 CI 不同档，只能看差分 |
| `Logger redactContext` 1 条 + `(unnamed)` 1 条 | 2 | **未定性** | 本轮未查，登记为待查 |

**结论：本机唯一可信的绿度信号是"差分"，不是"绝对全绿"** —— 这直接决定了 C/D 的验收方式必须写成"失败集不新增"，见 §5。

## 2 C 组：把裸 `fs` 写点收进 `safeFs`

### 2.1 现状（逐点定位，含一条不可复现的声明）

`safeFs` 的公开面（`src/utils/safe-fs.ts`）：`authorizePath:75`、`readFile:152`、`writeFile:200`、`readDir:241`、`move:266`、`remove:288`。
它的关键约束（同文件 L13 注释原文）：**"沙箱根固定为 `process.cwd()`：调用方传入的 roots 只能收窄、不能放宽。"** 现在全仓库有 **9 个非测试文件**在用它。

待收口的写点，实测四个（行号为本次抓取）：

| 落点 | 位置 | 写法 |
|---|---|---|
| 自进化 · 技能质量 | `src/self-evolve/skill-quality.ts:108`、`:111` | `data/skill-quality.json`，L92 注释自陈默认绝对化为 `<cwd>/data/…` |
| 自进化 · 意识流 promoter | `src/agents/consciousness/skill-promoter.ts:120`、`:121` | `targetPath = path.join(this.config.skillDirRel, …)`，默认值 `skillDirRel = "./axiom-memory/03-Resources/skills"`（L39） |
| Vault 笔记 | `src/memory/vault-manager.ts:323`（`mkdirSync`）、`:345`（`writeFileSync` tmp + rename） | 落点在 vault 目录内 |
| 模型输出库 | `src/utils/model-output-store.ts:295`（`ensureDir`→`mkdirSync`）、`:304`（`writeFileSync` tmp + rename） | 与 vault 同形 |

> **一条文档落差**：§2.7.5 把 `knowledge-graph-builder` 与 `model-output-store` 并列为"写盘未经 safeFs"。
> `model-output-store` 实测在 `src/utils/`（不是文档让人以为的位置）且确实有裸写；
> 而 `src/memory/knowledge-graph-builder.ts` 对 `fs.` / `writeFile` / `mkdir` / `Database` / `INSERT` **零命中**
> ⇒ 该文件当前**没有直接落盘动作**，这条声明不可复现。**C 的真实范围因此是 4 点，不是 6 点。**
> 按 F-2 口径这属历史留痕，本轮只登记不改文档。

### 2.2 为什么不能直接把四个点都套上 `safeFs`

文档已点名，实测确认其机制：`safeFs` 的根固定为 `process.cwd()` 且 roots **只能收窄**。
而 `skillDirRel` / vault 根这类落点**可以被配成 cwd 之外的 axiom home**（默认值 `./axiom-memory/…` 是相对 cwd 的，但它是可配项）。
直接套用判定的后果不是"报安全错误"，而是**把合法写入打成拒绝**，并且——`§2.7.5` 原文：「两处调用方都吞错」——即表现为**持久化静默失效**。
把安全洞换成静默失效洞，是更坏的结果。所以任何 C 方案都必须**同时**处理"根从哪来"和"拒绝要可见"。

第二个约束也不能忽略：不能为了省事在调用方另写一份符号链接判定 —— 那正是 `safeFs` 存在的原因（L4-L11：仓库曾有"两份互不复用的路径守卫"），重新制造它就等于回到 bug 现场。

### 2.3 三个选项

**C-1 各站点自证锚点（最小改动）**
每个调用方在写之前调 `authorizePath(target, { roots: [自己那一功能的配置根] })`，不改 `safeFs`。

- 影响面：4 个文件 + 2 处吞错调用方。判定内核零改动。
- 优点：最快落地。
- 缺点：`roots` 参数在 4 个地方各写一遍 ⇒ "谁都能收窄"变回"谁都得记得收窄"，**漏一个点就是静默裸奔**，且没有任何机器判定能发现漏了。这正是我们要避免的形状。

**C-2 命名根集中化（动公共面）**
引入 `config/sandbox-roots.json`（或 `AXIOM_SANDBOX_ROOTS`），`safeFs` 支持命名根（`home` / `vault` / `data`），调用方按名字声明。

- 影响面：`safeFs` 公共接口变更 + 新增配置面 + **9 个既有消费者全量回归**。
- 优点：口径一次统一，且 D 组将来可复用同一表达。
- 缺点：这是接口变更（总则 0.3 的 T3、规则 8 的"设计建议不等于施工授权"）；在没有可信绿度基线的当下（§1），9 个消费者的回归与噪声无法区分。

**C-3 薄工厂绑定（推荐）**
新增一个小模块，导出 `safeFsFor(policy)`，内部复用 `authorizePath` 与 `decideCapability`（**不复制判定逻辑**），返回绑定了该政策根读写函数；4 个写点各自绑定自己声明的根；2 处吞错的调用方同时改成"拒绝必记日志 + 计数"。

- 影响面：1 个新小模块 + 4 站点 + 2 处错误处理；`safeFs` 内核与 9 个既有消费者零改动。
- 优点：把"必须传根"变成类型上绕不过去的一步（工厂没有默认根就得显式给），因此 §2.7.5 担心的"漏一个点"可被一条架构测试锁住（见 §5）；判定内核仍单源。
- 缺点：多一层薄抽象。若最终只有 4 个使用者且不再增长，C-1 也够用。

### 2.4 C 的推荐与前置问题

推荐 **C-3**。但有一件事必须先由你定，否则方案选不动：

> **裁决点 C-Q：`axiom-memory/` 与 vault 目录在目标部署里是否允许位于 `process.cwd()` 之外？**
> - 若**允许**：C-3 的根必须来自配置，且需要一条"配置根不存在则启动即失败"的门（否则根配错＝静默拒写）。
> - 若**不允许**（一律要求落在 cwd 内）：C-1/C-3 都退化为"根就是 cwd"，工作量显著缩小，但需要一次现网配置核查确认没人配到外面。

## 3 D 组：`net.outbound` 的强制面

### 3.1 现状（实测）

- 判定与逐跳校验在 `src/utils/url-safety.ts`，由 `src/utils/proxy-fetch.ts:461` 的 `if (opts.ssrfGuard && !isSafeUrl(url.href))` 触发 —— **守卫是 opt-in，默认关**。
- `proxyFetch` 被 **18 个非测试文件**导入（注意：这是导入面，不等于 18 个出网点）；全仓库**实际传 `ssrfGuard: true` 的调用点只有 1 处**：`src/crawl/data-pipeline.ts:341`（其余 `ssrfGuard` 命中都是类型声明、注释或判定语句本身）。
- 唯一"完全旁路"：`src/local-llm/edge-embeddings.ts` 用原生 `fetch`，`proxy-fetch.ts:57` 的注释自己就写明了这件事（"注：local-llm/edge-embeddings.ts 走原生 fetch，不经本模块"）。
- 障碍（§2.7.5 原文）：SearXNG / CDP / 网关自身都在回环上，**直接强制会把自家服务全打断**；前置条件是"本地端点白名单的可配置表达"。

### 3.2 三个选项

**D-1 默认拒绝 + allow-list**：`ssrfGuard` 默认翻成 `true`，新增允许的本地/私网端点清单。
影响面最广（18 个 `proxyFetch` 导入方行为同时变），现网打断风险最高；回滚容易（一个开关）。
**但它有一个自身解决不了的盲区**：那 25 个用裸 `fetch` 的文件根本不经 `proxyFetch`，翻默认值对它们无效
⇒ D-1 单独做**不能**达成"全部出网受判"，必须与 D-3 的棘轮收口配套才有完整口径。**不推荐现在做。**

**D-2 三档强制**：
(a) 已配置的 provider 端点 —— 放行但仍过"非回环"检查；
(b) 抓取面（`crawl/*`、`search-engines`、`serpapi-client`、`lightpanda-client`、`computer-use-agent` 等模型可控 URL 的主要来源）—— 默认强制；
(c) 自家回环端点 —— allow-list 显式放行。
影响中等、可逐档推进、每档独立可回滚。**这是 D 的终局形态**，但它需要先定 allow-list 的表达载体（env？config-center？`config/` 文件？）。

**D-3 先收唯一有文档自证的旁路 + 装棘轮门（推荐作为第一步）**：
① 把 `edge-embeddings` 的原生 `fetch` 改为经 `proxyFetch`（或至少接 `isSafeUrl`），其 `base` 来自配置 ⇒ 归入 (a)/(c) 档处理；
② 装一道**棘轮门**而不是禁令：以现状清单为基线冻结，**新增**裸 `fetch` 即红。

> 这里要修正本文初稿的一处口径错误。初稿写的是"`src/` 内除 `proxy-fetch.ts` 自身外不得出现裸 `fetch(`，豁免清单为空则通过"。
> 实测口径 `grep -rlE '(^|[^a-zA-Z0-9_.])fetch\s*\(' src/ --include=*.ts | grep -v '\.test\.ts'` → **26 个文件**（去掉 `proxy-fetch.ts` 自身是 25）。
> ⇒ "清单为空"这道门**立不起来**，硬推等于一次改 25 个文件，违反规则 1 且完全无法与噪声区分。
> 正解是棘轮：仓库已有同族先例（doc-contract 的 **D7 概率层不得承担决策（棘轮）**），照它做"存量登记在册、只拦增量"，
> 并把 `edge-embeddings` 作为存量清单的**唯一收口动作**——每修一处就从清单里划掉一行，清单只会变短。
>
> 同理，"18 个 `proxyFetch` 消费方里只有 1 个传 `ssrfGuard: true`"这个数也要限定范围：那 18 是**导入 `proxy-fetch` 的文件数**，
> 不等于 18 个出网点；真实需强制的"模型可控 URL"点要按调用链逐个判定，属 D-2 的活，不在 D-3 里顺手做。

影响面：1 个文件（①）+ 1 个测试与 1 份在册清单（②）。不改任何现网 URL 策略，不需要先定白名单形态。

### 3.3 D 的推荐与前置问题

推荐 **D-3 先行，D-2 待你定 allow-list 载体后再做**。

> **裁决点 D-Q：本地端点白名单用什么表达？** 三选：
> - `AXIOM_ALLOWED_LAN_ENDPOINTS`（env，与现有 `${LAN_*}` 占位符口径一致，规则 11 友好）；
> - `config/` 下新增一份清单文件（可被 doc-contract 家族机器校验，但会新增入库面）；
> - 复用现有 config-center（无需新配置入口，但要确认它能在守卫调用点同步取值）。
> 注意：无论哪种，**清单里都不能写真实 IP 入库**（规则 11），只能放占位符/由 env 注入 —— 这与 §2.7.5 那行的措辞一致，也是为什么"直接强制会把自家服务打断"。

## 4 附带发现：一处跨平台夹具缺陷（建议先修）

`tests/unit/tool-mode-gate.test.ts`：

```
:141  wrapped.handler({ [key]: "/etc/shadow" })        → 期望 rejects.toThrow(/HardFloor/)
:150  wrapped.handler({ filePath: "D:/workspace/normal.txt" }) → 期望 { ok: true }
```

机制：`"D:/workspace/normal.txt"` 这个 token **在 Linux 上是相对路径**（无 `/` 前缀，解析到 `<cwd>/D:/workspace/…`，落在沙箱内）⇒ 放行；
**在 Windows 上它是绝对路径** ⇒ 逃出 `process.cwd()` 锚点 ⇒ 内核正确拒绝：
`[HardFloor] fs.delete: target 'D:/workspace/normal.txt' escapes sandbox root D:\openclaw-fusion`。
**内核是对的，夹具是错的。**

修法不是单行：两条断言都要换成"平台无关的锚定表达"——良性样例从沙箱根派生（如相对片段 `normal.txt`），敏感样例 `/etc/shadow` 也需复核它在 Windows 下是否仍按预期命中敏感锚点（它同样会被当相对路径）。这是一次"两条断言共同重做"的小改，属于 C 的验收前提（否则 C 的回归信号里混着 2 条已知假红）。

> **裁决点 F-Q：本轮先修这条夹具吗？** 我建议修，单独一个提交。

## 5 验证矩阵（每条判据在哪能跑）

| 判据 | 本机（Windows） | 说明 |
|---|---|---|
| `bun x tsc --noEmit` | ✅ 可 | 当前 exit 0，可直接作硬门 |
| `bun run audit:runtime` | ✅ 可 | 当前 16/16，可直接作硬门 |
| 全量 `bun run test` 的**绝对绿度** | ❌ 不可 | 13 条 doc-contract 假红 + 2 条符号链接不可验证 + 4 条网络 |
| 全量 `bun run test` 的**失败集差分** | ✅ 可，且**只能用这个** | 判据写作"相对 §1 基线的 28 条不新增" |
| C 的符号链接逃逸验收 | ❌ 本机不可（EFAULT） | 需 Linux runner；或本机开启 Windows 开发者模式后复测（该前提必须写进验收，不得默认成立） |
| C 的"漏绑根即失败"架构测试 | ✅ 可 | 纯静态/单测，不依赖符号链接 |
| D-3 的棘轮门（裸 `fetch` 存量在册、只拦增量） | ✅ 可 | 纯源码扫描；基线在册清单 = **26 个文件**（口径见 §3.2），只允许变短 |
| D-2 的强制面端到端 | ⚠️ 部分 | 需要 SearXNG/CDP/网关在跑，属 `AXIOM_LIVE_SERVER` 那一类环境 |
| Go / Rust 侧 | ✅ 现在可 | `go1.26.0` / `cargo 1.97.1` 均在 PATH |

## 6 需你裁决的四件事

1. **C-Q**：`axiom-memory/` 与 vault 目录是否允许落在 `process.cwd()` 之外？（决定根模型与工作量）
2. **C 选型**：C-3（薄工厂，不动公共面，推荐）还是 C-2（命名根集中化，动公共接口 = 接口变更裁决）？
3. **D 节奏**：接受"D-3 先行、D-2 待载体"吗？以及 allow-list 用 env / `config/` 文件 / config-center 哪种表达（D-Q）？
4. **F-Q**：§4 的夹具修复是否本轮先做（我建议先做，它决定 C 的验收信号是否可信）？

裁决后我按总则 0.4 冻结任务契约再开工；每刀一个提交、一条 ops log，且验收判据一律写成 §5 的"差分不新增"而非"绝对全绿"。
