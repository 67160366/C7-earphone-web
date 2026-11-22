# Build the printable parts: structure-layout.js -> cad/params.scad -> cad/out/*.stl, *.3mf, *.png
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-cad.ps1
#   ... -Fit 0.3 -HoleAdd 0.2 -Screw insert     (tune after printing cad/test_fit.scad)
#   ... -Only c7_lid,pod_lid_L -NoPng
# Needs Node 18+ and OpenSCAD 2021.01+ (winget install OpenSCAD.OpenSCAD).
param(
  [double]$Fit = 0.25,
  [double]$HoleAdd = 0.15,
  [ValidateSet('pilot', 'insert')][string]$Screw = 'pilot',
  [double]$PodCable = 1.2,
  [string[]]$Only = @(),
  [switch]$NoPng,
  [switch]$No3mf
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cad = Join-Path $root 'cad'
$out = Join-Path $cad 'out'
$src = Join-Path $out '_src'

$scad = $null
foreach ($c in @((Get-Command openscad.com -ErrorAction SilentlyContinue), (Get-Command openscad -ErrorAction SilentlyContinue))) { if ($c) { $scad = $c.Source; break } }
if (-not $scad) { foreach ($p in @("$env:ProgramFiles\OpenSCAD\openscad.com", "${env:ProgramFiles(x86)}\OpenSCAD\openscad.com")) { if (Test-Path $p) { $scad = $p; break } } }
if (-not $scad) { throw 'OpenSCAD not found. Install it: winget install --id OpenSCAD.OpenSCAD -e' }

$inv = [Globalization.CultureInfo]::InvariantCulture
$list = & node (Join-Path $root 'scripts/export-cad.mjs') --fit $Fit.ToString($inv) --hole-add $HoleAdd.ToString($inv) --screw $Screw --pod-cable $PodCable.ToString($inv)
if ($LASTEXITCODE -ne 0) { throw 'export-cad.mjs failed' }
$names = @($list | ForEach-Object { ($_ -split ' ')[0] }) + 'test_fit'
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })   # -File passes "a,b" as one string
if ($Only.Count) { $names = $names | Where-Object { $Only -contains $_ } }

New-Item -ItemType Directory -Force $src | Out-Null
$bad = @()
foreach ($n in $names) {
  $w = Join-Path $src "$n.scad"
  if ($n -eq 'test_fit') { Set-Content -Encoding ascii $w 'include <../../test_fit.scad>' }
  else { Set-Content -Encoding ascii $w "include <../../part.scad>`nwhich = `"$n`";" }
  $formats = @('stl'); if (-not $No3mf) { $formats += '3mf' }
  foreach ($f in $formats) {
    $o = Join-Path $out "$n.$f"
    $log = & $scad -o $o $w 2>&1 | Out-String
    $ok = ($LASTEXITCODE -eq 0) -and (Test-Path $o) -and ($log -notmatch 'Simple:\s*no') -and ($log -notmatch 'ERROR')
    if (-not $ok) { $bad += "$n.$f"; Write-Host "FAIL $n.$f`n$log" } else { Write-Host ("ok   {0,-14} {1,8:N0} bytes" -f "$n.$f", (Get-Item $o).Length) }
    if ($log -match 'WARNING') { Write-Host ($log -split "`n" | Where-Object { $_ -match 'WARNING' } | Out-String) }
  }
  if (-not $NoPng) {
    & $scad -o (Join-Path $out "$n.png") --render --imgsize=900,700 --viewall --autocenter --colorscheme=Tomorrow $w 2>&1 | Out-Null
  }
}
if (-not $NoPng -and -not $Only.Count) {
  & $scad -o (Join-Path $out 'assembly.png') --render --imgsize=1400,800 --viewall --autocenter --camera=0,0,0,55,0,25,0 --colorscheme=Tomorrow (Join-Path $cad 'assembly.scad') 2>&1 | Out-Null
}
if ($bad.Count) { Write-Host "`n$($bad.Count) failed: $($bad -join ', ')"; exit 1 }
# record what the files in cad/out were built from; scripts/check-web.mjs fails when the layout has moved on since
if (-not $Only.Count) {
  $info = [ordered]@{
    params_sha256 = (Get-FileHash (Join-Path $cad 'params.scad') -Algorithm SHA256).Hash.ToLower()
    fit = $Fit; hole_add = $HoleAdd; screw = $Screw; pod_cable = $PodCable
    openscad = ((& $scad --version 2>&1 | Out-String).Trim())
    parts = $names; formats = $formats; png = (-not $NoPng)
  }
  [IO.File]::WriteAllText((Join-Path $out 'build.json'), (($info | ConvertTo-Json) -replace "`r`n", "`n") + "`n")
}
Write-Host "`n$($names.Count) parts built in $out (fit $Fit, hole_add $HoleAdd, screws $Screw)"
