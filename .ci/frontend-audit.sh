#!/bin/bash
# CI ????????
# ??: .ci/frontend-audit.sh [--base-url=http://127.0.0.1:18789] [--out=reports/frontend-audit-ci-<ts>.md]
# ??: ???? ? ???? ? ??? ? ? 9 ??? ? ???? ? ???
# ??: critical/major>0 ? audit CLI exit 1 ? CI ??????????
set -uo pipefail
cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:18789}"
PORT="${PORT:-18789}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="${OUT:-reports/frontend-audit-ci-${TS}.md}"
mkdir -p reports

echo "[FrontendAudit-CI] build frontend -> public/ ..."
( cd frontend && bun install --frozen-lockfile >/dev/null 2>&1 && bunx vite build >/dev/null 2>&1 )
cp -r frontend/dist/index.html public/index.html
rm -rf public/assets && cp -r frontend/dist/assets public/assets

echo "[FrontendAudit-CI] start backend on :${PORT} ..."
AXIOM_GATEWAY_PORT="${PORT}" AXIOM_AUTH_TOKEN="${AXIOM_AUTH_TOKEN:-ci-visual-audit-token-at-least-16chars}" \
  nohup bun run src/main.ts > data/logs/ci-frontend-audit.log 2>&1 &
BACKEND_PID=$!
trap 'kill ${BACKEND_PID} 2>/dev/null || true' EXIT

echo "[FrontendAudit-CI] wait for health ..."
ok=0
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/health" || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != "1" ]; then echo "[FrontendAudit-CI] FAIL backend not healthy"; cat data/logs/ci-frontend-audit.log | tail -20; exit 1; fi

echo "[FrontendAudit-CI] audit all 9 pages ..."
bun run audit:frontend --base-url="${BASE_URL}" --concurrency=2 --block-on=critical --out="${OUT}"
AUDIT_EXIT=$?

echo "[FrontendAudit-CI] report: ${OUT}"
echo "[FrontendAudit-CI] audit exit=$AUDIT_EXIT (critical/major>0 ? 1 = ??????)"
exit ${AUDIT_EXIT}