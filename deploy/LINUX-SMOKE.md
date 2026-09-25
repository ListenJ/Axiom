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
| 6 | 聊天往返 | `POST /chat` 返回结构化响应（尽力而为，不阻塞门禁） |

Docker 模式说明：容器内以 `HOST=0.0.0.0` 绑定并通过 `-p 18789:18789` 发布；
容器网络桥接下 curl 来自非回环地址，会真实走 `x-api-key` 认证路径（与生产同构）。
冒烟结束自动 `docker rm`，可用 `--keep` 保留容器排查。

## 宿主机模式（bun 已安装）

```bash
./scripts/smoke-linux.sh --mode=host --repo=/opt/openclaw-fusion --token=<token>
```

要求：`bun` 在 PATH、端口 18789 空闲、仓库可写（会生成 `data/smoke.db`）。

## systemd 模式

1. 安装单元（模板实例名建议用服务账号）：

```bash
sudo cp deploy/systemd/axiom.service /etc/systemd/system/axiom@.service
sudo systemctl daemon-reload
# 实例名对应服务账号（如 axiom 用户）：/opt/openclaw-fusion 部署目录与 .env 就绪
sudo systemctl enable --now axiom@axiom
```

2. 冒烟（服务已在运行则只检查不停止；由冒烟脚本启动则结束后停止）：

```bash
./scripts/smoke-linux.sh --mode=systemd --service=axiom@axiom --repo=/opt/openclaw-fusion
```

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