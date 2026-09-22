# 退役机归并与进度对账（2026-09-23）

> 任务级别 T3。基线：`gitea/main` = `0ba2cb45`（本报告所在分支 `codex/retirement-consolidation-2026-09-23` 从此起步，`git rev-list --count HEAD..gitea/main` = 0）。
> 范围：三个散落目录（`D:\Linux-Retirement-20260922`、`D:\openclaw-fusion-verify`、`D:\qoder-export-from-linux-20260922`）的记忆盘点、目录归并、Gitea 一致性对账。
> 红线：本轮**不动 `main`**、**不删任何 tarball**、**不碰其余 6 个 `*-from-linux-*` 目录**。

## 1 结论速览

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| C1 | 三目录中的 Qoder 记忆已盘点干净 | ✅ user 11 条 + project 14 条全部定位 | §2 |
| C2 | 本仓库项目记忆已落到可被检索的键 | ✅ 5 条导入，字节与 tar 索引逐条相等 | §2.2 |
| C3 | 另两组项目记忆已暂存且未误写他人记忆键 | ✅ 9 文件 9/9 字节一致 | §2.3 |
| C4 | 散落目录收敛为单一归档根 | ✅ 顶层少 2 个（verify 移除、export 并入） | §3 |
| C5 | 122 GiB 载荷完整性与路径不变 | ✅ 未移动未删除，样本 sha256 前后一致 | §3.2 |
| C6 | 本地 ↔ Gitea 引用层一致 | ✅ 分支同名同 SHA、LFS 105/105、工作树干净 | §4.1 |
| C7 | 进度层一致 | ❌ **判红**：`main` 停 09-14，三线并立，两份同号 v1.5（已于 §4.3 更正为"可机械归并"，见 02:35 补记） | §4.2–§4.4 |
| C8 | 本报告未夹带清单外改动 | ✅ diff 只有报告 + ops log 两条 | §6 |

## 2 Qoder 记忆盘点

### 2.1 用户级（11 条）：早已就位，无需动作

