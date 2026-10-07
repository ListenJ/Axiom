#!/usr/bin/env bash
# ============================================================================
# 安全录入 Wind API Key（2026-10-07）
#
# 为什么要有这个脚本（而不是让你把 key 贴进聊天/命令行）：
#   1. **不回显**：`read -s` 输入，屏幕上不显示，也不会进 shell 历史；
#   2. **单一事实源**：key 先落到 `~/.axiom/axiom-secrets/wind.credentials`（0600），
#      再从这里注入仓库 `.env`（同样 0600）—— 之后轮换/备份都以凭据目录为准；
#   3. **可重复执行**：会先删掉 `.env` 里的旧 `WIND_API_KEY=` 行再写入，避免多行冲突；
#   4. **只做这一件事**：不碰其他配置，不动 systemd。
#
# 用法：
#   bash scripts/set-wind-key.sh                 # 交互式输入（推荐）
#   printf '%s' "$WIND_KEY" | bash scripts/set-wind-key.sh --stdin   # 从管道读（无回显）
#
# 执行后需重启服务才生效：
#   sudo systemctl restart axiom@listen.service
# ============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRET_DIR="$HOME/.axiom/axiom-secrets"
SECRET_FILE="$SECRET_DIR/wind.credentials"
ENV_FILE="$REPO/.env"

key=""
if [ "${1:-}" = "--stdin" ]; then
  IFS= read -r key || true
else
  if [ ! -t 0 ]; then
    echo "非交互终端：请用 --stdin，或直接在终端里运行本脚本。" >&2
    exit 2
  fi
  printf 'Wind API Key（ak_ 开头，输入时不回显）: ' >&2
  IFS= read -rs key
  printf '\n' >&2
fi

# ── 校验（只校验形状，不打印 key）────────────────────────────────────────────
key="$(printf '%s' "$key" | tr -d '[:space:]')"
if [ -z "$key" ]; then
  echo "空输入，未做任何修改。" >&2
  exit 1
fi
case "$key" in
  ak_*) ;;
  *) echo "形状不符：Wind key 应以 'ak_' 开头（实收长度 ${#key}）。未做修改。" >&2; exit 1 ;;
esac
if [ "${#key}" -lt 16 ]; then
  echo "长度可疑（${#key} 字符），疑似截断。未做修改。" >&2
  exit 1
fi

# ── 1) 写凭据目录（0600，先落盘再引用）──────────────────────────────────────
mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"
umask 077
printf 'WIND_API_KEY=%s\n' "$key" > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

# ── 2) 注入 .env（去重后追加；.env 一并收紧到 0600）─────────────────────────
[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE" >&2; exit 1; }
tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
chmod 600 "$tmp"
grep -v '^WIND_API_KEY=' "$ENV_FILE" > "$tmp" || true
# 确保文件以换行结尾再追加
[ -n "$(tail -c1 "$tmp" 2>/dev/null)" ] && printf '\n' >> "$tmp"
cat "$SECRET_FILE" >> "$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ── 3) 只回显"处置结果"，绝不回显 key ────────────────────────────────────────
echo "已写入: $SECRET_FILE (0600, $(wc -c < "$SECRET_FILE" | tr -d ' ') 字节)"
echo "已注入: $ENV_FILE (0600, WIND_API_KEY 行数=$(grep -c '^WIND_API_KEY=' "$ENV_FILE"))"
echo "下一步: sudo systemctl restart axiom@listen.service"
