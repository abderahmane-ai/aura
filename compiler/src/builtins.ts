import {
    Value, AuraList, AuraMap, AuraRange, AuraIterator, AuraNative,
    AuraFunction, AuraClass, AuraInstance, AuraEnum, AuraModule, BuiltinFn, AuraMeasure,
} from './types.js';
import { runtimeError } from './errors.js';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename as pathBasename, dirname as pathDirname, extname as pathExtname, isAbsolute, join as pathJoin, normalize as pathNormalize, resolve as pathResolve } from 'node:path';
import { tmpdir } from 'node:os';

interface NativeHeapData {
    items: Value[];
    mode: 'min' | 'max';
}

interface NativeIndexedData {
    keys: string[];
    items: Value[];
    maps: Map<string, Map<string, number[]>>;
}

interface NativeTensorData {
    shape: number[];
    values: number[];
}

function isList(v: Value): v is AuraList {
    return typeof v === 'object' && v !== null && (v as any).type === 'list';
}

function isMap(v: Value): v is AuraMap {
    return typeof v === 'object' && v !== null && (v as any).type === 'map';
}

function isNative(v: Value): v is AuraNative {
    return typeof v === 'object' && v !== null && (v as any).type === 'native';
}

function isHeapData(data: unknown): data is NativeHeapData {
    return typeof data === 'object' && data !== null && Array.isArray((data as NativeHeapData).items);
}

function isIndexedData(data: unknown): data is NativeIndexedData {
    const d = data as NativeIndexedData;
    return typeof d === 'object' && d !== null &&
        Array.isArray(d.keys) && Array.isArray(d.items) && d.maps instanceof Map;
}

function tensorSize(shape: number[]): number {
    let size = 1;
    for (const dim of shape) size *= dim;
    return size;
}

function isTensorData(data: unknown): data is NativeTensorData {
    const d = data as NativeTensorData;
    return typeof d === 'object' && d !== null &&
        Array.isArray(d.shape) && Array.isArray(d.values) &&
        d.shape.every((dim) => Number.isInteger(dim) && dim >= 0) &&
        d.values.every((v) => typeof v === 'number') &&
        tensorSize(d.shape) === d.values.length;
}

function tensorToNested(shape: number[], values: number[]): Value {
    if (shape.length === 0) return values[0] ?? 0;
    if (shape.length === 1) return { type: 'list', items: values.map((v) => v as Value) } as AuraList;
    const step = tensorSize(shape.slice(1));
    const out: Value[] = [];
    for (let i = 0; i < shape[0]; i++) {
        const start = i * step;
        out.push(tensorToNested(shape.slice(1), values.slice(start, start + step)));
    }
    return { type: 'list', items: out } as AuraList;
}

function flattenTensorInput(input: Value): { shape: number[]; values: number[] } {
    const walk = (value: Value, path: string): { shape: number[]; values: number[] } => {
        if (typeof value === 'number') return { shape: [], values: [value] };
        if (!isList(value)) runtimeError('Tensor expects numeric values, invalid entry at ' + path);

        const items = value.items;
        if (items.length === 0) return { shape: [0], values: [] };

        const first = walk(items[0], path + '[0]');
        const childShape = first.shape;
        const out = [...first.values];

        for (let i = 1; i < items.length; i++) {
            const child = walk(items[i], path + '[' + i + ']');
            if (child.shape.length !== childShape.length || child.shape.some((dim, idx) => dim !== childShape[idx])) {
                runtimeError('Tensor expects rectangular nested lists; shape mismatch at ' + path + '[' + i + ']');
            }
            out.push(...child.values);
        }

        return { shape: [items.length, ...childShape], values: out };
    };

    const flat = walk(input, 'tensor');
    if (flat.shape.length === 0) return { shape: [1], values: flat.values };
    return flat;
}

function makeTensorFromValue(value: Value): AuraNative {
    if (isNative(value) && value.kind === 'tensor' && isTensorData(value.data)) {
        const data = value.data;
        return { type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: [...data.values] } as NativeTensorData };
    }
    if (typeof value === 'number') {
        return { type: 'native', kind: 'tensor', data: { shape: [1], values: [value] } as NativeTensorData };
    }
    if (!isList(value)) runtimeError('Tensor(value) expects a number, list, or tensor');
    const data = flattenTensorInput(value);
    return { type: 'native', kind: 'tensor', data };
}

function tensorDims(shapeValue: Value, context: string): number[] {
    if (!isList(shapeValue)) runtimeError(context + ' expects shape as list of dimensions');
    const dims: number[] = [];
    for (const entry of shapeValue.items) {
        const dim = asNumber(entry, context + ' shape');
        const n = Math.trunc(dim);
        if (n < 0 || n !== dim) runtimeError(context + ' dimensions must be non-negative integers');
        dims.push(n);
    }
    if (dims.length === 0) runtimeError(context + ' requires at least one dimension');
    return dims;
}

function makeTensorFromShape(shapeValue: Value, fillValue: Value): AuraNative {
    const dims = tensorDims(shapeValue, 'TensorShape');
    const fill = fillValue === undefined ? 0 : asNumber(fillValue, 'TensorShape fill');
    const size = tensorSize(dims);
    return { type: 'native', kind: 'tensor', data: { shape: dims, values: new Array(size).fill(fill) } as NativeTensorData };
}

function makeTensorRandom(shapeValue: Value, minValue: Value, maxValue: Value): AuraNative {
    const dims = tensorDims(shapeValue, 'TensorRand');
    const min = minValue === undefined ? 0 : asNumber(minValue, 'TensorRand min');
    const max = maxValue === undefined ? 1 : asNumber(maxValue, 'TensorRand max');
    if (max < min) runtimeError('TensorRand expects max >= min');
    const size = tensorSize(dims);
    const span = max - min;
    const values = new Array<number>(size);
    for (let i = 0; i < size; i++) values[i] = min + Math.random() * span;
    return { type: 'native', kind: 'tensor', data: { shape: dims, values } as NativeTensorData };
}

