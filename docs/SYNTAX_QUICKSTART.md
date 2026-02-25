# Aura Syntax Quickstart (Current MVP)

This guide reflects the syntax currently implemented in this repository's TypeScript bytecode compiler and VM.

## 1. Program Entry

```aura
fn main():
    io.println("Hello, Aura")
```

Run:

```powershell
cd C:\Users\wwwab\Development\AURA\compiler
node dist/main.js ..\examples\data_types.aura
# (equivalent)
node dist/main.js run ..\examples\data_types.aura
```

IDE support (syntax highlighting, completions, icon):

```powershell
cd C:\Users\wwwab\Development\AURA\editor\vscode
powershell -ExecutionPolicy Bypass -File .\scripts\build-vsix.ps1
```

Then install `editor/vscode/aura-lang-0.1.0.vsix` in your VS Code-compatible IDE.
Detailed instructions: `editor/vscode/README.md`.
For full friend-sharing install flow (CLI + PATH + VSIX), see `docs/INSTALL.md`.

## 2. Comments

```aura
# line comment
```

## 3. Variables

```aura
let name = "Aura"   # immutable by convention
var count = 0       # mutable

count = count + 1
count += 2
```

## 4. Core Types

- `Int` / `Float64` (runtime uses JS number)
- `Bool` (`true`, `false`)
- `String`
- `nil`
- `List` (`[1, 2, 3]`)
- `Map` (`{"a": 1, "b": 2}`)

```aura
let n = 42
let pi = 3.14
let ok = true
let text = "hello"
let none = nil
let items = [1, 2, 3]
let m = {"x": 10, "y": 20}
```

## 5. Strings and Interpolation

```aura
let user = "Ada"
let score = 99
io.println("User: {user}, score: {score}")
```

## 6. Operators

Arithmetic:
- `+ - * / % **`

Comparison:
- `== != < > <= >=`

Logical:
- `and or not`

## 7. Control Flow

### if / elif / else

```aura
if x > 10:
    io.println("big")
elif x == 10:
    io.println("ten")
else:
    io.println("small")
```

### while

```aura
var i = 0
while i < 3:
    io.println("{i}")
    i += 1
```

### for with range

```aura
for i in 1..=5:
    io.println("{i}")
```

`1..5` is exclusive end, `1..=5` is inclusive end.

### repeat (Aura-native counted loop)

```aura
repeat 3:
    io.println("runs 3 times")

repeat 5 as i:
    io.println("index={i}")  # i is 0..4
```

### cadence (context-aware iteration)

`cadence` snapshots the iterable with `to_list(...)` and gives phase hooks:
- `start`: runs once before non-empty iteration
- `first`: runs only for the first item
- `each`: runs for every item (required)
- `between`: runs between items (not on the last item)
- `last`: runs only for the last item
- `empty`: runs when there are no items

Hook order for non-empty input: `start` -> (`first` on first item) -> `each` -> (`between` or `last`).

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

## 8. Functions

```aura
fn add(a: Int, b: Int) -> Int:
    return a + b
```

Default parameters are supported when defaults are compile-time constants:

```aura
fn echo_times(msg: String = "hi", times: Int = 2):
    for i in 1..=times:
        io.println(msg)
```

## 8.1 Constraints

```aura
constraint Price(value: Float64):
    require value >= 0
    require value < 1_000_000

fn main():
    let price: Price = 1200
    # price = -5   # runtime Constraint error
```

Constraints are lowered to checker functions and enforced on typed declarations, assignments, and typed parameters.

## 8.2 Units and Measures

```aura
unit Time:
    base: ms
    sec = ms * 1000
    min = sec * 60

fn main():
    let timeout: measure Time = 5sec
    let delay: measure Time = 500ms
    let total: measure Time = timeout + delay
    io.println("total={total}")   # 5.5sec
```

`measure` values are dimension-checked and support arithmetic/comparison with conversion through base units.

## 9. Lists and Maps

