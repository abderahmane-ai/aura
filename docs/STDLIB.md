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

## std.tensor

Import:

```aura
import std.tensor as tensor
```

Constructors:
- `tensor(value)`
- `from_shape(shape, fill = 0.0)`
- `full(shape, value)`, `zeros(shape)`, `ones(shape)`
- `rand(shape, min = 0.0, max = 1.0)`
- `randn(shape, mean = 0.0, std = 1.0)`
- `eye(n, m = n)`
- `zeros_like(t)`, `ones_like(t)`, `full_like(t, value)`

Shape/inspection:
- `shape(t)`, `rank(t)`, `len(t)`
- `to_list(t)`, `to_flat_list(t)`, `clone(t)`
- `min(t)`, `max(t)`, `argmin(t)`, `argmax(t)`
- `sum(t)`, `mean(t)`, `variance(t, sample = false)`, `std(t, sample = false)`
- `sum_axis(t, axis = -1)`, `mean_axis(t, axis = -1)` (rank-1/rank-2)

Transform/index:
- `flatten(t)`, `reshape(t, shape)`, `transpose(t)` (rank-2)
- `get(t, i)`, `set(t, i, value)`
- `at(t, i)`, `at2(t, i, j)`, `at3(t, i, j, k)`
- `set_at(t, i, value)`, `set_at2(t, i, j, value)`, `set_at3(t, i, j, k, value)`
- `map(t, fn_ref)`, `zip_map(a, b, fn_ref)`

Math/activations:
- `add`, `sub`, `mul`, `div` (with scalar + broadcast-compatible tensor)
- In-place: `add_`, `sub_`, `mul_`, `div_`, `fill_`
- `exp`, `log`, `pow`, `sqrt`, `abs`, `clip`
- `sigmoid`, `relu`, `tanh`, `softmax`, `log_softmax`
- `l2_norm`, `normalize`, `standardize`, `min_max_scale`

Linear algebra:
- `dot(a, b)` (vector dot)
- `matmul(a, b)` (rank-1/rank-2 combinations)

Loss/metrics:
- `mse_loss(pred, target)`
- `bce_loss(pred, target, eps = 1e-12)`
- `bce_with_logits(logits, target, eps = 1e-12)`
- `nll_loss(log_probs, target)`
- `cross_entropy_loss(pred_probs, target, eps = 1e-12)`
- `cross_entropy_with_logits(logits, target, axis = -1)`
- `binary_accuracy(pred, target, threshold = 0.5)`
- `classification_accuracy(scores, target)`

Init + utility creators:
- `xavier_uniform(shape, fan_in, fan_out)`
- `xavier_normal(shape, fan_in, fan_out)`
- `he_uniform(shape, fan_in)`
- `he_normal(shape, fan_in)`
- `arange(start, end?, step = 1.0)`
- `linspace(start, stop, n)`
- `one_hot(indices, num_classes)`
## std.optim

Import:

```aura
import std.optim as optim
```

Constructors:
- `sgd(lr = 0.01, momentum = 0.0, dampening = 0.0, nesterov = false, weight_decay = 0.0, maximize = false)`
- `adam(lr = 0.001, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weight_decay = 0.0, amsgrad = false, maximize = false)`
- `adamw(lr = 0.001, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weight_decay = 0.01, amsgrad = false, maximize = false)`
- `adamax(lr = 0.002, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weight_decay = 0.0, maximize = false)`
- `nadam(lr = 0.002, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weight_decay = 0.0, maximize = false)`
- `radam(lr = 0.001, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weight_decay = 0.0, maximize = false)`
- `rmsprop(lr = 0.01, alpha = 0.99, eps = 1e-8, weight_decay = 0.0, momentum = 0.0, centered = false, maximize = false)`
- `adagrad(lr = 0.01, lr_decay = 0.0, weight_decay = 0.0, eps = 1e-10, maximize = false)`
- `adadelta(lr = 1.0, rho = 0.9, eps = 1e-6, weight_decay = 0.0, maximize = false)`
- `lion(lr = 1e-4, beta1 = 0.9, beta2 = 0.99, weight_decay = 0.0, maximize = false)`
- `lookahead(inner_opt, k = 5, alpha = 0.5)`

