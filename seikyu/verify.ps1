[CmdletBinding()]
param([string]$Maven = 'mvn')
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & $Maven verify
    if ($LASTEXITCODE -ne 0) { throw 'Java verification failed' }
    $jar = Join-Path $PSScriptRoot 'target\seikyu-1.0.0-SNAPSHOT.jar'
    if (-not (Test-Path -LiteralPath $jar)) { throw 'Build artifact missing' }
    Get-FileHash -LiteralPath $jar -Algorithm SHA256
} finally { Pop-Location }
