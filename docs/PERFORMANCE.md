# Performance Comparison — Aura vs Python vs C++

> Status note (March 2026): these figures are directional targets, not measured results from the current TypeScript VM implementation in this repository.

---

## Theoretical Benchmark Comparison

| Dimension | C++ | Aura | Python |
|---|---|---|---|
| **Execution Speed** | ⭐⭐⭐⭐⭐ (baseline) | ⭐⭐⭐⭐ (70–80% of C++) | ⭐⭐ (~50–100× slower) |
| **Memory Safety** | ⭐⭐ (manual, UB-prone) | ⭐⭐⭐⭐⭐ (ARC, no dangling ptrs) | ⭐⭐⭐⭐ (GC-managed) |
| **Developer Velocity** | ⭐⭐ (slow iteration, templates) | ⭐⭐⭐⭐ (fast compile, clean syntax) | ⭐⭐⭐⭐⭐ (instant iteration) |
| **Compile Time** | ⭐⭐ (minutes for large projects) | ⭐⭐⭐⭐ (incremental, seconds) | ⭐⭐⭐⭐⭐ (interpreted) |
| **Concurrency Ergonomics** | ⭐⭐ (manual threads, locks) | ⭐⭐⭐⭐⭐ (structured async/await) | ⭐⭐⭐ (GIL, asyncio) |
| **Binary Size** | ⭐⭐⭐ (varies, can be small) | ⭐⭐⭐⭐ (static linking, small runtime) | N/A (needs interpreter) |
| **GC Pauses** | ⭐⭐⭐⭐⭐ (no GC) | ⭐⭐⭐⭐⭐ (no GC, ARC) | ⭐⭐ (stop-the-world GC) |
| **Learning Curve** | ⭐⭐ (steep) | ⭐⭐⭐⭐ (moderate, Python-like) | ⭐⭐⭐⭐⭐ (gentle) |

---

## Estimated Benchmark Numbers

The following are **theoretical estimates** based on the compilation strategy (AOT via LLVM O2 + LTO) and the memory model (ARC with elision).

### Fibonacci (n = 40, recursive)

| Language | Time | Notes |
|---|---|---|
| C++ (`-O2`) | ~0.5 s | Direct machine code, no overhead |
| **Aura** (`--release`) | ~0.6 s | Same LLVM backend, minimal ARC impact (no heap allocs) |
| Python 3.12 | ~25 s | Interpreted bytecode |

### HTTP Server Throughput (req/s, "Hello World")

| Language | Requests/sec | Notes |
|---|---|---|
| C++ (custom) | ~900K | Raw epoll/io_uring |
| **Aura** (stdlib) | ~650K | Async runtime + LLVM codegen |
| Python (uvicorn) | ~30K | asyncio + GIL |

### Memory Usage (10K concurrent connections)

| Language | RSS (MB) | Notes |
|---|---|---|
| C++ | ~15 | Manual allocation |
| **Aura** | ~25 | ARC overhead per connection object |
| Python | ~120 | Per-object GC metadata, dict overhead |

### JSON Parsing (1 GB file)

| Language | Time | Peak Memory |
|---|---|---|
| C++ (simdjson) | ~0.8 s | ~1.1 GB |
| **Aura** (stdlib) | ~1.2 s | ~1.3 GB |
| Python (json) | ~12 s | ~3.5 GB |

---

## Summary

```
Developer Velocity  ████████████████████░░░░░  Python wins
                    ████████████████░░░░░░░░░  Aura
                    ████████░░░░░░░░░░░░░░░░░  C++

Execution Speed     ████████████████████████░  C++ wins
                    ███████████████████░░░░░░  Aura
                    █████░░░░░░░░░░░░░░░░░░░░  Python

Memory Safety       ████████████████████████░  Aura wins
                    ████████████████████░░░░░  Python (GC)
                    ██████████░░░░░░░░░░░░░░░  C++ (manual)
```

> **Aura's sweet spot:** When you need Python-like readability with near-C++ performance and guaranteed memory safety — without the complexity of Rust's borrow checker or C++'s footguns.