function makeTensorRandomNormal(shapeValue: Value, meanValue: Value, stdValue: Value): AuraNative {
    const dims = tensorDims(shapeValue, 'TensorRandn');
    const mean = meanValue === undefined ? 0 : asNumber(meanValue, 'TensorRandn mean');
    const std = stdValue === undefined ? 1 : asNumber(stdValue, 'TensorRandn std');
    if (std < 0) runtimeError('TensorRandn expects std >= 0');
    const size = tensorSize(dims);
    const values = new Array<number>(size);
    let i = 0;
    while (i < size) {
        const u1 = Math.max(Number.MIN_VALUE, Math.random());
        const u2 = Math.random();
        const r = Math.sqrt(-2 * Math.log(u1));
        const z0 = r * Math.cos(2 * Math.PI * u2);
        const z1 = r * Math.sin(2 * Math.PI * u2);
        values[i++] = mean + std * z0;
        if (i < size) values[i++] = mean + std * z1;
    }
    return { type: 'native', kind: 'tensor', data: { shape: dims, values } as NativeTensorData };
}

function makeTensorEye(nValue: Value, mValue: Value): AuraNative {
    const nRaw = asNumber(nValue, 'TensorEye n');
    const n = Math.trunc(nRaw);
    if (n < 0 || n !== nRaw) runtimeError('TensorEye n must be a non-negative integer');
    const mRaw = mValue === undefined ? n : asNumber(mValue, 'TensorEye m');
    const m = Math.trunc(mRaw);
    if (m < 0 || m !== mRaw) runtimeError('TensorEye m must be a non-negative integer');
    const values = new Array<number>(n * m).fill(0);
    const diag = Math.min(n, m);
    for (let i = 0; i < diag; i++) values[i * m + i] = 1;
    return { type: 'native', kind: 'tensor', data: { shape: [n, m], values } as NativeTensorData };
}

function asNumber(v: Value, context: string): number {
    if (typeof v !== 'number') runtimeError(`${context} requires numeric values`);
    return v;
}

function makeList(items: Value[]): AuraList {
    return { type: 'list', items };
}

function recordField(item: Value, field: string): Value | undefined {
    if ((item as any)?.type === 'map') return (item as AuraMap).entries.get(field);
    if ((item as any)?.type === 'instance') return (item as AuraInstance).fields.get(field);
    return undefined;
}

function rebuildIndexed(data: NativeIndexedData): void {
    data.maps.clear();
    for (const key of data.keys) data.maps.set(key, new Map<string, number[]>());
    for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i];
        for (const key of data.keys) {
            const raw = recordField(item, key);
            if (raw === undefined || raw === null) continue;
            const map = data.maps.get(key)!;
            const idxKey = auraToString(raw);
            if (!map.has(idxKey)) map.set(idxKey, []);
            map.get(idxKey)!.push(i);
        }
    }
}

function makeIndexed(keys: string[]): AuraNative {
    const unique = [...new Set(keys)];
    if (unique.length === 0) runtimeError('Indexed() requires at least one key');
    const maps = new Map<string, Map<string, number[]>>();
    for (const key of unique) maps.set(key, new Map());
    return { type: 'native', kind: 'indexed', data: { keys: unique, items: [], maps } as NativeIndexedData };
}

function toArray(v: Value): Value[] {
    if (typeof v === 'string') return [...v];
    if (isList(v)) return [...v.items];
    if (isMap(v)) return [...v.entries.values()];
    if (isNative(v)) {
        if (v.kind === 'hashmap' || v.kind === 'tree') return [...(v.data as Map<string, Value>).values()];
        if (v.kind === 'heap') return isHeapData(v.data) ? [...v.data.items] : [];
        if (v.kind === 'indexed') return isIndexedData(v.data) ? [...v.data.items] : [];
        if (v.kind === 'tensor') return isTensorData(v.data) ? v.data.values.map((n) => n as Value) : [];
        if (Array.isArray(v.data)) return [...v.data];
    }
    runtimeError(`Expected collection, got ${auraToString(v)}`);
}

function toSortedKeys(m: Map<string, Value>): string[] {
    return [...m.keys()].sort((a, b) => a.localeCompare(b));
}

function heapCompare(a: Value, b: Value, mode: 'min' | 'max'): number {
    const na = asNumber(a, 'Heap');
    const nb = asNumber(b, 'Heap');
    return mode === 'min' ? na - nb : nb - na;
}

function heapSiftUp(items: Value[], idx: number, mode: 'min' | 'max'): void {
    let i = idx;
    while (i > 0) {
        const parent = Math.floor((i - 1) / 2);
        if (heapCompare(items[parent], items[i], mode) <= 0) break;
        [items[parent], items[i]] = [items[i], items[parent]];
        i = parent;
    }
}

function heapSiftDown(items: Value[], idx: number, mode: 'min' | 'max'): void {
    let i = idx;
    while (true) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let best = i;
        if (left < items.length && heapCompare(items[best], items[left], mode) > 0) best = left;
        if (right < items.length && heapCompare(items[best], items[right], mode) > 0) best = right;
        if (best === i) break;
        [items[i], items[best]] = [items[best], items[i]];
        i = best;
    }
}

function heapPush(data: NativeHeapData, v: Value): void {
    asNumber(v, 'Heap');
    data.items.push(v);
    heapSiftUp(data.items, data.items.length - 1, data.mode);
}

function heapPop(data: NativeHeapData): Value {
    if (data.items.length === 0) return null;
    const root = data.items[0];
    const tail = data.items.pop()!;
    if (data.items.length > 0) {
        data.items[0] = tail;
        heapSiftDown(data.items, 0, data.mode);
    }
    return root;
}

function makeHeap(args: Value[]): AuraNative {
    const data: NativeHeapData = { items: [], mode: 'min' };
    for (const v of args) heapPush(data, v);
    return { type: 'native', kind: 'heap', data };
}

