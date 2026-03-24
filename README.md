# Aura

Aura is an audited, experimental programming language built as a creative R&D project to explore AI-assisted language design, expressive syntax, powerful native features, and the functionalities developers have always wanted, even before clearly naming them.

> Current status: experimental and for exploration. Not intended for production-critical systems.

[![CI](https://img.shields.io/github/actions/workflow/status/abderahmane-ai/aura/ci.yml?branch=main&label=CI)](https://github.com/abderahmane-ai/aura/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Language](https://img.shields.io/badge/language-Aura-1f6feb)](./docs/LANGUAGE.md)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](./docs/INSTALL.md)

## Why Aura

- Low-boilerplate syntax for complex tasks.
- Native data structures and advanced iteration primitives.
- Language ideas tested quickly through an auditable compiler + VM stack.
- Full playground repo with runnable examples and editor tooling.

Unsupported today: generics, `async`/`await`, `struct`, `actor`, `spawn`, and `select`.

## Signature Features

- `repeat`: counted loop with optional index alias.
- `cadence`: context-aware loop phases (`start`, `first`, `each`, `between`, `last`, `empty`).
- `facet` + `adopts` + `as`: context-scoped object capabilities.
- `constraint`: semantic validated types.
- `unit` + `measure`: dimensional/unit-aware values.
- `indexed`: in-memory collection with automatic key indexes.
- `math` module: complete classical math + practical helpers + twists (`math.balance`, `math.exact`, `math.scale`).
- Native collections: `Stack`, `Queue`, `LinkedList`, `HashMap`, `TreeMap`, `Heap`.
- Practical stdlib MVP modules: `std.io`, `std.fs`, `std.json`, `std.time`, `std.collections`, `std.test`, `std.schema`.

## Repository Layout

- `compiler/`: lexer, parser, resolver, compiler, VM, CLI (`aura`, `aurac`)
- `stdlib/`: standard Aura modules (`std.math`, `std.io`, `std.fs`, `std.json`, `std.time`, `std.collections`, `std.test`, `std.schema`)
- `editor/vscode/`: syntax highlighting, snippets, icon theme, non-LSP IntelliSense
- `examples/`: language demos by topic
- `docs/`: install, language reference, tooling, roadmap
- `scripts/`: local install/uninstall/release helper scripts

## Quick Start

```powershell
git clone https://github.com/abderahmane-ai/aura.git
cd AURA
powershell -ExecutionPolicy Bypass -File .\scripts\install-aura.ps1
```

Run your first Aura file:

```powershell
aura --version
aura .\examples\data_types.aura
```

## Editor Experience

Aura ships a VS Code-compatible extension with:

- Syntax highlighting
- File icon
- Snippets
- Hover docs
- IntelliSense completions (no LSP required)

The installer tries to install the VSIX automatically when an editor CLI is available (`code`, `cursor`, `kiro`, `codium`, `windsurf`, `antigravity`).

## Code Example

```aura
constraint Price(value: Float64):
    require value >= 0
    require value < 1_000_000

unit Time:
    base: ms
    sec = ms * 1000

fn main():
    let timeout: measure Time = 5sec
    indexed users by id, email
    users.push({"id": 1, "email": "dev@test.com", "name": "Ada"})

    cadence u in users.to_list():
        each:
            let username = u["name"]
            io.println("user={username}")
        empty:
            io.println("No users")
```

## Documentation

- [Install Guide](./docs/INSTALL.md)
- [Language Reference](./docs/LANGUAGE.md)
- [Tooling](./docs/TOOLING.md)
- [Roadmap](./docs/ROADMAP.md)

## Quality Gates

```powershell
cd .\compiler
npm run check:strict
npm run test
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).

