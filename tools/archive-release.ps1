<#
  归档一个版本：把「重建这个版本所需的一切」复制成一份独立快照。

  用途：把一个版本所需的东西复制成一份独立快照，放在 Releases 目录下。
  这些内容不进版本库。

  用法：
    pwsh -File tools\archive-release.ps1 -Version 1.21.40
    pwsh -File tools\archive-release.ps1 -Version 1.21.40 -Apk "C:\path\梦弦居-v1.21.40.apk"

  产出：
    releases\v<版本>\
      apk\      安装包（有才放）
      src\      www / android / e2e / assets 完整源码
      tools\    构建脚本、依赖清单
     docs\     续接摘要与各轮评审报告
      BUILD.md  构建参数、签名指纹、SHA256
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Apk = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root ("releases\v" + $Version)

if (Test-Path $dest) {
  Write-Host "目标已存在：$dest"
  Write-Host "（不覆盖。要重做请先手动移走该目录。）"
  exit 1
}

$null = New-Item -ItemType Directory -Force -Path $dest
foreach ($sub in 'apk','src','tools','docs') {
  $null = New-Item -ItemType Directory -Force -Path (Join-Path $dest $sub)
}

function Copy-Tree($from, $to, $exclDirs, $exclFiles) {
  if (-not (Test-Path $from)) { Write-Host "  跳过（不存在）：$from"; return }
  $a = @($from, $to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
  if ($exclDirs) { $a += '/XD'; $a += $exclDirs }
  # ⚠️ /XD 只排【目录】，排不掉文件（v0.3.0 实测）：android\keystore.properties 是文件，
  #    写进 /XD 完全不起作用 —— 必须走 /XF。下面那句 Copy-Tree android 靠这个参数挡住它。
  if ($exclFiles) { $a += '/XF'; $a += $exclFiles }
  robocopy @a | Out-Null
  # robocopy 退出码 0-7 都算成功，>=8 才是失败
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（码 $LASTEXITCODE）：$from" }
}

Write-Host "归档 v$Version -> $dest"

# ---- 源码 ----
Copy-Tree (Join-Path $root 'www')     (Join-Path $dest 'src\www')     $null
# ⚠️ 也要排掉 app\src\main\assets\public —— 那是 cap sync 从 www 拷过去的副本，
#    留着就是每个快照多一份重复的前端代码，而且它和 www 可能不是同一版，回溯时更迷惑。
Copy-Tree (Join-Path $root 'android') (Join-Path $dest 'src\android') @('build','.gradle','.kotlin',(Join-Path $root 'android\app\src\main\assets\public')) 'keystore.properties'
Copy-Tree (Join-Path $root 'e2e')     (Join-Path $dest 'src\e2e')     $null
Copy-Tree (Join-Path $root 'assets')  (Join-Path $dest 'src\assets')  $null

# ---- 顶层脚本 ----
#  v0.3.0 起 e2e-*.mjs 移进 e2e\（上面那句 Copy-Tree 已带上），genmeme.mjs 移进 tools\（下面的 Copy-Tree tools 已带上），
#  根目录不再有需要单独扫描的脚本。

# ---- 工具与依赖清单 ----
Copy-Tree (Join-Path $root 'tools') (Join-Path $dest 'tools') $null
foreach ($f in 'package.json','package-lock.json','capacitor.config.json','.gitignore') {
  $p = Join-Path $root $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $dest ('tools\' + $f)) -Force }
}

# ---- 密钥 ----
#  v0.3.0 起【不再把签名密钥和口令复制进 releases\】。
#  起因（本机实测）：这个复制块 + 上面那句 Copy-Tree android，会让每个版本目录留下
#      keys\release.keystore、keys\keystore.properties、src\android\keystore.properties
#  三份明文副本 —— 本机因此攒出 3 份签名私钥 + 5 份明文口令（v0.3.0 / v1.21.61 各一套）。
#  私钥和明文口令躺在同一目录、目录名还带着版本号和 APK，一次打包外发就等于交出签名权。
#  需要重建这个版本时，密钥从仓库根取：
#      release.keystore  +  android\keystore.properties

# ---- 文档 ----
Get-ChildItem -Path $root -Filter '*.md' -File | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $dest ('docs\' + $_.Name)) -Force
}

# ---- 安装包 ----
$apkHash = '(未提供 APK)'
$apkName = '(未提供 APK)'
if ($Apk -and (Test-Path $Apk)) {
  $apkName = Split-Path $Apk -Leaf
  Copy-Item $Apk (Join-Path $dest ('apk\' + $apkName)) -Force
  $apkHash = (Get-FileHash $Apk -Algorithm SHA256).Hash
} elseif ($Apk) {
  Write-Host "  警告：找不到 APK：$Apk"
}

# ---- 构建参数 ----
$gradle = Join-Path $root 'android\app\build.gradle'
$vc = ''; $vn = ''
if (Test-Path $gradle) {
  $g = Get-Content $gradle -Raw
  $m = [regex]::Match($g, 'versionCode\s+(\d+)');     if ($m.Success) { $vc = $m.Groups[1].Value }
  $m = [regex]::Match($g, 'versionName\s+"([^"]+)"');  if ($m.Success) { $vn = $m.Groups[1].Value }
}

# ---- 签名指纹（有 APK 才算）----
$cert = '(未验证)'
if ($apkName -ne '(未提供 APK)') {
  $sdk = $env:ANDROID_HOME
  if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
  if ($sdk) {
    $bt = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory -ErrorAction SilentlyContinue |
          Sort-Object Name -Descending | Select-Object -First 1
    if ($bt) {
      $signer = Join-Path $bt.FullName 'apksigner.bat'
      if (Test-Path $signer) {
        $o = & $signer verify --print-certs (Join-Path $dest ('apk\' + $apkName)) 2>&1 | Out-String
        $m = [regex]::Match($o, 'SHA-256 digest: ([0-9a-f]+)')
        if ($m.Success) { $cert = $m.Groups[1].Value }
      }
    }
  }
}

$build = @"
# 构建记录 · v$Version

| 项 | 值 |
| --- | --- |
| versionName | $vn |
| versionCode | $vc |
| 归档时间 | $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') |
| APK 文件 | $apkName |
| APK SHA256 | $apkHash |
| 签名证书 SHA-256 | $cert |

## 从这个快照重建

    cd src\android
    .\gradlew.bat assembleRelease --no-daemon

签名用的是仓库根的 release.keystore —— 快照里【不含】密钥。把它和 android\keystore.properties
**同一个 keystore 才能签出可以覆盖安装、不丢数据的包**（证书指纹：$cert）。

## 目录说明

    apk\      安装包
    src\      www（前端源码）/ android（壳工程）/ e2e（测试）/ assets（图标）
    tools\    构建与归档脚本、依赖清单
   docs\     续接摘要与评审报告
"@
$build | Set-Content -Path (Join-Path $dest 'BUILD.md') -Encoding UTF8

if (-not (Test-Path (Join-Path $dest 'CHANGELOG.md'))) {
  ("# v$Version" + "`n`n" + "（在此写这一版改了什么）") | Set-Content -Path (Join-Path $dest 'CHANGELOG.md') -Encoding UTF8
}

Write-Host "完成：$dest"
Get-ChildItem $dest | Select-Object Name, Mode | Format-Table -AutoSize | Out-String -Width 120 | Write-Host
