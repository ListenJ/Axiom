#!/usr/bin/env bash
# deploy.sh — ship runtime-go binaries to the two-node cluster and (re)start services.
#
# Topology:
#   node n1: listen@192.168.0.150 — searchd :9103, agentd :9102, pcdad :9101, redis :6379 (docker)
#   node n2: data@192.168.0.22   — searchd :9103, agentd :9102, pcdad :9101
#
# 192.168.0.150 inbound is firewall-blocked (no sudo to change it), so n2
# reaches n1 through a persistent SSH reverse tunnel on n1:
#   19101->9101, 19102->9102, 19103->9103, 16379->6379 (all to 127.0.0.1 on n2)
# Each node never dials its own addr, so per-node NODES JSON may differ in
# the *other* node's addr; shard ownership keys on sorted node IDs only.
#
# All services run with GOMAXPROCS=2 by default (2-core budget validation);
# override per node with GP_N1/GP_N2 env (e.g. full-core cluster benchmarks).
# Usage: bash scripts/runtime-go/deploy.sh [build]
set -euo pipefail

GP_N1="${GP_N1:-2}"
GP_N2="${GP_N2:-2}"
# GOGC=800: query path allocates little but at 10k+ qps default GOGC=100 still
# burns ~20% CPU on GC; both nodes have RAM headroom. Override with GOGC env.
GOGC="${GOGC:-800}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/scripts/runtime-go/bin"
N1="listen@192.168.0.150"
N2="data@192.168.0.22"
REMOTE_DIR="runtime-go"

# n1 dials n2 directly; n2 dials n1 via the reverse tunnel on 127.0.0.1:191xx.
SEARCHD_NODES_N1='[{"id":"n1","addr":"http://192.168.0.150:9103","role":"primary"},{"id":"n2","addr":"http://192.168.0.22:9103","role":"standby"}]'
SEARCHD_NODES_N2='[{"id":"n1","addr":"http://127.0.0.1:19103","role":"primary"},{"id":"n2","addr":"http://192.168.0.22:9103","role":"standby"}]'
AGENTD_NODES_N1='[{"id":"n1","addr":"http://192.168.0.150:9102","role":"primary"},{"id":"n2","addr":"http://192.168.0.22:9102","role":"standby"}]'
AGENTD_NODES_N2='[{"id":"n1","addr":"http://127.0.0.1:19102","role":"primary"},{"id":"n2","addr":"http://192.168.0.22:9102","role":"standby"}]'
REDIS_N1="127.0.0.1:6379"
REDIS_N2="127.0.0.1:16379"

if [ "${1:-}" = "build" ]; then
  bash "$ROOT/scripts/runtime-go/build-linux.sh"
fi

ship() {
  local host="$1"
  ssh "$host" "mkdir -p $REMOTE_DIR/bin $REMOTE_DIR/data $REMOTE_DIR/logs; for p in pcdad agentd searchd; do [ -f $REMOTE_DIR/logs/\$p.pid ] && kill \$(cat $REMOTE_DIR/logs/\$p.pid) 2>/dev/null || true; done; sleep 1"
  scp -q "$BIN"/{pcdad,agentd,searchd,loadgen} "$host:$REMOTE_DIR/bin/"
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
SEARCHD_ADDR=:9103 SEARCHD_NODE_ID=$node_id SEARCHD_NODES='$searchd_nodes' \
  SEARCHD_REDIS_ADDR=$redis_addr \
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
  ssh "$N1" "pgrep -f 'ssh -f -N.*19103' >/dev/null || ssh -f -N -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 19101:127.0.0.1:9101 -R 19102:127.0.0.1:9102 -R 19103:127.0.0.1:9103 -R 16379:127.0.0.1:6379 data@192.168.0.22"
  # Verify the forwarded ports LISTEN on n2 (backend may still be down here).
  ssh "$N2" "ss -tln | grep -c -E '1910[123]|16379' | xargs -I{} echo 'tunnel listening ports: {}/4'"
}

echo "== ship binaries =="
ship "$N1"
ship "$N2"

echo "== redis on n1 (docker) =="
ssh "$N1" "docker ps --format '{{.Names}}' | grep -qx openclaw-redis || docker run -d --name openclaw-redis -p 6379:6379 redis:7 >/dev/null; docker ps --filter name=openclaw-redis --format '{{.Names}} {{.Status}}'"

echo "== ssh reverse tunnel n1->n2 =="
ensure_tunnel

echo "== start n1 (192.168.0.150, GOMAXPROCS=$GP_N1) =="
start_node "$N1" n1 "$SEARCHD_NODES_N1" "$AGENTD_NODES_N1" "$REDIS_N1" "$GP_N1"
echo "== start n2 (192.168.0.22, GOMAXPROCS=$GP_N2) =="
start_node "$N2" n2 "$SEARCHD_NODES_N2" "$AGENTD_NODES_N2" "$REDIS_N2" "$GP_N2"

echo "== cluster view (n2 entry) =="
curl -s -m 5 http://192.168.0.22:9103/cluster; echo
echo "deploy done."
