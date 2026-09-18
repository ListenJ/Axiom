#!/usr/bin/env bash
# deploy.sh — ship runtime-go binaries to the two-node cluster and (re)start services.
#
# Topology (2026-09-12: n2 moved data@${LAN_NODE_N2_LEGACY} -> listen@${LAN_NODE_N2};
# .22 is retired from the cluster. n2 IP history: initially assigned .111,
# which DHCP later reclaimed for w1; the box now holds wired .110 (used by the
# cluster) and WiFi .108 (unstable RTT 14-105ms, do not use for peering):
#   node n1: listen@${LAN_NODE_N1} — searchd :9103, agentd :9102, pcdad :9101, redis :6379 (docker)
#   node n2: listen@${LAN_NODE_N2} — searchd :9103, agentd :9102, pcdad :9101
#
# Note (2026-09-13): .150 is offline. w1 (Windows, ${LAN_NODE_W1}) currently
# serves as n1 with a locally started searchd (this script cannot deploy to a
# local Windows host; scope=n1 targets .150 and will fail preflight while it
# stays offline).
#
# n1 inbound is firewall-blocked (no sudo to change it), so n2 reaches n1
# through a persistent SSH reverse tunnel n1 -> n2 (-R binds on n2's loopback):
#   19101->9101, 19102->9102, 19103->9103, 16379->6379
# The tunnel needs n1's SSH key authorized on n2 and is only managed for
# scope=all. Single-node scopes skip it: n1 then shows up unhealthy on n2 and
# queries degrade to partial:true (expected single-node behavior).
#
# Usage: bash scripts/runtime-go/deploy.sh [build] [all|n1|n2]
#   build  cross-compile linux/amd64 binaries first (scripts/runtime-go/build-linux.sh)
#   scope  deploy target, default all. "n2" with n1 offline = single-node
#          degrade deploy; preflight checks only the nodes in scope.
#
# Env overrides:
#   N1 / N2            ssh targets (default listen@${LAN_NODE_N1} / listen@${LAN_NODE_N2})
#   N1_ADDR / N2_ADDR  cluster-visible searchd addrs (default
#                      http://${LAN_NODE_N1}:9103 / http://${LAN_NODE_N2}:9103);
#                      agentd addrs derive from the same host on :9102
#   REDIS_HOST         redis addr override for BOTH nodes; default is per-node
#                      (n1: docker 127.0.0.1:6379; n2: tunnel 127.0.0.1:16379,
#                      or none -> in-process lock when scope != all)
#   AUTH_TOKEN         shared write-auth token, exported to all three daemons as
#                      SEARCHD_/AGENTD_/PCDAD_AUTH_TOKEN (outbound peer RPC reads
#                      SEARCHD_AUTH_TOKEN); unset = write endpoints return 403
#   GP_N1 / GP_N2      GOMAXPROCS per node (default: remote nproc)
#   GOGC               GC target, default 800
set -euo pipefail

GOGC="${GOGC:-800}"
N1="${N1:-listen@${LAN_NODE_N1:?set LAN_NODE_N1 (see docs/DISTRIBUTED-TESTING.md)}}"
N2="${N2:-listen@${LAN_NODE_N2:?set LAN_NODE_N2 (see docs/DISTRIBUTED-TESTING.md)}}"
N1_ADDR="${N1_ADDR:-http://${LAN_NODE_N1:?set LAN_NODE_N1}:9103}"
N2_ADDR="${N2_ADDR:-http://${LAN_NODE_N2:?set LAN_NODE_N2}:9103}"
REDIS_HOST="${REDIS_HOST:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
GP_N1="${GP_N1:-}"
GP_N2="${GP_N2:-}"
REMOTE_DIR="runtime-go"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/scripts/runtime-go/bin"

BUILD=0
SCOPE="all"
for a in "$@"; do
  case "$a" in
    build)     BUILD=1 ;;
    all|n1|n2) SCOPE="$a" ;;
    *) echo "usage: $0 [build] [all|n1|n2]" >&2; exit 2 ;;
  esac
done

# Cluster-visible host:port per service. Node n1 is primary, n2 standby in
# every view (same on all nodes; shard ownership keys on sorted node IDs only).
N1_HOST="${N1_ADDR#http://}"; N1_HOST="${N1_HOST%:*}"
N2_HOST="${N2_ADDR#http://}"; N2_HOST="${N2_HOST%:*}"
if [ "$SCOPE" = "all" ]; then
  N1_VIEW_SEARCHD="127.0.0.1:19103"   # via reverse tunnel
  N1_VIEW_AGENTD="127.0.0.1:19102"