Core training ops:
- `step(opt, params, grads, clip_norm = nil, clip_value = nil, grad_scale = 1.0)`
- `zero_grad(grads)`
- `clip_grad_value_(grads, clip_value)`
- `global_grad_norm(grads)`
- `clip_grad_norm_(grads, max_norm, eps = 1e-12)`

Optimizer controls:
- `get_lr(opt)`
- `set_lr(opt, lr)`
- `state(opt)`
- `reset_state(opt)`

LR schedule helpers:
- `lr_constant(base_lr, step_idx)`
- `lr_step(base_lr, step_idx, step_size, gamma = 0.1)`
- `lr_exponential(base_lr, step_idx, gamma = 0.99)`
- `lr_linear_warmup(base_lr, step_idx, warmup_steps)`
- `lr_cosine(base_lr, step_idx, total_steps, min_lr = 0.0)`
- `lr_warmup_cosine(base_lr, step_idx, warmup_steps, total_steps, min_lr = 0.0)`

## std.data.synthetic

Import:

```aura
import std.data.synthetic as synthetic
```

Dataset generators:
- `binary_linear(n = 200, input_dim = 2, noise = 0.2, seed = 42)`
- `multiclass_blobs(num_classes = 3, n_per_class = 100, input_dim = 2, spread = 0.5, radius = 3.0, seed = 42)`

Splitting:
- `train_test_split(X, y, test_ratio = 0.2, shuffle = true, seed = 42)`

Returns maps containing tensor fields like `X`, `y`, and train/test splits.

## std.ml.logistic

Import:

```aura
import std.ml.logistic as logistic
```

Model lifecycle:
- `init(input_dim, num_classes = 1)`
- `clone_model(model)`

Inference:
- `logits(model, X)`
- `predict_proba(model, X)`
- `predict(model, X, threshold = 0.5)`

Training/evaluation:
- `fit(model, X, y, options = {})`
- `evaluate(model, X, y, l2 = 0.0)`
- `loss(model, X, y, l2 = 0.0)`

`fit` options:
- `epochs`, `batch_size`, `lr`, `optimizer`, `l2`
- `shuffle`, `seed`
- `clip_norm`, `clip_value`, `grad_scale`
- `verbose`, `log_every`
## std.test

Import:

```aura
import std.test as test
```

Assertions:
- `fail(message = "test failed")`
- `assert_true(value, message = "")`
- `assert_false(value, message = "")`
- `assert_equal(actual, expected, message = "")`
- `assert_not_equal(actual, expected, message = "")`
- `assert_nil(value, message = "")`
- `assert_not_nil(value, message = "")`
- `assert_contains(haystack, needle, message = "")`
- `assert_approx(actual, expected, epsilon = 0.000001, message = "")`

Helpers:
- `suite(name)`
- `it(name, fn_ref)`

`aura test [path]` discovers files ending in `*.test.aura` or `*_test.aura` (default root: `./tests`).



## std.schema

Import:

```aura
import std.schema as schema
```

Schema builders:
- `any()`
- `string(trim = false, min_len = 0, max_len = -1)`
- `int(min = nil, max = nil)`
- `float(min = nil, max = nil)`
- `bool()`
- `literal(value)`
- `one_of(values)`
- `list(item_schema, min_len = 0, max_len = -1)`
- `optional(schema)`
- `union(options)`
- `refine(schema, predicate, message = "refinement failed")`
- `object(fields, allow_extra = false)`

Object field helpers:
- `req(schema)`
- `opt(schema)`
- `defaulted(schema, default_value)`
- `field(schema, required = true, has_default = false, default_value = nil)`

Validation/coercion:
- `parse(schema, value) -> Result`
- `validate(schema, value) -> Result`
- `parse_or(schema, value, fallback)`
- `explain(error) -> String`

Versioning/migrations:
- `migration(from_version, to_version, run_fn)`
- `migrate(value, current_version, target_version, migrations) -> Result`
- `parse_versioned(schemas_by_version, target_version, value, version_field = "version", migrations = []) -> Result`

