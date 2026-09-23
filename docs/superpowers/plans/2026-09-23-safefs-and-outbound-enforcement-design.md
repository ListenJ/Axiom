# C/D 强制面设计：`safeFs` 扩面 与 `net.outbound` 收口

> **状态：待裁决。** 本文只给现状证据、可选方案、影响面与回滚路径，**不含实现**。
> 基线：路线线 `codex/s3-on-main-2026-09-22`（`de5a1f7d`）+ AGENTS v1.6，落点分支 `codex/runtime-safefs-outbound-design`。
> 来源：`docs/SECURITY-MEASURES.md` §2.7.5「未封堵项（如实记录，不声称完成）」中的 C 组（safeFs 扩面）与 D 组（`net.outbound` 强制面）。

## 0 摘要与推荐

| 组 | 推荐 | 为什么是它 | 需要你裁决什么 |
|---|---|---|---|
| **C** | **C-3 薄工厂绑定根**（`safeFsFor(policy)`，4 个写点各自绑定声明根，吞错处同时显式化） | 不动 `safeFs` 公共面 ⇒ 9 个既有消费者零回归；又不另起第二份符号链接判定（§2.7.5 点名的顾虑） | 落点是否允许在 cwd 之外（决定根模型）；选 C-3 还是 C-2 |
| **D** | **D-A 棘轮门 + 出网点来源分类**（零运行时行为变更），收口动作留到 D-B | 唯一不需要先定政策就能落地的一步，且它的产出是"哪些出网 URL 模型可控"这份目前没人答得出的事实；初稿"直接给 `edge-embeddings` 套守卫"经实测**撤回**——会把它自己的默认端点 `127.0.0.1:9001` 判死并静默失效 | allow-list 用 env / `config/` 文件 / config-center；D-A 是否先做 |

两个都不建议一上来做"全量强制"（C-2 / D-1）：它们的收益是口径统一，代价是同时改公共接口面与 18 个调用方行为，在没有可信绿度基线（见 §1）的时候，回归无法与噪声区分。

## 1 开工前基线（本机三门实测，2026-09-23）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `bun x tsc --noEmit` | **exit 0** ✅ |
| 运行时审查 | `bun run audit:runtime` | **overall=pass，16/16，0 警告 0 失败** ✅ |
| 全量测试 | `bun run test` | 见下：**同一份代码连跑三次的失败集不一致** |

**同一基线连跑三次实测**（第 1 次含 2 条夹具缺陷，第 2、3 次已修）：

| 运行 | 唯一失败条数 | 说明 |
|---|---|---|
| #1 | 28 | 4236 pass / 34 skip，exit 1 |
| #2 | 17 | 4247 pass，exit 1（夹具修复后） |
| #3 | 17 | 与 #2 **逐条完全相同**（`comm` 双向皆空） |

拆出来的结论，比"有 28 条红"重要得多：

- **稳定红 = 17 条**（#2 与 #3 逐条一致，且全部也在 #1 中出现）：13 条 doc-contract（D1×3、D2、D3×3、D4×2、D7、D9、D11、D12，Windows 分隔符假红，机制见对账报告 §8.3）+ **2 条 `S-3 safeFs 符号链接`**（`EFAULT … rm 'src/link-to-hooks'`，本机不可验证、未留残file）+ 1 条 `LLMClient concurrent stress` + 1 条 `(unnamed)`。
- **抖动 = 9 条**：只在 #1 出现过一次（`AtomEngine 5000`、`C. 5 层管道`、`CognitivePipeline throughput`、`D.1 熔断器`、`E.4 延迟分位`、`LLMClient 网络错误`、`LLMClient empty prompt`、`Mega 500 并发`、`Logger 无 context`）——全是负载/时序/网络敏感项。#1 是 checkout 后首跑（post-checkout 钩子刚重装过依赖），机器还带着别的工作在跑。
- **#1 与 #2 之间的差是 11 条，其中只有 2 条是修的**（`O1a` 只读工具夹具、`O1c` 键名扩展夹具，见 §4），另外 9 条属于抖动。

