# Aura Roadmap

> Near-term work for the implemented Aura surface.

**Current Version:** 0.1.0
**Status:** Experimental with a stable implemented core

## Current Baseline

Aura currently supports:

- Core expressions, control flow, functions, classes, interfaces, traits, enums, and pattern matching
- Aura-specific constructs such as `repeat`, `cadence`, `facet`/`adopts`, `constraint`, `unit`, and `indexed`
- The current `std.data`, `std.tensor`, `std.optim`, and `std.ml` stack

Aura does **not** currently support:

- Generics
- `async` / `await`
- `spawn` / `select`
- `struct`
- `actor`

Those features are intentionally absent from the supported syntax until they have complete parser, compiler, runtime, and test coverage.

## Near-Term Priorities

1. VM and compiler performance
2. Stronger diagnostics and error consistency
3. Stdlib cleanup and documentation depth
4. ML stack hardening, metrics, and model coverage
5. Tooling polish for the VS Code extension and CLI

## Feature Admission Policy

New syntax should land only when all of the following exist together:

- Parser support
- Resolver/compiler support
- VM/runtime behavior
- Conformance coverage
- Documentation

Aura avoids exposing placeholder syntax that only partially works.
- Track weak references separately
- Clear when target is deallocated

### Recommendation
Defer — not critical for MVP. Add when ARC is implemented.

---

## Implementation Order

```
Phase 1 (Week 1-2): Cleanup
├── Remove dead keywords (spawn, select)
├── Add error messages for unimplemented features
└── Update lexer.ts

Phase 2 (Week 3-6): Generics
├── Store type params in AST
├── Add basic type checking
├── Support List<T>, Map<K,V>
└── Test with existing stdlib

Phase 3 (Week 7-10): struct
├── Parse struct declarations
├── Compiler: copy semantics
├── VM: struct instantiation
└── Add to stdlib where appropriate

Phase 4 (Future): async/actor
├── Design async runtime
├── Implement task queue
├── Add async/await parsing
└── Network I/O support
```

---

## Files Reference

### Must Modify

| File | Purpose |
|------|---------|
| `compiler/src/lexer.ts` | Remove dead keywords |
| `compiler/src/parser.ts` | Add struct, generics parsing |
| `compiler/src/compiler.ts` | Generate code for new features |
| `compiler/src/vm.ts` | Runtime support |
| `docs/LANGUAGE.md` | Document completed features |

### May Modify

| File | Purpose |
|------|---------|
| `compiler/src/resolver.ts` | Type checking for generics |
| `compiler/src/types.ts` | Type representations |

---

## Success Criteria for 0.2.0

- [ ] Generics work for classes and functions
- [ ] `struct` is parseable and works correctly
- [ ] Dead keywords removed or produce clear errors
- [ ] All MVP features are stable
- [ ] Documentation matches implementation
- [ ] Test suite passes

---

## Future: Version 0.3.0+

- Async/await basic implementation
- Network I/O
- More efficient bytecode (current is interpreter)

---

**End of Roadmap**
