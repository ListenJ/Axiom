#!/usr/bin/env bash
# ============================================================================
# Wind 每日采集链（2026-10-07）
#
# 顺序（每步失败不阻断后续，但会如实记入 journal）：
#   1) 刷新成分股清单 —— AkShare，**0 额度**（指数成分会调整，每次刷新最稳）
#   2) 按配比采集 —— kline 60% / fundamentals 20% / macro 15% / announcements 5%
#   3) 原件 → 知识库副本（生成笔记并自动嵌入）
#
# 预算：WIND_DAILY_CREDITS（默认 270 **积分**，账号免费档 300/日，每日刷新）。
#       用量账本 data/wind-usage.jsonl（每条含 est_credits）。
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

log "② 按配比采集（日预算 ${WIND_DAILY_CREDITS:-270} 积分；单价见 daily_collect.py）"
timeout 5400 "$WIND_PY" -u "$COLLECT" --run
collect_rc=$?
log "采集退出码=$collect_rc"

log "③ 原件 → 知识库副本"
cd "$REPO" || exit 1
INGEST_RC=0
AXIOM_EMBEDDING_CONSENT=yes LOCAL_EMBED_API_KEY=local \
  timeout 1800 bun run scripts/ingest-wind-raw.ts --all || INGEST_RC=$?
# 真实退出码：②采集/③摄取任一失败必须让 cron/监控侧可见（轮 7 审计——
# 原 unconditional exit 0 使采集中断静默丢数）。
# ①成分股刷新失败已按设计降级（沿用上次清单），不计入失败。
if [ "$collect_rc" -ne 0 ] || [ "$INGEST_RC" -ne 0 ]; then
  log "完成（有失败：collect=$collect_rc ingest=$INGEST_RC）"
  exit 1
fi
log "完成"
exit 0