⇒ 因此验收协议不能写成"失败集不新增"（分母本身在抖），要写成两条：
**(a) 稳定红 17 条不得增大**；**(b) 涉及性能/网络/时序的新测试，判据必须自己跑 ≥3 次取交集**，不接受单次结果。

> **基线更正（2026-09-24，第三次 ≥3 运行）**：上面那句"13 条 doc-contract Windows 分隔符假红"当时只写到"机制见对账报告"，没有去修判据，于是 17 里最大的 13 条一直是噪声。修掉分隔符归一 + 本地专用目录出扫 + 一份月度日志的 CRLF + 规范件里的死引用/手抄行号之后，`doc-contract` 本机首次 **35 pass / 0 fail**。新的三次背靠背运行交集为 **稳定红 7 条**：2 条 `S-3` 符号链接（本机 EFAULT，需 Linux runner）+ 4 条负载/时序/网络阈值项（`CognitivePipeline 6-step` 是**撞到 15s 超时**而非差阈值、`E.4 p99<50ms`、`LLMClient concurrent stress`、`B+C DRE 降级链`）+ 1 条 `(unnamed)`。
> ⇒ 判据 (a) 自本行起按 **7 条**执行；(b) 不变。另外这一轮还暴露：一条**已入库的**月度操作日志整份是 CRLF（全仓仅此一个 md 有 CR），说明"历史留痕件不受完整性门保护"的假设不成立 —— 完整性检查确实覆盖它们，之前只是被分隔符 bug 报成了别的错。

> **再更正（同日，退避根因修后）**：7 条里的 `CognitivePipeline 6-step` 与 `B+C. DRE 无 LLM 降级链` 不是"性能缺陷待修"，而是**测试在替 TCP 重试策略付账** —— `isRetryableError` 对无 statusCode 的连接层错误一律判可重试，6 步管道每次运行要串行走完 3 次尝试 + 指数退避，死法是撞 `bun` 单用例超时（`.ci/run.sh` 用裸 `bun test` ⇒ CI 里必红）。测试侧隔离后二者降级为负载敏感。**当前稳定红 = 5 条**（2 `S-3` 符号链接 + `LLMClient 50 并发` + `Mega 500 并发` + `(unnamed)`）；那两条高并发项**故意不修**：它们已配 `maxRetries:0`，慢的是真实并发建连，降并发或放宽时限等于把断言改成我能过的样子。生产重试策略未动（把连接拒绝判为不可重试会影响瞬时抖动场景，属单独裁决）。

工具链现在三条线都能本机真跑：`bun 1.3.14`（恰好等于 `ci.yml` 钉的 `BUN_VERSION`，09-14 记的漂移已不存在）、`go1.26.0`（≥ `runtime-go/go.mod` 要求的 1.25.0）、`cargo 1.97.1`。
⇒ 旧结论"Go 编不过 / cargo 不在 PATH / 性能与内存只能估算"是**退役 Linux 机**的状态，在本机已作废。

## 2 C 组：把裸 `fs` 写点收进 `safeFs`

> **本节已被 `docs/decisions/ADR-007-safefs-single-source-and-configurable-root.md` 取代并扩展（2026-09-23 同日晚些时候）。**
> 写本节时还不知道的第二份守卫：`src/utils/path-safety.ts:22 isPathSafe()` 仍在 `src/sandbox/docker-sandbox.ts:38` 活着，
> 于是 C 的第一步从"C-1/C-2/C-3 选一个抽象"变成"先把那一份收敛掉"（ADR-007 的 C-0）。
> 下面三个选项的对比仍然有效，但它回答的是"根怎么绑"，不回答"两份守卫怎么办"。以 ADR-007 为准。

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

**D-3 装棘轮门（推荐第一步）——但本文初稿给的另一半推荐已被实测撤回**：

