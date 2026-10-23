# Engram 憶跡一鍵安裝：補齊 Node.js、Git、GitHub CLI → 登入 GitHub → engram install → 開啟管理介面。
# 用法：雙擊專案根目錄的 setup.cmd；或在終端機執行 setup.cmd -Label 公司電腦（-DryRun 只檢查、不安裝任何東西）。
# 本檔必須存成 UTF-8 含 BOM：Windows PowerShell 5.1 讀沒有 BOM 的檔案會用 CP950，中文會變成亂碼。
param(
  [string]$Label,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $AppDir 'bin\engram.mjs'

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "! $text" -ForegroundColor Yellow }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
# winget 裝完的程式要重新讀 PATH，這個視窗才找得到
function Update-PathFromRegistry {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Get-NodeMajor { if (Has 'node') { [int]((node --version) -replace '^v(\d+).*', '$1') } else { 0 } }
# 原生指令的錯誤輸出交給 cmd 丟掉：Windows PowerShell 5.1 在 Stop 模式下轉向 stderr 會直接中斷
function Test-Quiet($commandLine) { cmd /d /c "$commandLine >nul 2>&1"; return $LASTEXITCODE -eq 0 }

$script:missing = $false
function Install-IfMissing($name, $wingetId, [scriptblock]$isReady) {
  if (& $isReady) { Ok "$name 已安裝"; return }
  if ($DryRun) { Warn "缺少 $name；正式執行時會用 winget install --id $wingetId 安裝"; $script:missing = $true; return }
  if (-not (Has 'winget')) { throw "找不到 winget。請先手動安裝 $name，再重新執行 setup.cmd。" }
  Write-Host "正在安裝 $name（winget install --id $wingetId）…"
  winget install --id $wingetId -e --source winget --accept-package-agreements --accept-source-agreements
  Update-PathFromRegistry
  if (-not (& $isReady)) { throw "$name 安裝後仍找不到。請關閉這個視窗，再重新執行一次 setup.cmd。" }
  Ok "$name 安裝完成"
}

try {
  Write-Host 'Engram 憶跡 安裝程式' -ForegroundColor Cyan
  if ($DryRun) { Warn '演練模式：只檢查，不安裝也不修改任何東西' }

  Step '1/4 檢查必要工具'
  if (-not (Has 'claude')) { throw '找不到 Claude Code。請先安裝 Claude Code 並登入一次，再執行 setup.cmd。' }
  # Engram 用不經 shell 的方式呼叫 claude 安裝外掛，只找得到 claude.exe；npm 安裝的 claude.cmd 要在這裡先擋下
  if (-not (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -like '*.exe' })) {
    throw '你的 Claude Code 是用 npm 安裝的（claude.cmd），Engram 無法自動安裝外掛。請在 PowerShell 執行 irm https://claude.ai/install.ps1 | iex 改用官方安裝程式，開新視窗後再執行 setup.cmd。'
  }
  Ok 'Claude Code 已安裝'
  Install-IfMissing 'Git for Windows' 'Git.Git' { Has 'git' }
  $nodeMajor = Get-NodeMajor
  if ($nodeMajor -gt 0 -and $nodeMajor -lt 22) { throw "Node.js 版本太舊（v$nodeMajor），請先更新到 LTS 版：winget upgrade --id OpenJS.NodeJS.LTS" }
  Install-IfMissing 'Node.js LTS' 'OpenJS.NodeJS.LTS' { (Get-NodeMajor) -ge 22 }
  Install-IfMissing 'GitHub CLI' 'GitHub.cli' { Has 'gh' }

  Step '2/4 登入 GitHub（記憶庫是你 GitHub 上的私人 repo engram-vault）'
  if ($script:missing) { Warn '工具安裝好之後才會檢查 GitHub 登入' }
  elseif (Test-Quiet 'gh auth status') { Ok 'GitHub CLI 已登入' }
  elseif ($DryRun) { Warn '尚未登入；正式執行時會開啟瀏覽器登入 GitHub' }
  else {
    gh auth login --hostname github.com --git-protocol https --web
    if (-not (Test-Quiet 'gh auth status')) { throw 'GitHub 登入沒有完成，請重新執行 setup.cmd。' }
    Ok 'GitHub 已登入'
  }

  Step '3/4 安裝 Engram'
  if (-not $Label) {
    $Label = Read-Host "這台電腦在 Engram 裡要叫什麼名字？例如「公司電腦」（直接按 Enter 用 $env:COMPUTERNAME）"
    if (-not $Label) { $Label = $env:COMPUTERNAME }
  }
  $installArgs = @('install', '--label', $Label)
  if ($DryRun) { $installArgs += '--dry-run' }
  if ($script:missing) {
    Warn "工具裝好後會執行：node `"$Bin`" $($installArgs -join ' ')"
    exit 0
  }
  & node $Bin @installArgs
  if ($LASTEXITCODE -ne 0) { throw '安裝沒有完成（已取消或發生錯誤，請看上面的訊息）。' }
  if ($DryRun) { Ok '演練結束：以上是正式執行時的安裝計畫'; exit 0 }

  Step '4/4 開啟管理介面'
  & node (Join-Path $env:USERPROFILE '.engram\app\current\bin\engram.mjs') ui
  Write-Host ''
  Write-Host '接下來在管理介面的「匯入既有記憶」：產生計畫 → 逐筆檢查 → 開始演練 → 四項檢查都打勾後套用。' -ForegroundColor Cyan
  Write-Host '之後新開的終端機可以直接輸入 engram（例如 engram status）；Claude Code 裡也一樣。'
  exit 0
} catch {
  Write-Host ''
  Write-Host "✗ $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
