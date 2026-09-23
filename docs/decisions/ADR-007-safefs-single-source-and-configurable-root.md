# ADR-007：路径判定单源化与沙箱根可配（safeFs 扩面）

- 日期：2026-09-23 ｜ 状态：**提案，待批准** ｜ 决策人：项目经理（用户）
- 背景：`docs/SECURITY-MEASURES.md` §2.7.5 的 C 组（"写盘未经 `safeFs`"）。本轮勘察实测出的三件事**改变了问题形状**，故先记录事实再记决定：
  1. 文档称 6 个裸写点，**实测 4 个** —— `src/memory/knowledge-graph-builder.ts` 对 `fs.`/`writeFile`/`mkdir`/`Database`/`INSERT` 零命中，该声明不可复现。
  2. `src/utils/safe-fs.ts` 头注释（L4-L11）声称"两份互不复用的路径守卫"已由它终结，但 **`src/utils/path-safety.ts:22 isPathSafe()` 至今仍是一套独立实现**（自做 `path.relative(cwd,…)` + `startsWith("..")` + 自有 realpath 与父目录 realpath）。`src/mcp/tools/filesystem.ts:17-18` 的注释本身也确认："utils/path-safety.ts 仍在 docker-sandbox 的挂载白名单里使用"。实测收敛面极小：**全仓（`src/` + `tests/`）只有 1 处 import** —— `src/sandbox/docker-sandbox.ts:4`，调用点 1 处 —— `:38`；同文件导出的 `resolvePath` **零消费者**（`src/agent-evals/real-usage.ts:31` 那个同名符号是它自己的局部函数）；且 `tests/` 下**没有任何测试 import 过 `path-safety`** ⇒ 第二份守卫目前处于无自身测试的状态。
  2b. 两份文件**各自声称自己是唯一来源**：`path-safety.ts:2` 写"唯一围栏语义源"、`:20` 写"工具层不各自发明第二套围栏"；`safe-fs.ts:2` 写"文件系统特权的唯一执行点"，而其 L4-L11 正是在叙述"原有两份互不复用的守卫"如何被终结。三个声明互不自洽 —— 这是文档层面的口径事故，C-0 完成后应随之收敛（`filesystem.ts:17-18` 那句"与本工具无关"的注释也一并退休）。
  3. 落点 env（`OBSIDIAN_VAULT_PATH=./axiom-memory`、`DATABASE_PATH=./data/agent.db`、`skillDirRel`）默认 cwd 相对，但都是**可被运维改成任意绝对路径的普通 env**，且无 `AXIOM_HOME` 一类收口项 ⇒ `safeFs`"根固定 `process.cwd()`、roots 只收窄"与真实部署不兼容。

## 决定

把 C 拆成三刀，**顺序即依赖顺序**：

- **C-0 收敛第二份守卫（不引入任何新抽象）**：`docker-sandbox.ts:38` 的挂载栅栏改走 `safeFs.authorizePath`；`path-safety.ts` 整体下线（两个导出均无其他消费者）。
  - **清单方向已核**：`path-safety.ts:42-47` 的 4 条 `DENIED_SEGMENTS` 是 `permissions.ts` 锚点清单的**真子集** —— `.env`→`:270`、`.git`→`:260`、`data/[^/]+\.db`→`:274`、`data/model-config.json`→`:273`；而 `permissions.ts` 另有 `.ssh`/`sudoers`/`crontab`/`systemd`/`authorized_keys`/`id_rsa`/`.axiom\/axiom-secrets`/`ld.so.preload`/`.github/workflows` 等约 10 项它没有。⇒ **切换只会更严，不会放松**。
  - **唯一真实行为差异（必须在 C-0 内显式裁决）**：`path-safety.ts:77-86` 在"目标与其父目录都无法 realpath"时**保守放行（fail-open）**，注释写明理由是"新建文件属合法场景"；而 `safe-fs.ts:90` 的逐跳锚定是 fail-closed 方向。docker 挂载目录**允许尚不存在** ⇒ 直接切换可能把合法的新目录判拒。处置：要么在 C-0 内为该场景保留一条显式的"不存在即按解析后路径判定"分支并写测试锁住，要么改成"拒绝 + 上层创建后再校验"，二者都要留证据，**不得靠"统一了"当作理由略过**。
- **C-1 `safeFsFor(policy)` 薄工厂 + 4 个写点绑定**：工厂只接受根政策，内部转调 `authorizePath` / `decideCapability`，**不得含任何自己的路径判断**；落点根取自该功能**已有的** env，缺省仍为 cwd ⇒ 合法部署下行为不变。
- **C-2 吞错显式化**：`skill-promoter` 与 `skill-quality` 两处"写失败静默"改为记日志 + 计数。**必须单独提交** —— 这是行为变更，不能混进"纯重构"。

## 理由

- 规则 8：**先消灭重复，再谈抽象**。C-0 完成后，"根从哪来"才只有一个地方需要回答；否则工厂会把两份守卫的分歧固化成接口。
- 规则 8"两个适配器才叫真接缝"：现在确实存在两种根需求（docker 挂载 = cwd 锚定；vault/skills/db = 运维可配），工厂不是为想象中的需求写的。
- 规则 1 / YAGNI：不引入命名根配置面，因为它的第二个用户（D-B 的 allow-list）目前不存在。

## 备选与否决理由