> **撤回记录**：初稿的 D-3 有两步：①把 `edge-embeddings` 的原生 `fetch` 改接 `isSafeUrl`/`proxyFetch`；②装棘轮门。
> ②成立。①**不成立**——该模块默认端点是 `DEFAULT_EMBED_BASE = "http://127.0.0.1:9001"`（`src/local-llm/edge-embeddings.ts:16`），
> 而实跑 `isSafeUrl` 的结果是：
>
> ```
> DENY   http://127.0.0.1:9001/v1/embeddings   ← 它自己的默认端点
> DENY   http://localhost:9001/x
> ALLOW  https://api.openai.com/v1/embeddings
> DENY   http://192.168.0.150:9/v1
> ```
>
> ⇒ 套上守卫等于把它自己的默认配置判死；又因为该模块"不可用/超时/非 2xx 一律返回 null 不抛错"（`:33` 注释 + `catch { return null }`），
> 表现会是**边缘语义搜索静默失效** —— 与 C 组最怕的"把合法操作打成静默失效"是同一个失败形状。
> **所以①不能独立于 allow-list 做，D-3 里必须去掉它。**

修订后的 D 步序：

**D-A 棘轮门（不需要任何政策裁决，现在就能做）**：以现状清单为基线冻结，**新增**裸 `fetch` 即红；
在册清单每行标注该点 URL 的来源：`模型可控` / `运维配置` / `固定端点`。
这一步真正的产出不是"拦新增"，而是**把"哪些出网点的 URL 是模型可控的"盘成事实**——
现在答不出来，而 D-B 的策略必须建立在它上面。影响面：1 个测试 + 1 份在册清单，**零运行时行为变更**。

> 口径纠错（初稿第二处）：初稿写"`src/` 内不得出现裸 `fetch(`、豁免清单为空则通过"。
> 实测 `grep -rlE '(^|[^a-zA-Z0-9_.])fetch\s*\(' src/ --include=*.ts | grep -v '\.test\.ts'` → **26 个文件**
> （去掉 `proxy-fetch.ts` 自身是 25）⇒ "空清单"这道门立不起来，硬推等于 25 文件清扫，违反规则 1。
> 正解是棘轮：仓库已有同族先例（doc-contract 的 **D7 概率层不得承担决策（棘轮）**），照它做"存量在册、只拦增量"。
>
> 第三处口径纠正：初稿说"18 个 `proxyFetch` 消费方只有 1 个传 `ssrfGuard: true`"。18 是**导入面**，
> 不等于 18 个出网点；真需强制的点要按调用链逐个判定，属 D-B。

**D-B 收口（前置条件是 allow-list 载体已定）**：按 D-A 盘出的分类，对 `模型可控` 那批强制 `ssrfGuard`；
对 `运维配置`/`固定端点` 那批（含 `edge-embeddings`、provider 调用、SearXNG/CDP/网关）走 allow-list 显式放行。

影响面：D-A 为 1 个测试 + 1 份清单；D-B 待分类结果再估。

### 3.3 D 的推荐与前置问题

推荐 **D-A（棘轮门 + 出网点来源分类）先行**；初稿的"收 `edge-embeddings`"一步**已撤回**（实测会把该模块判死，见 §3.2），它与分档强制一起并入 **D-B**，而 D-B 的前置条件是你先定 allow-list 载体。

> **裁决点 D-Q：本地端点白名单用什么表达？** 三选：
> - `AXIOM_ALLOWED_LAN_ENDPOINTS`（env，与现有 `${LAN_*}` 占位符口径一致，规则 11 友好）；
> - `config/` 下新增一份清单文件（可被 doc-contract 家族机器校验，但会新增入库面）；
> - 复用现有 config-center（无需新配置入口，但要确认它能在守卫调用点同步取值）。
> 注意：无论哪种，**清单里都不能写真实 IP 入库**（规则 11），只能放占位符/由 env 注入 —— 这与 §2.7.5 那行的措辞一致，也是为什么"直接强制会把自家服务打断"。

