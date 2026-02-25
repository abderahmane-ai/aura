import {
    Value, AuraList, AuraMap, AuraRange, AuraIterator, AuraNative,
    AuraFunction, AuraClass, AuraInstance, AuraEnum, AuraModule, BuiltinFn, AuraMeasure,
} from './types.js';
import { runtimeError } from './errors.js';

interface NativeHeapData {
    items: Value[];
    mode: 'min' | 'max';
}

interface NativeIndexedData {
    keys: string[];
    items: Value[];
    maps: Map<string, Map<string, number[]>>;
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
    if ((v as any).type === 'enum') { const e = v as AuraEnum; return `.${e.tag}(${e.values.map(auraToString).join(', ')})`; }
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
            return `<indexed keys=[${data.keys.join(', ')}] items=[${data.items.map(auraToString).join(', ')}]>`;
        }
        const arr = Array.isArray(native.data) ? native.data : [];
        return `<${native.kind} [${arr.map(auraToString).join(', ')}]>`;
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

export function makeIoModule(): AuraModule {
    const attrs = new Map<string, Value>([
        ['println', builtin('io.println', (args) => {
            process.stdout.write(args.map(auraToString).join('') + '\n');
            return null;
        })],
        ['print', builtin('io.print', (args) => {
            process.stdout.write(args.map(auraToString).join(''));
            return null;
        })],
    ]);
    return { type: 'module', name: 'io', attrs };
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

    b.set('io', makeIoModule());

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
        const keys = [...(v as AuraMap).entries.keys()];
        return { type: 'iter', source: { type: 'list', items: keys }, index: 0 };
    }
    if ((v as any).type === 'native') {
        const native = v as AuraNative;
        if (native.kind === 'hashmap' || native.kind === 'tree') {
            const keys = native.kind === 'tree'
                ? toSortedKeys(native.data as Map<string, Value>)
                : [...(native.data as Map<string, Value>).keys()];
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
