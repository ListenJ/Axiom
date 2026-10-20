#!/usr/bin/env pwsh
# release/publish.ps1 — Windows 侧发布面推送（等价于 publish.sh，供无原生 bash 的机器使用）
#
# 为什么需要它：本机 PATH 上的 bash 是 WSL 的（x86_64-pc-linux-gnu），
# 而按项目口径 git 操作不得进入 WSL（9p 上 I/O 性能差且 git-lfs 不可用）。
#
# 用法：
#   pwsh scripts/release/publish.ps1 -DryRun   # 只打印将剔除的路径与文件数变化
#   pwsh scripts/release/publish.ps1           # 实际执行：剔除 -> 造快进提交 -> 推送 -> 复核
#
# 发布提交的历史形态（2026-10-19 裁定）：发布提交必须是「上一次发布提交」的子提交，
# 因此永远 fast-forward，不需要也用不到 force push。做法：
#   1) base = git ls-remote <remote> refs/heads/<branch>（上一次发布头；为空则无父）
#   2) 在临时 worktree 内把索引置为「源分支内容 − 剔除清单」，git write-tree 得到 tree
#   3) commit = git commit-tree <tree> [-p base] -F <msgfile>（造提交、不移动任何本地分支）
#   4) git push <remote> <commit>:refs/heads/<branch>，推完用 ls-remote 复核
# 幂等：新 tree 与 base 的 tree 相同 => 打印「无差异」并退出 0。
# 不动源分支、不改动开发工作树（全程在临时 git worktree 内完成）。
# 剔除清单唯一事实源：scripts/release/publish-excludes.txt（与 publish.sh 共用）。
#
# git 执行入口（2026-10-19 修复）：本机 PATH 上可能同时出现 MinGit 的 git.exe、DSH 工具链
# 便携版 git、以及工具链目录里的 git.cmd。git.cmd 是 cmd.exe 批处理包装器，用 %* 转发参数时
# cmd.exe 会把 `^` 当转义符吃掉，于是 `refs/heads/main^{commit}` 变成 `refs/heads/main{commit}`，
# git 报 "fatal: Needed a single revision"（退出码 128）。因此本脚本不调用裸 `git`：
# 显式解析 MinGit 的 git.exe 作为唯一执行入口，并无条件把它（及 git-lfs）移到 PATH 最前 ——
# 不依赖调用方 PATH 的顺序，也不看「PATH 里是否出现过 MinGit」。此外所有 rev 表达式都避开 `^`
# （分支直接给 ref 名、对象存在性用 cat-file、tree 用 show --format=%T）。

[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$Remote = "origin",
  [string]$Branch = "main",
  [string]$SrcBranch = "main",
  [string]$Message = "publish: 发布面整理（剔除产物/数据集/内部留痕/内部 CI；docs 整目录不外发）"
)

$ErrorActionPreference = "Stop"

# ── ssh 选择（2026-10-19 实测教训）────────────────────────────────────────────
# MinGit 自带 `usr/bin/ssh.exe`，在本机对 GitHub 鉴权失败（publickey，ls-remote 退出码 128）；
# Windows 自带 OpenSSH 正常。脚本会把 MinGit 无条件前置到 PATH，可能让 ssh 解析到错误实现，
# 故此处显式兜底指定；调用方仍可用 GIT_SSH 覆盖。
if (-not $env:GIT_SSH) {
  $winSsh = "C:/Windows/System32/OpenSSH/ssh.exe"
  if (Test-Path $winSsh) { $env:GIT_SSH = $winSsh }
}

# ── 0) 定位 git.exe：显式优先 MinGit，绝不落到 cmd.exe 批处理包装器 ─────────────
$mingitDirs = @(
  (Join-Path $HOME ".axiom/tools/mingit/cmd"),
  (Join-Path $env:USERPROFILE ".axiom/tools/mingit/cmd"),
  (Join-Path $HOME ".axiom/tools/mingit/cmd")
) | Select-Object -Unique
$mingit = $null
foreach ($d in $mingitDirs) {
  if ($d -and (Test-Path (Join-Path $d "git.exe"))) { $mingit = $d; break }
}
$script:GitExe = $null
if ($mingit) {
  $script:GitExe = Join-Path $mingit "git.exe"
  # 无条件把 MinGit 目录移到 PATH 最前（先剔除已有同名条目，避免重复与顺序不确定）。
  $mingitNorm = $mingit.TrimEnd('\')
  $pathParts = @($env:PATH -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $mingitNorm) })
  $env:PATH = "$mingit;" + ($pathParts -join ';')
}
else {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and ($cmd.Source -match '\.exe$')) { $script:GitExe = $cmd.Source }
}
if (-not $script:GitExe) {
  throw ("找不到可用的 git.exe：MinGit 目录（{0}）都没有 git.exe，且 PATH 上的 git 不是 .exe。" +
         "批处理包装器（.cmd/.bat）会改写参数里的 ^，不能用。") -f ($mingitDirs -join " / ")
}

