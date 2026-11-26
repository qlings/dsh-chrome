# 打包 dsh-chrome：扩展 zip + 插件 tgz + 校验和
#
#   pwsh -File scripts/build.ps1              # 完整打包
#   pwsh -File scripts/build.ps1 -SkipTests   # 跳过自测（CI 里测试单独跑时用）
#
# 产物落在 dist/（.gitignore 已排除），发布时作为 Release 附件上传。

[CmdletBinding()]
param(
  [switch]$SkipTests,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }

function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "→ $msg" -ForegroundColor Cyan }

# ---------- 1. 版本号三处一致 ----------
Step '校验版本号（package.json / manifest.json / lib/index.js）'

$pkgPath = Join-Path $root 'package.json'
$manPath = Join-Path $root 'extension\manifest.json'
$idxPath = Join-Path $root 'lib\index.js'

$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$man = Get-Content $manPath -Raw -Encoding UTF8 | ConvertFrom-Json
$idx = Get-Content $idxPath -Raw -Encoding UTF8

$vPkg = $pkg.version
$vMan = $man.version
$m = [regex]::Match($idx, "VERSION\s*=\s*'([^']+)'")
if (-not $m.Success) { Fail 'lib/index.js 里找不到 VERSION 常量' }
$vIdx = $m.Groups[1].Value

if ($vPkg -ne $vMan -or $vPkg -ne $vIdx) {
  Fail "版本号不一致：package.json=$vPkg manifest.json=$vMan lib/index.js=$vIdx"
}
$version = $vPkg
Write-Host "  版本 $version"

# ---------- 2. JSON / 编码体检 ----------
Step '体检：JSON 可解析 + 无 UTF-8 BOM'
foreach ($f in @($pkgPath, $manPath)) {
  $bytes = [IO.File]::ReadAllBytes($f)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Fail "$f 带 BOM，DSH 会读不了 bundle 清单"
  }
}

# ---------- 3. 自测 ----------
if (-not $SkipTests) {
  Step '自测 node --test tests/*.test.mjs'
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { $nodeExe = $env:DSH_NODE }
  if (-not $nodeExe) { Write-Host '  ! 没找到 node，跳过自测（发布前请手工跑一次）' -ForegroundColor Yellow }
  else {
    Push-Location $root
    try {
      & $nodeExe --test (Get-ChildItem 'tests\*.test.mjs' | ForEach-Object { $_.FullName })
      if ($LASTEXITCODE -ne 0) { Fail "自测失败（exit $LASTEXITCODE）" }
    } finally { Pop-Location }
  }
}

# ---------- 4. 扩展 zip ----------
Step '打包扩展 zip'
$stageExt = Join-Path $env:TEMP ("dsh-build-" + [guid]::NewGuid().ToString('N'))
$extDir = Join-Path $stageExt 'dsh-chrome-extension'
New-Item -ItemType Directory -Force $extDir | Out-Null
Copy-Item (Join-Path $root 'extension\*') $extDir -Recurse -Force

New-Item -ItemType Directory -Force $OutDir | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zipName = "dsh-chrome-extension-$version.zip"
$zipPath = Join-Path $OutDir $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
# 手工写条目：顶层目录固定 dsh-chrome-extension/，分隔符固定 '/'（.NET 默认会写反斜杠）
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($f in (Get-ChildItem $extDir -Recurse -File)) {
    $rel = $f.FullName.Substring($extDir.Length + 1).Replace('\', '/')
    $entry = $zip.CreateEntry("dsh-chrome-extension/$rel", [System.IO.Compression.CompressionLevel]::Optimal)
    $out = $entry.Open()
    try {
      $in = [IO.File]::OpenRead($f.FullName)
      try { $in.CopyTo($out) } finally { $in.Dispose() }
    } finally { $out.Dispose() }
  }
} finally { $zip.Dispose() }
Remove-Item $stageExt -Recurse -Force
"  $zipName  ({0:N1} KB)" -f ((Get-Item $zipPath).Length / 1KB)

# ---------- 5. 插件 tgz ----------
Step '打包插件 tgz（npm 布局：package/ 为根）'
$stagePkg = Join-Path $env:TEMP ("dsh-build-" + [guid]::NewGuid().ToString('N'))
$pkgDir = Join-Path $stagePkg 'package'
New-Item -ItemType Directory -Force $pkgDir | Out-Null
foreach ($item in @('lib', 'extension', 'references', 'SKILL.md', 'README.md', 'LICENSE', 'cordis.patch.yml', 'package.json')) {
  $src = Join-Path $root $item
  if (Test-Path $src) { Copy-Item $src $pkgDir -Recurse -Force }
}
$tgzName = "dsh-chrome-$version.tgz"
$tgzPath = Join-Path $OutDir $tgzName
if (Test-Path $tgzPath) { Remove-Item $tgzPath -Force }
Push-Location $stagePkg
try { & tar -czf $tgzPath package; if ($LASTEXITCODE -ne 0) { Fail 'tar 打包失败' } }
finally { Pop-Location }
Remove-Item $stagePkg -Recurse -Force
"  $tgzName  ({0:N1} KB)" -f ((Get-Item $tgzPath).Length / 1KB)

# ---------- 6. 校验和 ----------
Step '生成 SHA256SUMS.txt'
$lines = @($zipName, $tgzName) | ForEach-Object {
  $h = (Get-FileHash (Join-Path $OutDir $_) -Algorithm SHA256).Hash.ToLower()
  "$h  $_"
}
[IO.File]::WriteAllText((Join-Path $OutDir 'SHA256SUMS.txt'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
$lines | ForEach-Object { "  $_" }

Write-Host "`n✓ 完成：$OutDir" -ForegroundColor Green
