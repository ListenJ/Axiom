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

---

## Step 10 — runtime-go 拓扑与冒烟

> 真实地址/账号在 `~/.axiom/axiom-secrets/runtime-go-topology.md`（规则 11，不入库）。下文占位：`<N1_IP>`（n1 Linux）、`<W1_IP>`（Windows w1）、`<MODEL_HOST>`（llama.cpp OpenAI 兼容端点）、`<REDIS_BRIDGE_IP>`（n1 上 redis 容器 bridge IP）。

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

### 10.3 n1：searchd（docker，复用 redis:7；节点列表用实际 `<N1_IP>`/`<W1_IP>`）

```bash
# n1 上执行
docker exec openclaw-redis redis-cli CONFIG SET protected-mode no
docker rm -f searchd-n1 2>/dev/null || true
docker run -d --name searchd-n1 --restart unless-stopped \
  -v /home/listen/runtime-go/bin:/opt:ro -p 9103:9103 \
  -e SEARCHD_ADDR=:9103 -e SEARCHD_NODE_ID=n1 -e SEARCHD_NUM_SHARDS=32 \
  -e 'SEARCHD_NODES=[{"id":"n1","addr":"http://<N1_IP>:9103","role":"primary"},{"id":"w1","addr":"http://<W1_IP>:9103","role":"standby"}]' \
  -e SEARCHD_REDIS_ADDR=<REDIS_BRIDGE_IP>:6379 -e GOMAXPROCS=12 -e GOGC=800 \
  redis:7 /opt/searchd
docker logs --tail 50 searchd-n1
```

### 10.4 w1：searchd（Windows，交叉编译）

```bash
# 在 Linux 侧交叉编译
cd /run/media/listen/base/openclaw-fusion/runtime-go
GOOS=windows GOARCH=amd64 go build -o bin/searchd-w1.exe ./cmd/searchd
# 把 bin/searchd-w1.exe 拷到 w1，然后在 w1 上：
#   set SEARCHD_ADDR=:9103
#   set SEARCHD_NODE_ID=w1
#   set SEARCHD_NUM_SHARDS=32
#   set SEARCHD_NODES=[{"id":"n1","addr":"http://<N1_IP>:9103","role":"primary"},{"id":"w1","addr":"http://<W1_IP>:9103","role":"standby"}]
#   set GOMAXPROCS=12
#   set GOGC=800
#   searchd-w1.exe
```

### 10.5 部署脚本方式（可选，先核对默认值）

```bash
cd /run/media/listen/base/openclaw-fusion
# deploy.sh 的 N1/N2 默认值来自迁移前拓扑；先用环境变量覆盖，再执行
N1=<user@N1_IP> N2=<user@W1_IP> bash scripts/runtime-go/deploy.sh build all
# 脚本自动：ship 四件套 → 重启三守护 → 各端口 /healthz 打点（应 3×200）
```

### 10.6 验收判据

```bash
# 1) 各守护存活
curl -fsS http://<N1_IP>:9101/healthz && echo pcdad_ok
curl -fsS http://<N1_IP>:9102/healthz && echo agentd_ok
curl -fsS http://<N1_IP>:9103/healthz && echo searchd_ok
curl -fsS http://<W1_IP>:9103/healthz && echo w1_searchd_ok

# 2) 集群视图：两节点均 healthy，分片各 16
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
# w1：结束 searchd 进程（任务管理器或 taskkill /IM searchd-w1.exe /F）
# 保留 runtime-go/bin 与拓扑笔记，不做删除
```

### 10.8 已知边界（来自 runtime-go/README.md 实测）

- n1 入站白名单只开 22/3000/6379/9001，Windows 无法直连 n1:9103；不要用 SSH 隧道做热路径转发（实测 60–150ms 抖动），正解是 docker 发布端口 + DNAT。
- Windows 服务端 accept 上限约 13.7k QPS；该拓扑 simple ~35k / mixed ~18k，100K QPS 不可达。
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