## 4 附带发现：一处跨平台夹具缺陷（本轮已修）

`tests/unit/tool-mode-gate.test.ts` 里四个硬编码路径夹具：

```
:63   { path: "D:/tmp/x.txt" }          期望 rejects.toThrow(/ModeGate/)   ← 本来就通过，未动
:70   { path: "D:/tmp/ok.txt" }         期望 { ok: true }                   ← 失败，已修
:141  { [key]: "/etc/shadow" }          期望 rejects.toThrow(/HardFloor/)   ← 本来就通过，未动
:150  { filePath: "D:/workspace/normal.txt" }  期望 { ok: true }            ← 失败，已修
```

机制：`"D:/…"` 这类 token **在 Linux 上无盘符语义** ⇒ 是相对路径（解析到 `<cwd>/D:/…`，落在沙箱内）⇒ 放行；
**在 Windows 上是绝对路径** ⇒ 逃出 `process.cwd()` 锚点 ⇒ 内核正确拒绝：
`[HardFloor] fs.read: target 'D:/tmp/ok.txt' escapes sandbox root D:\openclaw-fusion`（`:150` 同形，能力为 `fs.delete`）。
**内核是对的，夹具是错的。**

**已修（2026-09-23，本设计稿落盘的同轮）**：`:70` 的 `D:/tmp/ok.txt` → `notes/ok.txt`、`:150` 的 `D:/workspace/normal.txt` → `workspace/normal.txt`，两处都改为"显式相对片段 ⇒ 两端都落在 `process.cwd()` 之内"。
`:63` 的 `D:/tmp/x.txt` **未动**：它期望的是 `ModeGate` 拒绝（模式门在硬底线之前），本来就通过，改它没有意义。
`:141` 的 `/etc/shadow` **未动**：实测在 Windows 上仍命中敏感锚点并通过，不需要重做。
验证：`bun test tests/unit/tool-mode-gate.test.ts` → **10 pass / 0 fail**；全量三次运行的失败集对比见 §1（稳定红 28→17，其中确因本次修复消失的是这 2 条）。

## 5 验证矩阵（每条判据在哪能跑）

| 判据 | 本机（Windows） | 说明 |
|---|---|---|
| `bun x tsc --noEmit` | ✅ 可 | 当前 exit 0，可直接作硬门 |
| `bun run audit:runtime` | ✅ 可 | 当前 16/16，可直接作硬门 |
| 全量 `bun run test` 的**绝对绿度** | ❌ 不可 | 稳定红 **7 条**（2026-09-24 更正，原记 17；构成见 §1 基线更正），另有 ≥6 条跨运行抖动 |
| 全量 `bun run test` 的**失败集差分** | ⚠️ 可用但**必须取交集** | 判据写作"§1 更正后的 7 条稳定红不得增大"；单次运行不可作结论（实测三次为 8 / 11 / 9，交集 7） |
| 新增的性能/时序类测试自身 | ❌ 单次不可信 | 必须同机跑 ≥3 次取交集后才允许进判据 |
| C 的符号链接逃逸验收 | ✅ **已在 Linux 容器实测**（2026-09-24） | `oven/bun:1.3.14` 里 `bun test tests/capability-invariants.test.ts`：**11 条 `S-3` 全通过**，含本机因 `EFAULT` 跑不了的两条（沙箱内符号链接指向沙箱外、目录符号链接指向锚点目录）。⇒ "需 Linux runner" 这条前提已兑现，**不再是未验证项**；本机 Windows 侧那 2 条红属平台语义差异，保留为环境性红。<br>**但同一容器不能当通用 runner**：该文件里 `S-2`/`S-8` 三条整仓扫描用例在同一容器中全部以 5s 超时收场（整份 179s vs 本机 5.9s，bind-mount I/O 饿死）⇒ 扫描类门的绿度只在原生运行上取，容器只用于符号链接语义。 |
| C 的"漏绑根即失败"架构测试 | ✅ 可 | 纯静态/单测，不依赖符号链接 |
| D-A 的棘轮门（裸 `fetch` 存量在册、只拦增量）+ 来源分类清单 | ✅ **已建成** | 纯源码扫描；`tests/outbound-fetch-ratchet.test.ts` + `config/outbound-fetch-baseline.json`。基线口径由初稿的 grep 26 文件更正为 **AST 23 文件 / 29 次直连调用 + 4 处 `globalThis.fetch` 引用**（见 §9） |
| D-B 的强制面端到端 | ⚠️ 部分 | 需要 SearXNG/CDP/网关在跑，属 `AXIOM_LIVE_SERVER` 那一类环境；且必须先有 allow-list 载体 |
| Go / Rust 侧 | ✅ 现在可 | `go1.26.0` / `cargo 1.97.1` 均在 PATH |

