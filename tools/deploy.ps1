# Simple Memos 一键部署
#
# 用法（二选一）：
#   双击 tools\deploy.bat
#   或：powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1 -Vault 'E:\Dnotes' -Enable
param(
  [string]$Vault = 'E:\Dnotes',
  [switch]$Enable
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dst = Join-Path $Vault '.obsidian\plugins\simple-memos'

if (-not (Test-Path $Vault)) { throw "库路径不存在：$Vault" }

Write-Host "[1/2] 复制插件到 $dst"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($f in @('main.js', 'manifest.json', 'styles.css', 'versions.json')) {
  $from = Join-Path $projectRoot $f
  if (-not (Test-Path $from)) { throw "缺少文件：$from" }
  Copy-Item $from (Join-Path $dst $f) -Force
  Write-Host "      $f"
}

if ($Enable) {
  $cfg = Join-Path $Vault '.obsidian\community-plugins.json'
  if (Test-Path $cfg) {
    $text = [IO.File]::ReadAllText($cfg, [Text.Encoding]::UTF8)
    $ids = @([regex]::Matches($text, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
    if ($ids -notcontains 'simple-memos') {
      $ids += 'simple-memos'
      $nl = [Environment]::NewLine
      $out = '[' + $nl + (($ids | ForEach-Object { '  "' + $_ + '"' }) -join (',' + $nl)) + $nl + ']' + $nl
      [IO.File]::WriteAllText($cfg, $out, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "      已写入启用列表（$($ids.Count) 条）"
    }
  }
}

Write-Host "[2/2] 完成：$dst"
Write-Host ''
Write-Host '接下来（在 Obsidian 里做一次）：'
Write-Host '  1) Ctrl+P -> 运行「重新加载应用而不保存」'
Write-Host '  2) 设置 -> 第三方插件 -> 启用 Simple Memos'
Write-Host '  3) Ctrl+P -> 运行「打开备忘视图」'
