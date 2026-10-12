# Linux 部署冒烟测试（systemd / pm2 / Docker）

> 目的：在 Linux 目标机验证「构建 → 启动 → 健康检查 → 资源审查 → 诊断端点 → 聊天往返」全链路，
> 作为 R-016/部署遗留风险的闭环实证。脚本：`scripts/smoke-linux.sh`。

## 快速开始（推荐：Docker 模式，不污染宿主机）

```bash
# 目标机预检：docker + curl
docker --version && curl --version

# 在仓库目录执行（示例：端口 18789，token 仅用于冒烟）
./scripts/smoke-linux.sh --mode=docker --repo=/path/to/openclaw-fusion \
  --token=smoke-test-token-0123456789abcdef --wait-secs=90
```

门禁清单（全部通过退出码 0）：

| # | 门禁 | 说明 |
|---|------|------|
| 1 | 构建 | `bun install --frozen-lockfile && bun run build` 产出 `dist/main.js` |
| 2 | 启动 | 服务进程/容器拉起（systemd/pm2/docker 各自路径） |
| 3 | 健康 | `GET /health` 200 且 `status:"ok"`（最多等待 `--wait-secs` 秒） |
| 4 | 资源审查 | `bun run audit:runtime` 13 项检查 pass |
| 5 | 诊断端点 | `GET /api/audit/diagnostics` 200 |
| 6 | 聊天往返（带鉴权） | `POST /chat`（真实契约载荷 + token）2xx；非 2xx 一律 FAIL（轮 7 审计：原 400/401/500 曾计 PASS，门形同虚设） |
| 6b | 鉴权链 | 无凭证 `POST /chat` 必须被 401/403 拒绝（轮 7 部署题②新增）；服务未启用鉴权时 SKIP 不计失败 |

> 门 6/6b 于 2026-10-12 拆分升级（轮 7 审计整改）：6 从"尽力而为"改为硬断言，
> 6b 补上"无凭证必须被拒"的反向断言——敞开门的服务在其余门全绿时更危险。

Docker 模式说明：容器内以 `HOST=0.0.0.0` 绑定并通过 `-p 18789:18789` 发布；
容器网络桥接下 curl 来自非回环地址，会真实走 `x-api-key` 认证路径（与生产同构）。
冒烟结束自动 `docker rm`，可用 `--keep` 保留容器排查。

## 宿主机模式（bun 已安装）

```bash
./scripts/smoke-linux.sh --mode=host --repo=/opt/openclaw-fusion --token=$(openssl rand -hex 16)
```

要求：`bun` 在 PATH、端口 18789 空闲、仓库可写（会生成 `data/smoke.db`）。

> **token 至少 16 字符**（2026-09-29 实测）：`AXIOM_AUTH_TOKEN` 有最小长度校验，短于 16 时服务**启动即拒**
> （`Failed validation for Gateway auth token`），表现为所有探针 `HTTP=000`，极易误判为端口/构建问题；
> 脚本已前置校验并直接报因。
>
> **门 6 载荷与清理（2026-09-29 修复）**：`/chat` 的 schema 要求 `messages:[{role,content}]`，旧载荷
> `{"message":...}` 必得 400 且被宽容计数 ⇒ 门 6 曾形同虚设；现发真实契约载荷、非 2xx 打印响应体（仍不阻塞门禁）。
> host 模式的清理曾漏杀真实服务进程（杀到的是包装进程），冒烟"PASS"后端口仍被占；现改为 `setsid` 独立进程组 +
> 进程组清理 + 端口监听兜底。

## systemd 模式

1. 安装单元（模板实例名建议用服务账号）：

```bash
sudo cp deploy/systemd/axiom@.service /etc/systemd/system/axiom@.service
sudo systemctl daemon-reload
# 实例名对应服务账号（如 axiom 用户）：/opt/openclaw-fusion 部署目录与 .env 就绪
sudo systemctl enable --now axiom@axiom
```

2. 冒烟（服务已在运行则只检查不停止；由冒烟脚本启动则结束后停止）：

```bash
./scripts/smoke-linux.sh --mode=systemd --service=axiom@axiom --repo=/opt/openclaw-fusion
```

> **`ReadWritePaths` 必须带 `-` 前缀（2026-10-07 实测）**：模板里列了 `axiom-memory.db-wal` / `-shm`、`.tmp` 等
> 运行时才存在（或重启后被清理）的路径。不带 `-` 时这些路径缺失会让 systemd 在 `NAMESPACE` 阶段直接失败
> （`status=226/NAMESPACE`）并进入 `Restart=always` 崩溃循环 —— 本机重启后实测连续重启 256 次、服务全程不可用。
> 带 `-` 前缀的路径不存在时被忽略，由 `ExecStartPre` 建目录、由应用建库文件。

注意：systemd 模式假设 `/opt/openclaw-fusion` 已部署、`bun` 已安装（单元内 `/usr/local/bin/bun`）、`.env` 已配置。

## pm2 模式

```bash
npm i -g pm2
cp deploy/pm2/ecosystem.config.json /opt/openclaw-fusion/ecosystem.config.json
cd /opt/openclaw-fusion && pm2 start ecosystem.config.json
./scripts/smoke-linux.sh --mode=pm2 --repo=/opt/openclaw-fusion
```

## 目标机首次交付（参考）

```bash
# 1) 安装 Bun（官方安装脚本）
curl -fsSL https://bun.sh/install | bash
# 2) 部署目录
sudo mkdir -p /opt/openclaw-fusion && sudo chown $USER /opt/openclaw-fusion
git clone ssh://data@<git-server>/home/data/openclaw-fusion.git /opt/openclaw-fusion
cd /opt/openclaw-fusion
bun install --frozen-lockfile
cp .env.example .env && vi .env   # 至少配置 AXIOM_AUTH_TOKEN（>=16 位随机串）
bun run build
# 3) 冒烟验证后选 systemd 或 pm2 托管
```

## 常见失败定位

| 症状 | 排查 |
|------|------|
| 构建失败 | `bun install` 网络/锁文件不一致；先 `bun install --frozen-lockfile` 手动复现 |
| 健康检查超时 | 端口被占（`ss -ltnp | grep 18789`）；`AXIOM_AUTH_TOKEN` 与 curl header 不一致；服务日志（docker logs / journalctl） |
| audit 失败 | 在仓库目录手动 `bun run audit:runtime` 查看具体检查项 |
| 聊天往返 401 | token 未传入 curl；`AXIOM_ALLOW_LOCAL_BYPASS` 语义（反代同主机需设 0） |

## 与 CI 门禁的关系

GitHub Actions 已把 `bun run audit:runtime` 作为合并门禁（见 `.github/workflows/ci.yml`）；
本冒烟脚本是对「Linux 真实环境」的补充验证，建议每次发版在目标机执行一次。