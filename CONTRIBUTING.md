# Contributing

## Local Setup

```powershell
cd compiler
npm ci
npm run build
```

## Validate Changes

```powershell
cd compiler
npm run check:all
```

Build editor extension:

```powershell
cd ..\editor\vscode
powershell -ExecutionPolicy Bypass -File .\scripts\build-vsix.ps1
```

## Pull Request Expectations

- Keep changes scoped and documented.
- Update `docs/` and `examples/` when language behavior changes.
- Include at least one runnable example for new syntax/runtime features.
