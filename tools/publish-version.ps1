<#
  发版：把仓库根的 version.json 指向【已经上传好的】那个 Release。

  用法：
    powershell -ExecutionPolicy Bypass -File tools\publish-version.ps1 -Version 0.5.7.2
    ... -DryRun                只打印将要写什么，不动文件
    ... -SkipUrlCheck          不联网校验资产地址（没有代理时用；慎用）
    ... -Apk "C:\path\x.apk"   指定包（默认去归档目录和桌面找）
    ... -Proxy http://127.0.0.1:7897

  为什么单独一个脚本（0.5.7.2 从 build-apk.ps1 里拆出来的）：
    version.json 是这条链上【唯一会打到真实用户】的文件。它的 apk.url 是按
    ".../releases/download/v<版本>/<资产名>" 拼出来的字符串 —— Release 没建、
    APK 没传的时候，这个 URL 本地看完全正常，用户点「检查更新」才 404。
    所以它只能在【上传完成之后】才被写。构建脚本不再碰它，
    「构建」和「发版」从此是两个物理上分开的命令，不再依赖谁记得 git checkout。

  关卡（任一不过就当场中止，一个字节都不写）：
    1. build.gradle 的 versionName 必须就是这次要发的版本
    2. versionCode 必须大于当前 version.json 里的（不许往回退）
    3. 安装包必须存在，并算出 size / sha256
    4. 资产地址必须真的返回 200（-SkipUrlCheck 才跳过）
    5. 拿到的 content-length 若和本地字节数不一致，直接判失败
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Code = '',
  [string]$Url = '',
  [string]$Apk = '',
  [string]$Proxy = '',
  [switch]$SkipUrlCheck,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
  throw ("版本号格式不对：" + $Version + "（要 0.5.7 或 0.5.7.2 这种）")
}

# ── 1. 版本号：和 build.gradle 对齐 ────────────────────────────────
$gvc = ''; $gvn = ''
$gradle = Join-Path $root 'android\app\build.gradle'
if (Test-Path $gradle) {
  $g = Get-Content $gradle -Raw
  $m = [regex]::Match($g, 'versionCode\s+(\d+)');        if ($m.Success) { $gvc = $m.Groups[1].Value }
  $m = [regex]::Match($g, 'versionName\s+"([^"]+)"');    if ($m.Success) { $gvn = $m.Groups[1].Value }
}
if ($gvn -and $gvn -ne $Version) {
  throw ("build.gradle 里的 versionName 是 " + $gvn + "，和 -Version " + $Version + " 不一致。" +
         "版本号要先改好（tools\bump-version.mjs），再构建，再发版。")
}
if (-not $Code) { $Code = $gvc }
if (-not $Code) { throw "拿不到 versionCode —— 用 -Code 指定" }
if ($Code -notmatch '^\d+$') { throw ("versionCode 必须是整数：" + $Code) }

# ── 2. 找安装包 ───────────────────────────────────────────────────
$cands = @()
if ($Apk) { $cands += $Apk }
$arch = Join-Path $root ('releases\v' + $Version + '\apk')
$cands += (Join-Path $arch ('mengxianju-v' + $Version + '.apk'))
$cands += (Join-Path $arch ('梦弦居-v' + $Version + '.apk'))
$desk = [Environment]::GetFolderPath('Desktop')
$cands += (Join-Path $desk ('mxj\mengxianju-v' + $Version + '.apk'))
$cands += (Join-Path $desk ('mxj\梦弦居-v' + $Version + '.apk'))
$apkPath = ''
foreach ($c in $cands) {
  if ($c -and (Test-Path $c)) { $apkPath = (Resolve-Path $c).Path; break }
}
if (-not $apkPath) {
  throw ("找不到 v" + $Version + " 的安装包。找过：" + [Environment]::NewLine + "  " + ($cands -join ([Environment]::NewLine + "  ")))
}
$f = Get-Item $apkPath
$sha = (Get-FileHash $apkPath -Algorithm SHA256).Hash

# ── 3. 资产地址 ───────────────────────────────────────────────────
$assetName = 'mengxianju-v' + $Version + '.apk'
if (-not $Url) {
  $Url = 'https://github.com/nan333680/mengxianju/releases/download/v' + $Version + '/' + $assetName
}