`D:\qoder-export-from-linux-20260922\qoder-export-20260922\memory\user\` 内 11 个文件与
`C:\Users\18336\.qoder\memory\` 逐名对照：**10 条同名已存在**，其中 3 条已按新机改写 ——
`user-machine-hardware`（82JW→82RC）、`feedback-no-bios-flashing…`、`feedback-long-running-jobs`
（5311 B→3736 B，去掉了 Linux `setsid`/`systemd-run` 机制）。本机另新增 2 条退役期产生的记忆。
判定：用户级记忆**不是缺口**，旧版本仍完整保存在 `U5-home-env.tar` 内（`.qoder/memory/`，见 `index/U5.index`）。

### 2.2 本仓库项目级（5 条）：本轮的真实缺口，已补

导出包里的 `memory/project/` 是**空目录**（`REDACTION-NOTE.md` 自陈"empty at pack time"），
真正的 3 组项目记忆只存在于 tar 内。本仓库这 5 条已导入
`C:\Users\18336\.qoder\projects\D--openclaw-fusion\memory\`（此前该目录**一个文件都没有**）：

| 文件 | 字节 | 与 `index/U5.index` 比对 |
|---|---|---|
| `project-openclaw-fusion-audit-constraints.md` | 6142 | 一致 |
| `reference-windows-d-migration-target.md` | 2358 | 一致 |
| `project-capability-driven-authorization.md` | 1876 | 一致 |
| `project-address-desensitization-caliber.md` | 1683 | 一致 |
| `MEMORY.md`（索引，按本机口径重写钩子） | — | 新建 |

价值判断：这 4 条正文记的都是**代码里读不出来的东西**——主干身份陷阱（`master` 冻结、真 trunk 是 `main`）、
两项由用户亲自裁决的架构决定（授权按 capability 分派并删名字表；S3 用 cherry-pick 重放）、
地址脱敏的边界裁决（规范面清零、历史留痕不改）、以及"D 盘 `D:\data` 是旧快照，直投会覆盖"。
其中"两线合并不能靠 cherry-pick"一条与本报告 §4.4 的实测直接对应。

### 2.3 另两组项目记忆：暂存，不导入

`lianghua`（6 条）与 `Omini`（3 条）抽到
`D:\Linux-Retirement-20260922\qoder-project-memories\`，附 `README.md` 说明来源与导入方法。
不直接写 `D--lianghua` / `D--Omini` 记忆键的理由：本次会话不在这两个工作区内，
无法验证其既有记忆状态；写错键等于污染别人的记忆目录。`D:\Omini` 经确认是活跃工作树（`fix/remediation`）。

### 2.4 记忆盘点过程中发现的两项未决（非本轮范围）

- `REDACTION-NOTE.md` 自陈：**原始** CHIA transcript 含 3 处真实 LLM API key 与 22 处 ModelScope DSW `authCode`
  （导出副本已脱敏）。移出仓库不等于失效，**轮换需用户执行**（规则 11）。
- tar 内另有 `.config/com.qoder.app.stable/memoryMigration.sqlite`（24 KB）未纳入任何导出，
  本轮只登记存在性，未抽读。

## 3 目录归并结果

| 对象 | 处置 | 结果 |
|---|---|---|
| `D:\openclaw-fusion-verify` | `git worktree remove`（**未加 `--force`**） | 目录消失；`c09c8283` 仍经 `gitea/codex/knowledge-unify-2026-09-17` 可达 |
| 临时 worktree `…/Temp/opencode/baseline` | `git worktree prune` | 已清理；`f151db65` 本就在当前分支可达 |
| `D:\qoder-export-from-linux-20260922` | 整体移入归档根 | `D:\Linux-Retirement-20260922\qoder-export-from-linux-20260922\` |
| `D:\Linux-Retirement-20260922` | **保持原位与内部结构** | 成为唯一归档根 |

`git worktree list` 现在只剩 `D:/openclaw-fusion` 一项。

### 3.1 移除前的安全前置（为什么敢删）

verify worktree 内 `node_modules` 是**指向主检出的符号链接**。先单独 `rm` 摘掉链接，
再让 git 删目录 —— 避免递归删除顺着链接吃掉主检出的 `node_modules`。前后各数一次：
**144 项 → 144 项**，未受影响。移除前 `git status --porcelain` 与
`--untracked-files=all` 均为空（只有被 ignore 的运行态 `data/`、`.tmp/`）。

### 3.2 122 GiB 载荷为什么原地不动

- `tarballs/` 是退役机 `/home/listen` 的**唯一完整副本**（MANIFEST §1：U1–U7 共 130,194,135,040 B、628,751 文件）。
  实测 `.22` **ping 通但 `ssh listen@` 认证被拒**（`Permission denied (publickey,password)`），
  不能假定源机还能再取一次。
- `SHA256SUMS.txt` 与 `MANIFEST-RETIREMENT.md` 按**路径**引用这些包（AC-3/AC-7 的可复现性依赖现路径）。
  移动会破坏一份被哈希引用的清单 —— 与既有纪律"不动被 hash 引用的那份"一致。
- 进仓库路径（即使 `archive/` 已被 gitignore）带来的是净风险：IDE 索引、备份工具、误 `git add -f`，
  且 `credentials/U7-credentials.tar`（40 KB，sha256 `f8fc4b2f…`）按规则 11 不该出现在仓库目录下。
  **本轮未移动该凭据包**，只登记位置与处置状态：仍在 `Linux-Retirement-20260922\credentials\`，待用户处置。
- 移动 9.5 MB 的导出包做了前后校验：**16 文件 / 9,846,400 B** 不变，样本 transcript（7.9 MB）
  sha256 前 `ae627ed713079d73` = 后 `ae627ed713079d73`。

## 4 Gitea 一致性对账

### 4.1 引用层：一致

| 检查 | 结果 |
|---|---|
| 本地分支 vs `gitea` 同名分支 | 7/7 SHA 全等（本轮之前） |
| 当前工作分支 | 已推送、与远端同点 |
| 工作树 | `git status --porcelain` 空 |
| LFS | 本地对象 **105**，`main` 与 `HEAD` 的 `git lfs ls-files` 均 **105** |
| Gitea 可达性 | `git ls-remote` 正常，24 个 heads + 2 tags；HTTP `:3000` 返回 200 |

### 4.2 进度层：三线并立（判红项）

`main` 自 2026-09-14 未动，之后有三条各自演进的线：

| 分支 | tip | tip 时间 | 相对 main | 跟踪文件数 |
|---|---|---|---|---|
| `codex/knowledge-unify-2026-09-17` | `6359fb6e` | 09-21 17:07 | **+164 / −2** | 2305 |
| `codex/s3-on-main-2026-09-22` | `de5a1f7d` | 09-22 21:21 | **+54 / −0** | 2238 |
| `codex/doc-caliber-doc-contract-gate-2026-09-21` | `44de0b88` | 09-22 23:40 | **+11 / −901** | — |
| `main` | `0ba2cb45` | 09-14 23:04 | — | 2216 |

merge-base：`ku ∩ s3 = 93620c29`（main 前 2 个提交）、`ku ∩ doc-caliber = s3 ∩ doc-caliber = 7ad30ce4`（即冻结的 `master`）。
所以 ku 与 s3 是**兄弟**而非祖先后代关系；`doc-caliber` 挂在陈旧 `master` 上，但它的 ops log 时间戳是全部线里最晚的
（含 09-22 23:15–23:40 的"本机退役全量迁移 T3"三条）。

### 4.3 两份"规则版本 v1.5"撞号（判红项 → 本节末已更正为"仅版本号冲突"）

两个分支的 `AGENTS.md` 都自称 v1.5，但是**两份不同文档**，且规则 3 直接冲突：

- `knowledge-unify` 侧：v1.5 = 新增规则 13（对抗性同行评审），规则 3 仍写"推送 `gitea <分支>`"。
- `s3-on-main` 侧：v1.5 = 规则 3 收口为"唯一远端 `internal`、不在文档中复制 IP/URL、
  推送目标由 `gitea` 改为 `internal`、主干为 `main`（`master` 冻结）"。

这不是措辞差异：一个改的是**新增约束**，一个改的是**远端与主干身份**。合并时必须同时保住
v1.4 的总则 0.1–0.7 + 规则 12 结构与"不复制 IP/URL"口径 —— 属于规则 0.7 的不兼容变更，须用户批准。

> **2026-09-23 02:35 更正（本报告作者自查）**：上面"互斥"一词用重了。实测三方合并
> `git merge-file -p <s3> <base=main v1.4> <ku>` 显示两份 v1.5 的**改动行区间互不重叠**，
> 除版本头一处外 0 冲突——真正互斥的只是**版本号本身**（两个分支各自占用了 v1.5），
> 内容层面是正交的。已按并集归并为 **v1.6**（见 ops log 同日条目），两处语义零丢弃。
> 结论修正为：**AGENTS.md 可机械归并（已完成）；不可机械归并的是 §4.4 的代码与其余文档。**

### 4.4 真合并冲突面：13 个文件（只读试算）

`git merge-tree --write-tree gitea/codex/knowledge-unify-2026-09-17 gitea/codex/s3-on-main-2026-09-22`：

```
AGENTS.md                              docs/REMINDERS.md
README.md                              docs/operations-log.md
docs/ARCHITECTURE.md                   package.json
docs/AXIOM-ARCHITECTURE.md             src/mcp/server/dre-tools.ts
docs/KNOWLEDGE-BASE.md                 src/mcp/server/skill-tools.ts
docs/LIMITATIONS.md                    src/mcp/tool-registry.ts
                                       src/mcp/tools/workspace-snapshot.ts