## 6 待裁决与已定事项

**已定（本轮实测取代，不需你答）**：

- ~~C-Q 落点是否允许在 cwd 之外~~ → **允许**：`OBSIDIAN_VAULT_PATH=./axiom-memory`、`DATABASE_PATH=./data/agent.db`（`.env.example:142,144`）都是可被运维改成任意绝对路径的普通 env，且没有 `AXIOM_HOME` 这类收口项。
  ⇒ 任何"根固定为 cwd"的做法在受支持配置下会打断合法写入，**C 的根必须可配**（这条把 C-1 直接排除出候选）。
- ~~F-Q 夹具是否先修~~ → **已修并验证**（§4）。
- ~~D-3① 收 `edge-embeddings`~~ → **撤回**（§3.2，实测 `isSafeUrl` 拒它的默认端点）。

**需要你答的两件事**：

1. **C 选型**：C-3（薄工厂 `safeFsFor(policy)`，不动 `safeFs` 公共面，推荐）还是 C-2（命名根集中化，改公共接口 ⇒ 属接口变更裁决，且要回归 9 个既有消费者）？
2. **allow-list 载体**（D-B 的前置）：`AXIOM_ALLOWED_LAN_ENDPOINTS`（env）／`config/` 清单文件／复用 config-center？三选都要求**入库面不出现真实 IP**（规则 11）。
   顺带确认：**D-A 棘轮门是否现在就做**（它零运行时行为变更，不需要等 D-B 的政策）。

裁决后按总则 0.4 冻结任务契约再开工；每刀一个提交、一条 ops log，验收判据一律写成 §5 那两条（稳定红不增大 + 新测试 ≥3 次取交集），不写"绝对全绿"。

## 9 D-A 施工记录（2026-09-24）—— 口径更正与 D-B 的事实基础

D-A 已建成：`tests/outbound-fetch-ratchet.test.ts`（14 pass）+ `config/outbound-fetch-baseline.json`（23 行在册）。**零运行时行为变更** —— 这道门只扫描与登记，不拦任何真实请求，不得读作"出网已受判"。

### 9.1 基线口径：grep 26 → AST 23（第四处口径纠正）

§3.2 用 `grep -rlE '(^|[^a-zA-Z0-9_.])fetch\s*\('` 量的 26 个文件里，有 5 个是假阳性：`Bun.serve({ async fetch(req, server) })` 的入站处理器 3 处（`src/mcp/server.ts`、`src/mcp/dre-backend.ts`、`src/mcp/kb-backend.ts`）、名为 `fetch` 的方法声明 1 处（`src/crawl/search-engines.ts`，它内部转 `proxyFetch`）、注释文本 1 处（`src/utils/proxy-fetch.ts`）。

改用 TS 语法树后实测口径为 **23 个文件 / 29 次直连 `fetch(...)` 调用 / 4 处 `globalThis.fetch` 引用**。门里有一条"扫描判据自证"用例把这四种形态各自的归属反向锁住，防止判据后来被改宽或改窄而门安静失效（照 §doc-contract 的 D0 先例）。

