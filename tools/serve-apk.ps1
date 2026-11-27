<#
  把桌面 mxj 用 HTTP 共享出去，不关机、不退出。日常随手用。
  睡前那一套用 serve-and-shutdown.py（下载完自动关机）。

  ⚠️ 本机防火墙三个 profile 全关，所以 binding 0.0.0.0 等于把目录暴露给
     任何连到这个网络的设备。只在可信网络下用。
#>
param([int]$Port = 8899)

$ErrorActionPreference = 'Stop'

$py = (& where.exe python 2>$null) | Where-Object { $_ -notlike '*WindowsApps*' } | Select-Object -First 1
if (-not $py) { throw "没找到 python" }
# ⚠️ 故意用 python.exe、不用 pythonw.exe：pythonw 没有控制台也没有 stderr，
#    新版 Python 的 http.server 会在写日志时炸，表现成"端口在监听但一个字节都不回"。
#    配合下面 Start-Process 的 -RedirectStandard* 才稳。

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
if (-not $lanIp) { throw "没找到局域网 IP" }

$dir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'mxj'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host ("端口 " + $Port + " 已在监听，直接用：http://" + $lanIp + ":" + $Port + "/latest.html") -ForegroundColor Yellow
  return
}

# ⚠️ 2026-11-27 修两处，都是"服务明明是好的、脚本却说它坏了"：
#
#   ① 必须重定向 stdout/stderr。pythonw 没有控制台，Python 3.14 的
#      http.server 在 log_message 里写 sys.stderr 会炸 —— 表现是【端口在监听、
#      socket 连得上、但一个字节都不回】（实测原始 socket 读回 bytes=0）。
#      昨晚能通是运气，今天开机就不通了。
#   ② 自检不能用 Invoke-WebRequest：它吃系统代理。VPN 一开（vgate0 起来），
#      自检就去走代理，127.0.0.1 也被劫走 → 报"自检失败"，而服务其实正好着。
#      改用 curl --noproxy。
#
# 另外显式 --bind 0.0.0.0：不给的话新版 Python 可能只绑 IPv6 的 ::，
# 手机（IPv4）连不上。
$logOut = Join-Path $env:TEMP 'mxj-serve.out.log'
$logErr = Join-Path $env:TEMP 'mxj-serve.err.log'
Start-Process $py -ArgumentList @('-m','http.server',"$Port",'--bind','0.0.0.0','--directory',$dir) -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr
Start-Sleep -Milliseconds 1500

$code = (& curl.exe -s -o NUL -w '%{http_code}' --noproxy '*' ("http://127.0.0.1:" + $Port + "/latest.html") 2>$null)
if ("$code" -eq '200') {
  Write-Host ("已启动（200）  日志：" + $logErr) -ForegroundColor Green
} else {
  Write-Host ("服务起了但自检失败（curl=" + $code + "），看日志：" + $logErr) -ForegroundColor Yellow
}
Write-Host ("手机打开：http://" + $lanIp + ":" + $Port + "/latest.html") -ForegroundColor Green
