# Run the whole Bara data pipeline in order, stopping at the first failure.
#   .\pipeline\run_all.ps1                     # development: includes unverified districts
#   .\pipeline\run_all.ps1 -Production         # verified districts only, then the production check
param([switch]$Production)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$py = Join-Path $root 'pipeline\.venv\Scripts\python.exe'

$steps = @(
    @('acquire.py'),
    @('clean.py'),
    @('aggregate.py'),
    @('harmonize.py'),
    $(if ($Production) { @('export.py') } else { @('export.py', '--allow-unverified') })
)
if ($Production) { $steps += , @('validate.py', '--production') }

foreach ($step in $steps) {
    Write-Host "`n=== $($step -join ' ')  ($(Get-Date -Format HH:mm:ss))"
    & $py (Join-Path 'pipeline' $step[0]) @($step | Select-Object -Skip 1)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n=== STOPPED: $($step[0]) failed (exit $LASTEXITCODE). Fix the error above, then run this again; finished downloads are kept."
        exit $LASTEXITCODE
    }
}
Write-Host "`n=== ALL DONE ($(Get-Date -Format HH:mm:ss)). Open http://localhost:8765/index.html after: cd site; python -m http.server 8765"