# git-lfs 同样前置到 PATH 最前：pre-push 钩子靠 PATH 找 git-lfs。
$lfs = Join-Path $HOME ".axiom/tools/git-lfs-3.8.0"
if (Test-Path (Join-Path $lfs "git-lfs.exe")) {
  $lfsNorm = $lfs.TrimEnd('\')
  $pathParts = @($env:PATH -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $lfsNorm) })
  $env:PATH = "$lfs;" + ($pathParts -join ';')
}

function Get-GitLine {
  param([string[]]$GitArgs)
  $out = & $script:GitExe @GitArgs
  if ($LASTEXITCODE -ne 0) { throw ("git {0} 失败（退出码 {1}）" -f ($GitArgs -join " "), $LASTEXITCODE) }
  return (@($out) -join "`n").Trim()
}

function Test-GitOk {
  param([string[]]$GitArgs)
  & $script:GitExe @GitArgs 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

$repoRoot = Get-GitLine -GitArgs @("rev-parse", "--show-toplevel")
Set-Location $repoRoot

$excludeFile = Join-Path $repoRoot "scripts/release/publish-excludes.txt"
if (-not (Test-Path -LiteralPath $excludeFile)) { throw "缺剔除清单 $excludeFile" }
# 必须显式 -Encoding UTF8：清单含中文注释；Windows PowerShell 5.1 的 Get-Content 默认按
# 系统 ANSI（本机 GBK）解码，会把 UTF-8 字节解错并吞掉换行，导致路径项被并进注释行而漏剔除。
$excludes = @(Get-Content -LiteralPath $excludeFile -Encoding UTF8 |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -and -not $_.StartsWith("#") })
if ($excludes.Count -eq 0) { throw "剔除清单为空 $excludeFile" }

Write-Host "== publish: $SrcBranch -> $Remote/$Branch ==" -ForegroundColor Cyan
Write-Host ("git = {0}（仓库根 {1}）" -f $script:GitExe, $repoRoot)
if (-not (Test-GitOk -GitArgs @("rev-parse", "--verify", "refs/heads/$SrcBranch"))) {
  throw "源分支不存在：refs/heads/$SrcBranch（仓库根 $repoRoot）"
}
$srcSha = Get-GitLine -GitArgs @("rev-parse", "refs/heads/$SrcBranch")

# ── 1) 上一次发布头（远端分支当前指向的提交）────────────────────────────────────
$remoteRef = "refs/heads/$Branch"
$base = ""
$canCompare = $false
$lsOut = @(& $script:GitExe ls-remote $Remote $remoteRef 2>$null)
$lsCode = $LASTEXITCODE
if ($lsCode -ne 0) {
  if ($DryRun) { Write-Warning "读取远端 $Remote/$remoteRef 失败（退出码 $lsCode），dry-run 跳过「无差异」判定。" }
  else { throw "git ls-remote $Remote $remoteRef 失败（退出码 $lsCode）" }
}
elseif ($lsOut.Count -gt 0 -and "$($lsOut[0])".Trim()) {
  $base = ("$($lsOut[0])" -split "\s+")[0].Trim()
}

if ($base) {
  $canCompare = $true
  if (-not (Test-GitOk -GitArgs @("cat-file", "-e", $base))) {
    # 远端发布头本地尚不存在（别人推过）：拉取该对象后再造提交，否则 commit-tree 找不到父提交。
    & $script:GitExe fetch --no-tags $Remote $remoteRef 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-GitOk -GitArgs @("cat-file", "-e", $base))) {
      if ($DryRun) {
        Write-Warning "无法在本地取得基线对象 $base，dry-run 跳过「无差异」判定。"
        $canCompare = $false
      }
      else { throw "无法在本地取得远端基线 $base（fetch 失败）" }
    }
  }
}

