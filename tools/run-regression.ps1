<#
  跑全部 e2e 套件，串行。

  ⚠️ 必须串行：每套自己起一个 http server 并驱动一个 Chrome 实例，
     并发跑会互相抢 Chrome，报 "Navigating frame was detached" /
     "LifecycleWatcher terminated"，结果是随机的假失败。

  用法：
    powershell -ExecutionPolicy Bypass -File tools\run-regression.ps1
    powershell -ExecutionPolicy Bypass -File tools\run-regression.ps1 -Only "e2e-mem*.mjs"

  结果同时写进 _regress.log（每套一行 + 末尾汇总 + DONE 结尾）。
#>
param([string]$Only = "")

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $root '_regress.log'

# 残留的 Chrome 会占着调试端口，让下一套连不上
# 依赖真实模型的套件从这里取 Key。没有这个文件时它们会拿占位符跑，预期失败 ——
# 那些套件测的是端到端真实链路，没法脱离真 Key（见 CHANGELOG「测试环境的连带修改」）。
$keyFile = Join-Path $root '_archive\apikey.txt'
if (Test-Path $keyFile) {
  $env:DSH_API_KEY = (Get-Content $keyFile -Raw).Trim()
  Write-Host "已载入 DSH_API_KEY：依赖真实模型的套件会真调 API（会计费）"
} else {
  Write-Host "未找到 _archive\apikey.txt —— 依赖真实模型的套件会失败，属预期" -ForegroundColor Yellow
}

taskkill /F /IM chrome.exe 2>$null | Out-Null
Start-Sleep -Milliseconds 800

$files = Get-ChildItem -Path $root -Filter 'e2e-*.mjs' -File |
         Where-Object { $_.Name -ne 'e2e-helper.mjs' } | Sort-Object Name
if ($Only) { $files = $files | Where-Object { $_.Name -like $Only } }

Set-Content -Path $log -Value "" -Encoding UTF8
$pass = 0; $fail = 0; $fails = @()
$sw = [Diagnostics.Stopwatch]::StartNew()

foreach ($f in $files) {
  $t0 = [Diagnostics.Stopwatch]::StartNew()
  # ⚠️ 不要写成 `& node x 2>&1 | Out-String`。
  # PowerShell 5.1 会把原生命令的 stderr 逐行包成 ErrorRecord 再格式化，
  # 实测把整套回归从「几十分钟」拖成「六小时」——套件本身只要 15~30 秒。
  # 交给 cmd 做文件重定向，PowerShell 完全不碰这些字节。
  $tmpOut = Join-Path $root '_e2e_out.tmp'
  Push-Location $root
  cmd /c "node `"$($f.FullName)`" > `"$tmpOut`" 2>&1"
  $code = $LASTEXITCODE
  Pop-Location
  $out = if (Test-Path $tmpOut) { Get-Content $tmpOut -Raw -Encoding UTF8 } else { '' }
  Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue
  $t0.Stop()

  # 三种汇总格式都要认（各套件是不同时期写的，没统一过）
  # 三种汇总格式，各套件是不同时期写的，没统一过：
  #   pass=8 fail=0        /  通过 23 项，失败 0 项  /  通过 31 / 失败 0
  # ⚠️ 第三种一直没被认出来（e2e-appearance 就是它），日志里显示成"(无汇总)"——
  #    判定本身没错（靠 exit code 兜底），但"通过 N 项"这个数字丢了。
  $m = [regex]::Match($out, 'pass=(\d+)\s+fail=(\d+)')
  if (-not $m.Success) { $m = [regex]::Match($out, '通过\s+(\d+)\s*项[^0-9]*失败\s+(\d+)') }
  if (-not $m.Success) { $m = [regex]::Match($out, '通过\s+(\d+)\s*/\s*失败\s+(\d+)') }
  if ($m.Success) {
    $p = [int]$m.Groups[1].Value; $fl = [int]$m.Groups[2].Value
    if ($fl -eq 0) { $verdict = 'PASS' } else { $verdict = 'FAIL' }
    $note = "通过 $p 项，失败 $fl 项"
    $pass += $p; $fail += $fl
    if ($fl -gt 0) { $fails += "$($f.Name)  pass=$p fail=$fl" }
  } else {
    # 实况型（只打印过程给你看，没有断言）：没崩就算过
    if ($code -ne 0) { $verdict = 'FAIL' } else { $verdict = 'PASS' }
    $note = '(无汇总)'
    if ($code -ne 0) { $fails += "$($f.Name)  退出码 $code" }
  }

  $line = "{0,-4} {1,-26} {2}   [{3:N1}s]" -f $verdict, $f.Name, $note, $t0.Elapsed.TotalSeconds
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}

$mins = [math]::Round($sw.Elapsed.TotalMinutes, 1)
$summary = "汇总: 通过 $pass / 失败 $fail / 共 $($files.Count) 套 / 耗时 $mins 分钟"
Add-Content -Path $log -Value $summary -Encoding UTF8
if ($fails.Count) {
  Add-Content -Path $log -Value "---- 失败清单 ----" -Encoding UTF8
  $fails | ForEach-Object { Add-Content -Path $log -Value "  $_" -Encoding UTF8 }
}
Add-Content -Path $log -Value 'DONE' -Encoding UTF8
Write-Host $summary
