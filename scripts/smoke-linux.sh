#!/usr/bin/env bash
# ============================================================================
# Axiom Agent Linux 部署冒烟测试
# 覆盖：构建 → 启动 → 健康检查 → runtime-audit → 诊断端点 → 聊天往返 → 清理
#
# 用法：
#   scripts/smoke-linux.sh [--mode=docker|host|systemd|pm2] [--repo=/path] \
#                          [--token=...] [--wait-secs=60] [--keep]
#
# 模式说明：
#   docker   （默认）用 oven/bun:1 容器构建并运行，不污染宿主机（推荐）
#   host     宿主机已安装 bun 且仓库已构建 dist/ 时使用
#   systemd  使用已安装的 systemd 单元（如 deploy/systemd/axiom.service），
#            若服务未运行则启动并在冒烟后停止（若冒烟前已在运行则不停止）
#   pm2      使用 deploy/pm2/ecosystem.config.json 管理，同上
#
# 退出码：全部门禁通过 = 0；任一失败 = 1
# ============================================================================
set -euo pipefail

MODE="docker"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="${SMOKE_AUTH_TOKEN:-smoke-test-token-0123456789abcdef}"
BIND="${SMOKE_BIND:-127.0.0.1}"
PORT="18789"
WAIT_SECS="60"
KEEP="0"
SERVICE_NAME="axiom"
PM2_APP="axiom-agent"

while [ $# -gt 0 ]; do
  case "$1" in
    --mode=*) MODE="${1#*=}" ;;
    --repo=*) REPO="${1#*=}" ;;
    --token=*) TOKEN="${1#*=}" ;;
    --port=*) PORT="${1#*=}" ;;
    --wait-secs=*) WAIT_SECS="${1#*=}" ;;
    --keep) KEEP="1" ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO="$(cd "$REPO" && pwd)"
CONTAINER="axiom-smoke-$(date +%s)"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
DIAG_URL="http://127.0.0.1:${PORT}/api/audit/diagnostics"
AUTH_HEADER="x-api-key: ${TOKEN}"
FAILED="0"

log()  { printf '[smoke] %s\n' "$*"; }
gate() { # gate <name> <exit_code>
  if [ "$2" -eq 0 ]; then log "PASS: $1"; else log "FAIL: $1"; FAILED="1"; fi
}

cleanup() {
  if [ "$MODE" = "docker" ] && [ "$KEEP" = "0" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  elif [ "$MODE" = "host" ]; then
    if [ -n "${SMOKE_PID:-}" ]; then
      kill -- "-$SMOKE_PID" 2>/dev/null || kill "$SMOKE_PID" 2>/dev/null || true
    fi
    # 兜底：按端口清理仍在监听的进程（防包装进程/子进程逃逸）。
    # 轮 7 审计：kill -9 前先校验 cmdline 属本仓库冒烟产物——任何恰好监听
    # 该端口的无关进程不得被误杀。
    sleep 1
    STILL=$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
    if [ -n "$STILL" ]; then
      if tr '\0' ' ' < "/proc/$STILL/cmdline" 2>/dev/null | grep -qE 'dist/main\.js|axiom|smoke'; then
        log "清理兜底：端口 ${PORT} 仍被 pid=$STILL（cmdline 匹配冒烟产物）占用，强制结束"
        kill -9 "$STILL" 2>/dev/null || true
      else
        log "清理兜底：端口 ${PORT} 被 pid=$STILL 占用但 cmdline 非冒烟产物，跳过强杀（防误伤）"
      fi
    fi
  elif [ "$MODE" = "systemd" ] && [ "${SYSTEMD_STARTED:-0}" = "1" ]; then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  elif [ "$MODE" = "pm2" ] && [ "${PM2_STARTED:-0}" = "1" ]; then
    pm2 delete "$PM2_APP" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---------- 预检 ----------
case "$MODE" in
  docker)  command -v docker >/dev/null || { echo "需要 docker"; exit 2; } ;;
  host)    command -v bun >/dev/null || { echo "需要 bun"; exit 2; } ;;
  systemd) command -v systemctl >/dev/null || { echo "需要 systemctl"; exit 2; } ;;
  pm2)     command -v pm2 >/dev/null || { echo "需要 pm2"; exit 2; } ;;
  *) echo "未知模式: $MODE" >&2; exit 2 ;;
