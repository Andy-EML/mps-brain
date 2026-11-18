# Keeps one MPS brain process running production-style and restarts it if it exits.
# Started by scripts\mps.ps1; not normally run by hand.
#   web    -> next start on :3000 (NODE_ENV=production; run `mps.ps1 build` first)
#   worker -> tsx src/main.ts (scheduled jobs; applies migrations on boot)
# The repo-root .env is loaded into this process only. Logs go to logs\<service>-<date>.log.
param([Parameter(Mandatory)][ValidateSet('web', 'worker')][string]$Service)

$repo = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null

foreach ($line in Get-Content (Join-Path $repo '.env')) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    $v = $Matches[2].Trim()
    if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { $v = $v.Substring(1, $v.Length - 2) }
    [Environment]::SetEnvironmentVariable($Matches[1], $v, 'Process')
  }
}

if ($Service -eq 'web') {
  $env:NODE_ENV = 'production'
  $dir = Join-Path $repo 'apps\web'
  $cmd = 'npx next start -p 3000'
} else {
  $dir = Join-Path $repo 'apps\worker'
  $cmd = 'npx tsx src/main.ts'
}

while ($true) {
  $log = Join-Path $logDir ("$Service-" + (Get-Date -Format 'yyyy-MM-dd') + '.log')
  Add-Content $log "=== $(Get-Date -Format s) starting $Service ==="
  Push-Location $dir
  cmd /c "$cmd >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  Pop-Location
  Add-Content $log "=== $(Get-Date -Format s) $Service exited ($code), restarting in 30s ==="
  Start-Sleep -Seconds 30
}