function mapFromArgs(args: Value[]): Map<string, Value> {
    if (args.length === 0) return new Map();
    if (args.length === 1) {
        const src = args[0];
        if (isMap(src)) return new Map(src.entries);
        if (isNative(src) && (src.kind === 'hashmap' || src.kind === 'tree')) {
            return new Map(src.data as Map<string, Value>);
        }
        if (isList(src)) {
            const out = new Map<string, Value>();
            for (const item of src.items) {
                if (isList(item) && item.items.length >= 2) {
                    out.set(auraToString(item.items[0]), item.items[1]);
                } else {
                    runtimeError('HashMap(List) expects list of [key, value] pairs');
                }
            }
            return out;
        }
    }
    if (args.length % 2 !== 0) runtimeError('HashMap/TreeMap expects key/value pairs');
    const out = new Map<string, Value>();
    for (let i = 0; i < args.length; i += 2) out.set(auraToString(args[i]), args[i + 1]);
    return out;
}

function jsToValue(input: unknown): Value {
    if (input === null || input === undefined) return null;
    if (typeof input === 'boolean' || typeof input === 'number' || typeof input === 'string') return input;
    if (Array.isArray(input)) return { type: 'list', items: input.map((v) => jsToValue(v)) } as AuraList;
    if (typeof input === 'object') {
        const entries = new Map<string, Value>();
        for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
            entries.set(k, jsToValue(v));
        }
        return { type: 'map', entries } as AuraMap;
    }
    return auraToString(input as Value);
}

function valueToJs(input: Value): unknown {
    if (input === null || typeof input === 'boolean' || typeof input === 'number' || typeof input === 'string') return input;
    if ((input as any).type === 'list') return (input as AuraList).items.map((v) => valueToJs(v));
    if ((input as any).type === 'map') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of (input as AuraMap).entries.entries()) out[k] = valueToJs(v);
        return out;
    }
    if ((input as any).type === 'enum') {
        const e = input as AuraEnum;
        return { tag: e.tag, values: e.values.map((v) => valueToJs(v)) };
    }
    if ((input as any).type === 'measure') {
        const m = input as AuraMeasure;
        return { dimension: m.dimension, value: m.baseValue / m.factor, unit: m.unit };
    }
    if ((input as any).type === 'native') {
        const n = input as AuraNative;
        if (n.kind === 'hashmap' || n.kind === 'tree') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of (n.data as Map<string, Value>).entries()) out[k] = valueToJs(v);
            return out;
        }
        if (n.kind === 'tensor' && isTensorData(n.data)) {
            return valueToJs(tensorToNested(n.data.shape, n.data.values));
        }
        if (Array.isArray(n.data)) return n.data.map((v: Value) => valueToJs(v));
    }
    return auraToString(input);
}

function mapOf(entries: Array<[string, Value]>): AuraMap {
    return { type: 'map', entries: new Map(entries) };
}

function mapValueOf(entries: Array<[string, Value]>): Value {
    return { type: 'map', entries: new Map(entries) } as AuraMap;
}

function listValueOf(items: Value[]): Value {
    return { type: 'list', items } as AuraList;
}

function readLineSync(prompt: string): string {
    if (prompt.length > 0) process.stdout.write(prompt);
    const chunks: number[] = [];
    const buf = Buffer.alloc(1);
    while (true) {
        const read = readSync(0, buf, 0, 1, null);
        if (read <= 0) break;
        const b = buf[0];
        if (b === 10) break; // \n
        if (b !== 13) chunks.push(b); // ignore \r
    }
    return Buffer.from(chunks).toString('utf8');
}

