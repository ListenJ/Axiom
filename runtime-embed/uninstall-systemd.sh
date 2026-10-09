#!/usr/bin/env bash
# 卸载/停用 Axiom 本地 CUDA embedding 服务，并阻止其再次自启。需 root 执行。
#
#   sudo bash runtime-embed/uninstall-systemd.sh            # 停用+屏蔽+移除单元（保留模型文件）
#   sudo bash runtime-embed/uninstall-systemd.sh --purge    # 追加删除 .venv/models/.cache（释放约 10G）
#
# 背景：axiom-embed@listen.service 为 system 服务、enabled + Restart=always；仅 stop 会被
# systemd 拉起，必须 stop+disable+mask，否则仍会开机自启。
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash runtime-embed/uninstall-systemd.sh [--purge]" >&2
  exit 1
fi

REPO=/run/media/listen/base/openclaw-fusion
UNIT=/etc/systemd/system/axiom-embed@.service
SVC=axiom-embed@listen.service

systemctl stop "$SVC" 2>/dev/null || true
systemctl disable "$SVC" 2>/dev/null || true
systemctl mask "$SVC" 2>/dev/null || true
rm -f "$UNIT"
systemctl daemon-reload
systemctl reset-failed "$SVC" 2>/dev/null || true

echo "axiom-embed: stopped + disabled + masked, unit removed ($UNIT)"
echo -n "is-enabled: "; systemctl is-enabled "$SVC" 2>&1 || true
echo -n "is-active:  "; systemctl is-active "$SVC" 2>&1 || true

if [ "${1:-}" = "--purge" ]; then
  echo "purging runtime-embed artifacts (.venv / models / .cache /.tmp)，释放磁盘约 10G…"
  rm -rf "$REPO/runtime-embed/.venv" "$REPO/runtime-embed/models" \
         "$REPO/runtime-embed/.cache" "$REPO/runtime-embed/.tmp"
  echo "purged."
fi