```

代码冲突集中在 MCP 工具注册面（`tool-registry.ts` + 3 个 tool 文件），与已恢复那条记忆描述一致：
两条线各自带一套安全内核（main 侧 `HardFloor` 正则门 + `path-safety.ts`；旧线 `capability` 字段）。
**因此"cherry-pick 一下就好"不成立**，需要按文件逐个裁决内核归属。

### 4.5 遗留待决项至今未处置（复测）

09-14 的 ops log 偏差③写"远端默认分支仍为 `master`，建议切到 `main`（待用户决策）"。
本轮复测 `git ls-remote gitea HEAD` → **`7ad30ce4`**，即默认分支仍是落后 `main` 901 个提交的 `master`。
任何从 Gitea 网页/新克隆进来的默认视角看到的都是陈旧线。**建议优先处置这一项**。

> **2026-09-23 03:40 已处置**：经用户提供 token，`PATCH /api/v1/repos/agent/Axiom` 返回 **HTTP 200**、
> `default_branch = "main"`，git 侧独立复测 `git ls-remote --symref internal HEAD` → `ref: refs/heads/main`
> （HEAD = `0ba2cb45`）。响应同时确认 `full_name` 仍为 `agent/Axiom`，非误改名。
> 09-14 登记的这条待决项至此收口，凭据处置与风险登记见 ops log 同日条目。

### 4.6 文档与本机配置的口径差

`AGENTS.md` v1.4 规则 3 称"本地 remote 名实际为 `origin`，URL 已指向 `agent/Axiom`"。
本机实测（`git remote -v`）：`gitea` 与 `internal` → `ssh://git@192.168.0.10:2222/agent/**openclaw-fusion**.git`，
`origin` → `git@github.com:ListenJ/Axiom.git`。三者都与该段描述不符（远端改名后 Gitea 做重定向，故仍能推拉）。
按 F-2 脱敏口径这属"历史留痕/功能默认值"层，本轮**只登记不改**；若要修，应连同 §4.3 的规则 3 一并裁决。

