# Gitea LFS 服务端启用变更计划（ADR-003b 前置）

- 日期：2026-09-12 ｜ 任务级别：**T3**（运维/外部系统写入）｜ 状态：**草案，待用户批准关键决策后冻结**
- 目标远端：`internal`/`gitea` → `git@192.168.0.10:2222`（Gitea 容器 `1Panel-gitea-cbmb`，镜像 `commitgo/gitea-ee:27.3.1`）
- 关联：ADR-003b（firefox/webkit 基线迁入 LFS → CI 矩阵扩列）；本计划仅覆盖**服务端启用 + 验证**，不含基线迁移施工。

## 任务契约（规则 0.4）

```
任务: 将 .10 Gitea 的 LFS_START_SERVER 由 false 改为 true，重启容器，验证 LFS 端点可用，
      为 ADR-003b 的基线迁入解除前置阻塞。
验收标准:
  A1 配置层：LFS batch 端点对未认证请求由 404 → 401（证明 LFS 路由已注册）。
  A2 服务健康：重启后 Gitea Web/API 正常（首页 200、/api/v1/version 200）。
  A3（可选，需批准）功能层：一次性小对象经 git-lfs basic(HTTP) push→pull 往返成功，
     Gitea 存储目录 /data/git/lfs/objects 出现对象。
改动清单（文件级，均在 .10 服务器，非本仓库）:
  - /opt/1panel/apps/gitea/gitea/data/gitea/conf/app.ini：LFS_START_SERVER false→true
  - （派生）容器重启；Gitea 自动创建 /data/git/lfs
不做项:
  - 不迁移任何基线 PNG、不改本仓库 .gitattributes/.gitignore（属 ADR-003b 后续施工）
  - 不动 internal211 裸仓库（其服务端无 git-lfs，另案）
  - 不改 Gitea 其他配置项、不升级镜像、不动数据库
验证命令: 见"阶段 2/3"
风险/回滚: 见"回滚方案"
```

## 影响面清单（T3 强制）

- **共享服务重启**：`docker restart 1Panel-gitea-cbmb` 会**短暂中断 .10 上全部 Gitea 仓库/协作者**（非仅 openclaw-fusion）。需选低峰窗口。
- 变更范围限于 LFS 开关；其余仓库功能不受配置影响（仅重启瞬间不可用）。
- 无凭据入库；操作经 SSH 密钥 + docker 组权限，不使用明文密码。
- 客户端 git-lfs 3.7.1 已就绪，`.gitattributes` 现有 `* text=auto` 不受影响。

## 执行步骤（批准后）

### 阶段 0 — 备份（规则 2）
```bash
# 宿主机可读拷贝（644 root 文件，data 有读权限）
cp -p /opt/1panel/apps/gitea/gitea/data/gitea/conf/app.ini \
    /home/data/app.ini.bak-lfs-20260912
sha256sum /home/data/app.ini.bak-lfs-20260912   # 记录基线哈希
```

### 阶段 1 — 改配置 + 重启
```bash
# 容器内以 root 精确改挂载卷（= 宿主机持久文件），避免误伤其他行
docker exec -u root 1Panel-gitea-cbmb \
  sed -i 's/^LFS_START_SERVER = false/LFS_START_SERVER = true/' /data/gitea/conf/app.ini
docker exec 1Panel-gitea-cbmb grep -n LFS_START_SERVER /data/gitea/conf/app.ini  # 确认 =true
docker restart 1Panel-gitea-cbmb
# 等待就绪（轮询 /api/v1/version 直到 200，上限 ~60s）
```

### 阶段 2 — 配置层验证（A1+A2）
```bash
# 本地（Windows）：未认证 batch 期望 401（启用前实测为 404）
curl.exe -s -o NUL -w "%{http_code}\n" -X POST \
  -H "Accept: application/vnd.git-lfs+json" -H "Content-Type: application/vnd.git-lfs+json" \
  --data "{}" http://192.168.0.10:3000/agent/openclaw-fusion.git/info/lfs/objects/batch
# 服务健康：首页/version 期望 200
```

### 阶段 3 — 功能层端到端（A3，可选，需单独批准）
- 在**独立临时目录**建一次性仓库，`git lfs track "*.bin"` + 造 1KB 对象，push 到 gitea remote 的
  `codex/lfs-smoke-test` 临时分支 → 校验 `.git/lfs/objects` 与 Gitea `/data/git/lfs/objects` 均出现对象
  → `git push internal :codex/lfs-smoke-test` 删除临时分支。
- 判定 basic(HTTP) transfer 通路成立；不污染正式分支与基线。

## 回滚方案

- 任一验收失败或需撤销：
```bash
docker exec -u root 1Panel-gitea-cbmb \
  sed -i 's/^LFS_START_SERVER = true/LFS_START_SERVER = false/' /data/gitea/conf/app.ini
docker restart 1Panel-gitea-cbmb
# 若 sed 误伤，整文件还原：
docker exec -u root 1Panel-gitea-cbmb cp /data/gitea/conf/app.ini.bak-lfs-20260912 \
  /data/gitea/conf/app.ini   # 或从 /home/data/app.ini.bak-lfs-20260912 覆盖挂载卷
```
- 回滚后重跑阶段 2，确认 batch 端点回到 404（= 原状态）。
- 纯配置开关，无数据迁移，回滚零残留（阶段 3 若做过，删临时分支 + 可选清理 lfs/objects 测试对象）。

## 关键决策点（待用户表决）

- D1：是否接受 .10 Gitea **共享服务重启的短暂中断**，及执行窗口（现在 / 低峰 / 延后）。
- D2：执行方式确认——`docker exec -u root` 改挂载卷 + `docker restart`（data 在 docker 组，无需 sudo）。
- D3：是否本轮即做**阶段 3 端到端验证**（推荐，坐实可用），还是仅阶段 2 配置层验证即收口。
- D4：完成后是否顺带补 ADR-003b 正文（记录"服务端已启用 + 验证结论"），基线迁移仍留后续。

## 遗留观察（非本任务，记录备查）

- 配置漂移：环境变量 `GITEA_URL=http://192.168.0.24:3000` 指向的 .24 返回 502，而 git remote 实际用 .10；`GITEA_TOKEN` 对 .10 API 返回 401。建议另案校正，不在本次范围。
- 容器内无 git-lfs 二进制：basic(HTTP) transfer 不依赖；若未来启用 SSH transfer 或 standalone-file 再评估补装。