```aura
let xs = [10, 20, 30]
io.println("{xs[1]}")   # 20
xs[1] = 99

let m = {"k": "v"}
io.println("{m["k"]}")
m["k"] = "new"
```

Common list methods:
- `append(value)`
- `push(value)`
- `pop()`
- `len()`
- `first()`, `last()`
- `sum()`
- `is_empty()`
- `clear()`

### 9.1 Indexed Collections

`indexed` creates an in-memory indexed store with automatic key lookup:

```aura
indexed users by id, email
users.push({"id": 101, "email": "dev@test.com", "name": "Alex"})
users.push({"id": 102, "email": "ops@test.com", "name": "Maya"})

let u1 = users.get("dev@test.com")       # search across declared keys
let u2 = users.get_by("id", 102)         # explicit key index
users.set_by("id", 101, "email", "new@test.com")
```

Available methods:
- `push(item)`, `append(item)`
- `get(key)`, `get_by(field, key)`
- `has(key)`, `has_by(field, key)`
- `set_by(field, key, target_field, value)`
- `remove_by(field, key)`
- `reindex()`
- `len()`, `is_empty()`, `keys()`, `to_list()`, `clear()`

## 10. Classes and Methods

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
    let p2 = p.clone()              # deep clone of instance fields
    io.println("{p.sum()}")  # 5
```

## 10.1 Facets, adopts, and as-context

```aura
facet Editor:
    fn edit(content: String):
        io.println("Editing {content}")

class User:
    adopts Editor

fn main():
    let u = User()
    as u: Editor:
        u.edit("draft")
```

Facet methods are namespaced under the hood and activated in `as <obj>: <Facet>:` blocks.

## 11. Enums and match

```aura
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
```

## 12. Built-ins

- `print(...)`
- `io.println(...)`, `io.print(...)`
- `len(x)`
- `min(a, b)`, `max(a, b)`
- `str(x)`, `int(x)`, `float(x)`
- `range(start, end)`
- Collections constructors:
- `Stack(...)`, `Queue(...)`, `LinkedList(...)`, `Indexed(...)`
- `HashMap(...)`, `TreeMap(...)`, `Heap(...)`
- Collection utilities:
- `to_list(x)`, `sum(x)`, `sort(x)`, `unique(x)`
- `top_k(x, k)`, `freq(x)`, `chunk(x, size)`, `window(x, size)`
- `take(x, n)`, `drop(x, n)`

### 12.1 Native Collections (new)

```aura
fn main():
    let s = Stack(1, 2, 3)
    s.push(4)
    io.println("stack peek: {s.peek()} len={s.len()}")

    let q = Queue("a", "b")
    q.enqueue("c")
    io.println("queue dequeue: {q.dequeue()}")

    let hm = HashMap("a", 10, "b", 20)
    hm.set("c", 30)
    io.println("hm keys: {hm.keys()}")

    let hp = Heap(5, 1, 9, 2)
    io.println("heap pop: {hp.pop()}")   # min-heap

    indexed users by id, email
    users.push({"id": 1, "email": "a@test.com", "name": "Ada"})
    users.push({"id": 2, "email": "b@test.com", "name": "Linus"})
    let first_user = users.get("a@test.com")
    io.println("indexed get: {first_user}")
```

## 13. Current MVP Limits (in this repo)

- Single-file execution (`import`/modules are parsed but not executed).
- `async/await` tokens exist but runtime is synchronous.
- Interfaces/traits are runtime-light (structural behavior is minimal).
- Some advanced type-system features are parsed but not enforced at runtime.

## 14. Suggested Test Programs

- Data types: `examples/data_types.aura`
- Loops (`for`, `while`, `repeat`, `cadence`): `examples/loops.aura`
- Functions: `examples/functions.aura`
- Interfaces: `examples/interfaces.aura`
- Classes and OOP (includes facets): `examples/classes_oop.aura`
- Native data structures: `examples/native_data_structures.aura`
- Constraints + measures: `examples/data_types.aura`
