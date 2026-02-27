# Aura Core Stabilization + Practical Stdlib Plan

This plan is execution-focused and tied to the current repository state.

## Track A: Stabilize The Core

### A1. Conformance Suite (implemented)
- Added `tests/conformance` with:
- `run/` golden-output feature tests
- `pass/` check-only parser/type-surface tests
- `fail_check/` expected compiler/parser failures
- `fail_run/` expected runtime failures
- Added runner: `scripts/run-conformance.ps1`

### A2. Strict Regression Gates (implemented)
- Added compiler scripts:
- `npm run check:conformance`
- `npm run check:strict` (`check:all` + conformance)
- CI now runs strict checks before VSIX build.

### A3. Growth Rule (next)
- Every new language feature must ship with:
- one positive run test
- one edge-case test
- one failure-mode test when applicable

## Track B: Useful App Stdlib

### B1. Host Primitives (implemented)
- Added runtime builtins for:
- JSON: `__json_parse`, `__json_stringify`
- FS: `__fs_exists`, `__fs_read`, `__fs_write`, `__fs_append`, `__fs_delete`, `__fs_mkdir`, `__fs_list`, `__fs_stat`
- Time: `__time_now_ms`, `__time_iso_now`, `__time_sleep_ms`, `__time_parse_iso`, `__time_from_unix_ms`

### B2. Std Modules (implemented)
- `stdlib/io.aura`
- `stdlib/fs.aura`
- `stdlib/json.aura`
- `stdlib/time.aura`
- `stdlib/collections.aura`

### B3. Stdlib Conformance (implemented)
- Added `tests/conformance/run/07_stdlib_core.aura`

## Execution Commands

From `compiler/`:

```powershell
npm run check:strict
```

From repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-conformance.ps1
```

## Next Priorities

1. Add `std.fs` path helpers (`join`, `basename`, `dirname`) and test them.
2. Expand `std.fs` and `std.json` interoperability helpers for larger project workflows.
3. Expand conformance coverage for parser edge-cases and module import cycles.
