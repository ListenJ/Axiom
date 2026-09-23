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
