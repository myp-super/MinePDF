# 打包版冒烟测试：运行 release/win-unpacked/MinePDF.exe 并输出关键诊断
$ErrorActionPreference = 'Continue'
Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
$env:PKM_SMOKE_TEST = '1'
$env:PKM_CAPTURE = '1'
$log = Join-Path $env:TEMP 'pkm-smoke-packaged.log'
& (Join-Path (Get-Location) 'release\win-unpacked\MinePDF.exe') *> $log
Write-Host "exit=$LASTEXITCODE"
Select-String -Path $log -Pattern '\[pdfium\]|renderDiag|perfDiag|switchDiag|hlMergeDiag|\[smoke\] result' |
    ForEach-Object { $_.Line.Substring(0, [Math]::Min($_.Line.Length, 400)) }