function parseJsonPath(path: string): Array<string | number> {
    const tokens: Array<string | number> = [];
    let i = 0;
    let current = '';
    while (i < path.length) {
        const ch = path[i];
        if (ch === '.') {
            if (current.length > 0) tokens.push(current);
            current = '';
            i++;
            continue;
        }
        if (ch === '[') {
            if (current.length > 0) tokens.push(current);
            current = '';
            const end = path.indexOf(']', i + 1);
            if (end < 0) runtimeError('Invalid json path: missing ]');
            const content = path.slice(i + 1, end).trim();
            const num = parseInt(content, 10);
            if (!Number.isNaN(num) && String(num) === content) tokens.push(num);
            else tokens.push(content.replace(/^['"]|['"]$/g, ''));
            i = end + 1;
            continue;
        }
        current += ch;
        i++;
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
}

function jsonPathGet(root: Value, path: string): { found: boolean; value: Value } {
    const tokens = parseJsonPath(path);
    let cur: Value = root;
    for (const token of tokens) {
        if (typeof token === 'number') {
            if ((cur as any)?.type !== 'list') return { found: false, value: null };
            const list = (cur as AuraList).items;
            const idx = token < 0 ? list.length + token : token;
            if (idx < 0 || idx >= list.length) return { found: false, value: null };
            cur = list[idx];
            continue;
        }
        if ((cur as any)?.type === 'map') {
            const m = cur as AuraMap;
            if (!m.entries.has(token)) return { found: false, value: null };
            cur = m.entries.get(token)!;
            continue;
        }
        if ((cur as any)?.type === 'native') {
            const n = cur as AuraNative;
            if ((n.kind === 'hashmap' || n.kind === 'tree') && (n.data as Map<string, Value>).has(token)) {
                cur = (n.data as Map<string, Value>).get(token)!;
                continue;
            }
        }
        return { found: false, value: null };
    }
    return { found: true, value: cur };
}

function sleepMs(ms: number): void {
    const duration = Math.max(0, Math.trunc(ms));
    if (duration === 0) return;
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    Atomics.wait(arr, 0, 0, duration);
}

function some(value: Value): AuraEnum {
    return { type: 'enum', tag: 'some', values: [value] };
}

function none(): AuraEnum {
    return { type: 'enum', tag: 'none', values: [] };
}

function ok(value: Value): AuraEnum {
    return { type: 'enum', tag: 'ok', values: [value] };
}

function err(value: Value): AuraEnum {
    return { type: 'enum', tag: 'error', values: [value] };
}

export function auraToString(v: Value): string {
    if (v === null) return 'nil';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    if (typeof v === 'string') return v;
    if ((v as any).type === 'list') return '[' + (v as AuraList).items.map(auraToString).join(', ') + ']';
    if ((v as any).type === 'map') {
        const m = v as AuraMap;
        const pairs = [...m.entries.entries()].map(([k, val]) => `"${k}": ${auraToString(val)}`);
        return '{' + pairs.join(', ') + '}';
    }
    if ((v as any).type === 'enum') {
        const e = v as AuraEnum;
        if (e.values.length === 0) return `.${e.tag}`;
        return `.${e.tag}(${e.values.map(auraToString).join(', ')})`;
    }
    if ((v as any).type === 'function') return `<fn ${(v as AuraFunction).name}>`;
    if ((v as any).type === 'class') return `<class ${(v as AuraClass).name}>`;
    if ((v as any).type === 'instance') return `<${(v as AuraInstance).klass.name} instance>`;
    if ((v as any).type === 'measure') {
        const m = v as AuraMeasure;
        const display = m.baseValue / m.factor;
        const n = Number.isInteger(display) ? String(display) : String(display);
        return `${n}${m.unit}`;
    }
    if ((v as any).type === 'builtin') return `<builtin ${(v as BuiltinFn).name}>`;
    if ((v as any).type === 'module') return `<module ${(v as AuraModule).name}>`;
    if ((v as any).type === 'native') {
        const native = v as AuraNative;
        if (native.kind === 'hashmap' || native.kind === 'tree') {
            const entries = [...(native.data as Map<string, Value>).entries()]
                .map(([k, val]) => `"${k}": ${auraToString(val)}`);
            return `<${native.kind} {${entries.join(', ')}}>`;
        }
        if (native.kind === 'heap') {
            const items = isHeapData(native.data) ? native.data.items : [];
            return `<heap [${items.map(auraToString).join(', ')}]>`;
        }
        if (native.kind === 'indexed') {
            const data = isIndexedData(native.data) ? native.data : { keys: [], items: [], maps: new Map() };
            return '<indexed keys=[' + data.keys.join(', ') + '] items=[' + data.items.map(auraToString).join(', ') + ']>';
        }
        if (native.kind === 'tensor') {
            const data = isTensorData(native.data) ? native.data : { shape: [0], values: [] };
            return '<tensor shape=[' + data.shape.join(', ') + '] values=[' + data.values.join(', ') + ']>';
        }
        const arr = Array.isArray(native.data) ? native.data : [];
        return '<' + native.kind + ' [' + arr.map(auraToString).join(', ') + ']>';
    }
    return String(v);
}

export function isTruthy(v: Value): boolean {
    if (v === null || v === false) return false;
    if (typeof v === 'number' && v === 0) return false;
    if (typeof v === 'string' && v === '') return false;
    return true;
}

function builtin(name: string, fn: (args: Value[]) => Value): BuiltinFn {
    return { type: 'builtin', name, fn };
}

export function makeBuiltins(): Map<string, Value> {
    const b = new Map<string, Value>();
    type UnitSymbol = { dimension: string; base: string; factor: number };
    const unitSymbols = new Map<string, UnitSymbol>();

    b.set('print', builtin('print', (args) => {
        process.stdout.write(args.map(auraToString).join('') + '\n');
        return null;
    }));

    b.set('panic', builtin('panic', ([msg]) => runtimeError(auraToString(msg ?? null))));

    b.set('__unit_register', builtin('__unit_register', ([dimension, base, symbol, factor]) => {
        if (typeof dimension !== 'string' || typeof base !== 'string' || typeof symbol !== 'string' || typeof factor !== 'number') {
            runtimeError('__unit_register(dimension, base, symbol, factor) expects (string, string, string, number)');
        }
        unitSymbols.set(symbol, { dimension, base, factor });
        return null;
    }));

    b.set('__measure', builtin('__measure', ([raw, symbol]) => {
        if (typeof raw !== 'number' || typeof symbol !== 'string') runtimeError('__measure(value, symbol) expects (number, string)');
        const def = unitSymbols.get(symbol);
        if (!def) runtimeError(`Unknown unit '${symbol}'`);
        return {
            type: 'measure',
            dimension: def.dimension,
            baseValue: raw * def.factor,
            unit: symbol,
            factor: def.factor,
        } as AuraMeasure;
    }));

    b.set('__measure_expect', builtin('__measure_expect', ([value, dimension]) => {
        if (typeof dimension !== 'string') runtimeError('__measure_expect(value, dimension) expects dimension string');
        if ((value as any)?.type !== 'measure') runtimeError(`Expected measure:${dimension}`);
        const m = value as AuraMeasure;
        if (m.dimension !== dimension) runtimeError(`Expected measure:${dimension}, got measure:${m.dimension}`);
        return value;
    }));

    b.set('__json_parse', builtin('__json_parse', ([text]) => {
        if (typeof text !== 'string') runtimeError('__json_parse(text) expects a string');
        try {
            return jsToValue(JSON.parse(text));
        } catch {
            runtimeError('Invalid JSON input');
        }
    }));

    b.set('__json_try_parse', builtin('__json_try_parse', ([text]) => {
        if (typeof text !== 'string') runtimeError('__json_try_parse(text) expects a string');
        try {
            return ok(jsToValue(JSON.parse(text)));
        } catch (e) {
            return err(String((e as Error).message ?? 'Invalid JSON input'));
        }
    }));

    b.set('__json_valid', builtin('__json_valid', ([text]) => {
        if (typeof text !== 'string') runtimeError('__json_valid(text) expects a string');
        try {
            JSON.parse(text);
            return true;
        } catch {
            return false;
        }
    }));

    b.set('__json_stringify', builtin('__json_stringify', ([value, pretty]) => {
        let indent = 0;
        if (typeof pretty === 'boolean') indent = pretty ? 2 : 0;
        else if (typeof pretty === 'number') indent = Math.max(0, Math.min(10, Math.trunc(pretty)));
        else if (pretty !== undefined && pretty !== null) runtimeError('__json_stringify(value, pretty?) expects bool or number for pretty');
        return JSON.stringify(valueToJs(value ?? null), null, indent);
    }));

    b.set('__json_typeof', builtin('__json_typeof', ([value]) => {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'string') return 'string';
        if (typeof value === 'number') return 'number';
        if (typeof value === 'boolean') return 'boolean';
        if ((value as any)?.type === 'list') return 'array';
        if ((value as any)?.type === 'map' || ((value as any)?.type === 'native' && (((value as AuraNative).kind === 'hashmap') || ((value as AuraNative).kind === 'tree')))) {
            return 'object';
        }
        return 'other';
    }));

    b.set('__json_get_path', builtin('__json_get_path', ([root, path, fallback]) => {
        if (typeof path !== 'string') runtimeError('__json_get_path(value, path, fallback?) expects path string');
        const out = jsonPathGet(root ?? null, path);
        return out.found ? out.value : (fallback ?? null);
    }));

    b.set('__json_has_path', builtin('__json_has_path', ([root, path]) => {
        if (typeof path !== 'string') runtimeError('__json_has_path(value, path) expects path string');
        return jsonPathGet(root ?? null, path).found;
    }));

    b.set('__fs_exists', builtin('__fs_exists', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_exists(path) expects a string path');
        return existsSync(path);
    }));

    b.set('__fs_read', builtin('__fs_read', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_read(path) expects a string path');
        try {
            return readFileSync(path, 'utf8');
        } catch (e) {
            runtimeError(`fs.read failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_write', builtin('__fs_write', ([path, content]) => {
        if (typeof path !== 'string' || typeof content !== 'string') runtimeError('__fs_write(path, content) expects (string, string)');
        try {
            writeFileSync(path, content, 'utf8');
            return null;
        } catch (e) {
            runtimeError(`fs.write failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_append', builtin('__fs_append', ([path, content]) => {
        if (typeof path !== 'string' || typeof content !== 'string') runtimeError('__fs_append(path, content) expects (string, string)');
        try {
            appendFileSync(path, content, 'utf8');
            return null;
        } catch (e) {
            runtimeError(`fs.append failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_delete', builtin('__fs_delete', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_delete(path) expects a string path');
        try {
            rmSync(path, { force: true, recursive: true });
            return null;
        } catch (e) {
            runtimeError(`fs.delete failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_mkdir', builtin('__fs_mkdir', ([path, recursive]) => {
        if (typeof path !== 'string') runtimeError('__fs_mkdir(path, recursive?) expects a string path');
        if (recursive !== undefined && recursive !== null && typeof recursive !== 'boolean') runtimeError('__fs_mkdir(path, recursive?) recursive must be bool');
        try {
            mkdirSync(path, { recursive: recursive === undefined || recursive === null ? true : recursive });
            return null;
        } catch (e) {
            runtimeError(`fs.mkdir failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_list', builtin('__fs_list', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_list(path) expects a string path');
        try {
            return { type: 'list', items: readdirSync(path).sort((a, c) => a.localeCompare(c)) } as AuraList;
        } catch (e) {
            runtimeError(`fs.list failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_stat', builtin('__fs_stat', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_stat(path) expects a string path');
        if (!existsSync(path)) {
            return mapOf([
                ['exists', false],
                ['is_file', false],
                ['is_dir', false],
                ['size', 0],
                ['mtime_ms', 0],
            ]);
        }
        try {
            const st = statSync(path);
            return mapOf([
                ['exists', true],
                ['is_file', st.isFile()],
                ['is_dir', st.isDirectory()],
                ['size', st.size],
                ['mtime_ms', st.mtimeMs],
            ]);
        } catch (e) {
            runtimeError(`fs.stat failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_copy', builtin('__fs_copy', ([src, dst, overwrite]) => {
        if (typeof src !== 'string' || typeof dst !== 'string') runtimeError('__fs_copy(src, dst, overwrite?) expects (string, string, bool?)');
        const canOverwrite = overwrite === undefined || overwrite === null ? true : Boolean(overwrite);
        if (!canOverwrite && existsSync(dst)) runtimeError(`fs.copy failed: destination exists '${dst}'`);
        try {
            copyFileSync(src, dst);
            return null;
        } catch (e) {
            runtimeError(`fs.copy failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_move', builtin('__fs_move', ([src, dst, overwrite]) => {
        if (typeof src !== 'string' || typeof dst !== 'string') runtimeError('__fs_move(src, dst, overwrite?) expects (string, string, bool?)');
        const canOverwrite = overwrite === undefined || overwrite === null ? true : Boolean(overwrite);
        if (!canOverwrite && existsSync(dst)) runtimeError(`fs.move failed: destination exists '${dst}'`);
        if (canOverwrite && existsSync(dst)) rmSync(dst, { recursive: true, force: true });
        try {
            renameSync(src, dst);
            return null;
        } catch (e) {
            runtimeError(`fs.move failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_cwd', builtin('__fs_cwd', (args) => {
        if (args.length !== 0) runtimeError('__fs_cwd() takes no arguments');
        return process.cwd();
    }));

    b.set('__fs_abs', builtin('__fs_abs', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_abs(path) expects path string');
        return isAbsolute(path) ? pathNormalize(path) : pathResolve(process.cwd(), path);
    }));

    b.set('__fs_join', builtin('__fs_join', (args) => {
        const parts: string[] = [];
        if (args.length === 1 && (args[0] as any)?.type === 'list') {
            for (const item of (args[0] as AuraList).items) parts.push(auraToString(item));
        } else {
            for (const arg of args) parts.push(auraToString(arg));
        }
        if (parts.length === 0) return '';
        return pathNormalize(pathJoin(...parts));
    }));

    b.set('__fs_basename', builtin('__fs_basename', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_basename(path) expects path string');
        return pathBasename(path);
    }));

    b.set('__fs_dirname', builtin('__fs_dirname', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_dirname(path) expects path string');
        return pathDirname(path);
    }));

    b.set('__fs_extname', builtin('__fs_extname', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_extname(path) expects path string');
        return pathExtname(path);
    }));

    b.set('__fs_normalize', builtin('__fs_normalize', ([path]) => {
        if (typeof path !== 'string') runtimeError('__fs_normalize(path) expects path string');
        return pathNormalize(path);
    }));

    b.set('__fs_walk', builtin('__fs_walk', ([root, recursive]) => {
        if (typeof root !== 'string') runtimeError('__fs_walk(path, recursive?) expects path string');
        const walkRecursive = recursive === undefined || recursive === null ? true : Boolean(recursive);
        if (!existsSync(root)) return listValueOf([]);
        const out: Value[] = [];
        const visit = (dir: string, prefix: string) => {
            const entries = readdirSync(dir, { withFileTypes: true }).sort((a, c) => a.name.localeCompare(c.name));
            for (const entry of entries) {
                const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
                out.push(rel);
                if (walkRecursive && entry.isDirectory()) visit(pathJoin(dir, entry.name), rel);
            }
        };
        try {
            visit(root, '');
            return listValueOf(out);
        } catch (e) {
            runtimeError(`fs.walk failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__fs_temp_dir', builtin('__fs_temp_dir', ([prefix]) => {
        const p = prefix === undefined || prefix === null ? 'aura-' : auraToString(prefix);
        return mkdtempSync(pathJoin(tmpdir(), p));
    }));

    b.set('__io_write_err', builtin('__io_write_err', (args) => {
        process.stderr.write(args.map(auraToString).join(''));
        return null;
    }));

    b.set('__io_write', builtin('__io_write', (args) => {
        process.stdout.write(args.map(auraToString).join(''));
        return null;
    }));

    b.set('__io_writeln', builtin('__io_writeln', (args) => {
        process.stdout.write(args.map(auraToString).join('') + '\n');
        return null;
    }));

    b.set('__io_writeln_err', builtin('__io_writeln_err', (args) => {
        process.stderr.write(args.map(auraToString).join('') + '\n');
        return null;
    }));

    b.set('__io_read_line', builtin('__io_read_line', ([prompt]) => {
        if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') runtimeError('__io_read_line(prompt?) expects prompt string');
        return readLineSync(prompt ?? '');
    }));

    b.set('__io_read_all_stdin', builtin('__io_read_all_stdin', (args) => {
        if (args.length !== 0) runtimeError('__io_read_all_stdin() takes no arguments');
        try {
            return readFileSync(0, 'utf8');
        } catch (e) {
            runtimeError(`io.read_all_stdin failed: ${String((e as Error).message ?? e)}`);
        }
    }));

    b.set('__time_now_ms', builtin('__time_now_ms', (args) => {
        if (args.length !== 0) runtimeError('__time_now_ms() takes no arguments');
        return Date.now();
    }));

    b.set('__time_now_unix_s', builtin('__time_now_unix_s', (args) => {
        if (args.length !== 0) runtimeError('__time_now_unix_s() takes no arguments');
        return Math.floor(Date.now() / 1000);
    }));

    b.set('__time_iso_now', builtin('__time_iso_now', (args) => {
        if (args.length !== 0) runtimeError('__time_iso_now() takes no arguments');
        return new Date().toISOString();
    }));

    b.set('__time_monotonic_ms', builtin('__time_monotonic_ms', (args) => {
        if (args.length !== 0) runtimeError('__time_monotonic_ms() takes no arguments');
        return Number(process.hrtime.bigint() / BigInt(1_000_000));
    }));

    b.set('__time_sleep_ms', builtin('__time_sleep_ms', ([ms]) => {
        if (typeof ms !== 'number') runtimeError('__time_sleep_ms(ms) expects a number');
        sleepMs(ms);
        return null;
    }));

    b.set('__time_parse_iso', builtin('__time_parse_iso', ([text]) => {
        if (typeof text !== 'string') runtimeError('__time_parse_iso(text) expects a string');
        const v = Date.parse(text);
        if (Number.isNaN(v)) runtimeError('Invalid ISO datetime');
        return v;
    }));

    b.set('__time_from_unix_ms', builtin('__time_from_unix_ms', ([ms]) => {
        if (typeof ms !== 'number') runtimeError('__time_from_unix_ms(ms) expects a number');
        return new Date(ms).toISOString();
    }));

    b.set('__time_from_unix_s', builtin('__time_from_unix_s', ([sec]) => {
        if (typeof sec !== 'number') runtimeError('__time_from_unix_s(sec) expects a number');
        return new Date(sec * 1000).toISOString();
    }));

    b.set('__time_to_unix_s', builtin('__time_to_unix_s', ([ms]) => {
        if (typeof ms !== 'number') runtimeError('__time_to_unix_s(ms) expects a number');
        return Math.floor(ms / 1000);
    }));

    b.set('__time_parts', builtin('__time_parts', ([ms]) => {
        const ts = ms === undefined || ms === null ? Date.now() : asNumber(ms, '__time_parts');
        const d = new Date(ts);
        return mapValueOf([
            ['year', d.getUTCFullYear()],
            ['month', d.getUTCMonth() + 1],
            ['day', d.getUTCDate()],
            ['hour', d.getUTCHours()],
            ['minute', d.getUTCMinutes()],
            ['second', d.getUTCSeconds()],
            ['ms', d.getUTCMilliseconds()],
            ['weekday', d.getUTCDay()],
            ['iso', d.toISOString()],
            ['unix_ms', d.getTime()],
            ['unix_s', Math.floor(d.getTime() / 1000)],
        ]);
    }));

    b.set('__time_add_ms', builtin('__time_add_ms', ([ms, delta]) => {
        if (typeof ms !== 'number' || typeof delta !== 'number') runtimeError('__time_add_ms(ms, delta) expects numbers');
        return ms + delta;
    }));

    b.set('__time_diff_ms', builtin('__time_diff_ms', ([a, c]) => {
        if (typeof a !== 'number' || typeof c !== 'number') runtimeError('__time_diff_ms(a, b) expects numbers');
        return a - c;
    }));

    b.set('len', builtin('len', ([v]) => {
        if (!v) return 0;
        if (typeof v === 'string') return v.length;
        if ((v as any).type === 'list') return (v as AuraList).items.length;
        if ((v as any).type === 'map') return (v as AuraMap).entries.size;
        if ((v as any).type === 'native') {
            const native = v as AuraNative;
            if (native.kind === 'hashmap' || native.kind === 'tree') return (native.data as Map<string, Value>).size;
            if (native.kind === 'heap') return isHeapData(native.data) ? native.data.items.length : 0;
            if (native.kind === 'indexed') return isIndexedData(native.data) ? native.data.items.length : 0;
            if (native.kind === 'tensor') return isTensorData(native.data) ? native.data.values.length : 0;
            if (Array.isArray(native.data)) return native.data.length;
        }
        runtimeError(`len() not supported on ${typeof v}`);
    }));

    b.set('min', builtin('min', ([a, c]) => {
        if (typeof a !== 'number' || typeof c !== 'number') runtimeError('min() requires numbers');
        return Math.min(a, c);
    }));

    b.set('max', builtin('max', ([a, c]) => {
        if (typeof a !== 'number' || typeof c !== 'number') runtimeError('max() requires numbers');
        return Math.max(a, c);
    }));

    b.set('str', builtin('str', ([v]) => auraToString(v ?? null)));

    b.set('int', builtin('int', ([v]) => {
        if (typeof v === 'number') return Math.trunc(v);
        if (typeof v === 'string') { const n = parseInt(v, 10); if (!isNaN(n)) return n; }
        runtimeError(`Cannot convert ${auraToString(v ?? null)} to Int`);
    }));

    b.set('float', builtin('float', ([v]) => {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') { const n = parseFloat(v); if (!isNaN(n)) return n; }
        runtimeError(`Cannot convert ${auraToString(v ?? null)} to Float`);
    }));

    b.set('abs', builtin('abs', ([v]) => {
        if (typeof v !== 'number') runtimeError('abs() requires a number');
        return Math.abs(v);
    }));

    b.set('sqrt', builtin('sqrt', ([v]) => {
        if (typeof v !== 'number') runtimeError('sqrt() requires a number');
        return Math.sqrt(v);
    }));

    b.set('range', builtin('range', ([start, end]) => {
        if (typeof start !== 'number' || typeof end !== 'number') runtimeError('range() requires numbers');
        return { type: 'range', start, end, inclusive: false } as AuraRange;
    }));

    b.set('Option', builtin('Option', (args) => {
        if (args.length > 1) runtimeError('Option(value?) accepts at most one argument');
        if (args.length === 0 || args[0] === null) return none();
        return some(args[0]);
    }));
    b.set('Some', builtin('Some', ([value]) => {
        if (value === undefined) runtimeError('Some(value) requires one argument');
        return some(value);
    }));
    b.set('None', builtin('None', (args) => {
        if (args.length !== 0) runtimeError('None() takes no arguments');
        return none();
    }));

    b.set('Result', builtin('Result', ([value, errorValue]) => {
        if (value === undefined && errorValue === undefined) runtimeError('Result(value, error?) requires at least one argument');
        if (errorValue !== undefined && errorValue !== null) return err(errorValue);
        return ok(value ?? null);
    }));
    b.set('Ok', builtin('Ok', ([value]) => {
        if (value === undefined) runtimeError('Ok(value) requires one argument');
        return ok(value);
    }));
    b.set('Err', builtin('Err', ([value]) => {
        if (value === undefined) runtimeError('Err(value) requires one argument');
        return err(value);
    }));

    b.set('is_some', builtin('is_some', ([v]) => (v as any)?.type === 'enum' && (v as AuraEnum).tag === 'some'));
    b.set('is_none', builtin('is_none', ([v]) => (v as any)?.type === 'enum' && (v as AuraEnum).tag === 'none'));
    b.set('is_ok', builtin('is_ok', ([v]) => (v as any)?.type === 'enum' && (v as AuraEnum).tag === 'ok'));
    b.set('is_err', builtin('is_err', ([v]) => (v as any)?.type === 'enum' && (v as AuraEnum).tag === 'error'));

    b.set('List', builtin('List', (args) => ({ type: 'list', items: [...args] } as AuraList)));
    b.set('Stack', builtin('Stack', (args) => ({ type: 'native', kind: 'stack', data: [...args] } as AuraNative)));
    b.set('Queue', builtin('Queue', (args) => ({ type: 'native', kind: 'queue', data: [...args] } as AuraNative)));
    b.set('LinkedList', builtin('LinkedList', (args) => ({ type: 'native', kind: 'linked_list', data: [...args] } as AuraNative)));
    b.set('HashMap', builtin('HashMap', (args) => ({ type: 'native', kind: 'hashmap', data: mapFromArgs(args) } as AuraNative)));
    b.set('TreeMap', builtin('TreeMap', (args) => ({ type: 'native', kind: 'tree', data: mapFromArgs(args) } as AuraNative)));
    b.set('Heap', builtin('Heap', (args) => makeHeap(args)));
    b.set('Indexed', builtin('Indexed', (args) => {
        if (args.length >= 1 && isList(args[0])) {
            const keys = (args[0] as AuraList).items.map((v) => auraToString(v));
            const indexed = makeIndexed(keys);
            if (args.length >= 2) {
                const data = indexed.data as NativeIndexedData;
                for (const item of toArray(args[1])) data.items.push(item);
                rebuildIndexed(data);
            }
            return indexed;
        }
        const keys = args.map((v) => auraToString(v));
        return makeIndexed(keys);
    }));
    b.set('Tensor', builtin('Tensor', (args) => {
        if (args.length !== 1) runtimeError('Tensor(value) expects exactly one argument');
        return makeTensorFromValue(args[0]);
    }));
    b.set('TensorShape', builtin('TensorShape', (args) => {
        if (args.length < 1 || args.length > 2) runtimeError('TensorShape(shape, fill?) expects 1 or 2 arguments');
        return makeTensorFromShape(args[0], args[1]);
    }));
    b.set('TensorRand', builtin('TensorRand', (args) => {
        if (args.length < 1 || args.length > 3) runtimeError('TensorRand(shape, min?, max?) expects 1 to 3 arguments');
        return makeTensorRandom(args[0], args[1], args[2]);
    }));
    b.set('TensorRandn', builtin('TensorRandn', (args) => {
        if (args.length < 1 || args.length > 3) runtimeError('TensorRandn(shape, mean?, std?) expects 1 to 3 arguments');
        return makeTensorRandomNormal(args[0], args[1], args[2]);
    }));
    b.set('TensorEye', builtin('TensorEye', (args) => {
        if (args.length < 1 || args.length > 2) runtimeError('TensorEye(n, m?) expects 1 or 2 arguments');
        return makeTensorEye(args[0], args[1]);
    }));

    b.set('to_list', builtin('to_list', ([v]) => makeList(toArray(v))));
    b.set('sum', builtin('sum', ([v]) => toArray(v).reduce<number>((acc, cur) => acc + asNumber(cur, 'sum'), 0)));
    b.set('sort', builtin('sort', ([v]) => {
        const items = toArray(v);
        const sorted = [...items].sort((a, c) => {
            if (typeof a === 'number' && typeof c === 'number') return a - c;
            return auraToString(a).localeCompare(auraToString(c));
        });
        return makeList(sorted);
    }));
    b.set('unique', builtin('unique', ([v]) => {
        const seen = new Set<string>();
        const out: Value[] = [];
        for (const item of toArray(v)) {
            const key = auraToString(item);
            if (!seen.has(key)) {
                seen.add(key);
                out.push(item);
            }
        }
        return makeList(out);
    }));
    b.set('top_k', builtin('top_k', ([v, k]) => {
        const n = Math.max(0, Math.trunc(asNumber(k, 'top_k')));
        const nums = toArray(v).map((item) => asNumber(item, 'top_k'));
        nums.sort((a, c) => c - a);
        return makeList(nums.slice(0, n));
    }));
    b.set('freq', builtin('freq', ([v]) => {
        const counts = new Map<string, Value>();
        for (const item of toArray(v)) {
            const key = auraToString(item);
            const cur = counts.get(key);
            counts.set(key, typeof cur === 'number' ? cur + 1 : 1);
        }
        return { type: 'map', entries: counts } as AuraMap;
    }));
    b.set('chunk', builtin('chunk', ([v, size]) => {
        const step = Math.max(1, Math.trunc(asNumber(size, 'chunk')));
        const input = toArray(v);
        const out: Value[] = [];
        for (let i = 0; i < input.length; i += step) out.push(makeList(input.slice(i, i + step)));
        return makeList(out);
    }));
    b.set('window', builtin('window', ([v, size]) => {
        const win = Math.max(1, Math.trunc(asNumber(size, 'window')));
        const input = toArray(v);
        const out: Value[] = [];
        for (let i = 0; i + win <= input.length; i++) out.push(makeList(input.slice(i, i + win)));
        return makeList(out);
    }));
    b.set('take', builtin('take', ([v, n]) => {
        const count = Math.max(0, Math.trunc(asNumber(n, 'take')));
        return makeList(toArray(v).slice(0, count));
    }));
    b.set('drop', builtin('drop', ([v, n]) => {
        const count = Math.max(0, Math.trunc(asNumber(n, 'drop')));
        return makeList(toArray(v).slice(count));
    }));

    return b;
}

export function getInstanceAttr(inst: AuraInstance, name: string): Value {
    if (inst.fields.has(name)) return inst.fields.get(name)!;
    const method = inst.klass.methods.get(name);
    if (method) {
        const bound: AuraFunction = { ...method, receiver: inst };
        return bound;
    }
    runtimeError(`'${inst.klass.name}' has no attribute '${name}'`);
}

export function getModuleAttr(mod: AuraModule, name: string): Value {
    if (mod.attrs.has(name)) return mod.attrs.get(name)!;
    runtimeError(`Module '${mod.name}' has no attribute '${name}'`);
}

export function makeIterator(v: Value): AuraIterator {
    if ((v as any).type === 'list') return { type: 'iter', source: v as AuraList, index: 0 };
    if ((v as any).type === 'range') return { type: 'iter', source: v as AuraRange, index: 0 };
    if ((v as any).type === 'map') {
        const keys = toSortedKeys((v as AuraMap).entries);
        return { type: 'iter', source: { type: 'list', items: keys }, index: 0 };
    }
    if ((v as any).type === 'native') {
        const native = v as AuraNative;
        if (native.kind === 'hashmap' || native.kind === 'tree') {
            const keys = toSortedKeys(native.data as Map<string, Value>);
            return { type: 'iter', source: { type: 'list', items: keys }, index: 0 };
        }
        if (native.kind === 'heap') {
            const items = isHeapData(native.data) ? [...native.data.items] : [];
            return { type: 'iter', source: { type: 'list', items }, index: 0 };
        }
        if (native.kind === 'indexed') {
            const items = isIndexedData(native.data) ? [...native.data.items] : [];
            return { type: 'iter', source: { type: 'list', items }, index: 0 };
        }
        if (native.kind === 'tensor') {
            const items = isTensorData(native.data) ? native.data.values.map((v) => v as Value) : [];
            return { type: 'iter', source: { type: 'list', items }, index: 0 };
        }
        const items = Array.isArray(native.data) ? [...native.data] : [];
        return { type: 'iter', source: { type: 'list', items }, index: 0 };
    }
    runtimeError(`Value is not iterable: ${auraToString(v)}`);
}

export function iterNext(it: AuraIterator): Value | typeof DONE {
    if (it.source.type === 'range') {
        const r = it.source as AuraRange;
        const val = r.start + it.index;
        const done = r.inclusive ? val > r.end : val >= r.end;
        if (done) return DONE;
        it.index++;
        return val;
    } else {
        const list = it.source as AuraList;
        if (it.index >= list.items.length) return DONE;
        return list.items[it.index++];
    }
}

export const DONE = Symbol('DONE');
