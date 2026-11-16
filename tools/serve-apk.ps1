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
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'
if (-not (Test-Path $pyw)) { $pyw = $py }

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

Start-Process $pyw -ArgumentList @('-m','http.server',"$Port",'--directory',$dir) -WindowStyle Hidden
Start-Sleep -Milliseconds 600

try {
  $r = Invoke-WebRequest ("http://" + $lanIp + ":" + $Port + "/") -UseBasicParsing -TimeoutSec 5
  Write-Host ("已启动（" + $r.StatusCode + "）") -ForegroundColor Green
} catch {
  Write-Host ("服务起了但自检失败：" + $_.Exception.Message) -ForegroundColor Yellow
}
Write-Host ("手机打开：http://" + $lanIp + ":" + $Port + "/latest.html") -ForegroundColor Green
