#!/usr/bin/env bash
# release/publish.sh — 把内部 main 的「发布面」推送到 GitHub（public 仓库），Linux 侧执行器
#
# 背景（2026-10-19 用户裁定）：
#   - 内部仓库（Gitea, remote `internal`）是唯一事实源，保留全部证据件与产物。
#   - GitHub `ListenJ/Axiom` 只作发布面，剔除测试产物、评估数据集、运维留痕、内部 CI 与 docs。
#   - 允许向 origin 推送属规则 3 的**用户授权例外**，每次发布须在 ops log 留痕。
#
# 用法：
#   bash scripts/release/publish.sh --dry-run     # 只打印将剔除的路径与文件数变化
#   bash scripts/release/publish.sh               # 实际执行：剔除 -> 造快进提交 -> 推 origin -> 复核
#
# 设计约束：
#   1) 剔除清单唯一事实源：scripts/release/publish-excludes.txt（与 publish.ps1 共用，不再内联）。
#   2) 发布提交是「上一次发布提交」的子提交：base = 远端发布头，tree = 源分支内容 − 剔除清单，
#      commit = git commit-tree tree -p base；推送该提交 -> 永远 fast-forward，不需要 force push。
#   3) 幂等：新 tree 与远端发布头 tree 相同则打印「无差异」并退出 0。
#   4) 不污染开发工作树：索引操作在临时 git worktree（--no-checkout）内完成，不动内部 main。
set -euo pipefail

REMOTE="${PUBLISH_REMOTE:-origin}"
BRANCH="${PUBLISH_BRANCH:-main}"
SRC_BRANCH="${PUBLISH_SRC_BRANCH:-main}"
MESSAGE="${PUBLISH_MESSAGE:-publish: 发布面整理（剔除产物/数据集/内部留痕/内部 CI；docs 整目录不外发）}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

EXCLUDE_FILE="$REPO_ROOT/scripts/release/publish-excludes.txt"
[ -f "$EXCLUDE_FILE" ] || { echo "缺剔除清单 $EXCLUDE_FILE"; exit 1; }

echo "== publish: $SRC_BRANCH -> $REMOTE/$BRANCH =="
SOURCE_SHA="$(git rev-parse --verify "refs/heads/$SRC_BRANCH^{commit}")"

# ── 上一次发布头（远端分支当前指向）────────────────────────────────────────────────
REMOTE_REF="refs/heads/$BRANCH"
BASE=""
CAN_COMPARE=0
if LS_REMOTE="$(git ls-remote "$REMOTE" "$REMOTE_REF" 2>/dev/null)"; then
  BASE="$(printf '%s\n' "$LS_REMOTE" | awk 'NR==1 && NF {print $1}')"
else
  if [ "$DRY_RUN" = "1" ]; then
    echo "警告：读取 $REMOTE/$REMOTE_REF 失败，dry-run 跳过「无差异」判定。"
  else
    echo "读取 $REMOTE/$REMOTE_REF 失败"; exit 1
  fi
fi

if [ -n "$BASE" ]; then
  CAN_COMPARE=1
  if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
    # 远端发布头本地尚不存在（别人推过）：先取回该对象，否则 commit-tree 找不到父提交。
    if ! git fetch --no-tags "$REMOTE" "$REMOTE_REF" >/dev/null 2>&1 || ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
      if [ "$DRY_RUN" = "1" ]; then
        echo "警告：无法在本地取得基线对象 $BASE，dry-run 跳过「无差异」判定。"
        CAN_COMPARE=0
      else
        echo "无法在本地取得远端基线 $BASE（fetch 失败）"; exit 1
      fi
    fi
  fi
fi