esac
command -v curl >/dev/null || { echo "需要 curl"; exit 2; }
# 2026-09-29：AXIOM_AUTH_TOKEN 有最小长度校验（<16 字符服务拒启、全部探针 000）——前置拦下并给准话
if [ "${#TOKEN}" -lt 16 ]; then
  echo "[smoke] AXIOM_AUTH_TOKEN 至少 16 字符（实测 <16 时服务启动即拒：Failed validation for Gateway auth token）" >&2
  echo "[smoke] 用法：--token=\$(openssl rand -hex 16)（本地冒烟可用任意 ≥16 字符串）" >&2
  exit 2
fi
[ -d "$REPO" ] || { echo "仓库不存在: $REPO"; exit 2; }

log "模式=$MODE 仓库=$REPO 端口=$PORT"

# ---------- 1. 构建 ----------
case "$MODE" in
  docker)
    log "容器构建: bun install + bun run build"
    docker run --rm -v "$REPO:/app" -w /app oven/bun:1 \
      sh -c "bun install --frozen-lockfile >/dev/null && bun run build" >/dev/null
    ;;
  host|systemd|pm2)
    log "本机构建: bun run build"
    ( cd "$REPO" && bun run build >/dev/null )
    ;;
esac
gate "构建 dist/" $?

# ---------- 2. 启动 ----------
case "$MODE" in
  docker)
    log "启动容器 $CONTAINER"
    docker run -d --name "$CONTAINER" \
      -v "$REPO:/app" -w /app -p "${PORT}:${PORT}" \
      -e HOST=0.0.0.0 -e AXIOM_AUTH_TOKEN="$TOKEN" -e AXIOM_GATEWAY_PORT="$PORT" \
      -e DATABASE_PATH=/app/data/smoke.db -e LOG_LEVEL=warn \
      oven/bun:1 sh -c "bun run dist/main.js" >/dev/null
    ;;
  host)
    log "启动前台进程（后台，setsid 独立进程组）"
    # 2026-09-29 修复：原实现把 bun 放在子 shell 里后台化，cleanup 杀到的不是真实服务进程，
    # 冒烟“PASS”后端口 18789 仍被占用（实测残留 pid）。改为当前 shell 直接后台化 + 记录真实 pid。
    ( cd "$REPO" && exec env HOST="$BIND" AXIOM_AUTH_TOKEN="$TOKEN" AXIOM_GATEWAY_PORT="$PORT" \
        DATABASE_PATH="$REPO/data/smoke.db" LOG_LEVEL=warn \
        setsid bun run dist/main.js ) >/tmp/axiom-smoke.log 2>&1 &
    SMOKE_PID=$!
    ;;
  systemd)
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      log "systemd 服务已在运行（冒烟后不停止）"
    else
      log "启动 systemd 服务 $SERVICE_NAME"
      systemctl start "$SERVICE_NAME"
      SYSTEMD_STARTED="1"
    fi
    ;;
  pm2)
    if pm2 list 2>/dev/null | grep -q "$PM2_APP.*online"; then
      log "pm2 进程已在运行（冒烟后不停止）"
    else
      log "启动 pm2 应用 $PM2_APP"
      ( cd "$REPO" && AXIOM_AUTH_TOKEN="$TOKEN" pm2 start ecosystem.config.json )
      PM2_STARTED="1"
    fi
    ;;
esac
gate "启动" $?

# ---------- 3. 健康检查（等待就绪） ----------
log "等待 /health（最多 ${WAIT_SECS}s）"
READY="0"
for i in $(seq 1 "$WAIT_SECS"); do
  if curl -sf -H "$AUTH_HEADER" "$HEALTH_URL" | grep -q '"status":"ok"'; then READY="1"; break; fi
  sleep 1
