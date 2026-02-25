Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$compilerDir = Join-Path $repoRoot "compiler"
$editorDir = Join-Path $repoRoot "editor\vscode"
$releaseRoot = Join-Path $repoRoot "release"

$pkg = Get-Content -Raw -Path (Join-Path $compilerDir "package.json") | ConvertFrom-Json
$editorPkg = Get-Content -Raw -Path (Join-Path $editorDir "package.json") | ConvertFrom-Json
$version = [string]$pkg.version
$vsixName = ("{0}-{1}.vsix" -f [string]$editorPkg.name, [string]$editorPkg.version)
$bundleName = "aura-$version-windows-x64"
$bundleDir = Join-Path $releaseRoot $bundleName
$zipPath = Join-Path $releaseRoot "$bundleName.zip"

if (Test-Path $bundleDir) {
    Remove-Item -Recurse -Force $bundleDir
}
if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
}

New-Item -ItemType Directory -Path $bundleDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleDir "compiler") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleDir "editor\vscode") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleDir "scripts") | Out-Null

Write-Output "Building compiler ..."
Push-Location $compilerDir
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "Compiler build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

Write-Output "Building VSIX ..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $editorDir "scripts\build-vsix.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "VSIX build failed with exit code $LASTEXITCODE."
}

$copyList = @(
    @{ Src = (Join-Path $compilerDir "dist"); Dst = (Join-Path $bundleDir "compiler\dist") },
    @{ Src = (Join-Path $compilerDir "package.json"); Dst = (Join-Path $bundleDir "compiler\package.json") },
    @{ Src = (Join-Path $compilerDir "package-lock.json"); Dst = (Join-Path $bundleDir "compiler\package-lock.json") },
    @{ Src = (Join-Path $editorDir $vsixName); Dst = (Join-Path $bundleDir ("editor\vscode\" + $vsixName)) },
    @{ Src = (Join-Path $repoRoot "scripts\install-aura.ps1"); Dst = (Join-Path $bundleDir "scripts\install-aura.ps1") },
    @{ Src = (Join-Path $repoRoot "scripts\uninstall-aura.ps1"); Dst = (Join-Path $bundleDir "scripts\uninstall-aura.ps1") },
    @{ Src = (Join-Path $repoRoot "docs\INSTALL.md"); Dst = (Join-Path $bundleDir "INSTALL.md") }
)

foreach ($item in $copyList) {
    $src = $item.Src
    $dst = $item.Dst
    if (-not (Test-Path $src)) {
        throw "Missing required file: $src"
    }
    Copy-Item -Path $src -Destination $dst -Recurse -Force
}

Compress-Archive -Path (Join-Path $bundleDir "*") -DestinationPath $zipPath -Force
Write-Output "Release bundle created: $zipPath"
