#!/usr/bin/env bash
# ============================================================================
# Axiom — 自建 SearXNG 一键部署 / 自检
#
#   bash scripts/deploy-searxng.sh [up|down|restart|status|logs|check|config]
#
# 做什么：
#   1. 准备 .env，自动生成并写入 SearXNG 密钥（两个变量名，见下）
#   2. docker compose 拉起 searxng + searxng-valkey（只启动这两个服务）
#   3. 等 /healthz 就绪，再验证 /search?format=json 真的返回 JSON 且**结果非空**
#
# 密钥为什么有两个名字（二者必须同值，不要"统一"成一个）：
#   SEARXNG_SECRET      —— SearXNG **容器**读取。上游 settings_defaults.py 里
#                          secret_key 的 environ_name 就是 'SEARXNG_SECRET'；
#                          compose 从 SEARXNG_SECRET_KEY 取值后以这个名字注入容器。
#   SEARXNG_SECRET_KEY  —— Axiom **应用**读取（config/web-search.yaml 的
#                          secret_key_env 字段）。
#   只写其一都会出现"密钥生成了但某一侧读不到"。
#
# 可用环境变量：
#   COMPOSE_FILE=docker-compose.yml   指定 compose 文件
#   ENV_FILE=/path/to/.env            指定 env 文件
#   WAIT_SECONDS=90                   等待就绪的上限
#
# 配置来源：config/searxng/settings.yml（json 格式已启用）
# 官方参考：https://docs.searxng.org/admin/installation-docker.html
# ============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
WAIT_SECONDS="${WAIT_SECONDS:-90}"
SEARXNG_SERVICES=(searxng-valkey searxng)

log()  { printf '\033[1;36m[searxng]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[searxng]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[searxng]\033[0m %s\n' "$*" >&2; exit 1; }

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  else
    die "未找到 docker compose（v2 插件）或 docker-compose"
  fi
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "未安装 docker"
  if ! docker info >/dev/null 2>&1; then
    die "无法访问 Docker daemon：把当前用户加入 docker 组后重新登录（sudo usermod -aG docker \$USER）"
  fi
}

read_env_var() {
  local key="$1" fallback="$2" v
  v="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "$fallback"; fi
}

# 幂等写入：存在则替换该键，不存在则追加（保留文件其余内容）
set_env_var() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# 占位/示例值一律视为"未设置"，避免用已知默认密钥上线
is_placeholder() {
  case "${1:-}" in
    ''|change-me-*|CHANGE_THIS*|your-*|ultrasecretkey) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$PROJECT_DIR/.env.example" ]; then
      cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
      log "已从 .env.example 创建 $ENV_FILE"
    else
      : > "$ENV_FILE"
      log "已创建空的 $ENV_FILE"
    fi
  fi

  local app_key container_key
  app_key="$(read_env_var SEARXNG_SECRET_KEY '')"
  container_key="$(read_env_var SEARXNG_SECRET '')"

  # 两个变量必须同值：以"先出现的有效值"为准，另一侧补齐。
  local secret="" need_write=0
  if ! is_placeholder "$app_key"; then
    secret="$app_key"
    [ "$container_key" = "$app_key" ] || need_write=1
  elif ! is_placeholder "$container_key"; then
    secret="$container_key"
    need_write=1
  else
    need_write=1
  fi

  if [ "$need_write" -eq 1 ]; then
    if [ -z "$secret" ]; then
      secret="$(openssl rand -hex 32 2>/dev/null \
        || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      log "已生成 SearXNG 密钥（openssl rand -hex 32）"
    fi
    if ! grep -qE '^# ── 自建 SearXNG' "$ENV_FILE" 2>/dev/null; then
      printf '\n# ── 自建 SearXNG（%s 由 deploy-searxng.sh 维护，两者必须同值）──\n' "$(date +%F)" >> "$ENV_FILE"
    fi
    set_env_var SEARXNG_SECRET_KEY "$secret"
    set_env_var SEARXNG_SECRET "$secret"
    log "已写入 SEARXNG_SECRET_KEY 与 SEARXNG_SECRET（同值）到 $ENV_FILE"
    log "  该文件已被 .gitignore 忽略；不要提交真实密钥（AGENTS.md 规则 11）"
  fi
}

