# Start or stop the local PHP server for the C7 web pages.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1          # start, this computer only (127.0.0.1)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1 -Lan     # start, also reachable by headsets on the same network
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1 -Stop    # stop
# -Lan makes this computer the server for the Wi-Fi path (docs/WIFI.md). Windows Firewall must allow php.exe on the port.
param([switch]$Stop, [switch]$Lan, [int]$Port = 8090)
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
    $candidates = @('C:\xampp\php\php.exe', 'C:\php\php.exe')
    $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path $winget) { $candidates += Get-ChildItem $winget -Directory -Filter 'PHP.PHP*' | ForEach-Object { Join-Path $_.FullName 'php.exe' } }
    foreach ($candidate in $candidates) { if (Test-Path $candidate) { $php = Get-Item $candidate; break } }
}
if (-not $php) { throw 'PHP 8+ not found. Install PHP or XAMPP, or add php.exe to PATH.' }
$phpPath = if ($php.Source) { $php.Source } else { $php.FullName }

$running = Get-ServerProcess
if ($running) { Write-Host "Already running: http://127.0.0.1:$Port/ (stop it first to change -Lan)"; exit 0 }

New-Item -ItemType Directory -Force $runtime | Out-Null
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null   # SQLite database of the Wi-Fi path lives here (not in git)

# A PHP without php.ini (winget) loads no PDO driver; the Wi-Fi API needs SQLite (or MySQL) through PDO.
$phpArgs = @()
$modules = & $phpPath -m
$extDir = Join-Path (Split-Path -Parent $phpPath) 'ext'
foreach ($ext in @('pdo_sqlite', 'pdo_mysql')) {
    if (($modules -notcontains $ext) -and (Test-Path (Join-Path $extDir "php_$ext.dll"))) {
        if ($phpArgs.Count -eq 0) { $phpArgs += @('-d', "extension_dir=`"$extDir`"") }
        $phpArgs += @('-d', "extension=$ext")
    }
}
$bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
$phpArgs += @('-S', "${bind}:$Port", '-t', "`"$root`"", "`"$(Join-Path $PSScriptRoot 'router.php')`"")

$proc = Start-Process -FilePath $phpPath -ArgumentList $phpArgs -WorkingDirectory $root -WindowStyle Hidden -PassThru `
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
Write-Host "Wi-Fi headsets: http://127.0.0.1:$Port/devices.html"
if ($Lan) {
    Write-Host ''
    Write-Host 'Reachable from the network. Server address to type into the headset setup page (pick the network the headset joins):'
    Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object {
        Write-Host ("  http://{0}:{1}/api/ingest.php   ({2})" -f $_.IPAddress, $Port, $_.InterfaceAlias)
    }
    Write-Host 'If the headset reports http=-1, allow php.exe through Windows Firewall for this port.'
}
Write-Host 'Stop with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1 -Stop'
