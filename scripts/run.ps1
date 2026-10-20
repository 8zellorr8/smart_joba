param(
    [Parameter(Position=0)]
    [ValidateSet('setup','start','stop','status','test','database')]
    [string]$Action = 'start',
    [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonCandidates = @(
    (Join-Path $projectRoot '.venv\Scripts\python.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
)
$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
if ($pythonCommand) { $pythonCandidates += $pythonCommand.Source }
$projectPython = $null
foreach ($candidate in $pythonCandidates) {
    if (Test-Path -LiteralPath $candidate) {
        & $candidate -c 'import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)' 2>$null
        if ($LASTEXITCODE -eq 0) { $projectPython = $candidate; break }
    }
}
if (-not $projectPython) { throw 'Python 3.12+ is required.' }
$runnerArgs = @((Join-Path $PSScriptRoot 'dev.py'), $Action)
if ($SkipInstall) { $runnerArgs += '--skip-install' }
& $projectPython @runnerArgs
exit $LASTEXITCODE
