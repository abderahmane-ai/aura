param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Normalize-Text {
    param([string]$Text)
    if ($null -eq $Text) { return "" }
    $t = $Text -replace "`r`n", "`n"
    $t = $t -replace "`r", "`n"
    return $t.TrimEnd()
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$compilerDir = Join-Path $repoRoot "compiler"
$cli = Join-Path $compilerDir "dist/main.js"
$suiteRoot = Join-Path $repoRoot "tests/conformance"

if (-not $SkipBuild) {
    Push-Location $compilerDir
    try {
        npm run build | Out-Null
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $cli)) {
    Write-Error "Compiler CLI not found at $cli"
}

$failed = $false
$total = 0

function Invoke-Aura {
    param(
        [ValidateSet("check", "run")]
        [string]$Mode,
        [string]$File
    )
    $tmpOut = [System.IO.Path]::GetTempFileName()
    $tmpErr = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath "node" -ArgumentList @($cli, $Mode, $File) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
    $stdout = if (Test-Path $tmpOut) { Get-Content -Path $tmpOut -Raw } else { "" }
    $stderr = if (Test-Path $tmpErr) { Get-Content -Path $tmpErr -Raw } else { "" }
    Remove-Item -Path $tmpOut, $tmpErr -ErrorAction SilentlyContinue
    $exit = $proc.ExitCode
    $text = "$stdout`n$stderr"
    return @{
        ExitCode = $exit
        Output = (Normalize-Text $text)
    }
}

function Report-Pass {
    param([string]$Name)
    Write-Host "[PASS] $Name" -ForegroundColor Green
}

function Report-Fail {
    param([string]$Name, [string]$Message)
    Write-Host "[FAIL] $Name" -ForegroundColor Red
    Write-Host "  $Message"
    $script:failed = $true
}

# Pass (check-only)
$passDir = Join-Path $suiteRoot "pass"
if (Test-Path $passDir) {
    Get-ChildItem -Path $passDir -Filter *.aura | Sort-Object Name | ForEach-Object {
        $total++
        $name = "pass/$($_.Name)"
        $res = Invoke-Aura -Mode "check" -File $_.FullName
        if ($res.ExitCode -eq 0) {
            Report-Pass $name
        } else {
            Report-Fail $name "Expected check success, got exit code $($res.ExitCode). Output: $($res.Output)"
        }
    }
}

# Run with golden output
$runDir = Join-Path $suiteRoot "run"
if (Test-Path $runDir) {
    Get-ChildItem -Path $runDir -Filter *.aura | Sort-Object Name | ForEach-Object {
        $total++
        $name = "run/$($_.Name)"
        $expectedFile = Join-Path $_.Directory.FullName ($_.BaseName + ".out")
        if (-not (Test-Path $expectedFile)) {
            Report-Fail $name "Missing expected output file: $expectedFile"
            return
        }

        $expected = Normalize-Text (Get-Content -Path $expectedFile -Raw)
        $res = Invoke-Aura -Mode "run" -File $_.FullName
        if ($res.ExitCode -ne 0) {
            Report-Fail $name "Expected run success, got exit code $($res.ExitCode). Output: $($res.Output)"
            return
        }
        if ($res.Output -ne $expected) {
            Report-Fail $name "Output mismatch.`nExpected:`n$expected`nActual:`n$($res.Output)"
            return
        }
        Report-Pass $name
    }
}

function Run-FailureSuite {
    param(
        [string]$Dir,
        [ValidateSet("check", "run")]
        [string]$Mode
    )
    if (-not (Test-Path $Dir)) { return }

    Get-ChildItem -Path $Dir -Filter *.aura | Sort-Object Name | ForEach-Object {
        $script:total++
        $name = "$Mode-fail/$($_.Name)"
        $expectedFile = Join-Path $_.Directory.FullName ($_.BaseName + ".err")
        if (-not (Test-Path $expectedFile)) {
            Report-Fail $name "Missing expected error file: $expectedFile"
            return
        }
        $needle = Normalize-Text (Get-Content -Path $expectedFile -Raw)
        $res = Invoke-Aura -Mode $Mode -File $_.FullName
        if ($res.ExitCode -eq 0) {
            Report-Fail $name "Expected failure, but command succeeded"
            return
        }
        if (-not $res.Output.Contains($needle)) {
            Report-Fail $name "Error output did not contain expected text.`nExpected snippet:`n$needle`nActual:`n$($res.Output)"
            return
        }
        Report-Pass $name
    }
}

Run-FailureSuite -Dir (Join-Path $suiteRoot "fail_check") -Mode "check"
Run-FailureSuite -Dir (Join-Path $suiteRoot "fail_run") -Mode "run"

Write-Host ""
Write-Host "Conformance tests run: $total"
if ($failed) {
    Write-Host "Conformance result: FAILED" -ForegroundColor Red
    exit 1
}
Write-Host "Conformance result: PASSED" -ForegroundColor Green
exit 0
