# Aura Language Roadmap

> Prioritized plan to complete half-baked features and stabilize the language.

**Current Version:** 0.1.0 (MVP)
**Target Version:** 0.2.0 (Stable)
**Language Status:** Production-ready for ML/Data work; async features are aspirational.

---

## Priority Matrix

| Priority | Feature | Effort | Impact | Status |
|----------|---------|--------|--------|--------|
| P0 | Generics `<T>` | High | High | Parsed only |
| P1 | `struct` value types | Medium | Medium | Not parsed |
| P2 | Remove dead keywords | Low | Low | Cleanup |
| P3 | `async`/`await` | Very High | High | Not parsed |
| P4 | `actor` model | Very High | High | Not parsed |
| P5 | Weak references | Medium | Low | Spec only |

---

## P0: Generics (High Priority)

### Current State
- Parser consumes `<T>` syntax but discards it
- No runtime type parameterization

### What to Implement
```aura
# Target syntax
class Stack<T>:
    var items: List<T> = []

    fn push(item: T):
        self.items.append(item)

    fn pop() -> T?:
        return self.items.pop()

fn first<T>(items: List<T>) -> T?:
    return items.len() > 0 ? items[0] : nil
```

### Implementation Steps

1. **Phase 1: Type Parameter Storage**
   - Store generic params in class/function AST nodes
   - Add `typeParams: string[]` to ClassDecl, FnDecl

2. **Phase 2: Type Checking**
   - Verify type arguments satisfy constraints
   - Support `T: Trait` bounds

3. **Phase 3: Monomorphization or Boxing**
   - Option A: Generate specialized code per type (fast, more code)
   - Option B: Runtime type tagging (slower, less code)

4. **Phase 4: Instantiation**
   - Handle generic method calls with type args

### Files to Modify
- `compiler/src/parser.ts` — Store type params in AST
- `compiler/src/resolver.ts` — Type param validation
- `compiler/src/compiler.ts` — Code generation
- `compiler/src/vm.ts` — Optional: boxed generic values

---

## P1: `struct` Value Types (Medium Priority)

### Current State
- Token `STRUCT` exists in lexer (line 13)
- No parsing logic — will error if used

### What to Implement
```aura
struct Point:
    let x: Float64
    let y: Float64

    fn distance_to(other: Point) -> Float64:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2).sqrt()

fn main():
    let p1 = Point(1.0, 2.0)
    let p2 = Point(3.0, 4.0)

    # Copy semantics (not reference)
    let p3 = p1  # copies the values
    p3.x = 10    # p1.x still 1.0
```

### Implementation Steps

1. **Phase 1: Parsing**
   - Add `parseStructDecl()` in parser.ts
   - Similar to class but immutable fields by default

2. **Phase 2: Compiler**
   - Emit different bytecode for struct vs class
   - Use copy operations instead of reference

3. **Phase 3: VM**
   - Add struct instantiation
   - Handle struct field access with copy semantics

### Key Difference from Class
| Aspect | Class | Struct |
|--------|-------|--------|
| Allocation | Heap (reference) | Stack or inline |
| Assignment | Copies reference | Copies values |
| Mutability | `var` fields | Immutable by default |
| Identity | `==` compares references | `==` compares values |

---

## P2: Remove Dead Keywords (Low Priority — Cleanup)

### Current State
These keywords exist in lexer but have no parsing:

| Keyword | Lines in lexer.ts | Action |
|---------|-------------------|--------|
| `struct` | 13 | Implement or remove |
| `actor` | 14 | Remove (future feature) |
| `spawn` | 17 | Remove (tied to async) |
| `select` | 17 | Remove (tied to async) |

### Recommended Actions

**Option A: Remove for 0.2.0**
```typescript
// Remove these from KEYWORDS in lexer.ts:
// struct: 'STRUCT',
// actor: 'ACTOR',
// spawn: 'SPAWN',
// select: 'SELECT',
```

**Option B: Keep with deprecation warning**
- Keep in lexer but emit warning if used

### Recommendation
Remove all async-related keywords (`spawn`, `select`) since async is not planned for 0.2.0.
Keep `struct` for P1 implementation.
Remove `actor` (too ambitious for near-term).

---

## P3: `async`/`await` (Very High Priority — Long Term)

### Current State
- Token exists in lexer (line 17)
- No parsing, no runtime

### Scope
This is a major feature requiring:
- [ ] Async runtime (event loop, task queue)
- [ ] `async fn` parsing and compilation
- [ ] `await` expression desugaring
- [ ] Task spawning and joining
- [ ] Promise/Future type
- [ ] Concurrent I/O (non-blocking file, network)

### Estimated Effort
- 2-4 months for basic implementation
- Full async I/O: 6+ months

### For Now: Document as Future Feature
Add to docs that async/await is **planned for version 0.3.0**.

---

## P4: `actor` Model (Very High Priority — Long Term)

### Current State
- Keyword exists in lexer
- No parsing, no runtime

### What It Would Look Like
```aura
actor Counter:
    var count: Int = 0

    fn increment():
        self.count += 1

    fn get() -> Int:
        return self.count
```

### Scope
- Message passing between actors
- Actor mailbox/queue
- Thread safety guarantees
- Actor supervision

### Recommendation
Defer to version 0.4.0+ — requires major runtime changes.

---

## P5: Weak References (Low Priority)

### Current State
- Not in lexer at all
- Only in SPEC.md aspirational docs

### What It Would Look Like
```aura
class Node:
    var value: Int
    var next: Node? = nil
    weak var parent: Node? = nil  # does not retain
```

### Implementation
- Requires reference counting in VM
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