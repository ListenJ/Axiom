# Step 9 / Step 10 运维操作手册（2026-10-02）

> 用途：Step 9（systemd 常驻）与 Step 10（runtime-go 拓扑）被环境阻塞（`sudo -n` 不可用 / `${LAN_*}` 实际值未提供）。本手册给出**可直接复制执行**的命令、验收判据与回滚方式。
> 规则 11：所有真实 IP、账号、token 只放 `~/.axiom/axiom-secrets/`，**不得**写入本文件或仓库任何文件。下面用 `<...>` 占位。
> 前置：`git status` 干净；当前工作分支已推送；`deploy/systemd/axiom.service` 为旧模板，Step 9 需按本文重写为 `axiom@.service`。

---

## Step 9 — systemd 常驻

### 9.1 前置检查

```bash
# 1) 仓库路径与 bun 路径（按实际机器）
REPO=/run/media/listen/base/openclaw-fusion
BUN=$(command -v bun)          # 本机实测 /home/listen/.bun/bin/bun
USER_NAME=$(id -un)            # 本机实测 listen

# 2) token 长度必须 >= 16（服务启动硬校验；<16 会启动即拒）
grep -E '^AXIOM_AUTH_TOKEN=' "$REPO/.env" | awk -F= '{print "token_len=" length($2)}'

# 3) 先手工确认 bundle 可跑（systemd 之前先排除应用自身问题）
cd "$REPO" && set -a && . ./.env && set +a && timeout 30 "$BUN" dist/main.js
# 另开终端：curl -fsS http://127.0.0.1:18789/health
```

### 9.2 写入修正后的 unit（模板实例：`axiom@listen.service`）

> 旧模板的 `Description=OpenClaw`、`User=%I`、`/opt/openclaw-fusion`、`/usr/local/bin/bun`、`ReadWritePaths=/opt/...` 全部过期；直接用下面内容替换。
> **2026-10-03 EROFS 修复**：`ProtectHome=read-only` 下 Bun 默认临时/安装目录在 `/home` 内不可写，子进程会报 `EROFS accessing temporary directory. Please set $BUN_TMPDIR or $BUN_INSTALL`。先把 temp/install 指到仓库 `.tmp`，并放行 `~/.cache`、`~/.npm` 的写入。

```bash
mkdir -p /run/media/listen/base/openclaw-fusion/.tmp/bun /run/media/listen/base/openclaw-fusion/.tmp/bun-install
```

```bash
sudo tee /etc/systemd/system/axiom@.service >/dev/null <<'UNIT'
[Unit]
Description=Axiom Runtime (instance %i)
After=network.target

[Service]
Type=simple
User=%i
WorkingDirectory=/run/media/listen/base/openclaw-fusion
Environment="PATH=/home/listen/.bun/bin:/usr/local/bin:/usr/bin:/bin"
Environment="NODE_ENV=production"
Environment="BUN_TMPDIR=/run/media/listen/base/openclaw-fusion/.tmp/bun"
Environment="BUN_INSTALL=/run/media/listen/base/openclaw-fusion/.tmp/bun-install"
EnvironmentFile=-/run/media/listen/base/openclaw-fusion/.env
ExecStart=/home/listen/.bun/bin/bun dist/main.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=axiom

# 安全设置：ProtectSystem=full 只读 /usr /boot /etc；ProtectHome=read-only 允许读 ~/.axiom/axiom-secrets
# 注意：如果 .env 里 OBSIDIAN_VAULT_PATH 指向仓库内的 axiom-memory/，ReadWritePaths 必须覆盖它。
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/run/media/listen/base/openclaw-fusion/data
ReadWritePaths=/run/media/listen/base/openclaw-fusion/axiom-memory
ReadWritePaths=/run/media/listen/base/openclaw-fusion/openclaw-memory
ReadWritePaths=/run/media/listen/base/openclaw-fusion/.tmp
ReadWritePaths=/run/media/listen/base/openclaw-fusion/axiom-memory.db
ReadWritePaths=/run/media/listen/base/openclaw-fusion/axiom-memory.db-wal
ReadWritePaths=/run/media/listen/base/openclaw-fusion/axiom-memory.db-shm
ReadWritePaths=/home/listen/.bun
ReadWritePaths=/home/listen/.cache
ReadWritePaths=/home/listen/.npm

[Install]
WantedBy=multi-user.target
UNIT
```