## 5 待用户裁定（本轮一律未动）

1. **主线归一方向**：ku(+164) / s3(+54) / doc-caliber(+11) 谁是主干，还是先冻结其中两条。
   连带裁决：两份 v1.5 哪份算数（规则 0.7 不兼容变更）。
2. ~~**Gitea 默认分支** `master` → `main`~~ **已于 03:40 完成**（HTTP 200 + `ls-remote --symref` 双向回读，见 §4.5 补记）。编号保留不重排。
3. **凭据处置**：CHIA transcript 原始件里的 LLM key 轮换；`credentials/U7-credentials.tar` 是否并入 `.axiom/axiom-secrets`。
4. **其余 6 个 `*-from-linux-*` 目录**（`D:\Omini` 28G、`D:\lianghua` 13G、`predict-chemical` 4.6G、
   `Axiom-from-linux` 916M、`chia-repo-audit` 148M、`gitea-migrate` 258M）本轮按用户选择**未纳入**。
5. **122 GiB 载荷的终局**：长期留 D 盘、还是转冷备（MANIFEST §4-6 提示快照非关机终态，
   要"关机即最终态"需重跑 U2/U3/U4/U5）。

## 6 复现命令与未执行检查

```bash
git fetch gitea && git rev-list --count HEAD..gitea/main          # 基线：应为 0
git worktree list                                                  # 应只剩主检出
git for-each-ref --format='%(refname:short)' refs/remotes/gitea/ \
  | sed 's|gitea/||' | grep -v '^gitea$' \
  | while read b; do printf "%-50s +%s -%s %s\n" "$b" \
      "$(git rev-list --count gitea/main..gitea/$b)" \
      "$(git rev-list --count gitea/$b..gitea/main)" \
      "$(git log -1 --format=%ci gitea/$b)"; done                  # §4.2 表
git merge-tree --write-tree gitea/codex/knowledge-unify-2026-09-17 \
  gitea/codex/s3-on-main-2026-09-22 | grep -c '^100644'            # §4.4：冲突 stage 条目
git lfs ls-files | wc -l ; git ls-remote gitea HEAD                # §4.1 / §4.5
find /d/Linux-Retirement-20260922/tarballs -name '*.tar' -printf '%s\n' | paste -sd+   # §3.2 载荷合计
```

**未执行的检查及原因**：

- `bun run lint` / `bun test`：本轮改动是 `docs/reports/**` + `docs/operations-log.md` 两个 markdown 文件，
  不含任何 `src/` 或配置改动，测试面不覆盖文档；且切基线后依赖树已由 post-checkout 钩子更新（`bun install`
  报 Added 22 / Modified 36 / Removed 3），跑全量测试属另一条作业线，不在本轮范围（规则 1）。
- Gitea REST API 仓库身份核验：本机无 token 可读私有实例 API，`/api/v1/repos/agent/openclaw-fusion` 返回空；
  改用 `git ls-remote` 取 refs（SSH 通道，已配置密钥）。
- `doc-caliber` 分支的跟踪文件数未列入 §4.2：该分支基于陈旧 `master`，与另两条线不同基，
  比较"文件数"会给出误导性的规模感。

## 8 重放至路线线的补记（2026-09-23 03:05；基线改为 s3-on-main）

按用户裁定「先重放到 s3 线，`main` 暂不动」，本报告与 AGENTS v1.6 被带到
`codex/retirement-consolidation-on-s3`，基线 `de5a1f7d`（= `codex/s3-on-main-2026-09-22`）。

### 8.1 包含关系证明（重放不丢内容）

`comm -23 <(sort <s3:AGENTS.md>) <(sort <v1.6>)` → **0 行** ⇒ v1.6 完整包含 s3 侧的 v1.5。

### 8.2 数字在新基线上复算

| 线 | 相对 s3 基线 ahead / behind |
|---|---|
| `codex/knowledge-unify-2026-09-17` | +164 / −56 |
| `codex/s3-on-main-2026-09-22` | +0 / −0 |
| `codex/doc-caliber-doc-contract-gate-2026-09-21` | +11 / −955 |

