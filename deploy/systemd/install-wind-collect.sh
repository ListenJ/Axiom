#!/usr/bin/env bash
# 安装/更新 Wind 每日采集的 systemd 单元（需 sudo）
#   sudo bash deploy/systemd/install-wind-collect.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "需要 root：sudo bash $0" >&2; exit 1; }

REPO=/run/media/listen/base/openclaw-fusion
SRC="$REPO/deploy/systemd"
DST=/etc/systemd/system
INSTANCE="${1:-listen}"

install -m 0644 "$SRC/wind-collect@.service" "$DST/wind-collect@.service"
install -m 0644 "$SRC/wind-collect@.timer"   "$DST/wind-collect@.timer"
systemctl daemon-reload

# 定时器启用即可（服务由 timer 触发，不单独 enable，避免开机自跑）
systemctl enable --now "wind-collect@$INSTANCE.timer"

echo "--- 状态 ---"
systemctl is-enabled "wind-collect@$INSTANCE.timer"
systemctl is-active  "wind-collect@$INSTANCE.timer"
systemctl list-timers "wind-collect@$INSTANCE.timer" --no-pager || true
echo
echo "手动试跑（可选，会真实消耗额度）："
echo "  sudo systemctl start wind-collect@$INSTANCE.service"
echo "看日志："
echo "  journalctl -u wind-collect@$INSTANCE.service -f"
