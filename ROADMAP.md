# Aura Language Roadmap

> Implementation roadmap for completing half-baked features and reaching production-ready status.

**Current Version:** 0.1.0 (MVP)
**Target Version:** 0.2.0 (Production)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Phase 1: Low-Hanging Fruit](#2-phase-1-low-hanging-fruit)
3. [Phase 2: Generics System](#3-phase-2-generics-system)
4. [Phase 3: Async Concurrency](#4-phase-3-async-concurrency)
5. [Phase 5: Value Types](#5-phase-5-value-types)
6. [Timeline Estimates](#6-timeline-estimates)
7. [Priority Order](#7-priority-order)

---

## 1. Overview

### Current State

| Category | Count | Status |
|----------|-------|--------|
| Fully Working | ~35 features | ✅ Production |
| Half-Baked | 8 features | ⚠️ Needs Work |
| Missing | 7 features | ❌ Not Started |

### Features Requiring Attention

```
HALF-BAKED (Parser exists, runtime incomplete):
├── Generics <T>     - Parsed but ignored
├── async/await     - Token only, no runtime
├── spawn           - Keyword only
└── select          - Keyword only

STUBBED (Lexer only, no parser):
├── struct          - Keyword only
└── actor           - Keyword only
```

---

## 2. Phase 1: Low-Hanging Fruit

Quick wins — remove or complete features with minimal effort.

### 2.1 Remove Stub Keywords (Priority: HIGH)

If not planned for 0.2.0, remove these from lexer to avoid confusion:

```typescript
// compiler/src/lexer.ts — Remove these lines:
struct: 'STRUCT',
actor: 'ACTOR',
```

**Action:** Either implement or remove. Recommend **removing** if not on roadmap.

### 2.2 Complete Generics Skeleton (Priority: HIGH)

Currently parser skips generic params. Either:

**Option A: Remove** (if not planning to implement)
```typescript
// Remove from parser.ts line 461, 501-512, 631
// This removes <T> syntax parsing
```

**Option B: Complete** (if planning full generics)

Required work:
1. Store type params in `ClassDecl` and `FnDecl` AST nodes
2. Add type parameter scope for function body
3. Substitute type params when instantiating
4. Add constraint syntax: `fn foo<T: Clone>`

**Recommended:** Option A (remove) for 0.2.0. Full generics is a 0.3.0 feature.

---

## 3. Phase 2: Async Concurrency

This is the biggest feature set. Full async/await with structured concurrency.

### 3.1 Architecture

```
async fn fetch(url) -> String:
    let response = await http.get(url)
    return response.body()
```

Requires:
- Async function parsing
- Await expression handling
- Task/future runtime
- Event loop in VM

### 3.2 Implementation Steps

#### Step 1: Async Function Parsing

```typescript
// compiler/src/parser.ts

// Modify parseFnDecl to handle async
private parseFnDecl(isTopLevel: boolean): FnDecl {
    const isAsync = this.check('ASYNC');
    if (isAsync) this.advance();

    this.expect('FN');
    // ... rest of parsing

    return {
        isAsync,
        // ...
    };
}
```

#### Step 2: Await Expression

```typescript
// Parse await in expressions
private parseAwaitExpr(): ASTNode {
    this.expect('AWAIT');
    const value = this.parseUnary();
    return { kind: 'AwaitExpr', value, line: this.currentLine };
}
```

#### Step 3: Compiler Changes

```typescript
// compiler/src/compiler.ts

// Generate different bytecode for async functions
case 'FnDecl': {
    if (node.isAsync) {
        // Generate async function prologue
        return this.compileAsyncFn(node);
    }
    // existing logic
}
```

#### Step 4: VM Runtime

```typescript
// compiler/src/vm.ts

// Add task/await support
private asyncStep(task: Task, expectedId: number): Value {
    // Check if task completed
    // If not, yield to event loop
}

// Add event loop
private runEventLoop(): void {
    while (this.pendingTasks.length > 0) {
        const ready = this.pendingTasks.filter(t => t.isReady());
        for (const task of ready) {
            this.resumeTask(task);
        }
    }
}
```

### 3.3 Spawn and Select

**spawn** — Launch concurrent task:
```aura
async fn main():
    spawn fetch_data()      # fire-and-forget
    spawn process_queue()  # background processing
```

**select** — Wait on multiple futures:
```aura
select:
    case result = await channel.receive():
        io.println(result)
    case await timer.after(5000):
        io.println("timeout")
```

### 3.4 Files to Modify

| File | Changes |
|------|---------|
| `compiler/src/lexer.ts` | ✅ Already has tokens |
| `compiler/src/parser.ts` | Add async fn parsing, await expr |
| `compiler/src/types.ts` | Add AsyncFnDecl, AwaitExpr types |
| `compiler/src/compiler.ts` | Generate async bytecode |
| `compiler/src/vm.ts` | Add Task, Future, event loop |

### 3.5 Complexity: HIGH

```
Time Estimate: 2-3 weeks
Risk: High (affects core runtime)
Dependencies: None (can implement standalone)
```

---

## 4. Phase 3: Value Types (struct)

### 4.1 Why struct?

struct = value types (copied on assignment)
class = reference types (ARC-managed)

```aura
struct Point:
    let x: Float64
    let y: Float64

fn main():
    let p1 = Point(1, 2)
    let p2 = p1      # COPY, not reference
    p2.x = 10
    io.println(p1.x)  # Still 1!
```

### 4.2 Implementation

#### Step 1: Parser

```typescript
// compiler/src/parser.ts

private parseStructDecl(): StructDecl {
    this.expect('STRUCT');
    const name = this.expectIdent();
    this.expect('COLON');
    // Parse fields similar to class
    // But no init(), methods optional
}
```

#### Step 2: Compiler

```typescript
// When generating assignment for struct:
// - Copy all fields (deep clone)
// - Don't create reference wrapper
```

#### Step 3: VM

```typescript
// Add value type handling
case 'struct': {
    // Deep clone on assignment
    const copy = deepClone(value);
    stack.push(copy);
    break;
}
```

### 4.3 Files to Modify

| File | Changes |
|------|---------|
| `compiler/src/parser.ts` | Add parseStructDecl |
| `compiler/src/types.ts` | Add StructDecl, StructInstance |
| `compiler/src/compiler.ts` | Generate struct bytecode |
| `compiler/src/vm.ts` | Add struct instance handling |

### 4.4 Complexity: MEDIUM

```
Time Estimate: 1-2 weeks
Risk: Medium (new type, won't break existing)
```

---

## 5. Phase 5: Actor Model (Future)

### 5.1 Why Actors?

Actors provide safe concurrency with message passing:

```aura
actor Counter:
    var count: Int = 0

    fn increment():
        self.count += 1

    fn get() -> Int:
        return self.count
```

### 5.2 Implementation Path

Actors depend on async. This is a 0.3.0+ feature.

```
Phase 1 (0.2.0): Async/Concurrency
        ↓
Phase 2 (0.3.0): Actor Model
```

---

## 6. Timeline Estimates

### Recommended Order

| Phase | Feature | Effort | Impact | Recommendation |
|-------|---------|--------|--------|----------------|
| 1 | Remove stubs | 1 hour | Low | Do first |
| 1 | Complete generics | 1 week | Medium | Defer to 0.3.0 |
| 2 | async/await | 2-3 weeks | High | Do second |
| 3 | struct | 1-2 weeks | Medium | Do third |
| 4 | spawn/select | 1 week | High | With async |
| 5 | actor | 3-4 weeks | High | 0.3.0+ |

### 0.2.0 Release Checklist

- [ ] Remove unused keywords (struct, actor) OR implement
- [ ] Complete async/await with runtime
- [ ] Implement spawn for background tasks
- [ ] Implement select for concurrent ops
- [ ] Add struct value types
- [ ] Document all new features in LANGUAGE.md
- [ ] Add tests for async features

---

## 7. Priority Order

### Immediate (This Week)

1. **Remove stub keywords** from lexer if not implementing
   - `struct`, `actor` are causing confusion

2. **Document async status** in LANGUAGE.md
   - Add note: "async/await planned for 0.2.0"

### Short-Term (This Month)

1. **Implement async/await**
   - Most requested feature
   - Enables real-world use cases

2. **Implement struct**
   - Complements class with value types

### Medium-Term (This Quarter)

1. **Complete spawn/select**
   - Depends on async

2. **Add proper error messages**
   - Currently generic errors

---

## Appendix: Implementation Checklist

### async/await

- [ ] Parse `async fn` as async function
- [ ] Parse `await` expressions
- [ ] Compile async functions to async bytecode
- [ ] Implement Task/Future in VM
- [ ] Implement event loop
- [ ] Handle async return values
- [ ] Add tests

### spawn

- [ ] Parse `spawn` keyword
- [ ] Launch task without waiting
- [ ] Fire-and-forget semantics
- [ ] Task cleanup on program end

### select

- [ ] Parse select blocks
- [ ] Wait on multiple futures
- [ ] First-ready semantics
- [ ] Timeout cases

### struct

- [ ] Parse struct declarations
- [ ] Compile struct instantiation
- [ ] Implement copy-on-assignment
- [ ] Add struct methods (if needed)
- [ ] Test value semantics

---

## Summary

| Priority | Action | Time |
|----------|--------|------|
| P0 | Remove unused keywords OR decide | 1 hour |
| P1 | Implement async/await | 2-3 weeks |
| P2 | Implement struct | 1-2 weeks |
| P3 | Implement spawn/select | 1 week |
| P4 | Actor model | 3-4 weeks (0.3.0) |

**Recommended path:** Remove stubs → async/await → struct → spawn/select → actor

---

*Last updated: March 2026*
*Maintainer: Project Author*