**只扫 `fetch(` 调用会整片失明**：`src/computer-use/frontend-review.ts` 走 `opts.fetchImpl ?? globalThis.fetch` 再调用、`src/router/provider-caller.ts` 走 `const fetchFn = globalThis.fetch` 再调用 —— 两个文件里没有一处 `fetch(` 直连调用。所以门把 `globalThis.fetch` 的**任意引用**也计入。第三个出网通道也一并量过：`http.request` 在 `src/` 内只出现在 `src/utils/proxy-fetch.ts` 一处，即认可的载体内部，无旁路。

### 9.2 「谁能决定目的主机」三分，而不是「URL 变量长什么样」

初稿的 `模型可控 / 运维配置 / 固定端点` 三档在落地时不够用：`src/routes/native-routes.ts` 的 URL 形如 `${NATIVE_BASE}${url.pathname}${url.search}`，主机是字面量回环、**换不掉**，但路径与查询串跟着入站请求走。按变量长相它属"入站可控"，按危害它和"模型能填任意主机"根本不是一回事。

因此在册清单按后者切成三份互斥名单，并由一条"完备性"用例强制任何新的可达外部影响点必须归入其一：

| 名单 | 在册 | 现状 |
|---|---|---|
| 模型/入站可选**主机** | `src/knowledge/document-ingest.ts`、`src/tools/read-tool.ts` | 两点都已挂守卫 ⇒ 该预算为 0，未挂守卫的新点直接红 |
| 主机固定、仅路径可控 | `src/routes/native-routes.ts` | 未挂 `net.outbound` 守卫，但打不到别的主机；风险面是越到 sidecar 的其它端点 |
| 运维可写主机（经认证 HTTP 体 / CLI 旗标 / env） | `src/router/provider-caller.ts`、`src/utils/api-key-store.ts`、`src/workers/pdf-worker.ts` | 三点都无 URL 校验；`POST /api-keys` 的写路径只判 http/https 协议，不查主机与内网 |

另登记 2 个**无生产调用方**的可达性结论（`src/dre/port/knowledge-port.ts` 的 `createRemotePort`、`src/dre/synapse/engine.ts` 的 `createLocalModelAssist`，`src/` 内除定义处与 re-export 桶文件外均无引用），并由用例把"提及该符号的文件数"钉死 —— 谁接上调用方，门就红，迫使重新分类，而不是让 `reachable:false` 悄悄变成假事实。顺带一条：`synapse/engine.ts` 的注释声称"仅在配置了 `MIND_LOCAL_LLM_URL` 时由调用方启用"，实测该 env 名在全仓只出现在这行注释里，没有任何代码读它。

### 9.3 D-B 必须知道的两条口径分裂（均经亲自回代，不采信转述）

1. **`redirect` 逐跳不复查是存量缺口**：`src/` 内只有 `src/knowledge/document-ingest.ts` 设了 `redirect: "manual"` 并逐跳复查，而那处的代码注释已经把失败形状写明白了（"只校验初始 URL，重定向逐跳不校验 ⇒ SSRF 残窗"）。同一个形状在**模型可控**的 `src/tools/read-tool.ts` 上仍然开着：它过了 `decideCapability`，但 `fetch` 只传 `signal`，重定向由运行时跟随且不二次裁决。⇒ D-B 对"模型可选主机"这一档的强制必须包含逐跳，否则只裁初始 URL 等于没裁。
2. **`AXIOM_NET_ALLOWLIST` 与 `isSafeUrl` 不共享豁免**：实测把 `127.0.0.1` 写进该 env 后，`decideCapability({capability:"net.outbound"})` 对回环返 ALLOW，而同一 URL 的 `isSafeUrl` 仍返 false。两个后果：
   - `src/utils/permissions.ts` 的 `decideOutbound` 注释写"只有显式登记的主机名可豁免；**IP 字面量永不豁免**"，而代码是 `if (!allowlist.includes(host))`，没有任何 IP 字面量排除 ⇒ **注释与实现不一致**，实测以 `127.0.0.1` 登记即放行。
   - allow-list 只作用于 `decideCapability` 一侧。若 D-B 让某些点改走 `proxyFetch(ssrfGuard)`，同一份 allow-list 对它们**无效**，会出现"登记了仍被打死"的静默失效 —— 与 §3.2 撤回 D-3① 时担心的是同一类失败形状。
   ⇒ **裁决点 D-Q 的三选都必须回答"这份 allow-list 由几个守卫读取"**，否则载体选了、口径仍分裂。这是 D-A 交付的新事实，初稿没有。

