# Start, stop and check MPS brain running production-style on this machine.
#
#   .\scripts\mps.ps1 start     start web (http://localhost:3000) and worker in the background
#   .\scripts\mps.ps1 stop      stop both
#   .\scripts\mps.ps1 restart   stop then start
#   .\scripts\mps.ps1 status    show what is running
#   .\scripts\mps.ps1 build     stop, production-build the web app, start again (after code changes)
#   .\scripts\mps.ps1 logs      show the last lines of today's logs
#
# Optional: -Only web | worker to act on one of them. Logs: logs\<service>-<date>.log.
# Both keep running after the terminal closes, but not after logging off or a reboot.
# If PowerShell refuses to run scripts: powershell -ExecutionPolicy Bypass -File .\scripts\mps.ps1 start
param(
  [Parameter(Position = 0)][ValidateSet('start', 'stop', 'restart', 'status', 'build', 'logs')][string]$Action = 'status',
  [ValidateSet('web', 'worker', 'both')][string]$Only = 'both'
)

$repo = Split-Path $PSScriptRoot -Parent
$runner = Join-Path $PSScriptRoot 'run-service.ps1'
$services = if ($Only -eq 'both') { @('worker', 'web') } else { @($Only) }

function Get-Runners([string]$svc) {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'run-service\.ps1' -and $_.CommandLine -match "-Service\s+$svc\b" }
}

function Get-NodeFor([string]$svc) {
  # Web: next under this repo (the server child is also caught by the port-3000 check in Stop-Svc).
  # Worker: the tsx entry point.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    if ($svc -eq 'web') { $_.CommandLine -match 'mps-brain-replenishment' -and $_.CommandLine -match 'next' }
    else { $_.CommandLine -match 'src[/\\]main\.ts' }
  }
}

function Stop-Svc([string]$svc) {
  # Kill the restart loop first so it can't bring the process back, then the node processes.
  Get-Runners $svc | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Get-NodeFor $svc | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  if ($svc -eq 'web') {
    Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop } catch {} }
  }
  Write-Host "stopped $svc"
}

function Start-Svc([string]$svc) {
  if (Get-Runners $svc) { Write-Host "$svc already running"; return }
  if ($svc -eq 'web' -and -not (Test-Path (Join-Path $repo 'apps\web\.next\BUILD_ID'))) {
    Write-Host 'web has no production build yet: run .\scripts\mps.ps1 build'; return
  }
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$runner`"", '-Service', $svc)
  Write-Host "started $svc"
}

function Show-Status {
  foreach ($svc in 'worker', 'web') {
    $state = if (Get-Runners $svc) { 'running' } else { 'stopped' }
    Write-Host ("{0,-7} {1}" -f $svc, $state)
  }
  $listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  Write-Host ("port 3000: " + $(if ($listening) { 'listening -> http://localhost:3000' } else { 'not listening' }))
}

function Invoke-Build {
  Stop-Svc 'web'
  Push-Location $repo
  try {
    foreach ($line in Get-Content '.env') {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $v = $Matches[2].Trim().Trim('"').Trim("'")
        [Environment]::SetEnvironmentVariable($Matches[1], $v, 'Process')
      }
    }
    npm run build -w '@mps/web' | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Host 'BUILD FAILED: web left stopped'; return $false }
  } finally { Pop-Location }
  return $true
}

switch ($Action) {
  'start'   { $services | ForEach-Object { Start-Svc $_ }; Start-Sleep 5; Show-Status }
  'stop'    { $services | ForEach-Object { Stop-Svc $_ } }
  'restart' { $services | ForEach-Object { Stop-Svc $_ }; Start-Sleep 2; $services | ForEach-Object { Start-Svc $_ }; Start-Sleep 5; Show-Status }
  'status'  { Show-Status }
  'build'   {
    $wasWorker = [bool](Get-Runners 'worker')
    if (Invoke-Build) {
      # Restart the worker too so it runs the same code (and applies any new migration) as the web.
      if ($wasWorker) { Stop-Svc 'worker'; Start-Sleep 2 }
      Start-Svc 'worker'; Start-Svc 'web'; Start-Sleep 5; Show-Status
    }
  }
  'logs'    {
    $day = Get-Date -Format 'yyyy-MM-dd'
    foreach ($svc in $services) {
      $f = Join-Path $repo "logs\$svc-$day.log"
      Write-Host "--- $svc ---"
      if (Test-Path $f) { Get-Content $f -Tail 20 } else { Write-Host '(no log today)' }
    }
  }
}
