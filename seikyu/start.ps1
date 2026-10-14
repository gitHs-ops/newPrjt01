[CmdletBinding()]
param([string]$Java = 'java')
$ErrorActionPreference = 'Stop'
if (-not $env:APLINK_ADMIN_PASSWORD -or $env:APLINK_ADMIN_PASSWORD.Length -lt 16) {
    throw 'Set APLINK_ADMIN_PASSWORD to at least 16 characters before starting.'
}
Push-Location $PSScriptRoot
try {
    $jar = Join-Path $PSScriptRoot 'seikyu-1.0.0-SNAPSHOT.jar'
    if (-not (Test-Path -LiteralPath $jar)) { $jar = Join-Path $PSScriptRoot 'target\seikyu-1.0.0-SNAPSHOT.jar' }
    if (-not (Test-Path -LiteralPath $jar)) { throw 'Build the JAR with mvn verify first.' }
    & $Java -jar $jar
    if ($LASTEXITCODE -ne 0) { throw 'Application exited with an error.' }
} finally { Pop-Location }
