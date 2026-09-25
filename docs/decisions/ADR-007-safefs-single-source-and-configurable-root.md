# ADR-007：路径判定单源化与沙箱根可配（safeFs 扩面）

- 日期：2026-09-23 ｜ 状态：**提案，待批准** ｜ 决策人：项目经理（用户）
- 背景：`docs/SECURITY-MEASURES.md` §2.7.5 的 C 组（"写盘未经 `safeFs`"）。本轮勘察实测出的三件事**改变了问题形状**，故先记录事实再记决定：
  1. 文档称 6 个裸写点，**实测 4 个** —— `src/memory/knowledge-graph-builder.ts` 对 `fs.`/`writeFile`/`mkdir`/`Database`/`INSERT` 零命中，该声明不可复现。
  2. `src/utils/safe-fs.ts` 头注释（L4-L11）声称"两份互不复用的路径守卫"已由它终结，但 **`isPathSafe()`（`src/utils/path-safety.ts`，C-0 时已删除；2026-09-26 归一以新实现回归，见文末归一裁决）至今仍是一套独立实现**（自做 `path.relative(cwd,…)` + `startsWith("..")` + 自有 realpath 与父目录 realpath）。`src/mcp/tools/filesystem.ts` 头部那条注释本身也确认："utils/path-safety.ts 仍在 docker-sandbox 的挂载白名单里使用"。实测收敛面极小：**全仓（`src/` + `tests/`）只有 1 处 import** —— 在 `src/sandbox/docker-sandbox.ts` 的 import 区，调用点 1 处 —— `assertMountDirAllowed` 里；同文件导出的 `resolvePath` **零消费者**（`src/agent-evals/real-usage.ts` 里那个同名符号是它自己的局部函数）；且 `tests/` 下**没有任何测试 import 过 `path-safety`** ⇒ 第二份守卫目前处于无自身测试的状态。
  2b. 两份文件**各自声称自己是唯一来源**：`path-safety.ts` 文件头写"唯一围栏语义源"、并写"工具层不各自发明第二套围栏"；`safe-fs.ts` 文件头写"文件系统特权的唯一执行点"，而其头部注释块正是在叙述"原有两份互不复用的守卫"如何被终结。三个声明互不自洽 —— 这是文档层面的口径事故，C-0 完成后应随之收敛（`filesystem.ts` 那句"与本工具无关"的注释也一并退休）。
  3. 落点 env（`OBSIDIAN_VAULT_PATH=./axiom-memory`、`DATABASE_PATH=./data/agent.db`、`skillDirRel`）默认 cwd 相对，但都是**可被运维改成任意绝对路径的普通 env**，且无 `AXIOM_HOME` 一类收口项 ⇒ `safeFs`"根固定 `process.cwd()`、roots 只收窄"与真实部署不兼容。

## 决定

把 C 拆成三刀，**顺序即依赖顺序**：

- **C-0 收敛第二份守卫（不引入任何新抽象）**：`assertMountDirAllowed` 里的挂载栅栏改走 `safeFs.authorizePath`；`src/utils/path-safety.ts` 整体下线（两个导出均无其他消费者）。
  - **清单方向已核**：`path-safety.ts` 的 4 条 `DENIED_SEGMENTS` 是 `permissions.ts` 锚点清单的**真子集** —— `.env`、`.git`、`data/*.db`、`data/model-config.json` 四条在 `EXECUTION_ANCHORS` 里都有对应项；而 `permissions.ts` 另有 `.ssh`/`sudoers`/`crontab`/`systemd`/`authorized_keys`/`id_rsa`/`.axiom\/axiom-secrets`/`ld.so.preload`/`.github/workflows` 等约 10 项它没有。⇒ **切换只会更严，不会放松**。
  - **唯一真实行为差异（必须在 C-0 内显式裁决）**：`path-safety.ts` 的 `isPathSafe` 在"目标与其父目录都无法 realpath"时**保守放行（fail-open）**，注释写明理由是"新建文件属合法场景"；而 `safe-fs.ts` 的 `realAncestor` 逐跳锚定是 fail-closed 方向。docker 挂载目录**允许尚不存在** ⇒ 直接切换可能把合法的新目录判拒。处置：要么在 C-0 内为该场景保留一条显式的"不存在即按解析后路径判定"分支并写测试锁住，要么改成"拒绝 + 上层创建后再校验"，二者都要留证据，**不得靠"统一了"当作理由略过**。
