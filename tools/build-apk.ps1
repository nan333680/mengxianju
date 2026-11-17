<#
  一键构建签名 Release APK。

  用法：
    powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1

  ⚠️ 三个坑，都是踩过的：
    1) 仓库根不能用 $MyInvocation.MyCommand.Path —— 它给的是【脚本自己所在的目录】，
       本脚本在 tools\ 下，那样 android\ 会被拼成 tools\android\（不存在）。
       用 $PSScriptRoot 的上一级。
    2) 调 npx 要用 npx.cmd。本机执行策略是 Restricted，裸 npx 起不来。
    3) 要的是 assembleRelease（签过名的），不是 assembleDebug ——
       debug 包签名不同，装上去会【覆盖失败】或丢数据。
#>

# -Shutdown：手机下载完就让电脑关机（睡前那一套，60 秒倒计时）。
# 默认【不关机】：包照样生成、服务照样起，但绝不设关机 —— 白天构建不会把你机器关掉。
# -CleanOld：构建完把桌面上【别的版本】的包删掉，只留这一个。
# 默认【保留】：本地迭代的四段版本号（0.3.0 -> 0.3.0.1 -> 0.3.0.2）要并排放着对比，
# 每构建一次就删掉上一个会很碍事。想清干净时显式加这个开关。
param([switch]$CleanOld, [switch]$Shutdown)

$ErrorActionPreference = 'Continue'

