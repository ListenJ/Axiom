#!/usr/bin/env bash
# ============================================================================
# Wind 每日采集链（2026-10-07）
#
# 顺序（每步失败不阻断后续，但会如实记入 journal）：
#   1) 刷新成分股清单 —— AkShare，**0 额度**（指数成分会调整，每次刷新最稳）
#   2) 按配比采集 —— kline 60% / fundamentals 20% / macro 15% / announcements 5%
#   3) 原件 → 知识库副本（生成笔记并自动嵌入）
#
# 额度：脚本上限 WIND_DAILY_CAP（默认 270，账号 300/日）。用量账本 data/wind-usage.jsonl。
# 原件：data/raw/quant/wind/<tool>/<key>.json（先落盘再记账，落盘失败即判失败）。
# ============================================================================
set -uo pipefail

REPO=/run/media/listen/base/openclaw-fusion
AK_PY="$REPO/runtime-data/.venv/bin/python"        # akshare（mcp>=2 侧）
WIND_PY="$REPO/mcp-servers/wind-mcp/.venv/bin/python"  # wind（mcp<2 侧）
COLLECT="$REPO/mcp-servers/wind-mcp/daily_collect.py"

log() { echo "[$(date '+%F %T')] $*"; }

log "① 刷新成分股清单（AkShare，0 额度）"
if ! timeout 600 "$AK_PY" -u "$COLLECT" --refresh-universe; then
  log "成分股刷新失败（沿用上次清单继续）"
fi

log "② 按配比采集（上限 ${WIND_DAILY_CAP:-270}）"
timeout 5400 "$WIND_PY" -u "$COLLECT" --run
collect_rc=$?
log "采集退出码=$collect_rc"

log "③ 原件 → 知识库副本"
cd "$REPO" || exit 1
AXIOM_EMBEDDING_CONSENT=yes LOCAL_EMBED_API_KEY=local \
  timeout 1800 bun run scripts/ingest-wind-raw.ts --all
log "完成"
exit 0