- **C-1 `safeFsFor(policy)` 薄工厂 + 4 个写点绑定**：工厂只接受根政策，内部转调 `authorizePath` / `decideCapability`，**不得含任何自己的路径判断**；落点根取自该功能**已有的** env，缺省仍为 cwd ⇒ 合法部署下行为不变。
- **C-2 吞错显式化**：`skill-promoter` 与 `skill-quality` 两处"写失败静默"改为记日志 + 计数。**必须单独提交** —— 这是行为变更，不能混进"纯重构"。

## 理由

- 规则 8：**先消灭重复，再谈抽象**。C-0 完成后，"根从哪来"才只有一个地方需要回答；否则工厂会把两份守卫的分歧固化成接口。
- 规则 8"两个适配器才叫真接缝"：现在确实存在两种根需求（docker 挂载 = cwd 锚定；vault/skills/db = 运维可配），工厂不是为想象中的需求写的。
- 规则 1 / YAGNI：不引入命名根配置面，因为它的第二个用户（D-B 的 allow-list）目前不存在。

## 备选与否决理由

- **各站点各自传 `roots`（原 C-1）**：判定内核零改动，但"必须传根"退化成口头约定，漏传即静默裸奔，且没有任何机器判据能发现漏了。否决。
- **命名根集中化（原 C-2，拟新增 config 下的 sandbox-roots.json）**：口径一次统一，但要改 `safeFs` 公共接口并回归 9 个既有消费者，而当下只有 1 个命名根用户 ⇒ 属"为以后可能需要写代码"。否决；若 D-B 落地后出现第二个真实用户，再复议，并按规则 0.7 走不兼容变更。
- **直接把 4 个写点套现有 `safeFs`**：会把合法写入打成拒绝，又因两处调用方吞错而表现为**持久化静默失效**，比现状更坏。否决。

## 三条机器判据（"没有制造出第二份守卫"怎么证明）

1. **结构门**：`grep -rn 'startsWith("\.\.")' src/` 与 realpath 系命中，只允许落在 `src/utils/safe-fs.ts`；`path-safety.ts` 的包含判定下线后该文件必须 **0 命中**。挂进 `tests/architecture-integrity.test.ts` 家族。
2. **结论相等门**：对同一批语料（cwd 内、`..` 穿越、绝对路径、符号链接、盘符形态），`safeFsFor(policy)` 的允许/拒绝必须与 `authorizePath(target, { roots: [policy.root] })` **逐条相同**。照抄仓库既有做法 —— `tests/command-danger-single-source.test.ts`（S-9 锁结构、该测试锁结论相等）。
3. **不可构造门**：`safeFsFor` **无默认根** ⇒ 不给根就编译不过；再加一条源码级断言：工厂文件内不得出现 `realpath` / `relative(` / `startsWith("..")` / 路径正则（工厂只能是转发，不能是判定）。

## 后果与回退条件

- (+) 越界判定单源；(+) 4 个写点纳入锚点且"漏绑根"在编译期即失败；(+) 现有 9 个 `safeFs` 消费者零改动；(+) `filesystem.ts` 那句"与本工具无关"的注释可以退休。
- (-) C-2 之后写失败会进日志与计数（预期变更，需回归确认不刷屏）。
- (-) ~~符号链接验收在本机不可跑 ⇒ 必须在 Linux runner 上取绿~~ → **2026-09-24 已在 Linux 容器实测兑现**：`oven/bun:1.3.14` 内跑本文件，`S-3` 全 11 条通过（含本机 `EFAULT` 跑不了的两条）。残留两点如实记下：① 本机 Windows 侧那 2 条仍是环境性红（平台语义差异，不是判据失效）；② 同一容器**不能当通用 runner** —— `S-2`/`S-8` 三条整仓扫描用例在容器里全部 5s 超时（整份 179s vs 本机 5.9s，bind-mount I/O 饿死），故扫描类门的绿度只在原生运行上取。
- 回退：三刀各自独立提交，任一刀 `git revert` 即可；C-0 的回退 = 恢复 `docker-sandbox.ts` 的 `isPathSafe` 调用与 `path-safety.ts` 的实现。
- 验收口径：稳定红集合**不得增大**，且必须同机跑 ≥3 次取交集后才允许当判据。当前实测（2026-09-24）：doc-contract 门禁修好后为 **5 条** = 2 条 `S-3` 符号链接（本机 EFAULT，需 Linux runner）+ 2 条高并发压力项（`LLMClient 50 并发`、`Mega 500 并发`）+ 1 条 `(unnamed)`；历史值依次是 17（含 13 条门禁自身的分隔符假红）→ 7 → 5。原 7 中的 `CognitivePipeline`、`B+C DRE 降级链`、`E.4 p99` 已降级为负载敏感（多次运行里只偶发）。构成与机制见设计稿 §1 基线更正段。