# Capacitor 8 要求 Java 21。
#
# 这两个路径【不写死在仓库里】—— 写死的话别人 clone 下来直接跑不起来。
# 取值顺序：已有的环境变量 → tools\local.env（一行一个 KEY=VALUE，不进版本库）→ 报错说清楚缺什么。
$localEnv = Join-Path $PSScriptRoot 'local.env'
if (Test-Path $localEnv) {
  foreach ($line in (Get-Content $localEnv -Encoding UTF8)) {
    if ($line -notmatch '^\s*[^#\s].*=') { continue }
    $parts = $line.Split('=', 2)
    $k = $parts[0].Trim(); $v = $parts[1].Trim()
    if ($k -and $v -and -not [Environment]::GetEnvironmentVariable($k)) {
      Set-Item -Path ("env:" + $k) -Value $v
    }
  }
}
if (-not $env:JAVA_HOME) {
  throw "没找到 JAVA_HOME。Capacitor 8 需要 JDK 21 —— 设好环境变量，或在 tools\local.env 里写一行 JAVA_HOME=<你的 JDK 目录>"
}
if (-not $env:ANDROID_HOME) {
  throw "没找到 ANDROID_HOME —— 设好环境变量，或在 tools\local.env 里写一行 ANDROID_HOME=<你的 Android SDK 目录>"
}
if (-not $env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 版本号从 build.gradle 读，避免脚本里再抄一份（抄了就会不一致）
$gradle = Join-Path $root "android\app\build.gradle"
$vc = ''; $vn = ''
if (Test-Path $gradle) {
  $g = Get-Content $gradle -Raw
  $m = [regex]::Match($g, 'versionCode\s+(\d+)');    if ($m.Success) { $vc = $m.Groups[1].Value }
  $m = [regex]::Match($g, 'versionName\s+"([^"]+)"'); if ($m.Success) { $vn = $m.Groups[1].Value }
}
# 关于页的兜底版本号（app.js 的 WEB_VERSION_FALLBACK）必须和这里一致。
# 真机上读的是原生 versionName，那个常量只在桌面浏览器里兜底 —— 对不上就是漏改了。
# 与其让它悄悄漂移，不如在构建这一步直接拦住。
$appjs = Join-Path $root "www\js\app.js"
if ((Test-Path $appjs) -and $vn) {
  $src = [System.IO.File]::ReadAllText($appjs, [System.Text.Encoding]::UTF8)
  $m = [regex]::Match($src, "WEB_VERSION_FALLBACK\s*=\s*'([^']+)'")
  if (-not $m.Success) {
    Write-Host "构建失败：app.js 里找不到 WEB_VERSION_FALLBACK 常量" -ForegroundColor Red
    exit 1
  } elseif ($m.Groups[1].Value -ne $vn) {
    Write-Host ("构建失败：app.js 的 WEB_VERSION_FALLBACK='" + $m.Groups[1].Value + "'，build.gradle 的 versionName='" + $vn + "'，两边对不上") -ForegroundColor Red
    exit 1
  }
}

Write-Host "=== 构建 梦弦居 v$vn (versionCode $vc) ===" -ForegroundColor Cyan

# ⚠️ 本次构建的开始时刻（v1.21.54，审计发现）。
# 下面用它判断产物是不是【这一轮】生成的 —— 只看"文件在不在"会被上一轮的产物骗过去。
$buildStart = Get-Date

Write-Host "=== 1) 同步 Web 资源到 Android 工程 ===" -ForegroundColor Cyan
cmd /c "npx.cmd cap sync android 2>&1"
# ⚠️ 退出码必须查（v1.21.54，审计发现）：cap sync 失败时脚本原来照样往下走，
#    而 android 工程里留着的是【上一轮】同步进去的前端 —— 打出来的包
#    "原生是新的、前端是旧的"，照样报「构建成功」。
if ($LASTEXITCODE -ne 0) {
  Write-Host "构建失败：cap sync 退出码 $LASTEXITCODE（Web 资源没同步进去，这个包不能用）" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "=== 2) Gradle 构建 Release APK ===" -ForegroundColor Cyan
Set-Location (Join-Path $root "android")
cmd /c "gradlew.bat assembleRelease --no-daemon 2>&1"
# 同理：gradlew 失败（编译错、签名配置错、JAVA_HOME 失效）时，产物路径上往往
# 还躺着上一轮的 APK，Test-Path 依然为真 —— 旧包会被当成这次成果拷到桌面并归档。
if ($LASTEXITCODE -ne 0) {
  Write-Host "构建失败：gradlew 退出码 $LASTEXITCODE" -ForegroundColor Red
  exit 1
}

Set-Location $root
$apk = Join-Path $root "android\app\build\outputs\apk\release\app-release.apk"
Write-Host ""
if (-not (Test-Path $apk)) {
  Write-Host "构建失败：没找到 $apk" -ForegroundColor Red
  Write-Host "往上翻构建日志。" -ForegroundColor Red
  exit 1
}

$f = Get-Item $apk
# ⚠️ 产物必须是【本次构建之后】写出来的（v1.21.54）。
#    这一条是防"旧包冒充新版本"的最后一道：即使某个环节的退出码没被正确传递，
#    只要产物是旧的，就在这里拦住 —— 绝不把它拷到桌面。
if ($f.LastWriteTime -lt $buildStart) {
  Write-Host ("构建失败：产物比本次构建还旧（产物 " + $f.LastWriteTime + " < 开始 " + $buildStart + "）") -ForegroundColor Red
  Write-Host "        这是上一轮留下的文件，不能当成本次成果。" -ForegroundColor Red
  exit 1
}
$sha = (Get-FileHash $apk -Algorithm SHA256).Hash
Write-Host "构建成功" -ForegroundColor Green
Write-Host ("   " + $apk)
Write-Host ("   大小   : " + [math]::Round($f.Length/1MB, 2) + " MB (" + $f.Length + " 字节)")
Write-Host ("   SHA256 : " + $sha)

# ── 检查更新用的 version.json（v0.5.7）────────────────────────────────
# 必须自动生成。手写一定会忘，而忘了的表现是「发了版但 App 查不到新版」——
# 这个功能坏掉时界面和正常时一模一样，靠肉眼发现不了。
#
# 两个数据源：GitHub Release（主，实时）+ 仓库根这份 JSON（备，经 jsDelivr）。
# ⚠️ 必须用 .NET 写成【无 BOM】的 UTF-8：Set-Content -Encoding UTF8 在
#    Windows PowerShell 5.1 下会带 BOM，而 JSON.parse 碰到 BOM 直接抛错，
#    整个备用源就永远拿到 null，且失败是静默的。
# 更新说明只取「给用户看的那一小段」，不是整节 CHANGELOG。
# ⚠️ 整节 CHANGELOG 里混着内部笔记（根因分析、TODO、实测数字），
#    App 里 notes 截断到 800 字，用户看到的会是半截技术细节。
#    所以约定：每节开头写
#        <!-- release-notes -->
#        一行给用户看的
#        <!-- /release-notes -->
#    只抓这一段；没有标记才退回抓标题行括号里的描述（老条目兼容）。
$notes = ''
$changelog = Join-Path $root "CHANGELOG.md"
if (Test-Path $changelog) {
  $cl = [System.IO.File]::ReadAllText($changelog, [System.Text.Encoding]::UTF8)
  # ⚠️ 必须先从标题定位到【这一版】，再往后找标记 —— 全局找标记会永远抓到
  #    文件最上面那一节（这一版还没写 CHANGELOG 时，会抓成上一版的说明）。
  $head = [regex]::Match($cl, '###\s*' + [regex]::Escape($vn) + '\s*（')
  if ($head.Success) {
    $rest = $cl.Substring($head.Index)
    $rn = [regex]::Match($rest, '<!--\s*release-notes\s*-->\s*([\s\S]*?)\s*<!--\s*/release-notes\s*-->')
    $hm = [regex]::Match($cl, '###\s*' + [regex]::Escape($vn) + '\s*（([^）]*)）')
    if ($rn.Success) {
      # 块内的 HTML 注释是写给人看的，不能跟着进 notes
      $notes = ($rn.Groups[1].Value -replace '<!--[\s\S]*?-->', '').Trim()
    } elseif ($hm.Success) {
      $notes = ($hm.Groups[1].Value -replace '^versionCode\s+\d+\s*·\s*', '').Trim()
    }
  }
}
$assetName = "mengxianju-v" + $vn + ".apk"

# ⚠️ 这里【不再写】仓库根的 version.json（0.5.7.2 改）。
#
# 原来这一段会把 version.json 直接改成本次构建的版本，连 apk.url 都按
# ".../releases/download/v<版本>/<资产名>" 拼好。可是构建的时候 Release 还没建、
# APK 还没传 —— 这份 JSON 一旦被 git add 进去推上去，所有在用的人一打开就会
# 检测到新版本，点进去 404。而 url 是拼出来的字符串，本地看完全正常，
# 谁也不会怀疑它坏在那里。
#
# 原来靠「记得 git checkout -- version.json」兜着。那等于把这条线上更新链
# 交给记性 —— 而 `git add -A` 是这个仓库里最常用的命令之一，一次手滑就中。
# 现在构建只管打包；发版走 tools\publish-version.ps1，两道命令物理上分开。
Write-Host ""
Write-Host "   ⚠️ 仓库根的 version.json 没有动（构建 ≠ 发版）。" -ForegroundColor Yellow
Write-Host "      发布时（Release 已建、APK 已传、curl 验到 200 之后）跑：" -ForegroundColor Yellow
Write-Host ("        powershell -ExecutionPolicy Bypass -File tools\publish-version.ps1 -Version " + $vn) -ForegroundColor Yellow
Write-Host "   本次构建的说明（会进 version.json 的 notes）："
if ($notes) { Write-Host ("     " + $notes) } else { Write-Host "   ⚠️ CHANGELOG 里没找到这一版的标题行，notes 会是空的" -ForegroundColor Yellow }

# 签名指纹：覆盖安装能不能保住数据，就看它和上一版是否一致
$signer = Join-Path $env:ANDROID_HOME "build-tools\36.0.0\apksigner.bat"
if (Test-Path $signer) {
  $o = & $signer verify --print-certs $apk 2>&1 | Out-String
  $sigOk = ($LASTEXITCODE -eq 0)
  $m = [regex]::Match($o, 'SHA-256 digest: ([0-9a-f]+)')
  if ($m.Success) { Write-Host ("   签名   : " + $m.Groups[1].Value) }
  # ⚠️ 只看【退出码】，别去匹配输出里的字。两种写法都踩过：
  #    · -match 'Verified using v[12] scheme.*true' —— -match 默认不跨行，而 apksigner
  #      的 scheme 是一行一个，那个 .* 永远跨不过去，签得再好也报"验证没通过"。
  #    · -notmatch 'Verifies' —— verify 不带 --verbose 时，成功也只打印证书信息，
  #      一个 "Verifies" 都不出现（v1.21.44 构建时实测确认）。
  #      于是每次构建都白报一句"没给出明确结论"，把真正的失败淹掉。
  if (-not $sigOk) {
    # ⚠️ 中止，不是只警告（v1.21.54，审计发现）。
    # 原来这里红字提示一句「别装这个包」，脚本却继续拷到桌面、继续归档，
    # 终端最后一行还是绿色的「已放到桌面」—— 真正的失败藏在中间一行，很容易被刷过去。
    Write-Host "   ⚠️ 签名验证失败（apksigner 退出码非 0）" -ForegroundColor Red
    Write-Host "   已中止：不把没通过签名校验的包放到桌面，也不归档。" -ForegroundColor Red
    exit 1
  } else {
    Write-Host "   签名验证: 通过（apksigner 退出码 0）"
  }
} else {
  # ⚠️ 原来没有这个 else：找不到 apksigner 时整段校验【静默消失】，
  #    日志里连一句「未校验」都没有，用的人会以为凡是从这个脚本出来的包都验过。
  Write-Host ("   ⚠️ 找不到 apksigner（" + $signer + "），本次【没有做签名校验】") -ForegroundColor Yellow
}

# 复制到本地交付目录（当前用户的桌面下的 mxj 文件夹，随机器走、不写死用户名）并改名成带版本号的（默认保留其它版本，-CleanOld 才清理）。
# ⚠️ v0.4.1.6：交付位置从桌面根目录改成桌面下的 mxj 子目录 —— 要的是
#    桌面根目录保持干净、安装包统一收在那个文件夹里（他明说的）。
$desk = [Environment]::GetFolderPath("Desktop")
$outDir = Join-Path $desk "mxj"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$dest = Join-Path $outDir ("梦弦居-v" + $vn + ".apk")
# ⚠️ 顺序反了会出事（v1.21.54，审计发现）：原来是【先删旧包、再 Copy】——
#    万一 Copy 失败（桌面文件被占用、磁盘满），桌面上就只剩一个不完整的文件，
#    而唯一的旧包已经被自己删掉了。现在先拷到 .new，成功了才动旧包。
$tmpDest = $dest + ".new"
try {
  Copy-Item $apk $tmpDest -Force -ErrorAction Stop
} catch {
  Write-Host ("复制到桌面失败：" + $_.Exception.Message) -ForegroundColor Red
  Write-Host "桌面上的旧包一个都没动。" -ForegroundColor Red
  exit 1
}
if ($CleanOld) {
  Get-ChildItem $outDir -Filter "梦弦居-v*.apk" | Where-Object { $_.FullName -ne $dest -and $_.FullName -ne $tmpDest } | ForEach-Object {
    Write-Host ("   移除旧包 " + $_.Name)
    Remove-Item $_.FullName -Force
  }
} else {
  Write-Host "   （交付目录里保留其它版本的包；要只留最新一个就加 -CleanOld）"
}
Move-Item -LiteralPath $tmpDest -Destination $dest -Force
Write-Host ""
Write-Host ("已放到：" + $dest) -ForegroundColor Green

# 发版用的 ASCII 副本（v0.5.7）：GitHub Release 的资产名不能带中文 ——
# URL 里会被百分号编码，写进 version.json 以后只要哪个环节没解码就是 404。
# 和中文名那份是同一个文件，只是名字不同；上传 Release 时用这个。
$assetDest = Join-Path $outDir $assetName
Copy-Item $dest $assetDest -Force
Write-Host ("   ASCII 副本  : " + $assetDest + "   <- 发 GitHub Release 时传这个")

# 顺带归档一份完整快照（脚本自己会拒绝覆盖已存在的版本目录）
& (Join-Path $PSScriptRoot "archive-release.ps1") -Version $vn -Apk $dest

# ============================================================
# 送达：构建完手机自己下
#   默认只送包、不关机（服务常驻到你手动停，或下次构建清端口）
#   加 -Shutdown 才是「人走、电脑自己关」那套
# ============================================================
# ⚠️ 三条硬规矩，写错了会出事：
#  1) 必须 Start-Process 脱离，不能同步调用 —— 否则构建永远不返回；
#  2) 这一段任何失败都不能让构建算失败（包本身是好的，只是没送出去）；
#  3) 不要 bind 具体 IP，手机重启后热点网段会变。

$servePort = 8899
$latestName = 'mengxianju-latest.apk'
$latest = Join-Path $outDir $latestName

# ---- 固定别名：书签失效时的兜底入口 ----
try {
  Copy-Item -LiteralPath $dest -Destination $latest -Force -ErrorAction Stop
  Write-Host ("   固定别名    : " + $latestName)
} catch {
  Write-Host ("   ⚠️ 生成固定别名失败：" + $_.Exception.Message) -ForegroundColor Yellow
}

# ---- 下载页脚注：关不关机是两套话，别写死 ----
if ($Shutdown) {
$dlNote = @'
  下载完成后电脑会在 60 秒内自动关机。<br>
  反悔就在电脑上敲 shutdown /a。
'@
$shutdownHint = "   下载完成后 60 秒自动关机（反悔敲 shutdown /a）"
$serveNote    = '已启动（下载完成即关机）'
} else {
$dlNote = @'
  下载完成后电脑不会关机，这个服务会一直开着。<br>
  不想再送了就停掉那个 python 进程。
'@
$shutdownHint = "   下载后【不】关机；服务常驻，停掉 python 进程才结束"
$serveNote    = '已启动（不关机，常驻）'
}

# ---- 下载页：链接带版本号，避开浏览器对同名文件的启发式缓存 ----
$dlHtml = @"
<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>梦弦居 v$vn</title>
<body style="font-family:system-ui;background:#141317;color:#eee;margin:0;padding:36px 22px">
<p style="opacity:.55;margin:0 0 6px;font-size:14px">最新构建</p>
<h1 style="font-size:28px;margin:0 0 26px">梦弦居 v$vn</h1>
<a href="mengxianju-v$vn.apk"
   style="display:block;text-align:center;padding:22px;border-radius:16px;
          background:#6d5ce0;color:#fff;text-decoration:none;font-size:20px;font-weight:600">
  下载安装包（约 52 MB）
</a>
<p style="opacity:.4;font-size:13px;margin-top:22px;line-height:1.6">
$dlNote
</p>
"@
try {
  Set-Content -Path (Join-Path $outDir 'latest.html') -Value $dlHtml -Encoding UTF8 -ErrorAction Stop
  Write-Host "   下载页      : latest.html"
} catch {
  Write-Host ("   ⚠️ 生成下载页失败：" + $_.Exception.Message) -ForegroundColor Yellow
}

# ---- 探测热点网卡 IP，写到桌面，方便书签失效时查 ----
try {
  $lanIp = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'WLAN' -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '169.254.*' } |
            Select-Object -First 1).IPAddress
  if (-not $lanIp) {
    $alias = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
              Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias
    if ($alias) {
      $lanIp = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $alias -ErrorAction SilentlyContinue |
                Select-Object -First 1).IPAddress
    }
  }
} catch { $lanIp = $null }