else
  N1_VIEW_SEARCHD="${N1_HOST}:9103"   # direct LAN (n1 may be unreachable)
  N1_VIEW_AGENTD="${N1_HOST}:9102"
fi

node_json() { # id host:port role
  printf '{"id":"%s","addr":"http://%s","role":"%s"}' "$1" "$2" "$3"
}
SEARCHD_NODES_N1="[$(node_json n1 "${N1_HOST}:9103" primary),$(node_json n2 "${N2_HOST}:9103" standby)]"
SEARCHD_NODES_N2="[$(node_json n1 "$N1_VIEW_SEARCHD" primary),$(node_json n2 "${N2_HOST}:9103" standby)]"
AGENTD_NODES_N1="[$(node_json n1 "${N1_HOST}:9102" primary),$(node_json n2 "${N2_HOST}:9102" standby)]"
AGENTD_NODES_N2="[$(node_json n1 "$N1_VIEW_AGENTD" primary),$(node_json n2 "${N2_HOST}:9102" standby)]"

REDIS_N1="${REDIS_HOST:-127.0.0.1:6379}"
if [ -n "$REDIS_HOST" ]; then
  REDIS_N2="$REDIS_HOST"
elif [ "$SCOPE" = "all" ]; then
  REDIS_N2="127.0.0.1:16379"
else
  REDIS_N2=""   # no tunnel -> no redis on n2 -> in-process lock
fi

preflight() {
  local hosts=() h
  case "$SCOPE" in
    all) hosts=("$N1" "$N2") ;;
    n1)  hosts=("$N1") ;;
    n2)  hosts=("$N2") ;;
  esac
  for h in "${hosts[@]}"; do
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$h" true 2>/dev/null; then
      echo "ERROR: preflight: node unreachable: $h (scope=$SCOPE)" >&2
      echo "       fix SSH access or run with an explicit scope: $0 [n1|n2]" >&2
      exit 1
    fi
  done
  echo "preflight ok: ${hosts[*]}"
}

# GOMAXPROCS defaults to the remote core count (peak-performance default);
# override with GP_N1/GP_N2 (e.g. pinned-budget benchmarks).
if [ -z "$GP_N1" ] && { [ "$SCOPE" = "all" ] || [ "$SCOPE" = "n1" ]; }; then
  GP_N1="$(ssh -o BatchMode=yes "$N1" nproc | tr -d '[:space:]')"
  [ -n "$GP_N1" ] || { echo "ERROR: nproc detect failed on $N1; set GP_N1" >&2; exit 1; }
fi
if [ -z "$GP_N2" ] && { [ "$SCOPE" = "all" ] || [ "$SCOPE" = "n2" ]; }; then
  GP_N2="$(ssh -o BatchMode=yes "$N2" nproc | tr -d '[:space:]')"
  [ -n "$GP_N2" ] || { echo "ERROR: nproc detect failed on $N2; set GP_N2" >&2; exit 1; }
fi

if [ "$BUILD" = 1 ]; then
  bash "$ROOT/scripts/runtime-go/build-linux.sh"
fi

ship() {
  local host="$1"
  ssh "$host" "mkdir -p $REMOTE_DIR/bin $REMOTE_DIR/data $REMOTE_DIR/logs; for p in pcdad agentd searchd; do [ -f $REMOTE_DIR/logs/\$p.pid ] && kill \$(cat $REMOTE_DIR/logs/\$p.pid) 2>/dev/null || true; done; sleep 1"
  # 逐文件传输：Windows Git-Bash 的 scp 对 {a,b,c} 批量展开偶发
  # "dest open Failure"（2026-08-25 实测），循环单发稳定。
  for b in pcdad agentd searchd loadgen; do
    scp -q "$BIN/$b" "$host:$REMOTE_DIR/bin/$b"
  done
  ssh "$host" "chmod +x $REMOTE_DIR/bin/*"
}