# ── 2) 在临时 worktree 内构造发布树（只动索引，不 commit、不推）──────────────────
$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("publish-wt-" + [guid]::NewGuid().ToString("N").Substring(0,8))
$msgFile = Join-Path ([System.IO.Path]::GetTempPath()) ("publish-msg-" + [guid]::NewGuid().ToString("N").Substring(0,8) + ".txt")
$worktreeAdded = $false
$pushed = $false
try {
  # --no-checkout：发布面只需要索引，不需要落工作树文件。
  # 这样既跳过 LFS smudge，也避开本机 .git/hooks/post-checkout（其 shebang 指向 WSL bash、
  # 在 Windows 路径下必然失败并让 worktree add 返回 127）。
  & $script:GitExe worktree add --no-checkout --detach $tmpRoot $srcSha 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "git worktree add 失败（$tmpRoot）" }
  $worktreeAdded = $true
  Push-Location $tmpRoot
  $pushed = $true
  & $script:GitExe read-tree $srcSha 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "git read-tree 失败（$srcSha）" }

  $hit = 0
  foreach ($p in $excludes) {
    $tracked = @(& $script:GitExe ls-files -- $p)
    if ($tracked.Count -eq 0) { continue }
    & $script:GitExe rm -r --cached -q --ignore-unmatch -- $p 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git rm --cached 失败：$p" }
    $hit++
  }

  $tree = Get-GitLine -GitArgs @("write-tree")
  $before = (@(& $script:GitExe ls-tree -r --name-only $srcSha) | Measure-Object).Count
  $after = (@(& $script:GitExe ls-files) | Measure-Object).Count
  $staged = @(& $script:GitExe diff --cached --name-only --diff-filter=D)
  Write-Host ("剔除路径命中 {0}/{1}；文件数 {2} -> {3}（移除 {4} 个文件）" -f $hit, $excludes.Count, $before, $after, $staged.Count)

  # ── 3) 幂等：发布树与远端发布头 tree 相同则无事可做 ───────────────────────────
  if ($canCompare) {
    $baseTree = Get-GitLine -GitArgs @("show", "-s", "--format=%T", $base)
    Write-Host ("基线 {0}/{1} = {2}（tree {3}）" -f $Remote, $Branch, $base, $baseTree)
    if ($baseTree -eq $tree) {
      Write-Host ("无差异：发布树与 {0}/{1} 相同，跳过提交与推送。" -f $Remote, $Branch) -ForegroundColor Green
      return
    }
  }
  else {
    Write-Host "基线 <空>：远端尚无 $Remote/$Branch，本次将新建分支。" -ForegroundColor Yellow
  }
  Write-Host ("发布树 tree = {0}" -f $tree)

  if ($DryRun) {
    Write-Host "--- dry-run：将从发布面移除的前 30 项 ---" -ForegroundColor Yellow
    $staged | Select-Object -First 30
    Write-Host ("（共 {0} 个文件）" -f $staged.Count)
    Write-Host "dry-run：未提交、未推送。" -ForegroundColor Yellow
    return
  }

  # ── 4) commit-tree：造一个以远端发布头为父的提交，本地不移动分支 ───────────────
  [System.IO.File]::WriteAllText($msgFile, $Message, (New-Object System.Text.UTF8Encoding($false)))
  $commitArgs = @("commit-tree", $tree)
  if ($base) { $commitArgs += @("-p", $base) }
  $commitArgs += @("-F", $msgFile)
  $commit = Get-GitLine -GitArgs $commitArgs
  if ($commit -notmatch "^[0-9a-f]{40}$") { throw "commit-tree 未返回合法 sha：$commit" }
  $parentText = if ($base) { $base } else { "<无父：新建分支>" }
  Write-Host ("新发布提交 {0}（父 {1}）" -f $commit, $parentText)

  if ($canCompare) {
    & $script:GitExe merge-base --is-ancestor $base $commit 2>$null
    if ($LASTEXITCODE -ne 0) { throw "新提交不是基线 $base 的后代，拒绝推送" }
    $ahead = Get-GitLine -GitArgs @("rev-list", "--count", "$base..$commit")
    Write-Host ("{0}..{1} 提交数 = {2}（快进）" -f $base.Substring(0, 12), $commit.Substring(0, 12), $ahead)
  }

  # ── 5) 推送并复核（推完远端发布头必须正好等于该提交）──────────────────────────
  & $script:GitExe push $Remote "$($commit):$remoteRef"
  if ($LASTEXITCODE -ne 0) { throw "推送失败" }

  $remoteSha = ""
  $verifyOut = @(& $script:GitExe ls-remote $Remote $remoteRef 2>$null)
  if ($LASTEXITCODE -eq 0 -and $verifyOut.Count -gt 0) {
    $remoteSha = ("$($verifyOut[0])" -split "\s+")[0].Trim()
  }
  Write-Host ("远端 {0}/{1} = {2}" -f $Remote, $Branch, $remoteSha)
  if ($remoteSha -ne $commit) { throw "推送后校验不一致：远端 $remoteSha，新提交 $commit" }
  if ($canCompare) {
    & $script:GitExe merge-base --is-ancestor $base $commit 2>$null
    if ($LASTEXITCODE -ne 0) { throw "推送后复核失败：$base 不是 $commit 的祖先" }
  }
  Write-Host "OK" -ForegroundColor Green
}
finally {
  if ($pushed) { Pop-Location }
  if ($worktreeAdded) {
    & $script:GitExe worktree remove --force $tmpRoot 2>$null | Out-Null
    & $script:GitExe worktree prune 2>$null | Out-Null
  }
  if (Test-Path -LiteralPath $tmpRoot) { Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $msgFile) { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
}