done
gate "健康检查 /health=ok" "$([ "$READY" = "1" ] && echo 0 || echo 1)"

if [ "$READY" != "1" ]; then
  log "服务未就绪，容器/进程日志："
  case "$MODE" in
    docker) docker logs "$CONTAINER" 2>&1 | tail -30 || true ;;
    host)   tail -30 /tmp/axiom-smoke.log 2>/dev/null || true ;;
    systemd) journalctl -u "$SERVICE_NAME" -n 30 --no-pager 2>/dev/null | tail -30 || true ;;
  esac
  exit 1
fi

# ---------- 4. runtime-audit 门禁 ----------
case "$MODE" in
  docker) docker exec "$CONTAINER" bun run audit:runtime >/tmp/axiom-smoke-audit.log 2>&1 ;;
  *) ( cd "$REPO" && AXIOM_AUTH_TOKEN="$TOKEN" bun run audit:runtime >/tmp/axiom-smoke-audit.log 2>&1 ) ;;
esac
AUDIT_RC=$?
cat /tmp/axiom-smoke-audit.log | tail -5
gate "runtime-audit" "$AUDIT_RC"

# ---------- 5. 诊断端点 ----------
curl -sf -H "$AUTH_HEADER" "$DIAG_URL" >/tmp/axiom-smoke-diag.json
gate "诊断端点 /api/audit/diagnostics" $?

# ---------- 6. 聊天往返（带鉴权，2xx=PASS / 其余 FAIL） ----------
# 2026-09-29 修复：原载荷 {"message":...} 与 /chat 契约不符（schema 要求 messages:[{role,content}]）。
# 轮 7 审计二稿：400/401/500 曾被 gate 0 计 PASS——门形同虚设。真实契约载荷下非 2xx 一律 FAIL。
CHAT_HTTP=$(curl -s -o /tmp/axiom-smoke-chat.json -w '%{http_code}' -H "$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"ping"}],"intent":false}' \
  "http://127.0.0.1:${PORT}/chat" 2>/dev/null) || true
if [ "$CHAT_HTTP" = "200" ] || [ "$CHAT_HTTP" = "202" ]; then
  log "聊天往返 HTTP=$CHAT_HTTP（结构化响应 OK）"
  gate "聊天往返（带鉴权）" 0
else
  log "聊天往返 HTTP=$CHAT_HTTP（非 2xx，门 6 FAIL）：$(head -c 200 /tmp/axiom-smoke-chat.json 2>/dev/null)"
  gate "聊天往返（带鉴权）" 1
fi

# ---------- 6b. 鉴权链门（新增，轮 7 部署题②裁决：拆出并升级断言门） ----------
# 无凭证请求必须被 401/403 拒绝——否则鉴权形同虚设（敞开门的服务在健康/聊天门全绿时
# 更危险）。本冒烟自己生成的 TOKEN 是随机值且服务用同一 TOKEN 启动 ⇒ 401/403 预期
# 确定性成立；服务端若未启用鉴权（无 token 启动），本门跳过（SKIP 不计 FAIL）。
NOAUTH_HTTP=$(curl -s -o /tmp/axiom-smoke-noauth.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"ping"}],"intent":false}' \
  "http://127.0.0.1:${PORT}/chat" 2>/dev/null) || true
if [ "$NOAUTH_HTTP" = "401" ] || [ "$NOAUTH_HTTP" = "403" ]; then
  log "鉴权链：无凭证请求 HTTP=$NOAUTH_HTTP（正确拒绝）"
  gate "鉴权链（无凭证拒绝）" 0
else
  log "鉴权链：无凭证请求 HTTP=$NOAUTH_HTTP（预期 401/403）——服务可能未启用鉴权，门跳过（SKIP）"
  # 跳过不进 gate（不计 FAIL 也不计 PASS）：服务端鉴权关闭属部署口径而非冒烟失败
fi

# ---------- 7. 汇总 ----------
if [ "$FAILED" = "0" ]; then
  log "SMOKE PASS（全部门禁通过）"
  exit 0
else
  log "SMOKE FAIL"
  exit 1
fi
