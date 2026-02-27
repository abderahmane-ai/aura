# Aura Stdlib Reference (MVP+)

This file documents the practical `std.*` modules currently implemented in this repository.

## std.io

Import:

```aura
import std.io as io
```

Core output:
- `print(value)`
- `println(value)`
- `eprint(value)` (stderr)
- `eprintln(value)` (stderr + newline)
- `write(values, sep = "", ending = "")`
- `writeln(values, sep = " ")`
- `print_many(values)`, `println_many(values)`

Formatting helpers:
- `line(width = 60, fill = "-") -> String`
- `hline(width = 60, fill = "-")`
- `banner(title, width = 60, fill = "=")`
- `kv(key, value)`
- `repeat_text(text, count) -> String`
- `table(rows, separator = " | ")`

Input:
- `read_line(prompt_text = "") -> String`
- `prompt(prompt_text = "") -> String`
- `read_all_stdin() -> String`
- `read_lines_stdin() -> List`
- `yes_no(question, default_yes = true) -> Bool`

Logging:
- `timestamp() -> String`
- `log(level, message)`
- `info(message)`, `warn(message)`, `error(message)`, `debug(message)`

## std.json

Import:

```aura
import std.json as json
```

Parsing/serialization:
- `parse(text)`
- `try_parse(text) -> Result`
- `valid(text) -> Bool`
- `stringify(value, pretty = false) -> String`
- `pretty(value, indent = 2) -> String`
- `compact(value_or_text) -> String`
- `prettify_text(text, indent = 2) -> String`
- `parse_or(text, fallback)`
- `clone(value)`

Inspection/path:
- `type_of(value) -> String`
- `get_path(value, path, fallback = nil)`
- `has_path(value, path) -> Bool`
- `require_path(value, path) -> Result`
- `pick(value, paths) -> Map`

Transforms:
- `merge(left, right) -> Map`
- `map_values(obj, fn_ref) -> Map`

Path format supports dots and array indexes, e.g. `nested.items[0].name`.

## std.time

Import:

```aura
import std.time as time
```

Duration helpers:
- `ms(n = 1)`, `sec(n = 1)`, `min(n = 1)`, `hour(n = 1)`, `day(n = 1)`, `week(n = 1)`

Clocks:
- `now_ms() -> Int`
- `now_unix_s() -> Int`
- `now_iso() -> String`
- `monotonic_ms() -> Int`

Sleep/timers:
- `sleep_ms(duration_ms)`
- `sleep_sec(duration_sec)`
- `sleep_until_ms(target_ms)`
- `timer_start() -> Int`
- `timer_stop(start_tick) -> Int`
- `profile(fn_ref) -> Map`

Parsing/conversion:
- `parse_iso(text) -> Int` (unix ms)
- `from_unix_ms(ms) -> String` (ISO)
- `from_unix_s(sec) -> String` (ISO)
- `to_unix_s(ms) -> Int`
- `parts(ms_or_nil) -> Map` (`year`, `month`, `day`, `hour`, `minute`, `second`, `ms`, `weekday`, `iso`, `unix_ms`, `unix_s`)

Arithmetic:
- `add_ms(ms, delta_ms) -> Int`
- `add_sec(ms, delta_sec) -> Int`
- `diff_ms(a, b) -> Int`
- `elapsed_ms(start_ms) -> Int`
- `since(start_ms) -> Int`
- `until(target_ms) -> Int`

## std.fs

Import:

```aura
import std.fs as fs
```

Files/directories:
- `exists(path) -> Bool`
- `read_text(path) -> String`
- `write_text(path, content)`
- `append_text(path, content)`
- `delete(path)`
- `mkdir(path, recursive = true)`
- `list(path) -> List`
- `walk(path, recursive = true) -> List`
- `stat(path) -> Map`
- `copy(src, dst, overwrite = true)`
- `move(src, dst, overwrite = true)`
- `touch(path)`
- `temp_dir(prefix = "aura-") -> String`

Path utilities:
- `cwd() -> String`
- `abs(path) -> String`
- `join(parts) -> String`
- `basename(path) -> String`
- `dirname(path) -> String`
- `extname(path) -> String`
- `normalize(path) -> String`

Predicates/meta:
- `is_file(path) -> Bool`
- `is_dir(path) -> Bool`
- `size(path) -> Int`
- `mtime_ms(path) -> Int`
- `ensure_dir(path)`
- `ensure_parent_dir(path)`

Line + JSON helpers:
- `read_lines(path) -> List`
- `write_lines(path, lines, trailing_newline = true)`
- `append_lines(path, lines, trailing_newline = true)`
- `read_json(path)`
- `read_json_safe(path) -> Result`
- `write_json(path, value, pretty = true)`
- `list_files(path, recursive = false) -> List`
- `list_dirs(path, recursive = false) -> List`

## std.collections

Import:

```aura
import std.collections as col
```

Core:
- `list(value)`
- `sum_of(value)`
- `sorted(value)`
- `unique_of(value)`
- `top(value, n)`
- `frequencies(value)`
- `chunked(value, size)`
- `windowed(value, size)`
- `take_first(value, n)`
- `drop_first(value, n)`

Functional ops:
- `reduce(items, fn_ref, init)`
- `map(items, fn_ref)`
- `filter(items, fn_ref)`
- `reject(items, fn_ref)`
- `flat_map(items, fn_ref)`
- `flatten(items, depth = 1)`
- `find(items, fn_ref)`
- `find_index(items, fn_ref)`
- `any(items, fn_ref)`
- `all(items, fn_ref)`
- `count(items, fn_ref)`

Grouping/indexing:
- `group_by(items, fn_ref)`
- `group_count_by(items, fn_ref)`
- `key_by(items, fn_ref)`
- `index_by(items, fn_ref)`
- `sort_by(items, fn_ref)`
- `min_by(items, fn_ref)`
- `max_by(items, fn_ref)`
- `zip(left, right)`
- `enumerate(items)`
- `partition(items, fn_ref)`

Set-like list ops:
- `contains(items, value) -> Bool`
- `concat(left, right)`
- `union(left, right)`
- `intersection(left, right)`
- `difference(left, right)`

Map/pair ops:
- `pairs(obj)`, `keys(obj)`, `values(obj)`
- `from_pairs(items)`
- `pluck(items, field)`
- `compact(items)`