cmd_wait() {
  local port url i=0
  port="$(read_env_var SEARXNG_PORT 8080)"
  url="http://127.0.0.1:${port}/healthz"
  log "等待 ${url} 就绪（上限 ${WAIT_SECONDS}s）..."
  until curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge "$WAIT_SECONDS" ]; then
      warn "SearXNG 未在 ${WAIT_SECONDS}s 内就绪，最近日志："
      compose logs --tail 50 searxng || true
      die "/healthz 不可达，部署失败"
    fi
    sleep 1
  done
  log "/healthz OK"
}

cmd_check() {
  local port base body n
  port="$(read_env_var SEARXNG_PORT 8080)"
  base="http://127.0.0.1:${port}"

  curl -fsS --max-time 5 "$base/healthz" >/dev/null || die "$base/healthz 不可达"
  log "/healthz OK"

  body="$(curl -fsS --max-time 30 "$base/search?q=docker&format=json" 2>/dev/null || true)"
  if ! printf '%s' "$body" | grep -q '"results"'; then
    warn "未拿到 JSON 响应（403 通常是 search.formats 未启用 json）"
    printf '%s\n' "${body:0:300}"
    die "JSON API 自检失败"
  fi

  # JSON 通 ≠ 能搜到东西：引擎全挂时同样返回 200 + 空 results。
  # 这里解析结果数与 unresponsive_engines，把「0 条」变成显式失败。
  local summary
  summary="$(printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_FAIL"); raise SystemExit
res = d.get("results") or []
print("%d|%s" % (len(res), d.get("unresponsive_engines")))
' 2>/dev/null || true)"

  case "$summary" in
    ""|PARSE_FAIL)
      n="$(printf '%s' "$body" | grep -o '"url":' | wc -l | tr -d ' ' || true)"
      log "JSON API OK（本次返回约 ${n} 条结果）"
      ;;
    *)
      n="${summary%%|*}"
      if [ "$n" -eq 0 ]; then
        warn "JSON API 通了，但 0 条结果 —— 通常是容器出不了网或引擎被上游拒绝。"
        warn "  失败/被跳过的引擎：${summary#*|}"
        warn "  排查：1) 容器能否出网（本机环境需在 settings.yml 配 outgoing.proxies）"
        warn "        2) docker logs --tail 50 axiom-searxng | grep -i 'engine timeout'"
        warn "        3) 确认 config/searxng/settings.yml 里 engines 至少开了 google/bing 等可用引擎"
        die "SearXNG 能连上但搜不到结果"
      fi
      log "JSON API OK（本次返回 ${n} 条结果，跳过/失败的引擎：${summary#*|})"
      ;;
  esac
  log "Axiom 侧：SEARXNG_INSTANCE=http://127.0.0.1:${port}（compose 内为 http://searxng:8080）"
}

cmd_up() {
  require_docker
  ensure_env
  log "启动 SearXNG 栈：$COMPOSE_FILE"
  compose up -d "${SEARXNG_SERVICES[@]}"
  cmd_wait
  cmd_check
  log "完成。查看日志：bash scripts/deploy-searxng.sh logs"
}

cmd_down() {
  require_docker
  log "停止并移除 SearXNG 容器（不影响 Axiom 其他服务）..."
  compose rm -sf "${SEARXNG_SERVICES[@]}"
}

cmd_restart() {
  cmd_down
  cmd_up
}

cmd_status() {
  require_docker
  compose ps "${SEARXNG_SERVICES[@]}"
}

cmd_logs() {
  require_docker
  compose logs -f --tail 100 searxng
}

cmd_config() {
  ensure_env
  log "渲染 compose 配置（不启动容器）：$COMPOSE_FILE"
  compose config
}

usage() {
  cat <<'EOF'
用法: bash scripts/deploy-searxng.sh [命令]

命令:
  up        生成/补齐 .env，启动 searxng + searxng-valkey，并自检（默认）
  down      停止并移除 SearXNG 容器
  restart   重启 SearXNG 栈
  status    查看容器状态
  logs      跟踪 searxng 日志
  check     只做 /healthz + JSON API 自检
  config    仅渲染 compose 配置做静态校验

示例:
  bash scripts/deploy-searxng.sh
  SEARXNG_PORT=8081 bash scripts/deploy-searxng.sh up
EOF
}

case "${1:-up}" in
  up)      cmd_up ;;
  down)    cmd_down ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  check)   cmd_check ;;
  config)  cmd_config ;;
  -h|--help|help) usage ;;
  *) usage; die "未知命令: $1" ;;
esac