# ── 4. 更新说明 ───────────────────────────────────────────────────
# 两个来源都试，取第一个抓得到的：
#   ① 仓库根 CHANGELOG.md —— 真东西在这；
#   ② 归档目录那份 —— 它是和这个 APK 一起冻结的快照，说明和包属于同一版。
# ⚠️ 为什么不能只读归档那份：archive-release.ps1 建的是【53 字节的占位模板】
#    （"# v<版本>" + "（在此写这一版改了什么）"），不是真的 CHANGELOG。
#    只读它会永远抓到空 notes，然后弹窗里一片空白 —— 而且脚本还会「成功」写出去。
# ⚠️ 下面这段提取逻辑和 build-apk.ps1 里那段同源（那边只打印，不落盘）。
$notes = ''
$clCands = @(
  (Join-Path $root 'CHANGELOG.md'),
  (Join-Path $root ('releases\v' + $Version + '\CHANGELOG.md'))
)
foreach ($clPath in $clCands) {
  if (-not (Test-Path $clPath)) { continue }
  $cl = [System.IO.File]::ReadAllText($clPath, [System.Text.Encoding]::UTF8)
  $head = [regex]::Match($cl, '###\s*' + [regex]::Escape($Version) + '\s*（')
  if (-not $head.Success) { continue }
  $rest = $cl.Substring($head.Index)
  $rn = [regex]::Match($rest, '<!--\s*release-notes\s*-->\s*([\s\S]*?)\s*<!--\s*/release-notes\s*-->')
  $hm = [regex]::Match($cl, '###\s*' + [regex]::Escape($Version) + '\s*（([^）]*)）')
  if ($rn.Success) {
    $notes = ($rn.Groups[1].Value -replace '<!--[\s\S]*?-->', '').Trim()
  } elseif ($hm.Success) {
    $notes = ($hm.Groups[1].Value -replace '^versionCode\s+\d+\s*·\s*', '').Trim()
  }
  if ($notes) { break }
}
if (-not $notes) {
  Write-Host ("   ⚠️ 没抓到 v" + $Version + " 的更新说明（CHANGELOG 里没这一节，也没有 release-notes 标记）") -ForegroundColor Yellow
  Write-Host "      更新弹窗里会是空的。建议先补好再发。" -ForegroundColor Yellow
}

# ── 5. 不许往回退 ─────────────────────────────────────────────────
$verPath = Join-Path $root 'version.json'
$before = $null
if (Test-Path $verPath) {
  try { $before = [System.IO.File]::ReadAllText($verPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $before = $null }
}
if ($before -and $before.versionCode) {
  if ([int]$before.versionCode -ge [int]$Code) {
    throw ("当前 version.json 的 versionCode 是 " + $before.versionCode + "，不小于这次的 " + $Code +
           " —— 拒绝往回退。（真要幂等重发，先把 version.json 手工改回更小的值。）")
  }
}

# ── 6. 资产地址必须真的存在 ───────────────────────────────────────
if (-not $SkipUrlCheck) {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (-not (Test-Path $curl)) { throw "找不到 curl.exe（" + $curl + "）。没有它就验不了资产地址；确认过要跳过就加 -SkipUrlCheck" }
  $curlArgs = @('-s', '-I', '-L', '--max-time', '40')
  if ($Proxy) { $curlArgs += @('-x', $Proxy) }
  $curlArgs += $Url
  $head = & $curl @curlArgs 2>$null
  $txt = ($head | Out-String)
  $codes = [regex]::Matches($txt, 'HTTP/[\d.]+\s+(\d{3})')
  $last = ''
  if ($codes.Count -gt 0) { $last = $codes[$codes.Count - 1].Groups[1].Value }
  if ($last -ne '200') {
    throw ("资产地址没有返回 200（拿到的是「" + $last + "」）：" + $Url + [Environment]::NewLine +
           "  这就是这个脚本存在的理由 —— 先把这个 Release 和资产传上去，再回来发版。")
  }
  $clm = [regex]::Match($txt, '(?im)^content-length:\s*(\d+)')
  if ($clm.Success) {
    $remote = [int64]$clm.Groups[1].Value
    if ($remote -ne [int64]$f.Length) {
      throw ("远端那份和本地不是同一个包：远端 " + $remote + " 字节，本地 " + $f.Length + " 字节。")
    }
    Write-Host ("   资产地址校验通过：200，content-length " + $remote + " 与本地一致")
  } else {
    Write-Host "   资产地址校验通过：200（没拿到 content-length，无法核对字节数）" -ForegroundColor Yellow
  }
} else {
  Write-Host "   ⚠️ 跳过了资产地址校验（-SkipUrlCheck）。请自己确认 Release 和 APK 都传好了。" -ForegroundColor Yellow
}

# ── 7. 组装 ───────────────────────────────────────────────────────
$obj = [ordered]@{
  versionCode = [int]$Code
  versionName = $Version
  date        = (Get-Date).ToString('yyyy-MM-dd')
  notes       = $notes
  apk         = [ordered]@{
    size    = [int]$f.Length
    sha256  = $sha
    url     = $Url
    mirrors = @()
  }
}
$json = $obj | ConvertTo-Json -Depth 5

Write-Host ""
if ($before) {
  Write-Host ("   before: " + $before.versionName + " / " + $before.versionCode)
} else {
  Write-Host "   before: （没有 version.json）"
}
Write-Host ("   after : " + $Version + " / " + $Code)
Write-Host ("   包    : " + $apkPath)
Write-Host ("   大小  : " + $f.Length + " 字节")
Write-Host ("   SHA256: " + $sha)
Write-Host ("   说明  : " + $notes)
Write-Host ""

if ($DryRun) {
  Write-Host "-DryRun：没有写文件。要写就把 -DryRun 去掉。" -ForegroundColor Yellow
  Write-Host $json
  return
}

[System.IO.File]::WriteAllText($verPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("✓ 写好了：" + $verPath) -ForegroundColor Green
Write-Host ""
Write-Host "接下来（顺序别反）："
Write-Host "   1) 打开 App 点「检查更新」，弹窗里的说明读得通、链接点得开"
Write-Host "   2) git add version.json; git commit -m 'release: v" + $Version + "'"
Write-Host "   3) 推送（代理）：git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin main"
Write-Host "   4) 推完再 curl 一次备用源，确认 jsDelivr 那份也变成新版了"
