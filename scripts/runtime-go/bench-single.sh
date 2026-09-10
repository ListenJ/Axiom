#!/usr/bin/env bash
# 单机多 acceptor 对照压测（P2-12b 效果验证，需 Linux + SO_REUSEPORT）
#
# 用法（在 Linux 节点上，二进制已就绪时）：
#   bash scripts/runtime-go/bench-single.sh [BINARY_DIR] [DOCS] [DURATION]
# 流程：对每个 N in 1,$(nproc) 分别以 SEARCHD_LISTENERS=N 启动 searchd，
#       灌入 DOCS 文档后闭环全速压测 DURATION，输出对照表。
set -euo pipefail
BIN_DIR="${1:-./bin}"
DOCS="${2:-100000}"
DUR="${3:-20s}"
ADDR="127.0.0.1:19103"

for N in 1 "$(nproc)"; do
  echo "=== acceptors=$N ==="
  SEARCHD_ADDR="$ADDR" SEARCHD_NODE_ID="bench-$N" SEARCHD_LISTENERS="$N" \
    "$BIN_DIR/searchd" >/tmp/bench-searchd-$N.log 2>&1 &
  SPID=$!
  sleep 2
  "$BIN_DIR/loadgen" -mode seed -addr "http://$ADDR" -docs "$DOCS" -batch 500 >/dev/null
  "$BIN_DIR/loadgen" -mode search -addr "http://$ADDR" -qps 0 -workers 192 -duration "$DUR" | grep -E "achieved|latency"
  kill "$SPID" 2>/dev/null || true
  wait "$SPID" 2>/dev/null || true
  sleep 1
done
echo "=== 对照完成：关注 achieved qps 与 p95/p99 随 acceptor 数的变化 ==="