### 9.3 安装、启停与验收

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now axiom@listen.service

# 验收 1：单元语法
sudo systemd-analyze verify /etc/systemd/system/axiom@.service

# 验收 2：运行态
systemctl status axiom@listen.service --no-pager
systemctl is-enabled axiom@listen.service        # 期望 enabled
journalctl -u axiom@listen.service -n 80 --no-pager

# 验收 3：应用面
curl -fsS http://127.0.0.1:18789/health
curl -fsS http://127.0.0.1:18789/api/audit/diagnostics >/dev/null && echo diagnostics_ok
BUN_AUDIT=$(curl -fsS -H "Authorization: Bearer $(grep -E '^AXIOM_AUTH_TOKEN=' /run/media/listen/base/openclaw-fusion/.env | cut -d= -f2-)" http://127.0.0.1:18789/api/audit/diagnostics) && echo "$BUN_AUDIT" | head -c 200

# 验收 4：开机自拉起（可选，需维护窗口）
# sudo reboot
# 重启后：systemctl is-active axiom@listen.service && curl -fsS http://127.0.0.1:18789/health
```

### 9.4 回滚

```bash
sudo systemctl disable --now axiom@listen.service
# 如需彻底移除：
sudo rm -f /etc/systemd/system/axiom@.service
sudo systemctl daemon-reload
# 恢复原 PM2 / 手工启动方式（deploy/pm2/start.sh）
```

### 9.5 常见坑（本机实测/代码事实）

| 现象 | 原因 | 处理 |
|---|---|---|
| `Failed to load environment files` | `.env` 路径写错或权限 | 确认 `EnvironmentFile` 指向仓库根 `.env`；`-` 前缀表示可选 |
| 服务启动即退出 `Failed validation for Gateway auth token` | `AXIOM_AUTH_TOKEN` < 16 字符 | 换成 `openssl rand -hex 16` 生成的值（规则 11 不入库） |
| 服务无法读 SenseNova 凭据 | `ProtectHome=true` 屏蔽 `/home/listen/.axiom` | 用 `ProtectHome=read-only`（本文已用） |
| Vault 写入失败 EROFS | `ProtectSystem=full` 下 repo 内 Vault 不在 `ReadWritePaths` | 按 `.env` 的 `OBSIDIAN_VAULT_PATH` 增加 `ReadWritePaths` |
| 端口冲突 | 已有 PM2/手工实例占 18789 | `sudo systemctl stop axiom@listen` 前先 `pm2 delete axiom-agent` 或改 `AXIOM_GATEWAY_PORT` |

### 9.6 EROFS 修复（2026-10-03 实测日志）

日志证据：`axiom[212457]: error: EROFS accessing temporary directory. Please set $BUN_TMPDIR or $BUN_INSTALL`。

- 根因：`ProtectHome=read-only` 让 `/home/listen/.bun`、`~/.cache`、`~/.npm` 不可写；Bun 子进程默认把临时/安装目录放在 `/home` 下。
- 修复：§9.2 的 unit 已加 `BUN_TMPDIR` / `BUN_INSTALL` 指向仓库 `.tmp`，并放行 `~/.bun`、`~/.cache`、`~/.npm` 的写入；`ReadWritePaths` 已有 `.tmp`。
- **2026-10-03 复测补充（关键）**：子进程 `bunx -y free-search-mcp` 等**只继承 `HOME`，不继承 `BUN_TMPDIR/BUN_INSTALL`**，因此回退写 `/home/listen/.bun`；仅设环境变量不够，必须 `ReadWritePaths=/home/listen/.bun`（本手册已加）。
- 应用修复：

```bash
sudo mkdir -p /run/media/listen/base/openclaw-fusion/.tmp/bun /run/media/listen/base/openclaw-fusion/.tmp/bun-install
# 用 §9.2 的完整 unit 覆盖 /etc/systemd/system/axiom@.service 后：
sudo systemctl daemon-reload
sudo systemctl restart axiom@listen.service
# 就绪轮询见 §9.3；随后确认 EROFS 不再出现：
journalctl -u axiom@listen.service --since "5 min ago" | grep -i EROFS && echo 'STILL PRESENT' || echo 'EROFS cleared'
```

- 若仍有 MCP 子进程写 `~/.cache`/`~/.npm` 的 EROFS，优先保留 `ProtectHome=read-only` + 精确 `ReadWritePaths`，不要直接改 `ProtectHome=false`。

### 9.7 线上闭合验收（2026-10-05）

- `/etc/systemd/system/axiom@.service`、`/tmp/axiom@.service`、`deploy/systemd/axiom.service` 三者 SHA-256 一致：`bd139a42bbc544066899d3d12ad089539f7db62906d96fe082db511595828747`。
- 线上 unit 已含 `ReadWritePaths=/home/listen/.bun`（第 30 行）。
- 服务在 `2026-10-05 00:20:08 CST` 重启，`ExecMainPID=498702`；`active` / `enabled`，`/health` = 200。
- 自该次重启以来 `journalctl -u axiom@listen.service | grep -ci EROFS` = **0**；EROFS 子项关闭。
- 独立残留（与 EROFS 无关）：`free-search-mcp` 从 npm registry 返回 404；`freeweb` 与 `obsidian` MCP 各 10s 超时，外部 MCP 仍处于 degraded 状态。

---

## Step 10 — runtime-go 拓扑与冒烟

> **2026-10-03 用户裁定：n1/n2/w1 多机联动全部退役**；不再需要分布式 runtime-go 拓扑，也不再需要任何 `${LAN_*}` 值。**本手册 §10 仅作历史参考，不再执行**。
> Step 10 已重定义为“单机并发能力强化（Go）”，详细计划见 `docs/superpowers/plans/2026-10-03-single-machine-go-concurrency.md`；核心是单机 worker pool / shard 并发 / `sync.Pool` / modelclient 并发 / 优雅退出，用 `cmd/loadgen` 做单机 before/after。
> 本地拓扑笔记仍保留在 `~/.axiom/axiom-secrets/runtime-go-topology.md`（规则 11，不入库；已追加多机退役状态），仅作历史资料，不再作为 Step 10 输入。

### 10.1 前置检查（只读，不泄露地址）

```bash
cd /run/media/listen/base/openclaw-fusion
go version                 # Go 1.25+
cat ~/.axiom/axiom-secrets/runtime-go-topology.md   # 只在本机读；不要把内容贴进仓库/日志
```

### 10.2 构建三守护

```bash
cd /run/media/listen/base/openclaw-fusion/runtime-go
go build -o bin/searchd ./cmd/searchd
go build -o bin/agentd   ./cmd/agentd
go build -o bin/pcdad    ./cmd/pcdad
go build -o bin/loadgen  ./cmd/loadgen
ls -l bin/
```

### 10.3 n1：searchd（docker，复用 redis:7；节点列表只含 Linux n1/n2）

```bash
# n1 上执行
docker exec openclaw-redis redis-cli CONFIG SET protected-mode no
docker rm -f searchd-n1 2>/dev/null || true
docker run -d --name searchd-n1 --restart unless-stopped \
  -v /home/listen/runtime-go/bin:/opt:ro -p 9103:9103 \
  -e SEARCHD_ADDR=:9103 -e SEARCHD_NODE_ID=n1 -e SEARCHD_NUM_SHARDS=32 \
  -e "SEARCHD_NODES=[{\"id\":\"n1\",\"addr\":\"http://<N1_IP>:9103\",\"role\":\"primary\"},{\"id\":\"n2\",\"addr\":\"http://<N2_IP>:9103\",\"role\":\"standby\"}]" \
  -e SEARCHD_REDIS_ADDR=<REDIS_BRIDGE_IP>:6379 -e GOMAXPROCS=12 -e GOGC=800 \
  redis:7 /opt/searchd
docker logs --tail 50 searchd-n1
```

### 10.4 w1：searchd（Windows，已退役，作废）

> **2026-10-03 用户裁定：Windows w1 退役**。本节不再执行；Linux 节点按 §10.3 部署。原 Windows 交叉编译/启动说明仅作历史记录，不再纳入 Step 10 验收。

### 10.5 部署脚本方式（可选，先核对默认值）

```bash
cd /run/media/listen/base/openclaw-fusion
# deploy.sh 的 N1/N2 默认值来自迁移前拓扑；先用环境变量覆盖，再执行
N1=<user@N1_IP> N2=<user@N2_IP> bash scripts/runtime-go/deploy.sh build all
# 脚本自动：ship 四件套 → 重启三守护 → 各端口 /healthz 打点（应 3×200）
```

### 10.6 验收判据

```bash
# 1) 各守护存活
curl -fsS http://<N1_IP>:9101/healthz && echo pcdad_ok
curl -fsS http://<N1_IP>:9102/healthz && echo agentd_ok
curl -fsS http://<N1_IP>:9103/healthz && echo searchd_ok


# 2) 集群视图：Linux 节点（n1/n2）均 healthy，分片各 16
curl -fsS http://<N1_IP>:9103/cluster

# 3) 写鉴权矩阵（无 token 应 403 write disabled / 错 token 403 / 对 token 200）

# 4) 压测冒烟：seed 10 万文档 → seed done；对照 runtime-go/README.md 实测表
cd /run/media/listen/base/openclaw-fusion/runtime-go
./bin/loadgen -mode seed -docs 100000 -addr http://<N1_IP>:9103 -token "<AUTH_TOKEN>"

# 5) modelclient 连通冒烟（模型服务）
curl -fsS http://<MODEL_HOST>:9001/health
# agentd 侧设置 MODEL_SERVICE_URL=http://<MODEL_HOST>:9001 后，发起一次 Chat 调用；
# 判据：content 或 reasoning_content 正常返回；max_tokens 给足（reasoning 模型建议 4096）。
```

### 10.7 回滚

```bash
# n1
docker stop searchd-n1 && docker rm searchd-n1
# w1 已退役（2026-10-03），不再有 w1 回滚项
# 保留 runtime-go/bin 与拓扑笔记，不做删除
```

### 10.8 已知边界（来自 runtime-go/README.md 实测）

- n1 入站白名单只开 22/3000/6379/9001，Windows 无法直连 n1:9103；不要用 SSH 隧道做热路径转发（实测 60–150ms 抖动），正解是 docker 发布端口 + DNAT。
- Windows 服务端 accept 上限约 13.7k QPS（**w1 已退役，仅历史参考**）；该拓扑 simple ~35k / mixed ~18k，100K QPS 不可达。
- 跨节点链路质量是 QPS 第一决定因素；WiFi 链路会使 simple QPS 减半，必须用有线 IP。
- `MODEL_SERVICE_URL` 未设置时默认 `${LAN_MODEL_SERVICE}`；真实值只放本地拓扑笔记。

---

## 验收记录模板（执行后回填 ops log）

```
Step 9:
- systemctl is-active axiom@listen.service = active
- systemctl is-enabled axiom@listen.service = enabled
- curl /health = ok；/api/audit/diagnostics = 200
- 重启自拉起 = 是/否
- 回滚锚点 = 原 PM2/手工启动方式

Step 10:
- n1/w1 searchd /healthz = 200/200；agentd/pcdad /healthz = 200/200
- /cluster = 两节点 healthy，分片 16/16
- loadgen seed 100000 = seed done（耗时/HQPS 填实测）
- modelclient chat = content/reasoning_content 正常
- 仓库内 LAN 明文 = 0（git grep 核验）
```

---

## 七、2026-10-02 用户实测踩坑修正（必读）

### 7.1 Step 9：服务确实启动成功，但健康检查太早

实测现象：`systemctl enable --now` 后 79ms 就 `curl /health` → 连接拒绝；`journalctl` 显示服务在 6.7s 时仍在 `VaultManager initialized`，随后被 `systemctl disable --now` 发的 SIGTERM 停掉。

**原因**：应用启动要等外部 MCP 客户端（free-search/freeweb/obsidian）各自 10s 超时，再到 `Server started`，总耗时约 10–30s；`systemctl enable --now` 本身只代表进程已拉起，不代表端口已监听。

**修正后的验收顺序（带就绪轮询）**：

```bash
sudo systemctl enable --now axiom@listen.service
code=000
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/health || true)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "health_http=$code"
systemctl is-active axiom@listen.service
systemctl is-enabled axiom@listen.service
journalctl -u axiom@listen.service -n 40 --no-pager
```

- **不要在 health=200 之前 `disable --now`**；否则服务会在初始化中途被 SIGTERM。
- `journalctl` 用本地 CST，应用日志用 UTC；看到时间差 8 小时属正常。
- `Unknown environment variable: AXIOM_ENCRYPTION_KEY` 是环境校验告警，不阻断启动；如不需要可忽略。

### 7.2 Step 10：占位符、反斜杠、redis 容器名三个坑

实测现象：
- `bash: REDIS_BRIDGE_IP: 没有那个文件或目录` —— 因为 `<REDIS_BRIDGE_IP>` 的 `<` `>` 被 shell 当成重定向；占位符必须替换成真实值。
- 行尾 `\ `（反斜杠后带空格）会破坏续行，导致下一行被当成独立命令。
- `docker exec openclaw-redis ...` → `No such container: openclaw-redis`；本机 `docker ps` 实际容器名是 `redis-server`（不同机器可能不同）。

**修正后的执行方式**：

```bash
# 1) 先在本地拓扑笔记里取值，设置 shell 变量（不要写进仓库）
N1_IP=<n1 实际地址>
W1_IP=<w1 实际地址>
REDIS_BRIDGE_IP=<n1 上 redis 容器的 bridge IP>
MODEL_HOST=<模型服务地址>