# ── 在临时 worktree 内构造发布树（只动索引，不 commit、不推）──────────────────────
WT_ROOT="$(mktemp -d)"
WT="$WT_ROOT/publish-wt"
cleanup() {
  # 先离开临时 worktree 再移除，避免「移除当前工作目录」失败后留下悬空 worktree 记录。
  cd "$REPO_ROOT" >/dev/null 2>&1 || true
  git worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$WT_ROOT" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 不需要工作树文件：--no-checkout 后 read-tree 只填索引，天然跳过 LFS smudge 与 post-checkout 钩子。
git worktree add --no-checkout --detach "$WT" "$SOURCE_SHA" >/dev/null
cd "$WT"
git read-tree "$SOURCE_SHA"

# 逐行读清单（单一事实源），不做 bash 数组、不做内联清单。
HIT=0
TOTAL=0
while IFS= read -r LINE || [ -n "$LINE" ]; do
  LINE="${LINE%$'\r'}"
  LINE="$(printf '%s' "$LINE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$LINE" in
    '' | '#'*) continue ;;
  esac
  TOTAL=$((TOTAL + 1))
  if [ -n "$(git ls-files -- "$LINE")" ]; then
    git rm -r --cached -q --ignore-unmatch -- "$LINE" >/dev/null 2>&1 || true
    HIT=$((HIT + 1))
  fi
done < "$EXCLUDE_FILE"

TREE="$(git write-tree)"
BEFORE="$(git ls-tree -r --name-only "$SOURCE_SHA" | wc -l | tr -d '[:space:]')"
AFTER="$(git ls-files | wc -l | tr -d '[:space:]')"
REMOVED_COUNT="$(git diff --cached --name-only --diff-filter=D | wc -l | tr -d '[:space:]')"
echo "剔除路径命中: ${HIT}/${TOTAL}   文件数: ${BEFORE} -> ${AFTER}（移除 ${REMOVED_COUNT} 个文件）"

# ── 幂等：发布树与远端发布头 tree 相同则无事可做 ───────────────────────────────────
if [ "$CAN_COMPARE" = "1" ]; then
  BASE_TREE="$(git rev-parse "$BASE^{tree}")"
  echo "基线 $REMOTE/$BRANCH = $BASE（tree $BASE_TREE）"
  if [ "$TREE" = "$BASE_TREE" ]; then
    echo "无差异：发布树与 $REMOTE/$BRANCH 相同，跳过提交与推送。"
    exit 0
  fi
else
  echo "基线 <空>：远端尚无 $REMOTE/$BRANCH，本次将新建分支。"
fi
echo "发布树 tree = $TREE"

if [ "$DRY_RUN" = "1" ]; then
  echo "--- dry-run：以下路径将从发布面移除（按前两级目录聚合，前 40 行）---"
  git diff --cached --name-only --diff-filter=D | awk -F/ '{print $1"/"$2}' | sort -u | head -40
  echo "（共 ${REMOVED_COUNT} 个文件）"
  echo "dry-run：未提交、未推送。"
  exit 0
fi

# ── commit-tree：造一个以远端发布头为父的提交，本地不移动任何分支 ───────────────────
if [ "$CAN_COMPARE" = "1" ]; then
  COMMIT="$(git commit-tree "$TREE" -p "$BASE" -m "$MESSAGE")"
else
  COMMIT="$(git commit-tree "$TREE" -m "$MESSAGE")"
fi
case "$COMMIT" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) echo "commit-tree 未返回合法 sha：$COMMIT"; exit 1 ;;
esac
echo "新发布提交 $COMMIT（父 ${BASE:-<无父：新建分支>}）"

if [ "$CAN_COMPARE" = "1" ]; then
  git merge-base --is-ancestor "$BASE" "$COMMIT" || { echo "新提交不是基线 $BASE 的后代，拒绝推送"; exit 1; }
  echo "基线..新提交 提交数 = $(git rev-list --count "$BASE..$COMMIT")（快进）"
fi

# ── 推送并复核（推完远端发布头必须正好等于该提交）────────────────────────────────
git push "$REMOTE" "$COMMIT:$REMOTE_REF"
REMOTE_SHA="$(git ls-remote "$REMOTE" "$REMOTE_REF" | awk 'NR==1 {print $1}')"
echo "远端 $REMOTE/$BRANCH = $REMOTE_SHA"
[ "$REMOTE_SHA" = "$COMMIT" ] || { echo "推送后校验不一致：远端 $REMOTE_SHA，新提交 $COMMIT"; exit 1; }
if [ "$CAN_COMPARE" = "1" ]; then
  git merge-base --is-ancestor "$BASE" "$COMMIT" || { echo "推送后复核失败：$BASE 不是 $COMMIT 的祖先"; exit 1; }
fi
echo "OK"
