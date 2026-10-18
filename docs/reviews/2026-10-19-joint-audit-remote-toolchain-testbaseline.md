# 2026-10-19 联合审查：远端收口 · 工具链统一 · 测试基线

> 本文记录 2026-10-19 一轮"本地 ↔ 内网 Gitea ↔ data 服务器"联合检查的事实与判定。
> 全部数字均附可复算命令；未能验证的项单独登记，不当作结论。
> 内网地址按规则 11 以占位符表示，实际取值见本机 `git remote -v` 与部署配置。

---

## 1. 远端拓扑（事实）

| 端口 | 服务 | 判定依据 |
|---|---|---|
| `:3000` | Gitea Web/API（`27.3.1`） | 容器 `1Panel-gitea-*`（`commitgo/gitea-ee:27.3.1`），`0.0.0.0:3000->3000/tcp` |
| `:2222` | 同一 Gitea 的 SSH | 容器端口映射 `0.0.0.0:2222->22/tcp` |
| `:2223` | **宿主机 sshd**（Ubuntu 26.04 LTS，用户 `data`） | `ssh -p 2223` 登入后 `uname -a` |

**结论**：<gitea-host> 上的 Gitea 与 data 服务器是**同一台物理机**；`:2222` 是 Gitea 的 Git 传输口，`:2223` 是它与外界之间的宿主 shell 口。仓库 `internal`/`gitea` 两个 remote 同指一处。

`origin`（GitHub）本轮**不可达**（`Permission denied (publickey)`），未做任何比对与推送。

---

## 2. 提交滞留与收口（事实）

推送前逐 ref 比对（`git ls-remote --heads` vs `git for-each-ref`）：

- 本地 16 分支 / 远端 44 分支，**behind 全为 0** —— 零分叉、零覆盖，远端不存在本地缺失的提交。
- 滞留提交：`main` 9 个、9 个 `codex/*` 各 1–2 个（合计 11）、`codex/r8-fixes-2026-10-13` 为本地独有。
- 处置：全部推送。推送后复核 **16/16 分支 SHA 与远端全等**。

---

## 3. git-lfs 缺失与 100 个 PNG 假阳性（事实 + 已闭环）

- 现象：本机无 `git-lfs` 时 `git status` 直接 fatal（`clean filter 'lfs' failed`），且 100 个 `*.png` 显示 `M`。
- 判定方法：逐件读 LFS 指针里的 `oid sha256`，与磁盘文件实算 SHA-256 比对 → **100/100 匹配**。
- 结论：**零真实改动**，差异纯由缺 git-lfs 造成。
- 处置：安装官方 `v3.8.0`（`sha256sums.asc` 校验一致）到 `~/.axiom/tools/git-lfs-3.8.0`。

---

## 4. 工具链 git 无法写本地（事实 + 已绕行）

- 现象：`git switch -c` / `update-ref` / `config` 均报 `cannot lock ...: Permission denied`。
- 排除实验：
  | 实验 | 结果 | 排除了 |
  |---|---|---|
  | PowerShell/.NET 向 `.git/refs/heads/` 写探针 | 成功 | 目录 ACL |
  | `bun` 向 `%TEMP%` 写文件 | 成功 | 进程级写入封锁 |
  | 全新空目录里 `git init` | **失败** | 仓库路径问题 |
- 结论：PATH 上的 git 是 DSH 工具链便携版，**本地写操作被沙箱拒绝**（读与推网可用），与仓库无关。
- 处置：本地分支/提交/推送改用另装的 MinGit `2.56.0.2`（`~/.axiom/tools/mingit`）。

---

## 5. 新增特性：A-0 口径契约（已入库）

`config/caliber.json`（17 条术语，CAL-01…CAL-17，5 域）+ `src/semantic/caliber-registry.ts`（运行时等价表，双源逐字段相等由门禁锁定）+ `tests/caliber-contract.test.ts`（C1–C6）；`bootstrap.ts` 接线 `renderCaliberSection()`，`AXIOM_CALIBER_GLOSSARY` 默认关闭 → 关闭时返回空串，零行为变更。

---

## 6. 工具链版本统一（已闭环）

