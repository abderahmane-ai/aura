param(
    [switch]$SkipCli,
    [switch]$SkipEditor,
    [string[]]$EditorCli = @("code", "cursor", "kiro", "codium", "windsurf", "antigravity")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$compilerDir = Join-Path $repoRoot "compiler"
$editorDir = Join-Path $repoRoot "editor\vscode"
$buildVsixScript = Join-Path $editorDir "scripts\build-vsix.ps1"
$vsixPath = ""

function Assert-Command {
    param([Parameter(Mandatory = $true)][string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Required command '$Name' is missing from PATH."
    }
}

function Get-NpmGlobalBin {
    $prefix = (& npm config get prefix).Trim()
    if (-not $prefix) {
        throw "Unable to determine npm global prefix."
    }
    if ($IsWindows) {
        return $prefix
    }
    return (Join-Path $prefix "bin")
}

function Ensure-UserPathContains {
    param([Parameter(Mandatory = $true)][string]$PathToAdd)

    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $currentUserPath) {
        $currentUserPath = ""
    }

    $parts = $currentUserPath -split ";" | Where-Object { $_ -ne "" }
    if ($parts -contains $PathToAdd) {
        return
    }

    $newUserPath = if ($currentUserPath) { "$currentUserPath;$PathToAdd" } else { $PathToAdd }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")

    if (-not (($env:Path -split ";") -contains $PathToAdd)) {
        $env:Path = "$env:Path;$PathToAdd"
    }
}

function Install-Cli {
    Ensure-CompilerBuilt
    Write-Output "Installing Aura CLI globally from $compilerDir ..."
    & npm install -g $compilerDir
    if ($LASTEXITCODE -ne 0) {
        throw "npm global install failed with exit code $LASTEXITCODE."
    }

    $npmGlobalBin = Get-NpmGlobalBin
    Ensure-UserPathContains -PathToAdd $npmGlobalBin

    $auraCmd = Get-Command aura -ErrorAction SilentlyContinue
    if (-not $auraCmd) {
        throw "Aura CLI installed, but 'aura' is still not resolvable. Restart shell and run: aura --version"
    }

    $version = & aura --version
    Write-Output "Aura CLI installed successfully. Version: $version"
}

function Ensure-CompilerBuilt {
    $tscPath = Join-Path $compilerDir "node_modules\typescript\bin\tsc"
    if (-not (Test-Path $tscPath)) {
        Write-Output "Installing compiler dependencies ..."
        Push-Location $compilerDir
        try {
            if (Test-Path (Join-Path $compilerDir "package-lock.json")) {
                & npm ci
            } else {
                & npm install
            }
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to install compiler dependencies (exit code: $LASTEXITCODE)."
            }
        }
        finally {
            Pop-Location
        }
    }

    $distMain = Join-Path $compilerDir "dist\main.js"
    if (-not (Test-Path $distMain)) {
        Write-Output "Building Aura compiler ..."
        Push-Location $compilerDir
        try {
            & npm run build
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to build compiler (exit code: $LASTEXITCODE)."
            }
        }
        finally {
            Pop-Location
        }
    }
}

function Ensure-Vsix {
    Ensure-CompilerBuilt

    if (-not $script:vsixPath) {
        $pkgPath = Join-Path $editorDir "package.json"
        if (Test-Path $pkgPath) {
            $editorPkg = Get-Content -Raw -Path $pkgPath | ConvertFrom-Json
            $candidate = Join-Path $editorDir ("{0}-{1}.vsix" -f [string]$editorPkg.name, [string]$editorPkg.version)
            if (Test-Path $candidate) {
                $script:vsixPath = $candidate
                return
            }
        }

        $anyVsix = Get-ChildItem -Path $editorDir -Filter *.vsix -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($anyVsix) {
            $script:vsixPath = $anyVsix.FullName
            return
        }
    }

    if (-not (Test-Path $buildVsixScript)) {
        throw "VSIX is unavailable and build script is missing at $buildVsixScript"
    }

    Write-Output "VSIX unavailable. Building Aura VSIX ..."
    & powershell -ExecutionPolicy Bypass -File $buildVsixScript
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to build VSIX. Exit code: $LASTEXITCODE"
    }

    $builtVsix = Get-ChildItem -Path $editorDir -Filter *.vsix -File | Select-Object -First 1
    if (-not $builtVsix) {
        throw "VSIX build completed but no VSIX was found in $editorDir"
    }
    $script:vsixPath = $builtVsix.FullName
}

function Install-EditorExtension {
    Ensure-Vsix
    $installedIn = @()
    foreach ($cli in $EditorCli) {
        $cmd = Get-Command $cli -ErrorAction SilentlyContinue
        if (-not $cmd) {
            continue
        }

        Write-Output "Installing Aura extension via '$cli' ..."
        & $cli --install-extension $vsixPath --force
        if ($LASTEXITCODE -eq 0) {
            $installedIn += $cli
        } else {
            Write-Warning "Failed to install extension with '$cli' (exit code: $LASTEXITCODE)."
        }
    }

    if ($installedIn.Count -eq 0) {
        Write-Warning "No supported editor CLI found in PATH. Install VSIX manually: $vsixPath"
        return
    }

    Write-Output ("Aura extension installed in: " + ($installedIn -join ", "))
}

Assert-Command -Name "npm"
Assert-Command -Name "node"

if (-not $SkipCli) {
    Install-Cli
}

if (-not $SkipEditor) {
    Install-EditorExtension
}

Write-Output "Done. Open a new terminal and test: aura --version"
