# 打包版冒烟测试：运行 release/win-unpacked/MinePDF.exe 并输出关键诊断
$ErrorActionPreference = 'Stop'
$exe = Join-Path (Get-Location) 'release\win-unpacked\MinePDF.exe'
$result = Join-Path $env:TEMP 'pkm-smoke-result.json'
$stdout = Join-Path $env:TEMP 'pkm-smoke-packaged.stdout.log'
$stderr = Join-Path $env:TEMP 'pkm-smoke-packaged.stderr.log'

Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'MinePDF.exe' -and $_.ExecutablePath -eq $exe } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $result, $stdout, $stderr -Force -ErrorAction SilentlyContinue

$env:PKM_SMOKE_TEST = '1'
$env:PKM_CAPTURE = '1'
$process = Start-Process -FilePath $exe -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$process.WaitForExit()
Write-Host "exit=$($process.ExitCode)"

if (-not (Test-Path $result)) {
    Get-Content $stdout -Tail 50 -ErrorAction SilentlyContinue
    Get-Content $stderr -Tail 50 -ErrorAction SilentlyContinue
    throw 'Packaged smoke test did not write a result file'
}

$data = Get-Content $result -Raw -Encoding UTF8 | ConvertFrom-Json
$failed = @($data.steps | Where-Object { -not $_[1] })
Write-Host "steps=$($data.steps.Count) failed=$($failed.Count)"
$data.steps | Where-Object { $_[0] -like 'translation*' } | ConvertTo-Json -Depth 8
if ($failed.Count -gt 0) {
    $failed | ConvertTo-Json -Depth 8
    exit 1
}