> **撤回一条转述结论**：本轮子代理报告断言 `decideOutbound` 对 `http://2130706433:9001/` 这类十进制回环会 ALLOW（因 `LOOPBACK_OR_LINK_LOCAL` 只做点分前缀匹配、不做归一化）。按规则 13.1 亲自回代实测：`new URL()` 会把十进制/十六进制/八进制 IPv4 全部归一，`hostname` 已是 `127.0.0.1`，实测 `cap=DENY` 且与 `isSafeUrl=false` 一致 ⇒ **该断言不成立，撤回**，D-B 不需要为此立项。

### 9.4 D-A 不做什么

- 不改任何运行时行为、不给任何点新增守卫、不引入 allow-list —— 这三件都在 D-B。
- 不覆盖 `proxyFetch` 的 18 个导入方（§3.2 已纠正：导入面 ≠ 出网点，逐点判定属 D-B）。
- 不覆盖 WebSocket / `Bun.spawn` 子进程自行联网等非 `fetch` 通道；只确认了 `http.request` 无旁路（§9.1）。

---

## 10 D-B 机械半已收口（2026-09-24）：`read-tool` 逐跳裁决，政策半仍待裁决

§9.3(1) 登记的那条缺口已按 D-A 定的形状修掉：`src/tools/read-tool.ts` 的 `source=web` 分支改为
`redirect: "manual"` + 每跳重过 `decideCapability` + 跳数上限 5（与 `document-ingest` 的 B3-Medium 同形）。
在册预算 `guardWithRedirectGapMax` 由 1 下调到 0。

**证据不是"我改了就绿"**：夹具桩刻意模拟"传输层自己跟随跳转"，只回 302 的桩会让旧实现因 `!res.ok` 也抛错、
于是测不到那个洞。三条用例（内网元数据跳转、协议相对 `//169.254.169.254/`、9 跳长链）修前全部 resolve 出
被拒主机的响应体，修后全部抛错且断言"被拒那一跳根本没发出请求"；另三条红线（公网→公网、相对 Location、
file 分支不触网）锁住不误伤。

**顺手补了一处会说谎的门**：`redirectPerHop` 原先只是在册清单里的一个**自述字段**，"修好一个就下调"那条用例
读的是 JSON 而不是源码 —— 只改清单就能把预算调到 0。新增一条把声明回扣到 AST 可见机制的用例，并对该判据
做了自检（注释里的 `redirect:"manual"` 不算、`redirect:"follow"` 不算、`fetchData` 这类名字不算）。
残留边界：判据按仓库实际用到的被调名（`fetch`/`fetchImpl`/`fetchFn`/`globalThis.fetch`）识别，换新别名会
**报红而不是自动放行**（实测把声明改回 false 即触发 red）。行为层的证据仍在 fence 测试，不在这个 AST 判据里。

**仍未做、且必须由用户先裁的一半**：§9.3(2) 的 allow-list 载体（D-Q），以及 `decideOutbound` 那句
"IP 字面量永不豁免"的注释与 `allowlist.includes(host)` 实现不一致 —— 改注释还是改语义是政策选择，
不在机械收口里擅动。`native-routes` 的越端点面与"运维可写主机"三点也仍按 §9.2 留在 D-B。

