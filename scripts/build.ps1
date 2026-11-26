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

# 写 npm 风格的 .tgz：ustar 头 + gzip，条目以 package/ 开头。
# 纯 .NET 实现，不调系统 tar —— CI runner 上的 GNU tar 会把 D:\ 当远程主机，
# bsdtar 在部分环境还会崩（exit 0xC0000005）。
function Write-Tgz {
  param([string]$SourceDir, [string]$DestinationPath)

  $ascii = [Text.Encoding]::ASCII
  $utf8 = [Text.Encoding]::UTF8
  $mtime = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())

  function Put-Octal([byte[]]$hdr, [int]$offset, [int]$width, [int64]$value) {
    $s = [Convert]::ToString($value, 8).PadLeft($width - 1, '0')
    $b = $ascii.GetBytes($s)
    [Array]::Copy($b, 0, $hdr, $offset, $b.Length)
  }

  $files = @(Get-ChildItem $SourceDir -Recurse -File | Sort-Object FullName)
  $fs = [IO.File]::Open($DestinationPath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  $gz = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Compress)
  try {
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($SourceDir.Length + 1).Replace('\', '/')
      $nameBytes = $utf8.GetBytes($rel)
      if ($nameBytes.Length -gt 100) { Fail "路径超过 100 字节，ustar 头放不下：$rel" }
      $data = [IO.File]::ReadAllBytes($f.FullName)
      $hdr = New-Object byte[] 512
      [Array]::Copy($nameBytes, 0, $hdr, 0, $nameBytes.Length)
      Put-Octal $hdr 100 8 420          # mode 0644
      Put-Octal $hdr 108 8 0            # uid
      Put-Octal $hdr 116 8 0            # gid
      Put-Octal $hdr 124 12 ([int64]$data.Length)
      Put-Octal $hdr 136 12 $mtime
      $hdr[156] = 48                    # typeflag '0' = 普通文件
      [Array]::Copy($ascii.GetBytes('ustar'), 0, $hdr, 257, 5)   # magic "ustar\0"
      $hdr[262] = 0
      $hdr[263] = 48; $hdr[264] = 48    # version "00"
      for ($i = 148; $i -lt 156; $i++) { $hdr[$i] = 32 }        # 校验和字段先填空格
      $sum = 0
      foreach ($b in $hdr) { $sum += $b }
      $chk = $ascii.GetBytes(([Convert]::ToString($sum, 8).PadLeft(6, '0')))
      [Array]::Copy($chk, 0, $hdr, 148, 6)
      $hdr[154] = 0
      $hdr[155] = 32
      $gz.Write($hdr, 0, 512)
      if ($data.Length -gt 0) { $gz.Write($data, 0, $data.Length) }
      $pad = (512 - ($data.Length % 512)) % 512
      if ($pad -gt 0) { $gz.Write((New-Object byte[] $pad), 0, $pad) }
    }
    $gz.Write((New-Object byte[] 1024), 0, 1024)
  } finally {
    $gz.Dispose()
    $fs.Dispose()
  }
}

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
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue
$zipName = "dsh-chrome-extension-$version.zip"
$zipPath = Join-Path $OutDir $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
# 手工写条目：顶层目录固定 dsh-chrome-extension/，分隔符固定 '/'（.NET 默认会写反斜杠）
# 相对路径一律走 GetFullPath 规范化后再比 —— 直接拿字符串长度做 Substring，
# 在 CI runner 上遇到过前缀长度不一致、切出 "on/background.js" 这种脏条目的情况。
$rootFull = [IO.Path]::GetFullPath($extDir).TrimEnd('\', '/')
$sep = [IO.Path]::DirectorySeparatorChar
$entryCount = 0
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($f in (Get-ChildItem $extDir -Recurse -File)) {
    $fileFull = [IO.Path]::GetFullPath($f.FullName)
    $prefix = $rootFull + $sep
    if (-not $fileFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      Fail "文件不在扩展目录下，无法算相对路径：$fileFull"
    }
    $rel = $fileFull.Substring($prefix.Length).Replace($sep, '/')
    if ($rel -match '^\.|^/|^\\|:') { Fail "相对路径不合法：$rel" }
    $entry = $zip.CreateEntry("dsh-chrome-extension/$rel", [System.IO.Compression.CompressionLevel]::Optimal)
    $entryCount++
    $out = $entry.Open()
    try {
      $in = [IO.File]::OpenRead($f.FullName)
      try { $in.CopyTo($out) } finally { $in.Dispose() }
    } finally { $out.Dispose() }
  }
} finally { $zip.Dispose() }
Remove-Item $stageExt -Recurse -Force

# 产出体检：条目必须全在 dsh-chrome-extension/ 下，且 manifest.json 在第一层
$check = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $names = @($check.Entries | ForEach-Object { $_.FullName })
} finally { $check.Dispose() }
$bad = @($names | Where-Object { $_ -notmatch '^dsh-chrome-extension/' })
if ($bad.Count -gt 0) { Fail ("zip 条目没落在 dsh-chrome-extension/ 下：`n  " + (($bad | Select-Object -First 5) -join "`n  ")) }
if ($names -notcontains 'dsh-chrome-extension/manifest.json') { Fail 'zip 根上没有 manifest.json，条目层级被破坏了' }
"  $zipName  ({0:N1} KB，{1} 个文件)" -f ((Get-Item $zipPath).Length / 1KB), $entryCount

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
# 不调系统 tar：CI runner 上的 GNU tar 会把 D:\... 当远程主机，bsdtar 在部分环境直接崩
# （exit 0xC0000005）。tar(ustar) + gzip 都在 .NET 里手写，行为到处一样。
Write-Tgz -SourceDir $stagePkg -DestinationPath $tgzPath
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