if ($lanIp) {
  $addrFile = Join-Path ([Environment]::GetFolderPath('Desktop')) '手机下载地址.txt'
  @(
    "手机浏览器打开：http://$lanIp`:$servePort/latest.html",
    "",
    "生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "版本：v$vn",
    "",
    "打不开的话：热点重开过就会换 IP，重跑一次 tools\serve-apk.ps1 看新地址。"
  ) | Set-Content -Path $addrFile -Encoding UTF8
  Write-Host ""
  Write-Host ("   手机打开：http://" + $lanIp + ":" + $servePort + "/latest.html") -ForegroundColor Green
  Write-Host  ($shutdownHint) -ForegroundColor Green
  Write-Host ("   地址也写进了：" + $addrFile)
} else {
  Write-Host "   ⚠️ 没探测到局域网 IP，手机可能连不上" -ForegroundColor Yellow
}

# ---- 拉起送达服务（独立进程，脱离本会话） ----
try {
  $pyw = 'C:\Python314\pythonw.exe'
  if (-not (Test-Path $pyw)) {
    $py  = (& where.exe python 2>$null) | Where-Object { $_ -notlike '*WindowsApps*' } | Select-Object -First 1
    if ($py) {
      $cand = Join-Path (Split-Path $py) 'pythonw.exe'
      $pyw = if (Test-Path $cand) { $cand } else { $py }
    }
  }
  # 端口已被占用就先停掉旧的，避免两个服务抢
  $busy = Get-NetTCPConnection -LocalPort $servePort -State Listen -ErrorAction SilentlyContinue
  if ($busy) {
    $busy | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
      Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 400
  }
  # 关不关机由这里决定：默认给子进程 MXJ_NO_SHUTDOWN=1，只有 -Shutdown 才撤掉
  if ($Shutdown) {
    Remove-Item Env:\MXJ_NO_SHUTDOWN -ErrorAction SilentlyContinue
  } else {
    $env:MXJ_NO_SHUTDOWN = '1'
  }
  Start-Process $pyw `
    -ArgumentList @((Join-Path $PSScriptRoot 'serve-and-shutdown.py')) `
    -WindowStyle Hidden
  Write-Host ("   送达服务    : " + $serveNote)
} catch {
  Write-Host ("   ⚠️ 送达服务没起来：" + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host  "      包已经生成好了，只是没送到手机；可以手动跑 tools\serve-apk.ps1" -ForegroundColor Yellow
}