# 2) 二进制必须在“运行 searchd 容器的那台主机”上；本机构建后 scp 到 n1
cd /run/media/listen/base/openclaw-fusion
ls -l runtime-go/bin/{searchd,agentd,pcdad,loadgen}
scp runtime-go/bin/{searchd,agentd,pcdad,loadgen} <user>@$N1_IP:/home/listen/runtime-go/bin/
# 或改用：N1=<user@$N1_IP> N2=<user@$W1_IP> bash scripts/runtime-go/deploy.sh build all

# 3) 在 n1 上执行；先发现 redis 真实容器名（不同机器可能是 redis-server / openclaw-redis）
ssh <user>@$N1_IP
docker ps --format '{{.Names}}' | grep -i redis      # 记下 <REDIS_CONTAINER>
docker exec <REDIS_CONTAINER> redis-cli CONFIG SET protected-mode no

# 4) 注意：整个 SEARCHD_NODES 用双引号包裹、内部 JSON 双引号转义，变量才会展开；
#    每行行尾的 \ 后不得有空格。
docker rm -f searchd-n1 2>/dev/null || true
docker run -d --name searchd-n1 --restart unless-stopped \
  -v /home/listen/runtime-go/bin:/opt:ro -p 9103:9103 \
  -e SEARCHD_ADDR=:9103 -e SEARCHD_NODE_ID=n1 -e SEARCHD_NUM_SHARDS=32 \
  -e "SEARCHD_NODES=[{\"id\":\"n1\",\"addr\":\"http://$N1_IP:9103\",\"role\":\"primary\"},{\"id\":\"w1\",\"addr\":\"http://$W1_IP:9103\",\"role\":\"standby\"}]" \
  -e SEARCHD_REDIS_ADDR=$REDIS_BRIDGE_IP:6379 -e GOMAXPROCS=12 -e GOGC=800 \
  redis:7 /opt/searchd

# 5) w1：交叉编译后拷到 Windows 运行
GOOS=windows GOARCH=amd64 go build -o runtime-go/bin/searchd-w1.exe ./runtime-go/cmd/searchd
```

**本机 untracked 构建物提示**：本轮 `go build` 生成了 `runtime-go/bin/{searchd,agentd,pcdad,loadgen}`，`git status` 显示为 `??`。它们是 Step 10 的本地执行产物，**不要提交**；如不需要长期保留，可在 Step 10 完成后按规则 4 例外删除（可确定性重建）。