- **各站点各自传 `roots`（原 C-1）**：判定内核零改动，但"必须传根"退化成口头约定，漏传即静默裸奔，且没有任何机器判据能发现漏了。否决。
- **命名根集中化 `config/sandbox-roots.json`（原 C-2）**：口径一次统一，但要改 `safeFs` 公共接口并回归 9 个既有消费者，而当下只有 1 个命名根用户 ⇒ 属"为以后可能需要写代码"。否决；若 D-B 落地后出现第二个真实用户，再复议，并按规则 0.7 走不兼容变更。
- **直接把 4 个写点套现有 `safeFs`**：会把合法写入打成拒绝，又因两处调用方吞错而表现为**持久化静默失效**，比现状更坏。否决。

## 三条机器判据（"没有制造出第二份守卫"怎么证明）

1. **结构门**：`grep -rn 'startsWith("\.\.")' src/` 与 realpath 系命中，只允许落在 `src/utils/safe-fs.ts`；`path-safety.ts` 的包含判定下线后该文件必须 **0 命中**。挂进 `tests/architecture-integrity.test.ts` 家族。
2. **结论相等门**：对同一批语料（cwd 内、`..` 穿越、绝对路径、符号链接、盘符形态），`safeFsFor(policy)` 的允许/拒绝必须与 `authorizePath(target, { roots: [policy.root] })` **逐条相同**。照抄仓库既有做法 —— `tests/command-danger-single-source.test.ts`（S-9 锁结构、该测试锁结论相等）。
3. **不可构造门**：`safeFsFor` **无默认根** ⇒ 不给根就编译不过；再加一条源码级断言：工厂文件内不得出现 `realpath` / `relative(` / `startsWith("..")` / 路径正则（工厂只能是转发，不能是判定）。

## 后果与回退条件

- (+) 越界判定单源；(+) 4 个写点纳入锚点且"漏绑根"在编译期即失败；(+) 现有 9 个 `safeFs` 消费者零改动；(+) `filesystem.ts:17-18` 那句"与本工具无关"的注释可以退休。
- (-) C-2 之后写失败会进日志与计数（预期变更，需回归确认不刷屏）。
- (-) **符号链接验收在本机不可跑**（`S-3` 两条 `EFAULT … rm 'src/link-to-hooks'`）⇒ C-0/C-1 的符号链接用例必须在 Linux runner 上取绿，或本机开 Windows 开发者模式复测并把该前提写进验收，**不得默认成立**。
- 回退：三刀各自独立提交，任一刀 `git revert` 即可；C-0 的回退 = 恢复 `docker-sandbox.ts` 的 `isPathSafe` 调用与 `path-safety.ts` 的实现。
- 验收口径：稳定红 **17 条不得增大**；涉及时序的新测试同机跑 ≥3 次取交集（实测同基线三次为 28 / 17 / 17，见设计稿 §1）。

## 施工实测与前提更正（2026-09-23，C-0 落地时）

本 ADR 上文的两处前提在施工中被实测修正。**两条都是我自己核对时抓出来的，不是外部反馈。**

1. **"唯一真实行为差异是 fail-open"这句错了。** 用 12 条语料实跑三侧判定（`isPathSafe` / `authorizePath(fs.read)` / `authorizePath(fs.write)`）：
   **结论不一致只有 2 条，且方向全部是 safe-fs 更严** —— `<cwd>/.ssh` 与 `<cwd>/.axiom/axiom-secrets` 旧实现**放行**、单源后由 `permissions.ts:267`/`:269` 锚点拦下；
   其余 10 条（含"根内不存在的单层/多层目录"）三侧一致。⇒ `path-safety.ts:77-86` 的 fail-open **不构成迁移障碍**，
   safe-fs 的 `realAncestor()` 在整条链都不存在时返回 null 并跳过 realpath 复核，两侧对"尚不存在的路径"行为相同。C-0 因此**不需要额外分支**。
   能力取 `fs.read` 的依据是该挂载本身是只读的（`docker-sandbox.ts:101` 的 `-v ${mountDir}:/workspace:ro`），不是随手挑的。
2. **"全仓第二份守卫只剩 docker 一处"这句也错了，实际是三份。** 施工时按 `realpathSync` / `startsWith("..")` 反查发现：
   | 包含判定实现 | 位置 | `src/` 内消费者 | 与 `permissions.ts` 锚点清单的关系 |
   |---|---|---|---|
   | `withinAny()` | `src/utils/safe-fs.ts:51` | 9 个文件（权威） | 权威清单本身（14 条 `anchor()`） |
   | `isWithinAnyRoot()` | `src/knowledge/document-ingest.ts:86` | 1（`assertReadableFile`） | 另有 `INGEST_DENIED_SEGMENTS`（`.env`/`.git` 2 条）——**第三份敏感段清单**，且是 permissions 的子集 |
   | `isPathSafe()` | `src/utils/path-safety.ts` | — | **本 ADR C-0 已删除**（归档 `archive/safefs-single-source-2026-09-23/`） |
   | `escapesBase()` | `src/utils/platform.ts` | **0（只有自身测试引用）** | 无清单，纯判定 |

   ⇒ 两处修正结论：**C-0 只完成 1/3**；`document-ingest` 那份**不能并进 C-0**，因为它的 roots 是
   `[process.cwd(), resolve(OBSIDIAN_VAULT_PATH)]`（`:97`）——**含一个可落在 cwd 之外的配置根**，
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