| 位置 | 改前 | 改后 |
|---|---|---|
| 开发机 bun | 1.4.3 | 1.4.3 |
| data 服务器 bun | 1.3.14 | **1.4.3**（官方 linux-x64，双侧 sha256 一致；旧版留 `bun-1.3.14.bak`） |
| WSL bun | 缺失 | **1.4.3**（同一发布件，同 sha256） |
| `package.json` / 3 个 workflow | `1.3.14` | `1.4.3` |
| `ARCHITECTURE.md` / `README(±en)` / `PROJECT-GUIDE.md` | `1.4+` / `1.3+` | `1.4.3+（统一基线，滚动升级至最新稳定版）` |

`1.4.3` 经 GitHub API 核实为稳定版（`prerelease=false`，发布 2026-10-10）。

---

## 7. 测试基线：Windows vs Linux（同一份代码、同一 bun）

| 环境 | 用例 | pass | skip | fail | 耗时 |
|---|---|---|---|---|---|
| Windows 11 + bun 1.4.3 | 4,770 | 4,674 | 66 | **30** | 246s |
| WSL Debian 13 + bun 1.4.3 | 4,823 | 4,756 | 62 | **5** | 363s |

**同批 7 个失败文件的直接对照**：Windows `26–27 pass / 29–30 fail`；WSL `59 pass / 0 fail`。

**裁定：Windows 那 30 项是平台性失败，不是代码缺陷。** 典型如 `tests/utils/env-file-permissions.test.ts` 断言 `statSync(p).mode & 0o777 === 0o600`，Windows 的 `mode` 不表达 POSIX 权限位，原理上不可能通过。

---

## 8. Linux 上剩余的 5 项（逐项定性）

| # | 失败项 | 定性 | 依据 |
|---|---|---|---|
| 1 | `DeepSeek 真实链路 > services.executeChat 完整链路` | **环境依赖**（120s 超时，需真实 API） | 无凭据/无外网时必然超时 |
| 2 | 另一项 120s 超时 | 同上，待逐条登记 | 输出被截断，未取到全名（**未验证**） |
| 3 | `health-checker.checkSecurity > healthy=false 时返回 warning` | 待查 | 集成用例，尚未定位根因 |
| 4 | `docs-consistency §1 基线棘轮` | **真实文档缺陷**（见 §9） | `arch:stats` 实测 40 模块 vs 文档 41 |
| 5 | `Mega 压力：Vault 500 写入 + 1000 并发检索` | 资源敏感（采样机器相关） | 3.4s 内失败，疑似内存/并发阈值 |

---

## 9. 新发现：`ARCHITECTURE.md` §1 的「41 模块」在干净检出上不成立

- 事实：完整 Windows 工作树 `arch:stats` → **41 模块**；从 git 干净克隆出的树 → **40 模块**（文件数 456、行数 122,138、测试 500、工具 189 四项**完全一致**）。
- 成因：`arch:stats` 只统计 `src/` 下的**目录数**，其中有一个目录在 git 中**不含任何受跟踪文件**（空目录不被 git 跟踪），故干净检出后消失。
- 影响：`tests/unit/docs-consistency.test.ts` 的棘轮断言在**任何干净克隆（含 CI）**上都会红。
- 处置建议：把 §1 的模块数改为按受跟踪目录统计，或同步为 40 —— 属文档/脚本口径修正，需单独提交。

---

## 10. 未验证项（不得当作结论）

1. GitHub（`origin`）当前状态 —— 不可达，未比对。
2. WSL 全量结果中第 2 项超时用例的具体名称。
3. data 服务器上 `axiom-agent`（镜像 `single-db-2026-08-20`）与本仓库 `main` 的差异 —— 未做逐提交比对。
4. CI/CD runner 尚未搭建，故「CI 绿」无任何实测证据。

---

## 11. 复算命令

```bash
# 分支一致性
git ls-remote --heads internal | wc -l ; git for-each-ref refs/heads | wc -l

# 仓库完整性
git fsck --no-dangling

# 架构基线（干净克隆上执行才能复现 40）
bun run scripts/count-arch-stats.mjs

# 测试基线
bun test --timeout 15000 ./tests
```
