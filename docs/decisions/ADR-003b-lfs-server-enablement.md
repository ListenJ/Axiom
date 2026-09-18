# ADR-003b：LFS 服务端选型与启用（.10 Gitea）

- 日期：2026-09-12 ｜ 状态：**已启用并端到端验证通过** ｜ 决策人：项目经理（用户）
- 背景：ADR-003 T2.1 修订触发 >50MB 回退条款，firefox/webkit 基线（88.78MB 全量）待迁入 LFS。前置条件是"LFS 服务端可用性验证"。本 ADR 记录选型、启用变更与验证结论。

## 服务端验证结论（启用前，2026-09-12）

| 候选远端 | git-lfs 服务端 | 结论 |
|---|---|---|
| `internal211`（`data@${LAN_NODE_N2_LEGACY}` 裸仓库） | 未安装：`git-lfs: command not found`、无 `lfs/` 目录、无 `git-lfs-transfer` | ❌ LFS over SSH 不可用 |
| `internal`/`gitea`（`git@${LAN_NODE_GITEA}:2222`，Gitea `1Panel-gitea-cbmb`） | `app.ini`：`LFS_START_SERVER = false` | ❌ 未启用（但内置 Go LFS server，可一键开启） |

## 决定

采纳**方案 1：启用 .10 Gitea 的内置 LFS server**（`LFS_START_SERVER = true`）。
否决 internal211 裸仓库方案：需在 .22 装 git-lfs + 配裸仓库 hook，依赖安装、无管理面、较重。
Gitea 方案改动小、有 Web 管理面、镜像（gitea-ee:27.3.1）内置 LFS server。

## 变更实施（T3 运维，用户批准"现在执行 + 端到端验证"）

- 配置：`app.ini` `[server] LFS_START_SERVER false → true`（持久化卷 `/opt/1panel/apps/gitea/gitea/data/gitea/conf/app.ini`）。
- 备份：`/home/data/app.ini.bak-lfs-20260912`（sha256 `19927b23…`，保留用于回滚）。
- 计划文档：`docs/superpowers/plans/2026-09-12-gitea-lfs-enablement.md`。

## 施工中发现并修复的问题（关键）

- **启用后 Gitea 启动崩溃循环**：`error saving JWT Secret ... app.ini: permission denied`。
  根因：LFS 启用要求 Gitea 回写 `LFS_JWT_SECRET` 到 app.ini，但该文件属 `root:root 644`，进程 `RUN_USER=git` 无写权限。
  修复：临时容器 `--entrypoint sh` 以 root 对挂载卷 `chown git:git app.ini`（→ `git:git 600`），重启后 Gitea 成功自写 `LFS_JWT_SECRET` 并创建 `/data/git/lfs`。
  教训：启用需回写 app.ini 的功能开关前，必须先确认 app.ini 对 RUN_USER 可写（规则 6 反馈回路：日志直接指向 permission denied）。

## 验证证据（2026-09-12）

- **配置层**：LFS batch 端点由 404（无路由）→ 400/401（LFS handler 响应，`Content-Type: application/vnd.git-lfs+json`）；服务健康 `/api/v1/version` 200（v27.3.1）、首页 200。
- **端到端**：临时仓库 `git lfs track *.bin` → push 到 `codex/lfs-smoke-test`，`Uploading LFS objects: 100% (1/1) 46 B` 成功；服务端落盘 `/data/git/lfs/3e/4a/2f9db74…`（oid 分桶）；删本地缓存重拉 `roundtrip_match=True`。传输走 **basic HTTP 自动回退**（SSH remote + 无 token → 回退 `https://${LAN_NODE_GITEA}/…`，未认证即可，私有仓库读受 git-auth 保护）。
- 清理：临时分支已删（`ls-remote` 确认无）、临时仓库/脚本已删、服务器脚本已删（保留 app.ini 备份）。

## 基线迁入 LFS 施工（2026-09-12，用户表决端点+范围）

**端点冲突（关键决策）**：规则 3 主推送目标 internal211（.22 裸仓库）**无 git-lfs 且 data 用户无 sudo**，LFS 对象无法落 .22。用户表决：**基线分支直接推 .10 Gitea**（LFS 已启用），.22 装 git-lfs 由用户执行后再同步。

**迁移范围**：仅 firefox/webkit 入 LFS（105 张），**chromium 63 张保持普通 blob 不动**（7.28MB 未超阈，契合 ADR-003 原意）。webkit-desktop 组合已废弃（ADR-002），其 15 张磁盘残留经 `.gitignore` 排除不入库。

**迁移机制（规则 9：不改写历史）**：用 renormalize——`.gitattributes` 加 `filter=lfs` 规则 + `git add` 触发 clean filter 转 pointer，**新增提交**；否决 `git lfs migrate import`（会改写已推送历史）。

**验证证据**：
- `git lfs ls-files` = 105（firefox 63 + webkit-tablet 21 + webkit-mobile 21），chromium 命中 0；
- push gitea：`Uploading LFS objects: 100% (105/105), 66 MB`，分支 `cda7ec9..6aee3a0`；
- 服务端 `/data/git/lfs` 对象数 106（105 + 冒烟残留 1）；`git lfs fsck` OK；
- 工作区文件完好（firefox PNG magic `89 50 4E 47` / 1086137 B，未被 pointer 污染）；chromium 63 张未动。

## 后果与后续（剩余待办）

- ✅ 前置阻塞解除 + firefox/webkit 基线已入 LFS（推 .10 gitea）。
- ✅ ~~.22 装 git-lfs 后同步 internal211~~ **已作废（2026-09-12 用户确认）**：.22 服务器整体废弃，不再作为任何推送目标；全仓核验（`rev-list --count 3814022..9856a65`=0 + 逐分支对比 + tags/LFS 对象清点）证实 gitea 为 .22 完整超集，无内容遗漏。规则 3 主远端已切换为 `gitea`（AGENTS.md v1.3），`internal211` remote 保留仅作历史引用。
- ⏳ CI 矩阵扩列：firefox/webkit 基线已可用，`.github/workflows/visual-snapshot.yml` 扩列 + chromium 阻断级不变（webkit-desktop 恢复条件见 ADR-002 附录）。
- ⏳ 冒烟残留对象（1 个 46B）可选清理，无功能影响。
- 遗留观察：`GITEA_URL` 指向 .24（502）与 remote 实际 .10 漂移；`GITEA_TOKEN` 对 .10 API 返回 401。另案校正。

## 回滚

`app.ini` 改回 `LFS_START_SERVER = false`（或从备份覆盖）→ `docker restart 1Panel-gitea-cbmb`。纯配置开关，无数据迁移。
