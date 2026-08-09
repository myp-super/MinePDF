# 清理残留进程与旧的未压缩打包目录
Get-Process electron, MinePDF -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 800
$target = Join-Path (Get-Location) 'release\win-unpacked'
if (Test-Path $target) {
    Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'cleanup done'
