# Aura VS Code-Compatible Extension

This extension provides Aura editor support without LSP:

- Syntax highlighting
- `.aura` file icon
- Snippets for Aura syntax/features
- IntelliSense completions (keywords, builtins, snippets, collection methods, cadence clauses)
- Hover docs for Aura keywords
- Go to Definition / clickable import links for Aura modules (including `std.*` to `stdlib/`)

It also applies Aura-specific editor defaults so suggestions feel like a real language mode (not plain text word suggestions).

## Build VSIX

```powershell
cd C:\Users\wwwab\Development\AURA\editor\vscode
powershell -ExecutionPolicy Bypass -File .\scripts\build-vsix.ps1
```

Output:

- `C:\Users\wwwab\Development\AURA\editor\vscode\aura-lang-0.1.0.vsix`

For a full friend-install flow (CLI + PATH + extension), see `docs/INSTALL.md` and use `scripts/install-aura.ps1`.

## Install In IDEs

Any IDE that uses the VS Code extension host and supports VSIX install should work (for example VS Code, Cursor, Kiro, and similar builds).

Use one of these:

1. Command Palette: `Extensions: Install from VSIX...` and select `aura-lang-0.1.0.vsix`.
2. Extensions panel menu (`...`) -> `Install from VSIX...`.

If your IDE does not expose VSIX install or does not run VS Code extensions, completions/hover will not load there (syntax coloring may still work only if that IDE supports TextMate grammars separately).

## Enable Aura File Icon

1. Open Command Palette.
2. Run `File Icon Theme`.
3. Select `Aura File Icons`.

## Update Cycle

Whenever you change `src/extension.ts`, snippets, grammar, or icon assets:

1. Re-run `scripts/build-vsix.ps1`.
2. Reinstall the new VSIX in your IDE.
3. Reload the IDE window.

## IntelliSense Quality Notes

For Aura files, the extension defaults to:

- Word-based suggestions off.
- Language/snippet suggestions prioritized.
- 4-space indentation defaults.

If your IDE still shows noisy "recent words", check whether it overrides workspace/user settings for:

- `editor.wordBasedSuggestions`
- `editor.suggest.showWords`
