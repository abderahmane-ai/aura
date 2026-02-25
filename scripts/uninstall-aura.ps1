Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Output "Uninstalling Aura CLI from global npm ..."
& npm uninstall -g aurac
if ($LASTEXITCODE -ne 0) {
    Write-Warning "npm uninstall returned exit code $LASTEXITCODE. Aura may already be removed."
}

Write-Output "Done. If needed, remove Aura VSIX from your IDE extension manager."
