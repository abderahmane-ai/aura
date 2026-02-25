# The Aura Language Specification

> Status note (March 2026): this is a long-term draft specification. For behavior currently implemented in this repository, use `docs/SYNTAX_QUICKSTART.md` and `examples/` as the source of truth.

> *Version 0.1.0 — Draft*

---

## 1. Philosophy & Design Goals

Aura occupies the **Goldilocks zone** between Python's readability and C++'s performance. It is designed for programmers who want:

| Principle | Description |
|---|---|
| **Clean syntax** | Indentation-significant blocks. No semicolons. Minimal parentheses. |
| **Static safety** | Strong, static types with aggressive inference — you rarely write a type that the compiler can already deduce. |
| **Native speed** | AOT compiled via LLVM. Target: **70–80 %** of equivalent hand-tuned C++. |
| **No GC pauses** | Memory managed through **Automatic Reference Counting (ARC)** with compile-time region optimisations. |
| **Fearless concurrency** | Structured `async / await` built into the language core. |

---

## 2. Lexical Structure

### 2.1 Keywords

```
let       var       fn        return    if        else
elif      for       in        while     break     continue
class     struct    interface trait     impl      self
import    from      as        module    pub       mut
async     await     spawn     select    match     enum
true      false     nil       and       or        not
try       catch     throw     defer     where     is
```

### 2.2 Operators

| Category | Operators |
|---|---|
| Arithmetic | `+`  `-`  `*`  `/`  `%`  `**` |
| Comparison | `==`  `!=`  `<`  `>`  `<=`  `>=` |
| Logical | `and`  `or`  `not` |
| Bitwise | `&`  `\|`  `^`  `~`  `<<`  `>>` |
| Assignment | `=`  `+=`  `-=`  `*=`  `/=` |
| Type | `->` (return type)  `:` (annotation)  `?` (optional)  `!` (unwrap) |
| Range | `..` (exclusive)  `..=` (inclusive) |
| Pipeline | `\|>` (pipe-forward) |

### 2.3 Literals

```aura
42                  # Int
3.14                # Float
0xFF                # Hex Int
0b1010              # Binary Int
"hello"             # String (UTF-8)
'c'                 # Char
true / false        # Bool
nil                 # Absence of value
[1, 2, 3]           # List
{"key": "value"}    # Map
(1, "two", 3.0)     # Tuple
```

### 2.4 Comments

```aura
# Single-line comment

##
  Multi-line
  block comment
##
```

### 2.5 Indentation Rules

Aura uses **4-space indentation** to define blocks. A colon `:` at the end of a line opens a new block scope.

---

## 3. Grammar & Syntax Rules

### 3.1 Variables

```aura
# Immutable binding (default) — type inferred
let name = "Aura"

# Mutable binding
var counter = 0

# Explicit type annotation (only when needed)
let pi: Float64 = 3.14159

# Destructuring
let (x, y, z) = (1, 2, 3)
```

**Rule:** `let` creates an immutable binding. `var` creates a mutable binding. Types are inferred unless ambiguous.

### 3.2 Functions

```aura
fn greet(name: String) -> String:
    return "Hello, {name}!"

# Single-expression shorthand
fn double(x: Int) -> Int = x * 2

# Default parameters
fn connect(host: String, port: Int = 8080) -> Connection:
    ...

# Generic function
fn first<T>(items: List<T>) -> T?:
    return items[0] if items.len() > 0 else nil

# Multiple return values via tuples
fn divmod(a: Int, b: Int) -> (Int, Int):
    return (a / b, a % b)
```

**Rule:** Parentheses are required around parameters. The return type follows `->`. The body is indented.

### 3.3 Control Flow

```aura
# If / elif / else
if temperature > 100:
    log("Too hot")
elif temperature < 0:
    log("Freezing")
else:
    log("Just right")

# For loop (range-based)
for i in 0..10:
    print(i)

# For loop (collection)
for item in collection:
    process(item)

# While loop
while connected:
    data = socket.read()

# Pattern matching
match status:
    case .ok(value):
        process(value)
    case .error(err):
        log("Error: {err}")
    case _:
        log("Unknown")
```

### 3.4 Classes

```aura
class Vehicle:
    # Properties
    let make: String
    let model: String
    var speed: Float64 = 0.0

    # Constructor
    fn init(make: String, model: String):
        self.make = make
        self.model = model

    # Method
    fn describe() -> String:
        return "{self.make} {self.model}"
```

**Rule:** No `new` keyword. Instantiation is `let car = Vehicle("Toyota", "Camry")`.

### 3.5 Interfaces

```aura
interface Drivable:
    fn accelerate(amount: Float64)
    fn brake(amount: Float64)
    fn current_speed() -> Float64
```

**Rule:** Interfaces define method signatures without bodies. A class satisfies an interface by implementing all its methods.

### 3.6 Traits (with default implementations)

```aura
trait Printable:
    fn to_string() -> String

    # Default implementation
    fn print():
        io.println(self.to_string())
```

### 3.7 Implementation Blocks & Composition

```aura
class Car:
    let vehicle: Vehicle          # Composition
    var gear: Int = 1

    fn init(make: String, model: String):
        self.vehicle = Vehicle(make, model)

impl Drivable for Car:
    fn accelerate(amount: Float64):
        self.vehicle.speed += amount

    fn brake(amount: Float64):
        self.vehicle.speed = max(0.0, self.vehicle.speed - amount)

    fn current_speed() -> Float64:
        return self.vehicle.speed

impl Printable for Car:
    fn to_string() -> String:
        return "{self.vehicle.describe()} going {self.current_speed()} km/h"
```

