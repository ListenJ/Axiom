#!/bin/bash
# CI: run lint + test in Docker
# Usage: .ci/run.sh [--lint-only|--test-only]

set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"
CI_DIR="$PROJECT_ROOT/.ci"

mkdir -p "$CI_DIR/logs"
LOG_FILE="$CI_DIR/logs/ci-$(date +%Y%m%d-%H%M%S).log"

echo "[CI] Starting at $(date)" | tee -a "$LOG_FILE"

# 1. Install dependencies
echo "[CI] bun install..." | tee -a "$LOG_FILE"
docker run --rm -v "$PROJECT_ROOT:/app" -w /app oven/bun:1 sh -c "bun install 2>&1" | tee -a "$LOG_FILE"
DEPS_EXIT=${PIPESTATUS[0]}
if [ "$DEPS_EXIT" -ne 0 ]; then
  echo "[CI] FAIL: bun install failed (exit=$DEPS_EXIT)" | tee -a "$LOG_FILE"
  exit 1
fi

# 2. Lint (tsc --noEmit)
echo "[CI] tsc --noEmit..." | tee -a "$LOG_FILE"
docker run --rm -v "$PROJECT_ROOT:/app" -w /app oven/bun:1 sh -c "bun x tsc --noEmit 2>&1" | tee -a "$LOG_FILE"
LINT_EXIT=${PIPESTATUS[0]}
if [ "$LINT_EXIT" -ne 0 ]; then
  echo "[CI] FAIL: tsc --noEmit (exit=$LINT_EXIT)" | tee -a "$LOG_FILE"
fi

# 3. Test
if [ "${1:-}" != "--lint-only" ]; then
  echo "[CI] bun test..." | tee -a "$LOG_FILE"
  docker run --rm -v "$PROJECT_ROOT:/app" -w /app oven/bun:1 sh -c "bun test 2>&1" | tee -a "$LOG_FILE"
  TEST_EXIT=${PIPESTATUS[0]}
  if [ "$TEST_EXIT" -ne 0 ]; then
    echo "[CI] FAIL: bun test (exit=$TEST_EXIT)" | tee -a "$LOG_FILE"
  fi
fi

echo "[CI] Done at $(date)" | tee -a "$LOG_FILE"
echo "[CI] Log: $LOG_FILE"
exit $(( LINT_EXIT + ${TEST_EXIT:-0} ))
