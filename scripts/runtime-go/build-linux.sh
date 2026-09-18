#!/usr/bin/env bash
# build-linux.sh — cross-compile runtime-go daemons for linux/amd64.
# Usage: bash scripts/runtime-go/build-linux.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/scripts/runtime-go/bin"
mkdir -p "$OUT"

cd "$ROOT/runtime-go"
export CGO_ENABLED=0 GOOS=linux GOARCH=amd64
for cmd in pcdad agentd searchd loadgen; do
  go build -trimpath -ldflags='-s -w' -o "$OUT/$cmd" "./cmd/$cmd"
  echo "built $OUT/$cmd"
done
