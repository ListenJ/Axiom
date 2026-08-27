# axiom-dsh 验证脚本
# 用法: powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
# 该脚本执行: 构建 -> 单元/冒烟测试 -> 可选安装到 DSH -> 提示启动 Web
param(
  [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
$PluginDir = Split-Path -Parent $PSScriptRoot
$Root = Split-Path -Parent $PluginDir
$DSH_PROFILE = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }

Write-Host "==> [1/4] TypeScript build (tsc -p tsconfig.build.json)" -ForegroundColor Cyan
Push-Location $PluginDir
try {
  if (Test-Path 'node_modules\.bin\tsc.cmd') {
    & '.\node_modules\.bin\tsc.cmd' -p tsconfig.build.json
  } else {
    & 'npx.cmd' tsc -p tsconfig.build.json
  }
  if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed (exit $LASTEXITCODE)" }
  Write-Host "    Build OK" -ForegroundColor Green
} finally { Pop-Location }

Write-Host "==> [2/4] Unit + MCP smoke tests (bun test tests/)" -ForegroundColor Cyan
Push-Location $PluginDir
try {
  & 'bun' test tests/
  if ($LASTEXITCODE -ne 0) { throw "Tests failed (exit $LASTEXITCODE)" }
  Write-Host "    Tests OK" -ForegroundColor Green
} finally { Pop-Location }

Write-Host "==> [3/4] Typecheck (tsc --noEmit)" -ForegroundColor Cyan
Push-Location $PluginDir
try {
  if (Test-Path 'node_modules\.bin\tsc.cmd') {
    & '.\node_modules\.bin\tsc.cmd' -p tsconfig.json --noEmit
  } else {
    & 'npx.cmd' tsc -p tsconfig.json --noEmit
  }
  if ($LASTEXITCODE -ne 0) { throw "Typecheck failed (exit $LASTEXITCODE)" }
  Write-Host "    Typecheck OK" -ForegroundColor Green
} finally { Pop-Location }

Write-Host "==> [4/4] Install to DSH profile '$DSH_PROFILE' (optional, skip with -SkipInstall)" -ForegroundColor Cyan
if (-not $SkipInstall) {
  & 'npx.cmd' -p @deepseek-ai/dsh dsh plugin --profile $DSH_PROFILE add $PluginDir
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed (exit $LASTEXITCODE)" }
  Write-Host "    Plugin installed to profile '$DSH_PROFILE'" -ForegroundColor Green
} else {
  Write-Host "    Skipped (parameter -SkipInstall)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==> 下一步验证" -ForegroundColor Yellow
Write-Host "  1. 启动 DSH Web: npx -p @deepseek-ai/dsh dsh web --profile $DSH_PROFILE"
Write-Host "  2. 浏览器打开 http://127.0.0.1:3080"
Write-Host "  3. 调用工具 axiom_status 确认 frostedGlass=true，MCP 桥已连接"
Write-Host "  4. 检查页面是否有磨砂玻璃效果 (侧边栏/弹窗/输入区)"
Write-Host ""
Write-Host "验证完成。" -ForegroundColor Green