## 施工实测与前提更正（2026-09-23，C-0 落地时）

本 ADR 上文的两处前提在施工中被实测修正。**两条都是我自己核对时抓出来的，不是外部反馈。**

1. **"唯一真实行为差异是 fail-open"这句错了。** 用 12 条语料实跑三侧判定（`isPathSafe` / `authorizePath(fs.read)` / `authorizePath(fs.write)`）：
   **结论不一致只有 2 条，且方向全部是 safe-fs 更严** —— `<cwd>/.ssh` 与 `<cwd>/.axiom/axiom-secrets` 旧实现**放行**、单源后由 `EXECUTION_ANCHORS` 里的 `.ssh` 与 `.axiom/axiom-secrets` 两条锚点拦下；
   其余 10 条（含"根内不存在的单层/多层目录"）三侧一致。⇒ `src/utils/path-safety.ts` 那处 fail-open **不构成迁移障碍**，
   safe-fs 的 `realAncestor()` 在整条链都不存在时返回 null 并跳过 realpath 复核，两侧对"尚不存在的路径"行为相同。C-0 因此**不需要额外分支**。
   能力取 `fs.read` 的依据是该挂载本身是只读的（`dockerSandbox.execute` 拼 `-v ${mountDir}:/workspace:ro` 那行），不是随手挑的。
2. **"全仓第二份守卫只剩 docker 一处"这句也错了，实际是三份。** 施工时按 `realpathSync` / `startsWith("..")` 反查发现：
   | 包含判定实现 | 位置 | `src/` 内消费者 | 与 `permissions.ts` 锚点清单的关系 |
   |---|---|---|---|
   | `withinAny()` | `src/utils/safe-fs.ts` | 9 个文件（权威） | 权威清单本身（14 条 `anchor()`） |
   | `isWithinAnyRoot()` | `src/knowledge/document-ingest.ts` | 1（`assertReadableFile`） | 另有 `INGEST_DENIED_SEGMENTS`（`.env`/`.git` 2 条）——**第三份敏感段清单**，且是 permissions 的子集 |
   | `isPathSafe()` | path-safety.ts（C-0 时已删除；2026-09-26 归一随文件回归并恢复判定实现） | 1（`src/sandbox/execution-guard.ts`，ku 沙箱统一层） | **`isPathSafe` 判定已随归一回退并在册**（归一裁决保留 ku 沙箱统一层的现役消费者，见文末归一裁决；2026-09-23 旧实现归档 `archive/safefs-single-source-2026-09-23/`） |
   | `escapesBase()` | `src/utils/platform.ts` | **0（只有自身测试引用）** | 无清单，纯判定 |

   ⇒ 两处修正结论：**C-0 只完成 1/3**；`document-ingest` 那份**不能并进 C-0**，因为它的 roots 是
   `[process.cwd(), resolve(OBSIDIAN_VAULT_PATH)]`（`ingestDocument` 内那处 roots 组装）——**含一个可落在 cwd 之外的配置根**，
   而 `safe-fs` 的 `effectiveRoots` 只允许从 cwd 收窄 ⇒ **必须先有 C-1 的可配根**。
   反过来，这也给了 C-1 一直缺的"第二个真实适配器"（规则 8）：合并前 `document-ingest` 与 `safe-fs` 是两个独立需求方，
   C-1 不再是投机抽象。另可考虑把纯判定下沉到 `platform.escapesBase`（它已有测试、当前生产零消费者）作为唯一 primitive。
3. 敏感段清单三份并存，与 R3-B 修过的"命令危险判据两份清单"是同一缺陷类别在路径维度复发；
   `INGEST_DENIED_SEGMENTS` 与 `path-safety` 的 `DENIED_SEGMENTS` 都是 permissions 锚点的子集 ⇒ 收敛方向明确（并集已在 permissions，删除即收紧），
   但**必须逐条实测确认没有"只存在于子清单"的项**后才能删 —— 本次 C-0 用的正是这个口径。

