# Aura Programming Language

> A low-boilerplate language with native data structures, advanced iteration, and built-in ML capabilities.

**Version:** 0.1.0 (MVP)
**Status:** Experimental, with a stable implemented core

---

## Table of Contents

1. [Philosophy](#1-philosophy)
2. [Getting Started](#2-getting-started)
3. [Language Basics](#3-language-basics)
4. [Unique Features](#4-unique-features)
5. [Data Structures](#5-data-structures)
6. [Standard Library](#6-standard-library)
7. [Machine Learning](#7-machine-learning)
8. [Examples](#8-examples)

---

## 1. Philosophy

Aura is designed for programmers who want:

| Principle | Description |
|-----------|-------------|
| **Clean syntax** | Indentation-significant blocks. No semicolons. Minimal parentheses. |
| **Static types** | Strong, static types with aggressive inference — you rarely write a type the compiler can deduce. |
| **Low boilerplate** | Common patterns have dedicated syntax (`cadence`, `repeat`, `indexed`). |
| **Native collections** | Built-in Stack, Queue, Heap, Indexed collections — no import needed. |
| **ML-ready** | First-class tensor operations, linear algebra, and ML algorithms in stdlib. |

Aura occupies the **Goldilocks zone** between Python's readability and compiled language performance.

### Supported Today

- Core control flow, functions, classes, interfaces, traits, enums, and pattern matching
- Unique Aura constructs such as `repeat`, `cadence`, `facet`/`adopts`, `constraint`, `unit`, and `indexed`
- The current data/ML stdlib in `std.tensor`, `std.optim`, `std.data.*`, and `std.ml.*`

### Not Supported Today

- Generics such as `List<T>` or `fn id<T>(x: T)`
- `async` / `await`
- `spawn` / `select`
- `struct`
- `actor`

---

## 2. Getting Started

### Installation

```powershell
# Clone and install
git clone https://github.com/abderahmane-ai/aura.git
cd AURA

# Install dependencies
cd compiler
npm install

# Build
npm run build

# Run
node dist/main.js run ..\examples\data_types.aura
```

### Running Programs

```powershell
# Run a file
aura run script.aura

# Interactive REPL
aura repl

# Run tests
aura test

# Via node directly
cd compiler
node dist/main.js run ..\examples\data_types.aura
node dist/main.js repl
node dist/main.js test
```

### VS Code Extension

```powershell
cd editor/vscode
powershell -ExecutionPolicy Bypass -File .\scripts\build-vsix.ps1
```

Install the generated `.vsix` file in VS Code for syntax highlighting and completions.

---

## 3. Language Basics

### Comments

```aura
# Single-line comment
```

### Variables

```aura
let name = "Aura"   # immutable (recommended default)
var count = 0       # mutable

count = count + 1
count += 2
```

### Core Types

| Type | Description | Example |
|------|-------------|---------|
| `Int` | Integer | `42` |
| `Float64` | Floating-point | `3.14` |
| `Bool` | Boolean | `true`, `false` |
| `String` | Text | `"hello"` |
| `List` | Dynamic array | `[1, 2, 3]` |
| `Map` | Key-value store | `{"a": 1}` |
| `nil` | Null/absence | `nil` |
| `Option` | Optional value | `Some(x)`, `None()` |
| `Result` | Success/failure | `Ok(x)`, `Err(msg)` |

```aura
let n = 42
let pi = 3.14
let ok = true
let text = "hello"
let none = nil
let items = [1, 2, 3]
let m = {"x": 10, "y": 20}
let maybe_user: Option = Some("Ada")
let parse_result: Result = Ok(42)
```

### Operators

```aura
# Arithmetic
+ - * / % **

# Comparison
== != < > <= >=

# Logical
and or not

# Assignment
= += -= *= /=
```

### Functions

```aura
fn greet(name: String) -> String:
    return "Hello, {name}!"

# Default parameters (compile-time constants only)
fn echo_times(msg: String = "hi", times: Int = 2):
    for i in 1..=times:
        io.println(msg)
```

### Control Flow

**if / elif / else:**

```aura
if x > 10:
    io.println("big")
elif x == 10:
    io.println("ten")
else:
    io.println("small")
```

**while:**

```aura
var i = 0
while i < 3:
    io.println("{i}")
    i += 1
```

**for with range:**

```aura
for i in 1..=5:
    io.println("{i}")

# Exclusive: 1..5 = 1,2,3,4
# Inclusive: 1..=5 = 1,2,3,4,5
```

**repeat (counted loop):**

```aura
repeat 3:
    io.println("runs 3 times")

repeat 5 as i:
    io.println("index={i}")  # i is 0..4
```

### Classes

```aura
class Point:
    var x: Int = 0
    var y: Int = 0

    fn init(x: Int, y: Int):
        self.x = x
        self.y = y

    fn sum() -> Int:
        return self.x + self.y

fn main():
    let p = Point(2, 3)
    p.with("x", 10).with("y", 20)   # fluent field updates
    let p2 = p.clone()              # deep clone
    io.println("{p.sum()}")  # 5
```

### Enums and match

```aura
enum Status:
    case ok
    case error
    case pending

fn classify(v: Int):
    if v >= 0:
        return .ok(v)
    return .error("negative")

fn main():
    let r = classify(5)
    match r:
        case .ok(n):
            io.println("ok {n}")
        case .error(msg):
            io.println("error {msg}")
        case .pending:
            io.println("pending")
```

### Modules and Imports

```aura
# Define a module (in stdlib/math.aura)
module std.math

pub fn clamp(x: Float64, lo: Float64, hi: Float64) -> Float64:
    if x < lo: return lo
    if x > hi: return hi
    return x
```

```aura
# Import and use
import std.math as math
import std.io as io

fn main():
    io.println("{math.clamp(42, 0, 10)}")
```

---

## 4. Unique Features

These features define Aura's identity — they don't exist in mainstream languages.

### 4.1 `cadence` — Context-Aware Iteration

Phase-based iteration with hooks for `start`, `first`, `each`, `between`, `last`, `empty`.

```aura
cadence name in ["Ada", "Linus", "Grace"]:
    start:
        io.print("Team: ")
    each:
        io.print(name)
    between:
        io.print(", ")
    last:
        io.println(".")
    empty:
        io.println("No members")
```

**Output:** `Team: Ada, Linus, Grace.`

Phase execution order: `start` → (`first` on first) → `each` → (`between` or `last`)

### 4.2 `constraint` — Semantic Type Validation

Define runtime-checkable type constraints:

```aura
constraint Price(value: Float64):
    require value >= 0
    require value < 1_000_000

constraint Email(value: String):
    require value.contains("@")
    require value.contains(".")

fn main():
    let price: Price = 1200         # OK
    # let bad_price: Price = -5     # Runtime error!
    let email: Email = "user@test.com"  # OK
```

### 4.3 `unit` and `measure` — Dimensional Analysis

Define units with base conversion:

```aura
unit Time:
    base: ms
    sec = ms * 1000
    min = sec * 60

unit Distance:
    base: mm
    cm = mm * 10
    m = cm * 100
    km = m * 1000

fn main():
    let timeout: measure Time = 5sec
    let delay: measure Time = 500ms
    let total: measure Time = timeout + delay
    io.println("total={total}")   # 5500ms (converted)

    # let invalid = timeout + 100  # Type error!
    # let bad = timeout + 1m       # Dimension error!
```

### 4.4 `indexed` — Multi-Key Auto-Indexed Collections

Create in-memory stores with automatic index by multiple fields:

```aura
indexed users by id, email

users.push({"id": 101, "email": "dev@test.com", "name": "Alex"})
users.push({"id": 102, "email": "ops@test.com", "name": "Maya"})
users.push({"id": 103, "email": "dev@other.com", "name": "Sam"})

# Search across ALL declared keys
let u1 = users.get("dev@test.com")       # finds by email
let u2 = users.get(101)                 # finds by id

# Explicit field lookup
let u3 = users.get_by("id", 102)

# Update
users.set_by("id", 101, "email", "new@test.com")

# Check existence
if users.has("ops@test.com"):
    io.println("Found!")
```

**Methods:**
- `push(item)`, `append(item)` — add record
- `get(key)` — search across all indexed fields
- `get_by(field, key)` — lookup by specific field
- `has(key)`, `has_by(field, key)` — check existence
- `set_by(field, key, target_field, value)` — update field
- `remove_by(field, key)` — delete record
- `reindex()` — rebuild indexes
- `len()`, `is_empty()`, `keys()`, `to_list()`, `clear()`

### 4.5 `facet` — Capability System

Define capabilities (interfaces) that objects can adopt:

```aura
facet Serializable:
    fn to_json() -> String

    fn save(path: String):
        let data = self.to_json()
        fs.write_text(path, data)

class User:
    adopts Serializable
    var name: String = ""
    var email: String = ""

    fn init(name: String, email: String):
        self.name = name
        self.email = email

    fn to_json() -> String:
        return '{"name": "' + self.name + '", "email": "' + self.email + '"}'

fn main():
    let u = User("Ada", "ada@test.com")
    as u: Serializable:
        u.save("user.json")
```

### 4.6 String Transformations

Aura adds unique string methods not found in Python/JS:

```aura
let text = "Hello World"

text.camel_case()    # "helloWorld"
text.snake_case()    # "hello_world"
text.kebab_case()    # "hello-world"
text.title()         # "Hello World"
text.words()         # ["Hello", "World"]
text.pad_left(10, "0")   # "000Hello World"
text.pad_right(15, "-")  # "Hello World-----"
```

---

## 5. Data Structures

### Built-in Collections

```aura
fn main():
    # Stack (LIFO)
    let s = Stack(1, 2, 3)
    s.push(4)
    io.println("peek: {s.peek()}, pop: {s.pop()}")

    # Queue (FIFO)
    let q = Queue("a", "b")
    q.enqueue("c")
    io.println("dequeue: {q.dequeue()}")

    # Heap (min-heap by default)
    let hp = Heap(5, 1, 9, 2)
    io.println("pop: {hp.pop()}")  # 1

    # HashMap
    let hm = HashMap("a", 10, "b", 20)
    hm.set("c", 30)
    io.println("get b: {hm.get("b")}")

    # TreeMap (sorted keys)
    let tm = TreeMap("z", 1, "a", 2, "m", 3)
    io.println("keys: {tm.keys()}")  # ["a", "m", "z"]

    # LinkedList
    let ll = LinkedList(1, 2, 3)
    ll.push_back(4)
    ll.push_front(0)
```

### List Methods

```aura
let xs = [3, 1, 4, 1, 5, 9, 2, 6]

xs.len()              # 8
xs.first()            # 3
xs.last()             # 6
xs.sum()              # 31
xs.is_empty()         # false

# Transformations
xs.map(fn x: x * 2)          # [6,2,8,2,10,18,4,12]
xs.filter(fn x: x > 3)       # [4,5,9,6]
xs.reduce(fn acc, x: acc + x, 0)  # 31

# Grouping
xs.group_by(fn x: x % 2)      # {0:[4,2,6], 1:[3,1,5,9]}
xs.key_by(fn x: str(x))      # {"3":3,"1":1,"4":4...}

# Sorting
xs.sort()                    # in-place sort
xs.sorted()                  # returns new sorted list
xs.sort_by(fn x: -x)         # descending
xs.min_by(fn x: x)           # 1
xs.max_by(fn x: x)           # 9

# Partitioning
xs.partition(fn x: x > 3)    # [[4,5,9,6], [3,1,2]]

# Window/chunk
xs.chunk(3)                  # [[3,1,4],[1,5,9],[2,6]]
xs.window(3)                 # [[3,1,4],[1,4,1],[4,1,5],[1,5,9],[5,9,2],[9,2,6]]

# Utility
xs.top_k(3)                  # [9,6,5]
xs.freq()                    # {3:2,1:2,4:1,5:1,9:1,2:1,6:1}
xs.unique()                  # [3,1,4,5,9,2,6]
xs.flatten()                 # flatten nested lists
xs.pluck("field")            # extract field from objects
```

### Option and Result

```aura
# Option — value that may be nil
let maybe: Option = Some(42)
maybe.is_some()    # true
maybe.is_none()    # false
maybe.unwrap()     # 42
maybe.unwrap_or(0) # 42
maybe.map(fn x: x * 2)  # Some(84)
maybe.filter(fn x: x > 10)  # Some(42)
maybe.and_then(fn x: Some(x * 2))  # Some(84)

# Result — success or error
let result: Result = Ok(42)
result.is_ok()      # true
result.is_err()     # false
result.unwrap()     # 42
result.unwrap_or(0) # 42
result.map(fn x: x * 2)  # Ok(84)
result.map_err(fn e: "error: " + e)  # Ok(42)
```

---

## 6. Standard Library

### std.io — Input/Output

```aura
import std.io as io

fn main():
    io.println("Hello")      # print with newline
    io.print("No newline")
    io.eprintln("Error!")    # stderr

    # Formatted I/O
    io.kv("name", "Ada")     # name: Ada
    io.table([["Name", "Age"], ["Ada", 30], ["Linus", 50]])

    # Input
    let name = io.read_line("Enter name: ")
    let confirmed = io.yes_no("Continue?", default_yes: true)

    # Logging
    io.info("Starting up")
    io.warn("Low memory")
    io.error("Connection failed")
    io.debug("Debug info")
```

### std.fs — File System

```aura
import std.fs as fs
import std.json as json

fn main():
    # Read/write text
    fs.write_text("data.txt", "Hello, Aura!")
    let content = fs.read_text("data.txt")

    # Read/write JSON
    fs.write_json("config.json", {"port": 8080})
    let config = fs.read_json("config.json")

    # File operations
    fs.copy("a.txt", "b.txt")
    fs.move("temp.txt", "final.txt")
    fs.exists("file.txt")
    fs.mkdir("data", true)  # recursive

    # Directory walking
    for path in fs.walk("."):
        io.println(path)
```

### std.json — JSON Handling

```aura
import std.json as json

fn main():
    let text = '{"name": "Ada", "age": 30, "active": true}'

    # Parse
    let data = json.parse(text)
    let valid = json.valid(text)

    # Try parse (returns Result)
    let result = json.try_parse(text)
    match result:
        case .ok(data):
            io.println(data["name"])
        case .error(err):
            io.println("Parse failed: {err}")

    # Serialize
    let json_str = json.stringify(data)
    let pretty = json.pretty(data, 2)

    # Path access
    let name = json.get_path(data, "name", "default")
    let has_nested = json.has_path(data, "address.city")
```

### std.time — Time and Durations

```aura
import std.time as time

fn main():
    # Duration literals
    let timeout = time.sec(5)      # 5000ms
    let delay = time.min(2)       # 120000ms

    # Clocks
    let now = time.now_ms()
    let unix = time.now_unix_s()
    let iso = time.now_iso()      # "2024-01-15T10:30:00Z"
    let tick = time.monotonic_ms()

    # Sleep
    time.sleep_ms(1000)

    # Timing
    let start = time.timer_start()
    # ... work ...
    let elapsed = time.timer_stop(start)

    # Profile function
    let result = time.profile(fn:
        expensive_operation()
    )
    io.println("Result: {result["value"]}, Time: {result["elapsed_ms"]}ms")
```

### std.math — Mathematics

```aura
import std.math as math

fn main():
    # Basic
    math.clamp(42, 0, 10)    # 10
    math.sign(-5)           # -1
    math.abs_val(-3.14)     # 3.14

    # Trigonometry
    math.sin(math.PI / 2)   # 1.0
    math.cos(0)             # 1.0
    math.atan2(1, 1)        # π/4

    # Exponents
    math.exp(1)             # e
    math.ln(math.E)         # 1
    math.pow(2, 8)          # 256
    math.sqrt(16)           # 4

    # Rounding
    math.round(3.7)         # 4
    math.floor(3.7)         # 3
    math.ceil(3.2)          # 4
    math.round_to(3.14159, 2)  # 3.14

    # Statistics
    math.mean([1, 2, 3, 4])     # 2.5
    math.median([1, 2, 3])      # 2
    math.mode([1, 2, 2, 3])    # 2
    math.variance([1, 2, 3])    # 1.0
    math.stddev([1, 2, 3])     # 1.0
    math.quantile([1,2,3,4,5], 0.25)  # 2

    # Combinatorics
    math.factorial(5)       # 120
    math.gcd(48, 18)        # 6
    math.lcm(4, 5)          # 20
    math.ncr(5, 2)          # 10  (5 choose 2)
    math.npr(5, 2)          # 20  (5 permutations 2)
```

### std.math — The "Twists"

Aura adds unique mathematical tools:

**math.balance — Total-Preserving Rounding:**

```aura
# The classic floating-point problem:
# 33.333 + 33.333 + 33.333 = 99.999 (not 100!)

let fixed = math.balance.round_to_total([33.333, 33.333, 33.333], 100, 2)
io.println(fixed)  # [33.33, 33.33, 33.34] — sums to exactly 100!

# Split a total into weighted parts
let split = math.balance.split(100, [1, 2, 3], true, 0)
io.println(split)  # [17, 33, 50] — integers summing to 100

# Percentage distribution
let percents = math.balance.percentages([1, 2, 3])
io.println(percents)  # [16.67, 33.33, 50.00] — sums to 100
```

**math.exact — Decimal-Safe Arithmetic:**

```aura
# Floating-point errors in money calculations
let wrong = 0.1 + 0.2  # 0.30000000000000004

# Use exact arithmetic
let exact = math.exact.add(0.1, 0.2, 6)  # 0.3
let product = math.exact.mul(0.1, 0.2, 6) # 0.02
let quotient = math.exact.div(1, 3, 6)     # 0.333333

# Money rounding
let price = math.exact.money(19.999)  # 20.00
```

**math.scale — Robust Normalization:**

```aura
let data = [2, 3, 3, 4, 200]  # outlier at 200

# Linear (standard min-max)
let linear = math.scale(data, "linear", true)
linear.map(4)  # ~0.505

# Robust (5th-95th percentile, ignores outliers)
let robust = math.scale(data, "robust", true)
robust.map(4)  # ~0.667

# Log (for exponential data)
let log_data = [1, 10, 100, 1000]
let log_scale = math.scale(log_data, "log", true)
```

### std.collections — Collection Utilities

```aura
import std.collections as col

fn main():
    # Pipeline-style operations
    let result = col.pipe([1, 2, 3, 4],
        col.map(fn x: x * 2),
        col.filter(fn x: x > 3),
        col.sum()
    )  # result = 14 (4+6+4 from [2,4,6,8] filtered to [4,6,8])

    # Set operations
    col.union([1,2,3], [2,3,4])  # [1,2,3,4]
    col.intersection([1,2,3], [2,3,4])  # [2,3]
    col.difference([1,2,3], [2])  # [1,3]
```

### std.schema — Data Validation

```aura
import std.schema as schema

fn main():
    # Define schema
    let user_schema = schema.object({
        "name": schema.req(schema.string(trim: true, min_len: 1)),
        "age": schema.opt(schema.int(min: 0, max: 150)),
        "email": schema.string(),
    })

    # Validate
    let result = schema.validate(user_schema, {"name": "Ada", "age": 30})
    match result:
        case .ok(data):
            io.println("Valid!")
        case .error(err):
            io.println(schema.explain(err))

    # With defaults
    let with_defaults = user_schema.with_defaults()
```

### std.test — Testing

```aura
import std.test as test

fn test_addition():
    test.assert_eq(2 + 2, 4)
    test.assert_ne(2 + 2, 5)
    test.assert_true(2 < 3)
    test.assert_false(2 > 3)

fn main():
    test.run()
```

---

## 7. Machine Learning

Aura includes a comprehensive ML library in stdlib.

### std.tensor — Tensor Operations

```aura
import std.tensor as tensor

fn main():
    # Create tensors
    let t = tensor.tensor([[1, 2], [3, 4]])
    let zeros = tensor.zeros([3, 4])
    let ones = tensor.ones([2, 3])
    let eye = tensor.eye(3)

    # Random
    let rand = tensor.rand([100, 10], 0.0, 1.0)
    let randn = tensor.randn([100, 10], 0.0, 1.0)

    # Properties
    t.shape()   # [2, 2]
    t.rank()    # 2
    t.len()     # 4
    t.to_list() # [[1,2],[3,4]]
    t.to_flat_list()  # [1,2,3,4]

    # Operations
    t.transpose()    # [[1,3],[2,4]]
    t.reshape([4])   # [1,2,3,4]
    t.flatten()      # [1,2,3,4]

    # Math
    t.add(1)         # element-wise add
    t.mul(2)         # element-wise multiply
    t.matmul(other)  # matrix multiplication
    t.sum()          # sum all elements
    t.mean()         # mean
    t.max()          # max
    t.min()          # min

    # Activation functions
    t.sigmoid()      # element-wise sigmoid
    t.softmax(1)     # softmax along axis 1

    # Loss functions (for training)
    tensor.bce_loss(pred, target)         # Binary cross-entropy
    tensor.cross_entropy_loss(pred, target)  # Multi-class

    # One-hot encoding
    let labels = tensor.tensor([0, 2, 1, 0])
    let onehot = tensor.one_hot(labels, 3)
    # [[1,0,0], [0,0,1], [0,1,0], [1,0,0]]
```

### std.optim — Optimizers

```aura
import std.optim as optim

fn main():
    # Create optimizer
    let opt = optim.sgd(lr: 0.01)
    # or Adam
    let adam = optim.adam(lr: 0.001, beta1: 0.9, beta2: 0.999)

    # During training:
    optim.step(opt, [w, b], [dw, db], nil, nil, 1.0)

    # Or set learning rate
    optim.set_lr(opt, 0.005)
```

### std.ml.logistic — Logistic Regression

```aura
import std.ml.logistic as logistic
import std.tensor as tensor

fn main():
    # Binary classification
    let model = logistic.model(4)  # 4 input features
    let X = [[0,0,1,1], [1,0,0,1], [0,1,1,0], [1,1,0,0]]
    let y = [0, 1, 1, 0]

    # Train
    let result = model.fit(X, y, {"epochs": 100, "lr": 0.1, "verbose": true})

    # Predict
    let prob = model.predict_proba([[0,0,1,1]])
    let pred = model.predict([[0,0,1,1]])

    # Evaluate
    let stats = model.evaluate(X, y)
    io.println("Accuracy: {stats["accuracy"]}")

    # Save/load
    model.save("model.json")
    let loaded = logistic.load("model.json")
```

### std.ml.linear — Linear Regression

```aura
import std.ml.linear as linear
import std.tensor as tensor

fn main():
    let model = linear.model(2)  # 2 features
    let X = [[1, 2], [2, 3], [3, 4], [4, 5]]
    let y = [3, 5, 7, 9]

    model.fit(X, y, {"epochs": 200, "lr": 0.01})

    let pred = model.predict([[5, 6]])
    io.println("Prediction: {pred}")  # ~11
```

### std.ml.metrics — Evaluation

```aura
import std.ml.metrics as metrics

fn main():
    # Classification metrics
    let preds = [0, 1, 2, 0, 1]
    let targets = [0, 1, 1, 0, 2]

    let stats = metrics.classification_metrics(preds, targets, 3)
    io.println("Accuracy: {stats["accuracy"]}")
    io.println("Precision: {stats["precision"]}")
    io.println("Recall: {stats["recall"]}")
    io.println("F1: {stats["f1"]}")

    # Regression metrics
    let pred_reg = [1.0, 2.0, 3.0, 4.0]
    let target_reg = [1.1, 1.9, 3.2, 3.8]

    let reg_stats = metrics.regression_metrics(pred_reg, target_reg)
    io.println("MSE: {reg_stats["mse"]}")
    io.println("R2: {reg_stats["r2"]}")
```

### Other ML Modules

| Module | Description |
|--------|-------------|
| `std.ml.svm` | Support Vector Machine |
| `std.ml.knn` | K-Nearest Neighbors |
| `std.ml.tree` | Decision Tree |
| `std.ml.forest` | Random Forest |
| `std.ml.naive_bayes` | Naive Bayes Classifier |
| `std.ml.preprocess` | Data preprocessing |
| `std.ml.pipeline` | ML pipeline composition |

---

## 8. Examples

### Hello World

```aura
import std.io as io

fn main():
    io.println("Hello, Aura!")
```

### FizzBuzz with cadence

```aura
import std.io as io

fn main():
    cadence n in 1..=15:
        each:
            let msg = {
                if n % 15 == 0: "FizzBuzz"
                elif n % 3 == 0: "Fizz"
                elif n % 5 == 0: "Buzz"
                else: str(n)
            }
            io.println(msg)
```

### CRUD with indexed

```aura
import std.io as io

indexed users by id, email

fn main():
    users.push({"id": 1, "email": "ada@test.com", "name": "Ada"})
    users.push({"id": 2, "email": "linus@test.com", "name": "Linus"})
    users.push({"id": 3, "email": "grace@test.com", "name": "Grace"})

    # Find by email
    let ada = users.get("ada@test.com")
    io.println("Found: {ada["name"]}")

    # Update
    users.set_by("id", 1, "name", "Ada Lovelace")
    io.println("Updated: {users.get("ada@test.com")["name"]}")

    # Delete
    users.remove_by("id", 2)
    io.println("Remaining: {users.len()}")
```

### ML Training

```aura
import std.ml.logistic as logistic
import std.io as io

# Iris-like dataset (sepal length, sepal width, petal length, petal width)
let X = [
    [5.1, 3.5, 1.4, 0.2],  # setosa
    [4.9, 3.0, 1.4, 0.2],  # setosa
    [7.0, 3.2, 4.7, 1.4],  # versicolor
    [6.4, 3.2, 4.5, 1.5],  # versicolor
    [6.3, 3.3, 6.0, 2.5],  # virginica
    [5.8, 2.7, 5.1, 1.9],  # virginica
]

# Labels: 0=setosa, 1=versicolor, 2=virginica
let y = [0, 0, 1, 1, 2, 2]

fn main():
    let model = logistic.model(4, 3)

    let result = model.fit(X, y, {
        "epochs": 200,
        "lr": 0.1,
        "verbose": true,
    })

    io.println("Final accuracy: {result["history"]["accuracy"].last()}")
```

---

## Appendix: Running Tests

```powershell
# Run all tests
aura test

# Or via node
cd compiler
node dist/main.js test ../tests
```

---

**End of Language Reference**
