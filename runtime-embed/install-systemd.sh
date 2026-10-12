#!/usr/bin/env bash
# Install/restart the Axiom local CUDA embedding service. Run with sudo.
# 仓库根从脚本位置推导（AXIOM_REPO_ROOT 可覆盖）；服务实例用户从
# SUDO_USER 推导（轮 7 审计：模板化 unit 写死 listen，换用户/机器即失败）。
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash runtime-embed/install-systemd.sh" >&2
  exit 1
fi

REPO="${AXIOM_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
UNIT_SRC="$REPO/deploy/systemd/axiom-embed@.service"
UNIT_DST=/etc/systemd/system/axiom-embed@.service
INSTANCE="${SUDO_USER:-$(id -un)}"

if [ ! -f "$REPO/runtime-embed/.env" ]; then
  echo "missing $REPO/runtime-embed/.env (copy .env.example and review it first)" >&2
  exit 1
fi

install -m 0644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable --now "axiom-embed@$INSTANCE.service"

code=000
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9001/health || true)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "health_http=$code"
systemctl is-active "axiom-embed@$INSTANCE.service"
systemctl is-enabled "axiom-embed@$INSTANCE.service"
exit 0