**C-0 落地结果**：`docker-sandbox.ts` 挂载栅栏改走 `authorizePath(resolved, "fs.read")`，非 `CapabilityDeniedError` 的异常原样上抛（不把崩溃伪装成"目录被拒"）；
`path-safety.ts` 归档后出库；`tests/docker-sandbox-mount.test.ts` 补 2 条收紧用例 + 10 行围栏判定表 + 静态断言改为"`src` 内不得再出现 `isPathSafe`/`path-safety`"；
`tests/filesystem-symlink.test.ts` 原本读 `path-safety.ts` 源码文本、随之下线，重写为指向 `safe-fs.ts` 并**在注释里声明它只是静态断言**（真正的符号链接行为覆盖是 `S-3`，本机 EFAULT 不可跑）。
ADR 里 `.ssh`/`.axiom` 两条收紧是**登记的预期行为变更**：容器只读挂载本就不该能读到宿主凭据目录。

## C-1 施工实测：本 ADR 的 C-1 前提不成立，已停下待裁决

C-1 原写"落点根取自该功能已有的 env，缺省仍为 cwd ⇒ 合法部署下行为不变"。**这句是错的**，实测证据：

- `effectiveRoots`（`src/utils/safe-fs.ts`）会把任何不在 `process.cwd()` 内的 roots **静默过滤掉**，
  过滤到空集后连根自身都会被拒 ⇒ "配置根可落在 cwd 之外"在当前不变式下**根本无法表达**，不是工厂能补的。
- 更直接的反证：仓库自己的测试就用沙箱外绝对路径当合法落点 ——
  `tests/hardening-t8-low.test.ts` 的 `dir = mkdtempSync(join(tmpdir(), "skill-quality-t8-"))`，
  并在随后的两条用例里传给 `createFileQualityStore`。把该写点绑到 cwd 沙箱内 ⇒ 这两条测试必红，
  且任何把 `OBSIDIAN_VAULT_PATH` / `filePath` 配到仓库外的真实部署同样会坏。

⇒ **`safeFsFor` 工厂与其 13 条测试作为已验证的基件先入库（当前无消费者，不得读作"围栏已生效"），
4 个写点的绑定与 `document-ingest` 的合并一并冻结**，等下面这个政策裁决：

| 方案 | 内容 | 代价 |
|---|---|---|
| **P-1 沙箱根可配** | 新增 `AXIOM_SANDBOX_ROOT`（默认 `process.cwd()`），4 个写点与 9 个既有消费者统一以它为基准；"vault 在仓库外"变成"把沙箱根设到共同父目录" | 保持"roots 只收窄"不变式；但需一次性核查现网配置，并把上述测试夹具改为落在沙箱内（或显式注入该 env） |
| **P-2 只围栏"模型可控"写点** | 由代码/运维传入绝对路径的写点不绑沙箱，仅对入参可被模型影响的点强制 | 需要一份可信的"谁可控"清单——这正是 §2.7.5 里 `mcp.external` 那行承认答不出来的东西，等于把问题往后推 |
| **P-3 维持现状** | 4 个写点继续裸 `fs`，只登记 | 收紧面不增；§2.7.5 的 C 组条目继续挂着 |

推荐 **P-1**：它不放宽任何不变式，且把"合法的外部落点"变成显式配置而非隐式豁免；代价是一次配置核查与测试夹具改造，都可验证、可回滚。

## 归一裁决（2026-09-26，主干归一合并 ku 线）

ku 线（knowledge-unify-2026-09-17）在 `src/utils/path-safety.ts` 独立发展出一份 containment 原语 `isWithinBase(base, target)`，
`src/sandbox/execution-guard.ts` 等 13+ 文件依赖它。归一裁决：**文件回归，且随文件一并恢复 `isPathSafe` 判定实现**
（cwd 围栏 + 敏感段拒绝 + symlink realpath 校验；ku 线从未实现过第二份敏感路径清单，其清单语义仍是 permissions 锚点的子集）。
`src/sandbox/execution-guard.ts`（其 `execution-guard` 内的值围栏分支）是 `isPathSafe` 的现役消费者（ku 沙箱统一层），这是合并产生的**新事实**：
与本 ADR C-0 的「`isPathSafe` 判定下线」相反，作为登记的归一结构变更记录在案；C-0 的其余实质
（挂载栅栏走 `authorizePath`、`safe-fs` 仍是 I/O 特权唯一执行点）不受影响；上文"现已删除"等叙述按 2026-09-23 当时事实保留。
文内原有的三处墓碑注释哨兵（HTML 注释形态，指向本文件路径的反向断言）随之移除 —— D3 墓碑断言以"文件存在于工作树"为准，文件复活后墓碑失效。
单源原则不变：权威判定仍在 `src/utils/permissions.ts`（锚点清单）与 `src/utils/safe-fs.ts`（I/O 点）；
`path-safety.ts` 不含任何敏感段清单，不得再长出第二份清单（三条机器判据之结构门继续适用）。