**Rule:** `impl Interface for Type:` is used to attach interface conformance outside the class body, keeping the class definition lean.

### 3.8 Structs (Value Types)

```aura
struct Point:
    let x: Float64
    let y: Float64

    fn distance_to(other: Point) -> Float64:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2).sqrt()
```

**Rule:** Structs are **value types** (copied on assignment). Classes are **reference types** (ARC-managed).

### 3.9 Enums & Algebraic Types

```aura
enum Result<T, E>:
    case ok(T)
    case error(E)

enum Direction:
    case north
    case south
    case east
    case west
```

### 3.10 Modules & Imports

```aura
# File: math/geometry.aura
module math.geometry

pub fn area_circle(r: Float64) -> Float64:
    return 3.14159 * r ** 2

# File: main.aura
import math.geometry
# or
from math.geometry import area_circle
```

---

## 4. Type System

### 4.1 Primitive Types

| Type | Size | Description |
|---|---|---|
| `Int` | 64-bit | Signed integer (platform default) |
| `Int8`, `Int16`, `Int32`, `Int64` | 8–64 bit | Sized signed integers |
| `UInt`, `UInt8`, … `UInt64` | 8–64 bit | Unsigned integers |
| `Float32`, `Float64` | 32/64 bit | IEEE 754 floats |
| `Bool` | 1 byte | `true` / `false` |
| `Char` | 4 bytes | Unicode scalar value |
| `String` | dynamic | UTF-8 encoded, immutable by default |

### 4.2 Type Inference

The compiler performs **bidirectional type inference** (Hindley-Milner extended with subtyping). Users only annotate when:

1. A function's **parameter types** (always required).
2. The type is genuinely **ambiguous** (e.g., numeric literals in generic context).

```aura
let x = 42            # Inferred as Int
let y = 3.14          # Inferred as Float64
let names = ["a","b"] # Inferred as List<String>
let result = fetch()  # Inferred from fn return type
```

### 4.3 Generics

```aura
class Stack<T>:
    var items: List<T> = []

    fn push(item: T):
        self.items.append(item)

    fn pop() -> T?:
        return self.items.pop()

# Constrained generics
fn sort<T: Comparable>(items: List<T>) -> List<T>:
    ...
```

### 4.4 Optional & Result Types

```aura
# Optional — value or nil
let name: String? = find_user(id)

# Safe unwrap
if let user = find_user(id):
    greet(user)

# Force unwrap (crashes on nil)
let user = find_user(id)!

# Result type for error handling
fn read_file(path: String) -> Result<String, IOError>:
    ...
```

---

## 5. Memory Management

Aura uses **Automatic Reference Counting (ARC)** with compile-time optimisations.

### 5.1 Ownership Rules

1. Every value has exactly **one owner** at a time.
2. `let` bindings are immutable; `var` bindings are mutable.
3. Values are **reference-counted** when shared across scopes.
4. The compiler **elides** retain/release calls where it can prove the lifetime statically.

### 5.2 Region-Based Optimisation

The compiler groups short-lived allocations into **regions** (arena-style). When a region's scope ends, all memory is freed in O(1) — no per-object deallocation.

```aura
fn process_batch(items: List<Data>):
    # The compiler allocates temporaries in a region tied to this scope.
    for item in items:
        let transformed = item.transform()   # region-allocated
        output.write(transformed)
    # Region freed here — all temporaries gone instantly.
```

### 5.3 Cycle Breaking

Weak references break retain cycles:

```aura
class Node:
    var value: Int
    var next: Node? = nil
    weak var parent: Node? = nil     # Does not increment ref count
```

---

## 6. Concurrency

### 6.1 Async Functions

```aura
async fn fetch_data(url: String) -> Result<Data, NetError>:
    let response = await http.get(url)
    return response.body()
```

### 6.2 Structured Concurrency

```aura
async fn load_dashboard():
    # Parallel tasks — all must complete before scope exits
    async let profile = fetch_data("/api/profile")
    async let feed    = fetch_data("/api/feed")
    async let alerts  = fetch_data("/api/alerts")

    let dashboard = Dashboard(
        profile: await profile,
        feed:    await feed,
        alerts:  await alerts,
    )
    render(dashboard)
```

### 6.3 Select

```aura
select:
    case msg = await channel.recv():
        handle(msg)
    case await timer.tick(1000):
        heartbeat()
```

### 6.4 Actor-Style Isolation (future)

```aura
actor Counter:
    var count: Int = 0

    fn increment():
        self.count += 1

    fn get() -> Int:
        return self.count
```

---

## 7. Error Handling

Aura uses **value-based** error handling (no exceptions).

```aura
fn parse_config(path: String) -> Result<Config, ParseError>:
    let text = try read_file(path)       # Propagates error if Result is .error
    let data = try parse_json(text)
    return Config.from(data)

# Caller
match parse_config("app.toml"):
    case .ok(config):
        start(config)
    case .error(err):
        log("Failed: {err}")
```

The `try` keyword unwraps a `Result` or immediately returns the `.error` from the enclosing function.

---

## 8. Standard Library Overview

| Module | Contents |
|---|---|
| `io` | File I/O, stdin/stdout, streams |
| `net` | TCP/UDP sockets, HTTP client |
| `collections` | List, Map, Set, Deque, PriorityQueue |
| `math` | Numeric functions, constants |
| `text` | Regex, Unicode utilities |
| `json` | JSON encode/decode |
| `time` | Clocks, durations, formatting |
| `os` | Env vars, process, filesystem paths |
| `sync` | Channels, Mutex, Semaphore |
| `test` | Test runner, assertions |