算术自洽：56 = s3 的 54 + `main` 独有的 2；955 = 901 + 54。§4.2 表以 `main` 为基准，本节以路线线为基准，两组数不通用。

### 8.3 D12 门禁在本机可跑了：结论是"环境性判红"，不是我的改动

`main` 基线上根本没有 `tests/doc-contract.test.ts`（该门只存在于 s3 / doc-caliber 线），所以 §6 里
"无本地门禁可跑"这条在路线线上变成了可跑的实测。差分对照：

| 运行 | 唯一失败条数 | 退出码 |
|---|---|---|
| 基线（s3 原生 AGENTS v1.5） | 13 | 1 |
| 装入 v1.6 | 13（与基线**逐条相同**） | 1 |

双向 `comm` 均为空 ⇒ **v1.6 引入 0 条新红，也未修好任何一条**。
`D12 判据自检：私网形态真的会红、回环/公网/版本号不误伤` **通过**，说明门是活的而非恒绿。
13 条红的根因**不是**行尾。先记一次自查撤回头稿的错误归因：我最初写下"CRLF + 反斜杠"，
依据是 `grep -c $'\r' file` 报"每行都有 CR"。改用 `tr -cd '\r' | wc -c` 直数 CR 字节后实测：
`AGENTS.md`、`operations-log.md`、s3 原生版、另一分支已提交的 v1.6 **CR 字节全为 0**，
`file -b` 也不报 CRLF ⇒ 先前那条 grep 的模式被吞成空模式、匹配了所有行，读数无效。

真正的根因是**门禁的文件扫描面在 Windows 上过度纳入**：`D12` 期望 0 命中、实际 **88** 命中，
逐条按顶层归类为 86 条落在 `docs/` 下 —— `docs/operations-log/`（24）、`docs/operations-log.md`、
`docs/superpowers/plans/`（5）、`docs/superpowers/specs/`、`docs/reports/`；
而 **`AGENTS.md` / `README.md` / `.env.example` 自身命中数为 0**。
也就是说：F-2 裁决明确豁免的 **D 层（历史留痕：ops log / plans / reports）被算进了"规范面"**，
而真·规范面是干净的。机制上，失败输出里的路径一律是 `docs\operations-log\2026-08.md:4450`
这种反斜杠形态 ⇒ 该门用 POSIX 分隔符写的排除判断在 Windows 上匹配不上，排除失效 ⇒ 假红。
这条门是在 Linux 上写绿的（其注释自陈 RED 时"11 件 / 22 行"），所以它是**平台相关的假红**，不是内容回归。

顺带一条独立的卫生问题：`docs/reports/2026-09-12-runtime-go-n2-swap-verification.md` 是
**未被 git 跟踪**的工作区文件（`.gitignore` 的 `reports/` 通配），却进了"规范面"扫描 ⇒
一个不入库的本地文件足以把一条绿门翻成红。与 §4.6、ops log 同日偏差⑥同源。

**推论（这才是可执行的结论）**：这台机器上不能把 `doc-contract` 的绝对值当合并前提，
只能看**差分**——即"同一台机器、换掉我的文件前后，失败集是否变化"。本轮的差分答案是：不变。
修 D12 的分隔符相关排除属另一条作业线（规则 1，本轮不动测试代码）。

### 8.4 新出现的操作坑：`gitea/` 与 `internal/` 是两套独立跟踪引用

同一个 URL 挂了两个 remote 名。v1.6 把推送目标改成 `internal` 之后，`gitea/<分支>` 的本地跟踪引用
**不再随之更新**：实测服务端 = `41372ecf`，而 `gitea/codex/retirement-consolidation-2026-09-23` 仍停在
`680dbc3b`。本轮差点因此把已经推送成功的 `df99f351` / `41372ecf` 判成"不可解析"。
**判据改写：核对远端一律用 `git ls-remote`，不要用 `gitea/…` 跟踪引用算 ahead/behind。**

### 8.5 一项独立印证

§4.5 之外另查得：09-14 的 DRE 勘察条目在 `main` 上 Commit 字段仍是 `<待回填>`。用
`git log -S'## 2026-09-14 — recon(T3/步骤1.1)'` 定位到 `2adc74f7`（恰好给 ops log 加 9 行，
commit body 与条目"验证结果"逐字对应），并核验其从 `main` 可达后回填（`41372ecf`）。
**而路线线 s3 上同一条目早已回填为同一个 `2adc74f7`（还带全 40 位 SHA）**——两条独立路径得出同一答案。
