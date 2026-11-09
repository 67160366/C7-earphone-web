# Start or stop the local PHP server for the C7 web pages (loopback only).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1          # start in background
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1 -Stop    # stop
param([switch]$Stop, [int]$Port = 8090)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root '.local'
$pidFile = Join-Path $runtime 'server.pid'

function Get-ServerProcess {
    if (-not (Test-Path $pidFile)) { return $null }
    $id = [int](Get-Content $pidFile -Raw)
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -like 'php*') { return $p }
    Remove-Item $pidFile -Force
    return $null
}

if ($Stop) {
    $p = Get-ServerProcess
    if ($p) { Stop-Process -Id $p.Id -Force; Remove-Item $pidFile -Force; Write-Host 'Server stopped.' }
    else { Write-Host 'Server is not running.' }
    exit 0
}

$php = Get-Command php -ErrorAction SilentlyContinue
if (-not $php) {
    foreach ($candidate in @('C:\xampp\php\php.exe', 'C:\php\php.exe')) { if (Test-Path $candidate) { $php = Get-Item $candidate; break } }
}
if (-not $php) { throw 'PHP 8+ not found. Install PHP or XAMPP, or add php.exe to PATH.' }
$phpPath = if ($php.Source) { $php.Source } else { $php.FullName }

$running = Get-ServerProcess
if ($running) { Write-Host "Already running: http://127.0.0.1:$Port/"; exit 0 }

New-Item -ItemType Directory -Force $runtime | Out-Null
$proc = Start-Process -FilePath $phpPath -ArgumentList @('-S', "127.0.0.1:$Port", '-t', $root) -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runtime 'server.out.log') -RedirectStandardError (Join-Path $runtime 'server.err.log')
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii

$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
    Start-Sleep -Milliseconds 250
    try { $ok = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/index.html").StatusCode -eq 200 } catch { $ok = $false }
}
if (-not $ok) { Write-Warning "Server did not answer. See .local/server.err.log (is port $Port in use?)"; exit 1 }
Write-Host "User page: http://127.0.0.1:$Port/"
Write-Host "Demo:      http://127.0.0.1:$Port/?demo"
Write-Host "Dev page:  http://127.0.0.1:$Port/dev.html"
Write-Host 'Stop with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1 -Stop'
