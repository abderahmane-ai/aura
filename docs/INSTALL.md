# Aura Install Guide

This guide is for sharing Aura with friends so they can run `aura file.aura` immediately and get editor support.

## Prerequisites

- Node.js 20+ (includes npm)
- A VS Code-compatible IDE for extension support (VS Code, Cursor, Kiro, etc.)

## Option A: Install From A Source/Zip Checkout

If your friend has a checkout (or zip) of this repository:

```powershell
cd <AURA_ROOT>
powershell -ExecutionPolicy Bypass -File .\scripts\install-aura.ps1
```

What this does:

- Installs Aura CLI globally (`aura`, `aurac`) using npm.
- Ensures npm global bin is on user `PATH`.
- Installs the Aura VSIX into detected editor CLIs (`code`, `cursor`, `kiro`, `codium`, `windsurf`, `antigravity`) when available.

Verify:

```powershell
aura --version
aura .\examples\data_types.aura
```

## Option B: Share A Ready Release Bundle

From your machine:

```powershell
cd <AURA_ROOT>
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
```

This creates:

- `release\aura-<version>-windows-x64.zip`

Your friend extracts the zip and runs:

```powershell
cd <EXTRACTED_FOLDER>
powershell -ExecutionPolicy Bypass -File .\scripts\install-aura.ps1
```

## Manual VSIX Install (Fallback)

If editor CLI auto-install did not run:

1. Open your IDE.
2. Command Palette -> `Extensions: Install from VSIX...`
3. Select the VSIX generated in `editor\vscode` (for example `aura-lang-0.1.0.vsix`).
4. Reload window.

## Uninstall

```powershell
cd <AURA_ROOT>
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-aura.ps1
```