start_node() {
  local host="$1" node_id="$2" searchd_nodes="$3" agentd_nodes="$4" redis_addr="$5" gp="$6"
  ssh "$host" "bash -s" <<EOF
set -e
cd $REMOTE_DIR
# stop previous instances (ignore errors)
for p in pcdad agentd searchd; do
  [ -f logs/\$p.pid ] && kill \$(cat logs/\$p.pid) 2>/dev/null || true
done
sleep 1
export GOMAXPROCS=$gp
export GOGC=$GOGC
if [ -n "$AUTH_TOKEN" ]; then
  export SEARCHD_AUTH_TOKEN="$AUTH_TOKEN" AGENTD_AUTH_TOKEN="$AUTH_TOKEN" PCDAD_AUTH_TOKEN="$AUTH_TOKEN"
fi
SEARCHD_ADDR=:9103 SEARCHD_NODE_ID=$node_id SEARCHD_NODES='$searchd_nodes' \
  ${redis_addr:+SEARCHD_REDIS_ADDR=$redis_addr} \
  nohup ./bin/searchd > logs/searchd.log 2>&1 &
echo \$! > logs/searchd.pid
AGENTD_ADDR=:9102 AGENTD_NODE_ID=$node_id AGENTD_NODES='$agentd_nodes' \
  nohup ./bin/agentd > logs/agentd.log 2>&1 &
echo \$! > logs/agentd.pid
PCDAD_ADDR=:9101 PCDAD_NODE_ID=$node_id PCDAD_DATA_DIR=data \
  nohup ./bin/pcdad > logs/pcdad.log 2>&1 &
echo \$! > logs/pcdad.pid
sleep 2
for port in 9101 9102 9103; do
  code=\$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:\$port/healthz || true)
  echo "$node_id :\$port healthz -> \$code"
done
EOF
}

ensure_tunnel() {
  # Persistent reverse tunnel on n1 exposing its services to n2 (see header).
  # Requires n1's SSH key to be authorized on n2.
  #
  # 修复（2026-08-25）：原 `pgrep -f 'ssh -f -N.*19103'` 守卫经 ssh bash -c
  # 执行时会匹配到自身命令行（自匹配），守卫恒真 → 隧道从不建立。
  # 改为以 N2 侧端口存活为唯一事实源：不通则清理陈旧隧道（[s]sh 防 pgrep
  # 自匹配）后重建并复验；在节点启动前调用也成立（只验转发，不验后端）。
  if ssh "$N2" "ss -tln 2>/dev/null | grep -q ':19103'"; then
    return 0
  fi
  ssh "$N1" "pkill -f '[s]sh -f -N' 2>/dev/null || true"
  ssh "$N1" "ssh -f -N -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 19101:127.0.0.1:9101 -R 19102:127.0.0.1:9102 -R 19103:127.0.0.1:9103 -R 16379:127.0.0.1:6379 $N2"
  if ! ssh "$N2" "ss -tln 2>/dev/null | grep -q ':19103'"; then
    echo "ERROR: tunnel established but 19103 not listening on n2" >&2
    exit 1
  fi
  # Verify the forwarded ports LISTEN on n2 (backend may still be down here).
  ssh "$N2" "ss -tln | grep -c -E '1910[123]|16379' | xargs -I{} echo 'tunnel listening ports: {}/4'"
}

echo "== preflight (scope=$SCOPE) =="
preflight

echo "== ship binaries =="
if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "n1" ]; then
  ship "$N1"
fi
if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "n2" ]; then
  ship "$N2"
fi

if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "n1" ]; then
  echo "== redis on n1 (docker) =="
  ssh "$N1" "docker ps --format '{{.Names}}' | grep -qx openclaw-redis || docker run -d --name openclaw-redis -p 6379:6379 redis:7 >/dev/null; docker ps --filter name=openclaw-redis --format '{{.Names}} {{.Status}}'"
fi

if [ "$SCOPE" = "all" ]; then
  echo "== ssh reverse tunnel n1->n2 =="
  ensure_tunnel
fi

if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "n1" ]; then
  echo "== start n1 ($N1_ADDR, GOMAXPROCS=$GP_N1) =="
  start_node "$N1" n1 "$SEARCHD_NODES_N1" "$AGENTD_NODES_N1" "$REDIS_N1" "$GP_N1"
fi
if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "n2" ]; then
  echo "== start n2 ($N2_ADDR, GOMAXPROCS=$GP_N2) =="
  start_node "$N2" n2 "$SEARCHD_NODES_N2" "$AGENTD_NODES_N2" "$REDIS_N2" "$GP_N2"
fi

echo "== cluster view =="
case "$SCOPE" in
  n1) curl -s -m 5 "$N1_ADDR/cluster" || echo "(n1 /cluster unreachable from here — n1 inbound may be firewall-blocked)" ;;
  *)  curl -s -m 5 "$N2_ADDR/cluster" || echo "(n2 /cluster unreachable from here)" ;;
esac
echo
echo "deploy done."
