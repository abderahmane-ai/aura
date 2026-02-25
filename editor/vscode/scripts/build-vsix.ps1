Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$tscPath = Join-Path $root "..\..\compiler\node_modules\typescript\bin\tsc"
if (-not (Test-Path $tscPath)) {
    throw "TypeScript compiler is missing at $tscPath. Run npm install in compiler/ first."
}

Write-Output "Compiling extension TypeScript..."
& node $tscPath -p "tsconfig.json"
if ($LASTEXITCODE -ne 0) {
    throw "TypeScript compilation failed with exit code $LASTEXITCODE."
}

$pkg = Get-Content -Raw -Path "package.json" | ConvertFrom-Json
$publisher = [string]$pkg.publisher
$name = [string]$pkg.name
$version = [string]$pkg.version
$displayName = [string]$pkg.displayName
$description = [string]$pkg.description
$categories = if ($pkg.categories) { ([string[]]$pkg.categories) -join "," } else { "Programming Languages" }
$iconPath = if ($pkg.icon) { [string]$pkg.icon } else { "" }
$license = if ($pkg.license) { [string]$pkg.license } else { "" }

$vsixName = "$name-$version.vsix"
$buildDir = Join-Path $root ".vsix-build"
$extDir = Join-Path $buildDir "extension"

if (Test-Path $buildDir) {
    Remove-Item -Recurse -Force $buildDir
}
New-Item -ItemType Directory -Path $extDir | Out-Null

# Copy extension payload.
$pathsToCopy = @(
    "package.json",
    "README.md",
    "language-configuration.json",
    "icon-theme.json",
    "out",
    "syntaxes",
    "snippets",
    "images"
)
foreach ($p in $pathsToCopy) {
    if (Test-Path $p) {
        Copy-Item -Recurse -Force $p (Join-Path $extDir $p)
    }
}

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$publisher.$name" Version="$version" Publisher="$publisher" />
    <DisplayName>$displayName</DisplayName>
    <Description xml:space="preserve">$description</Description>
    <Categories>$categories</Categories>
    <Icon>$iconPath</Icon>
    <License>$license</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"@
$manifest | Out-File -LiteralPath (Join-Path $buildDir "extension.vsixmanifest") -Encoding utf8

$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
"@
$contentTypes | Out-File -LiteralPath (Join-Path $buildDir "[Content_Types].xml") -Encoding utf8

$zipPath = Join-Path $root "$vsixName.zip"
$vsixPath = Join-Path $root $vsixName

if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
if (Test-Path $vsixPath) { Remove-Item -Force $vsixPath }

Push-Location $buildDir
try {
    Compress-Archive -Path * -DestinationPath $zipPath -Force
}
finally {
    Pop-Location
}

Move-Item -Path $zipPath -Destination $vsixPath -Force
Write-Output "Built $vsixPath"
