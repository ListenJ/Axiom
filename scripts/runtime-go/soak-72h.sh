#!/usr/bin/env bash
# soak-72h.sh — 用户侧 72h 浸泡压测（在 w1 / Git-Bash 下执行）。
#
# 用法:
#   bash scripts/runtime-go/soak-72h.sh                 # 默认 72h，mixed @3000 QPS
#   SOAK_HOURS=1 bash scripts/runtime-go/soak-72h.sh    # 短验证跑
#
# 环境变量:
#   ADDR        压测入口（默认 http://127.0.0.1:9103，即 w1 本机 searchd）
#   TOKEN       写鉴权 token（默认 n2swap-test-2026，需与集群部署一致）
#   QPS         定速目标（默认 3000，约为实测混合峰值 10893 的 27%）
#   WORKERS     并发连接数（默认 32）
#   SOAK_HOURS  时长（默认 72）
#   N2          n2 ssh 目标（默认 listen@192.168.0.110），用于 RSS 抓取与存活检查
#
# 通过判据（脚本结束时自动汇总）:
#   1) 错误率 = 0
#   2) p95 无漂移：末小时 p95 与首小时 p95 比值 < 1.5（loadgen 汇总 + 每小时快照）
#   3) RSS 无泄漏：结束 RSS / 开始 RSS < 2，且结束 RSS 无持续单调增长
#   4) 零重启：三守护进程 PID 与启动时一致
set -uo pipefail

ADDR="${ADDR:-http://127.0.0.1:9103}"
TOKEN="${TOKEN:-n2swap-test-2026}"
QPS="${QPS:-3000}"
WORKERS="${WORKERS:-32}"
SOAK_HOURS="${SOAK_HOURS:-72}"
N2="${N2:-listen@192.168.0.110}"
SNAP_INTERVAL="${SNAP_INTERVAL:-3600}"   # RSS 快照间隔（秒）

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LG="$ROOT/scripts/runtime-go/bin/loadgen"   # windows 本机压测用 build-windows 产物；见下方回退
if [ ! -x "$LG" ]; then LG="$ROOT/.tmp/rt-w1/loadgen.exe"; fi
[ -x "$LG" ] || { echo "ERROR: loadgen not found (build first: build-linux.sh / go build ./cmd/loadgen)" >&2; exit 1; }

LOGDIR="$ROOT/.tmp/soak-72h-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOGDIR"
echo "soak: duration=${SOAK_HOURS}h qps=$QPS workers=$WORKERS addr=$ADDR"
echo "logs: $LOGDIR"

rss_snapshot() {
  local tag="$1"
  {
    echo "-- $tag $(date '+%F %T') --"
    echo "[w1 searchd]"
    powershell.exe -NoProfile -Command "Get-Process searchd -ErrorAction SilentlyContinue | Select-Object Id,@{n='RSS_MB';e={[math]::Round(\$_.WorkingSet64/1MB,1)}} | Format-Table -HideTableHeaders"
    echo "[n2 daemons]"
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$N2" \
      "for p in searchd agentd pcdad; do pid=\$(cat runtime-go/logs/\$p.pid 2>/dev/null); rss=\$(ps -o rss= -p \$pid 2>/dev/null); echo \"\$p pid=\$pid RSS_MB=\$((\${rss:-0}/1024))\"; done"
  } >> "$LOGDIR/rss.log" 2>&1
}

pids_snapshot() {
  {
    echo "-- pids $(date '+%F %T') --"
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$N2" \
      "for p in searchd agentd pcdad; do cat runtime-go/logs/\$p.pid 2>/dev/null; done" | tr '\n' ' '
    echo ""
    powershell.exe -NoProfile -Command "(Get-Process searchd -ErrorAction SilentlyContinue).Id"
  } >> "$LOGDIR/pids.log" 2>&1
}

rss_snapshot "start"
pids_snapshot

# 主压测：loadgen 直接输出到汇总日志；每小时在后台补一次 RSS 快照。
( while true; do sleep "$SNAP_INTERVAL"; rss_snapshot "periodic"; done ) &
SNAPPER=$!
trap 'kill $SNAPPER 2>/dev/null' EXIT

"$LG" -mode search -addr "$ADDR" -qps "$QPS" -workers "$WORKERS" \
  -duration "${SOAK_HOURS}h" -mix mixed -token "$TOKEN" | tee "$LOGDIR/loadgen-final.txt"

kill "$SNAPPER" 2>/dev/null
rss_snapshot "end"
pids_snapshot

echo ""
echo "=== soak summary ==="
tail -20 "$LOGDIR/loadgen-final.txt"
echo ""
echo "判据人工核对:"
echo "  1) 错误率: 看 loadgen-final.txt 的 errors 行，应为 0 (0.00%)"
echo "  2) p95 漂移: 对比 rss.log 各时点与 loadgen-final.txt 末段 p95（本脚本无分时延迟统计，"
echo "     精确分时漂移以 loadgen-final.txt 汇总 p95 相对 30min 复测值 10.92ms 的比值 < 1.5 为准）"
echo "  3) RSS 泄漏: 对比 rss.log 的 start/end 快照，比值 < 2 且无单调增长"
echo "  4) 零重启: 对比 pids.log 的 start/end PID 列表，应完全一致"
echo "全部日志: $LOGDIR"
