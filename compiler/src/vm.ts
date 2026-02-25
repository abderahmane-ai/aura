import {
    Chunk, Value,
    AuraFunction, AuraClass, AuraInstance, AuraEnum,
    AuraList, AuraMap, AuraRange, AuraIterator, AuraModule, BuiltinFn, AuraNative, AuraMeasure,
} from './types.js';
import {
    makeBuiltins, auraToString, isTruthy,
    getInstanceAttr, getModuleAttr, makeIterator, iterNext, DONE,
} from './builtins.js';
import { AuraError, runtimeError, StackFrame } from './errors.js';

interface NativeHeapData {
    items: Value[];
    mode: 'min' | 'max';
}

interface NativeIndexedData {
    keys: string[];
    items: Value[];
    maps: Map<string, Map<string, number[]>>;
}

interface CallFrame {
    chunk: Chunk;
    ip: number;
    locals: Map<string, Value>;
    receiver?: AuraInstance;
    constructing?: AuraInstance;
    fnName?: string;
    file?: string;
}

export class VM {
    private stack: Value[] = [];
    private globals: Map<string, Value>;
    private frames: CallFrame[] = [];

    constructor() {
        this.globals = makeBuiltins();
    }

    run(chunk: Chunk): Value {
        this.pushFrame(chunk, new Map(), undefined);
        return this.execute(0);
    }

    setGlobal(name: string, value: Value): void {
        this.globals.set(name, value);
    }

    getGlobal(name: string): Value | undefined {
        return this.globals.get(name);
    }

    hasGlobal(name: string): boolean {
        return this.globals.has(name);
    }

    private execute(untilDepth: number): Value {
        while (this.frames.length > untilDepth) {
            const frame = this.frames[this.frames.length - 1];
            if (!frame) break;
            if (frame.ip >= frame.chunk.code.length) {
                this.frames.pop();
                const out: Value = null;
                if (this.frames.length === untilDepth) return out;
                this.push(out);
                continue;
            }
            const instr = frame.chunk.code[frame.ip++];
            try {
                switch (instr.op) {
                    case 'HALT': {
                        this.frames.pop();
                        const out = this.stack.pop() ?? null;
                        if (this.frames.length === untilDepth) return out;
                        this.push(out);
                        break;
                    }

                    case 'PUSH_CONST': this.push(frame.chunk.constants[instr.arg as number]); break;
                    case 'PUSH_TRUE': this.push(true); break;
                    case 'PUSH_FALSE': this.push(false); break;
                    case 'PUSH_NIL': this.push(null); break;

                    case 'POP': this.pop(); break;
                    case 'DUP': this.push(this.peek()); break;
                    case 'SWAP': { const a = this.pop(); const b = this.pop(); this.push(a); this.push(b); break; }

                    case 'DEFINE_GLOBAL': this.globals.set(instr.arg as string, this.pop()); break;
                    case 'GET_GLOBAL': {
                        const name = instr.arg as string;
                        if (!this.globals.has(name)) runtimeError(`Undefined name '${name}'`);
                        this.push(this.globals.get(name)!);
                        break;
                    }
                    case 'SET_GLOBAL': this.globals.set(instr.arg as string, this.pop()); break;
                    case 'GET_LOCAL': {
                        const name = instr.arg as string;
                        if (name === 'self' && frame.receiver) { this.push(frame.receiver); break; }
                        if (!frame.locals.has(name)) {
                            if (this.globals.has(name)) { this.push(this.globals.get(name)!); break; }
                            runtimeError(`Undefined local '${name}'`);
                        }
                        this.push(frame.locals.get(name)!);
                        break;
                    }
                    case 'SET_LOCAL': frame.locals.set(instr.arg as string, this.pop()); break;

                    case 'ADD': { const b = this.pop(), a = this.pop(); this.push(this.add(a, b)); break; }
                    case 'SUB': { const b = this.pop(), a = this.pop(); this.push(this.sub(a, b)); break; }
                    case 'MUL': { const b = this.pop(), a = this.pop(); this.push(this.mul(a, b)); break; }
                    case 'DIV': { const b = this.pop(), a = this.pop(); this.push(this.div(a, b)); break; }
                    case 'MOD': { const b = this.pop(), a = this.pop(); this.push((a as number) % (b as number)); break; }
                    case 'POW': { const b = this.pop(), a = this.pop(); this.push(Math.pow(a as number, b as number)); break; }
                    case 'NEG': { const a = this.pop(); this.push(-(a as number)); break; }
                    case 'CONCAT': { const b = this.pop(), a = this.pop(); this.push(String(a) + String(b)); break; }

                case 'EQ': { const b = this.pop(), a = this.pop(); this.push(this.equal(a, b)); break; }
                case 'NEQ': { const b = this.pop(), a = this.pop(); this.push(!this.equal(a, b)); break; }
                case 'LT': { const b = this.pop(), a = this.pop(); this.push(this.compare(a, b) < 0); break; }
                case 'GT': { const b = this.pop(), a = this.pop(); this.push(this.compare(a, b) > 0); break; }
                case 'LE': { const b = this.pop(), a = this.pop(); this.push(this.compare(a, b) <= 0); break; }
                case 'GE': { const b = this.pop(), a = this.pop(); this.push(this.compare(a, b) >= 0); break; }
                case 'NOT': { this.push(!isTruthy(this.pop())); break; }
                case 'AND': { const b = this.pop(), a = this.pop(); this.push(isTruthy(a) ? b : a); break; }
                case 'OR': { const b = this.pop(), a = this.pop(); this.push(isTruthy(a) ? a : b); break; }

                case 'JUMP': frame.ip = instr.arg as number; break;
                case 'JUMP_IF_FALSE': { const v = this.pop(); if (!isTruthy(v)) frame.ip = instr.arg as number; break; }
                case 'JUMP_IF_TRUE': { const v = this.pop(); if (isTruthy(v)) frame.ip = instr.arg as number; break; }

                case 'BUILD_LIST': {
                    const n = instr.arg as number;
                    const items = this.stack.splice(this.stack.length - n, n);
                    this.push({ type: 'list', items } as AuraList);
                    break;
                }
                case 'BUILD_MAP': {
                    const n = instr.arg as number;
                    const entries = new Map<string, Value>();
                    const pairs = this.stack.splice(this.stack.length - n * 2, n * 2);
                    for (let i = 0; i < pairs.length; i += 2) entries.set(auraToString(pairs[i]), pairs[i + 1]);
                    this.push({ type: 'map', entries } as AuraMap);
                    break;
                }
                case 'BUILD_RANGE': {
                    const end = this.pop() as number, start = this.pop() as number;
                    this.push({ type: 'range', start, end, inclusive: instr.arg as boolean } as AuraRange);
                    break;
                }
                case 'BUILD_ENUM': {
                    const [tag, countStr] = (instr.arg as string).split(':');
                    const n = parseInt(countStr, 10);
                    const vals = this.stack.splice(this.stack.length - n, n);
                    this.push({ type: 'enum', tag, values: vals } as AuraEnum);
                    break;
                }
                case 'BUILD_STRING': {
                    const n = instr.arg as number;
                    const parts = this.stack.splice(this.stack.length - n, n);
                    this.push(parts.map(auraToString).join(''));
                    break;
                }

                case 'GET_ITER': {
                    const v = this.pop();
                    this.push(makeIterator(v));
                    break;
                }
                case 'FOR_ITER': {
                    const it = this.peek() as AuraIterator;
                    const next = iterNext(it);
                    if (next === DONE) { frame.ip = instr.arg as number; }
                    else { this.push(next); }
                    break;
                }

                case 'GET_ATTR': {
                    const obj = this.pop();
                    const attr = instr.arg as string;
                    this.push(this.getAttr(obj, attr));
                    break;
                }
                case 'SET_ATTR': {
                    const val = this.pop();
                    const obj = this.pop();
                    const attr = instr.arg as string;
                    if ((obj as any)?.type === 'instance') {
                        (obj as AuraInstance).fields.set(attr, val);
                    } else {
                        runtimeError(`Cannot set attribute '${attr}' on ${auraToString(obj)}`);
                    }
                    break;
                }
                case 'GET_INDEX': {
                    const idx = this.pop();
                    const obj = this.pop();
                    if ((obj as any)?.type === 'list') {
                        const list = obj as AuraList;
                        const i = idx as number;
                        const realIdx = i < 0 ? list.items.length + i : i;
                        if (realIdx < 0 || realIdx >= list.items.length) runtimeError(`Index ${i} out of bounds`);
                        this.push(list.items[realIdx]);
                    } else if ((obj as any)?.type === 'map') {
                        const m = obj as AuraMap;
                        this.push(m.entries.get(auraToString(idx)) ?? null);
                    } else {
                        runtimeError(`Cannot index ${auraToString(obj)}`);
                    }
                    break;
                }
                case 'SET_INDEX': {
                    const val = this.pop(), idx = this.pop(), obj = this.pop();
                    if ((obj as any)?.type === 'list') (obj as AuraList).items[idx as number] = val;
                    else if ((obj as any)?.type === 'map') (obj as AuraMap).entries.set(auraToString(idx), val);
                    else runtimeError(`Cannot index-assign ${auraToString(obj)}`);
                    break;
                }

                case 'CALL': {
                    const argc = instr.arg as number;
                    const args = this.stack.splice(this.stack.length - argc, argc);
                    const callee = this.pop();
                    this.callValue(callee, args);
                    break;
                }
                    case 'RETURN': {
                        const retVal = this.pop();
                        const doneFrame = this.frames.pop();
                        const out = doneFrame?.constructing ?? retVal;
                        if (this.frames.length === untilDepth) return out;
                        this.push(out);
                        break;
                    }

                case 'CALL_METHOD': {
                    const [method, countStr] = (instr.arg as string).split(':');
                    const argc = parseInt(countStr, 10);
                    const args = this.stack.splice(this.stack.length - argc, argc);
                    const obj = this.pop();
                    this.callMethod(obj, method, args);
                    break;
                }

                case 'NEW_OBJECT': {
                    const klass = this.globals.get(instr.arg as string) as AuraClass;
                    if (!klass) runtimeError(`Unknown class '${instr.arg}'`);
                    const inst: AuraInstance = { type: 'instance', klass, fields: new Map() };
                    for (const f of klass.fields) inst.fields.set(f.name, this.materializeDefault(f.defaultVal));
                    this.push(inst);
                    break;
                }

                case 'MATCH_ENUM': {
                    const [tag, countStr, jumpStr] = String(instr.arg).split(':');
                    const n = parseInt(countStr, 10);
                    const jumpTarget = parseInt(jumpStr, 10);
                    const subject = this.peek();
                    if ((subject as any)?.type === 'enum' && (subject as AuraEnum).tag === tag) {
                        const vals = (subject as AuraEnum).values;
                        for (let i = 0; i < Math.min(n, vals.length); i++) this.push(vals[i]);
                    } else {
                        frame.ip = jumpTarget;
                    }
                    break;
                }

                case 'PRINT': {
                    const n = instr.arg as number;
                    const args = this.stack.splice(this.stack.length - n, n);
                    process.stdout.write(args.map(auraToString).join('') + '\n');
                    this.push(null);
                    break;
                }

                    default:
                        runtimeError(`Unknown opcode: ${(instr as any).op}`);
                }
            } catch (err) {
                this.rethrowWithStack(err, instr.line);
            }
        }
        return null;
    }

    private callValue(callee: Value, args: Value[]): void {
        if ((callee as any)?.type === 'builtin') {
            this.push((callee as BuiltinFn).fn(args));
            return;
        }
        if ((callee as any)?.type === 'function') {
            const fn = callee as AuraFunction;
            const locals = this.buildLocals(fn, args);
            this.pushFrame(fn.chunk, locals, fn.receiver);
            return;
        }
        if ((callee as any)?.type === 'class') {
            const klass = callee as AuraClass;
            const inst: AuraInstance = { type: 'instance', klass, fields: new Map() };
            for (const f of klass.fields) inst.fields.set(f.name, this.materializeDefault(f.defaultVal));
            const initFn = klass.methods.get('init');
            if (initFn) {
                const locals = this.buildLocals(initFn, args);
                locals.set('self', inst);
                this.pushFrame(initFn.chunk, locals, inst, inst);
            } else {
                this.push(inst);
            }
            return;
        }
        runtimeError(`Cannot call ${auraToString(callee)}`);
    }

    private callMethod(obj: Value, method: string, args: Value[]): void {
        if (method === 'add_method') {
            const name = auraToString(args[1]);
            const fn = args[0] as AuraFunction;
            if ((obj as any)?.type === 'class') (obj as AuraClass).methods.set(name, fn);
            this.push(null);
            return;
        }

        const attr = this.getAttr(obj, method);
        if ((attr as any)?.type === 'builtin') {
            this.push((attr as BuiltinFn).fn(args));
            return;
        }
        if ((attr as any)?.type === 'function') {
            const fn = attr as AuraFunction;
            const inst = (obj as any)?.type === 'instance' ? obj as AuraInstance : undefined;
            const locals = this.buildLocals(fn, args);
            if (inst) locals.set('self', inst);
            this.pushFrame(fn.chunk, locals, inst);
            return;
        }
        runtimeError(`'${method}' is not callable on ${auraToString(obj)}`);
    }

    private invokeCallable(callee: Value, args: Value[]): Value {
        if ((callee as any)?.type === 'builtin') {
            return (callee as BuiltinFn).fn(args);
        }
        if ((callee as any)?.type === 'function') {
            const fn = callee as AuraFunction;
            const locals = this.buildLocals(fn, args);
            if (fn.receiver) locals.set('self', fn.receiver);
            const baseDepth = this.frames.length;
            this.pushFrame(fn.chunk, locals, fn.receiver);
            return this.execute(baseDepth);
        }
        runtimeError(`Expected callable, got ${auraToString(callee)}`);
    }

    private buildLocals(fn: AuraFunction, args: Value[]): Map<string, Value> {
        const locals = new Map<string, Value>();
        fn.params.forEach((p, i) => {
            locals.set(p.name, i < args.length ? args[i] : this.materializeDefault(p.defaultVal));
        });
        return locals;
    }

    private getAttr(obj: Value, attr: string): Value {
        if (obj === null) runtimeError(`Cannot access '${attr}' on nil`);
        if (typeof obj === 'string') {
            const strMethods: Record<string, (s: string) => Value> = {
                len: s => s.length,
                upper: s => s.toUpperCase(),
                lower: s => s.toLowerCase(),
                trim: s => s.trim(),
                split: _ => ({ type: 'builtin', name: 'split', fn: ([sep]: Value[]) => ({ type: 'list', items: _.split(auraToString(sep)) } as AuraList) } as BuiltinFn),
            };
            if (strMethods[attr]) {
                const fn = strMethods[attr];
                return { type: 'builtin', name: attr, fn: () => fn(obj as string) } as BuiltinFn;
            }
            runtimeError(`String has no attribute '${attr}'`);
        }
        if ((obj as any)?.type === 'instance') {
            const inst = obj as AuraInstance;
            if (attr === 'with') {
                return this.builtin(`${inst.klass.name}.with`, (args: Value[]) => {
                    if (args.length !== 2) runtimeError("with(field, value) expects exactly 2 arguments");
                    const field = args[0];
                    if (typeof field !== 'string') runtimeError('with(field, value) expects `field` to be a string');
                    inst.fields.set(field, args[1]);
                    return inst;
                });
            }
            if (attr === 'clone') {
                return this.builtin(`${inst.klass.name}.clone`, (args: Value[]) => {
                    if (args.length !== 0) runtimeError('clone() takes no arguments');
                    const fields = new Map<string, Value>();
                    for (const [key, val] of inst.fields.entries()) fields.set(key, this.cloneValue(val));
                    return { type: 'instance', klass: inst.klass, fields } as AuraInstance;
                });
            }
            return getInstanceAttr(inst, attr);
        }
        if ((obj as any)?.type === 'class') return (obj as AuraClass).methods.get(attr) ?? runtimeError(`Class has no method '${attr}'`);
        if ((obj as any)?.type === 'module') return getModuleAttr(obj as AuraModule, attr);
        if ((obj as any)?.type === 'list') {
            const list = obj as AuraList;
            const listMethods: Record<string, () => Value> = {
                len: () => list.items.length,
                first: () => list.items.length > 0 ? list.items[0] : null,
                last: () => list.items.length > 0 ? list.items[list.items.length - 1] : null,
                is_empty: () => list.items.length === 0,
                pop: () => list.items.pop() ?? null,
                clear: () => { list.items.length = 0; return null; },
                to_list: () => ({ type: 'list', items: [...list.items] } as AuraList),
                sum: () => list.items.reduce<number>((acc, v) => acc + this.asNumber(v, 'list.sum'), 0),
                append: () => ({ type: 'builtin', name: 'append', fn: ([v]: Value[]) => { list.items.push(v); return null; } } as BuiltinFn),
                push: () => ({ type: 'builtin', name: 'push', fn: ([v]: Value[]) => { list.items.push(v); return null; } } as BuiltinFn),
                map: () => ({ type: 'builtin', name: 'map', fn: ([fn]: Value[]) => {
                    const out: Value[] = [];
                    for (let i = 0; i < list.items.length; i++) {
                        out.push(this.invokeCallable(fn, [list.items[i], i, list]));
                    }
                    return { type: 'list', items: out } as AuraList;
                } } as BuiltinFn),
                filter: () => ({ type: 'builtin', name: 'filter', fn: ([fn]: Value[]) => {
                    const out: Value[] = [];
                    for (let i = 0; i < list.items.length; i++) {
                        const item = list.items[i];
                        if (isTruthy(this.invokeCallable(fn, [item, i, list]))) out.push(item);
                    }
                    return { type: 'list', items: out } as AuraList;
                } } as BuiltinFn),
            };
            if (attr in listMethods) {
                const v = listMethods[attr]();
                if ((v as any)?.type === 'builtin') return v;
                return { type: 'builtin', name: attr, fn: () => v } as BuiltinFn;
            }
        }
        if ((obj as any)?.type === 'native') {
            return this.getNativeAttr(obj as AuraNative, attr);
        }
        runtimeError(`Cannot get attribute '${attr}' on ${auraToString(obj)}`);
    }

    private getNativeAttr(native: AuraNative, attr: string): Value {
        if (attr === 'explain_plan') {
            const summary = native.kind === 'stack' ? 'LIFO array-backed container'
                : native.kind === 'queue' ? 'FIFO array-backed container'
                    : native.kind === 'linked_list' ? 'Linked-list API with low-code methods'
                        : native.kind === 'heap' ? 'Binary heap with O(log n) push/pop'
                            : native.kind === 'hashmap' ? 'Hash map with average O(1) operations'
                                : native.kind === 'tree' ? 'Tree map with sorted key traversal'
                                    : 'Indexed collection with automatic key lookup';
            return this.builtin(`${native.kind}.explain_plan`, () => summary);
        }
        if (native.kind === 'stack') return this.getStackAttr(native, attr);
        if (native.kind === 'queue') return this.getQueueAttr(native, attr);
        if (native.kind === 'linked_list') return this.getLinkedListAttr(native, attr);
        if (native.kind === 'hashmap') return this.getMapNativeAttr(native, attr, false);
        if (native.kind === 'tree') return this.getMapNativeAttr(native, attr, true);
        if (native.kind === 'heap') return this.getHeapAttr(native, attr);
        if (native.kind === 'indexed') return this.getIndexedAttr(native, attr);
        runtimeError(`Unknown native kind '${native.kind}'`);
    }

    private getStackAttr(native: AuraNative, attr: string): Value {
        const data = this.expectNativeArray(native, 'stack');
        const methods: Record<string, () => Value> = {
            len: () => data.length,
            is_empty: () => data.length === 0,
            peek: () => data.length > 0 ? data[data.length - 1] : null,
            pop: () => data.pop() ?? null,
            clear: () => { data.length = 0; return null; },
            to_list: () => ({ type: 'list', items: [...data] } as AuraList),
            push: () => this.builtin('stack.push', ([v]: Value[]) => { data.push(v); return null; }),
        };
        if (!(attr in methods)) runtimeError(`Stack has no attribute '${attr}'`);
        const value = methods[attr]();
        return (value as any)?.type === 'builtin' ? value : this.builtin(`stack.${attr}`, () => value);
    }

    private getQueueAttr(native: AuraNative, attr: string): Value {
        const data = this.expectNativeArray(native, 'queue');
        const methods: Record<string, () => Value> = {
            len: () => data.length,
            is_empty: () => data.length === 0,
            peek: () => data.length > 0 ? data[0] : null,
            dequeue: () => data.shift() ?? null,
            pop: () => data.shift() ?? null,
            clear: () => { data.length = 0; return null; },
            to_list: () => ({ type: 'list', items: [...data] } as AuraList),
            enqueue: () => this.builtin('queue.enqueue', ([v]: Value[]) => { data.push(v); return null; }),
            push: () => this.builtin('queue.push', ([v]: Value[]) => { data.push(v); return null; }),
        };
        if (!(attr in methods)) runtimeError(`Queue has no attribute '${attr}'`);
        const value = methods[attr]();
        return (value as any)?.type === 'builtin' ? value : this.builtin(`queue.${attr}`, () => value);
    }

    private getLinkedListAttr(native: AuraNative, attr: string): Value {
        const data = this.expectNativeArray(native, 'linked_list');
        const indexFor = (idx: Value, allowEnd = false): number => {
            if (typeof idx !== 'number') runtimeError('LinkedList index must be number');
            const len = data.length;
            const raw = Math.trunc(idx);
            const resolved = raw < 0 ? len + raw : raw;
            const max = allowEnd ? len : len - 1;
            if (resolved < 0 || resolved > max) runtimeError(`Index ${raw} out of bounds`);
            return resolved;
        };
        const methods: Record<string, () => Value> = {
            len: () => data.length,
            is_empty: () => data.length === 0,
            front: () => data.length > 0 ? data[0] : null,
            back: () => data.length > 0 ? data[data.length - 1] : null,
            pop_front: () => data.shift() ?? null,
            pop_back: () => data.pop() ?? null,
            clear: () => { data.length = 0; return null; },
            to_list: () => ({ type: 'list', items: [...data] } as AuraList),
            push_front: () => this.builtin('linked_list.push_front', ([v]: Value[]) => { data.unshift(v); return null; }),
            push_back: () => this.builtin('linked_list.push_back', ([v]: Value[]) => { data.push(v); return null; }),
            push: () => this.builtin('linked_list.push', ([v]: Value[]) => { data.push(v); return null; }),
            get: () => this.builtin('linked_list.get', ([idx]: Value[]) => data[indexFor(idx)]),
            set: () => this.builtin('linked_list.set', ([idx, v]: Value[]) => { data[indexFor(idx)] = v; return null; }),
            insert: () => this.builtin('linked_list.insert', ([idx, v]: Value[]) => { data.splice(indexFor(idx, true), 0, v); return null; }),
            remove: () => this.builtin('linked_list.remove', ([idx]: Value[]) => {
                const i = indexFor(idx);
                const removed = data[i];
                data.splice(i, 1);
                return removed;
            }),
        };
        if (!(attr in methods)) runtimeError(`LinkedList has no attribute '${attr}'`);
        const value = methods[attr]();
        return (value as any)?.type === 'builtin' ? value : this.builtin(`linked_list.${attr}`, () => value);
    }

    private getMapNativeAttr(native: AuraNative, attr: string, sorted: boolean): Value {
        const map = this.expectNativeMap(native);
        const orderedKeys = (): string[] => sorted ? [...map.keys()].sort((a, b) => a.localeCompare(b)) : [...map.keys()];
        const methods: Record<string, () => Value> = {
            len: () => map.size,
            clear: () => { map.clear(); return null; },
            keys: () => ({ type: 'list', items: orderedKeys() } as AuraList),
            values: () => ({ type: 'list', items: orderedKeys().map((k) => map.get(k)!) } as AuraList),
            items: () => ({
                type: 'list',
                items: orderedKeys().map((k) => ({ type: 'list', items: [k, map.get(k)!] } as AuraList)),
            } as AuraList),
            get: () => this.builtin(`${native.kind}.get`, ([k, fallback]: Value[]) => map.get(auraToString(k)) ?? (fallback ?? null)),
            set: () => this.builtin(`${native.kind}.set`, ([k, v]: Value[]) => { map.set(auraToString(k), v); return null; }),
            has: () => this.builtin(`${native.kind}.has`, ([k]: Value[]) => map.has(auraToString(k))),
            delete: () => this.builtin(`${native.kind}.delete`, ([k]: Value[]) => map.delete(auraToString(k))),
            merge: () => this.builtin(`${native.kind}.merge`, ([other]: Value[]) => {
                if ((other as any)?.type === 'native' && (((other as AuraNative).kind === 'hashmap') || ((other as AuraNative).kind === 'tree'))) {
                    for (const [k, v] of this.expectNativeMap(other as AuraNative).entries()) map.set(k, v);
                    return null;
                }
                if ((other as any)?.type === 'map') {
                    for (const [k, v] of (other as AuraMap).entries.entries()) map.set(k, v);
                    return null;
                }
                runtimeError('merge() expects HashMap, TreeMap, or Map');
            }),
        };
        if (!(attr in methods)) runtimeError(`${native.kind} has no attribute '${attr}'`);
        const value = methods[attr]();
        return (value as any)?.type === 'builtin' ? value : this.builtin(`${native.kind}.${attr}`, () => value);
    }

    private getHeapAttr(native: AuraNative, attr: string): Value {
        const heap = this.expectHeap(native);
        const methods: Record<string, () => Value> = {
            len: () => heap.items.length,
            is_empty: () => heap.items.length === 0,
            peek: () => heap.items.length > 0 ? heap.items[0] : null,
            pop: () => this.heapPop(heap),
            clear: () => { heap.items.length = 0; return null; },
            to_list: () => ({ type: 'list', items: [...heap.items] } as AuraList),
            push: () => this.builtin('heap.push', ([v]: Value[]) => { this.heapPush(heap, v); return null; }),
        };
        if (!(attr in methods)) runtimeError(`Heap has no attribute '${attr}'`);
        const value = methods[attr]();
        return (value as any)?.type === 'builtin' ? value : this.builtin(`heap.${attr}`, () => value);
    }

    private getIndexedAttr(native: AuraNative, attr: string): Value {
        const data = this.expectIndexed(native);
        const firstIndex = (field: string, key: Value): number | null => {
            const map = data.maps.get(field);
            if (!map) runtimeError(`Indexed field '${field}' is not registered`);
            const hits = map.get(auraToString(key)) ?? [];
            return hits.length > 0 ? hits[0] : null;
        };
        const findAcrossKeys = (key: Value): number | null => {
            for (const field of data.keys) {
                const idx = firstIndex(field, key);
                if (idx !== null) return idx;
            }
            return null;
        };
        const methods: Record<string, () => Value> = {
            len: () => data.items.length,
            is_empty: () => data.items.length === 0,
            keys: () => ({ type: 'list', items: [...data.keys] } as AuraList),
            to_list: () => ({ type: 'list', items: [...data.items] } as AuraList),
            clear: () => { data.items.length = 0; this.rebuildIndexed(data); return null; },
            get: () => this.builtin('indexed.get', ([key]: Value[]) => {
                const idx = findAcrossKeys(key);
                return idx === null ? null : data.items[idx];
            }),
            get_by: () => this.builtin('indexed.get_by', ([field, key]: Value[]) => {
                if (typeof field !== 'string') runtimeError('get_by(field, key) expects field string');
                const idx = firstIndex(field, key);
                return idx === null ? null : data.items[idx];
            }),
            has: () => this.builtin('indexed.has', ([key]: Value[]) => findAcrossKeys(key) !== null),
            has_by: () => this.builtin('indexed.has_by', ([field, key]: Value[]) => {
                if (typeof field !== 'string') runtimeError('has_by(field, key) expects field string');
                return firstIndex(field, key) !== null;
            }),
            push: () => this.builtin('indexed.push', ([item]: Value[]) => {
                const idx = data.items.length;
                data.items.push(item);
                this.indexIndexedItem(data, item, idx);
                return null;
            }),
            append: () => this.builtin('indexed.append', ([item]: Value[]) => {
                const idx = data.items.length;
                data.items.push(item);
                this.indexIndexedItem(data, item, idx);
                return null;
            }),
            remove_by: () => this.builtin('indexed.remove_by', ([field, key]: Value[]) => {
                if (typeof field !== 'string') runtimeError('remove_by(field, key) expects field string');
                const idx = firstIndex(field, key);
                if (idx === null) return null;
                const removed = data.items[idx];
                data.items.splice(idx, 1);
                this.rebuildIndexed(data);
                return removed;
            }),
            set_by: () => this.builtin('indexed.set_by', ([field, key, targetField, value]: Value[]) => {
                if (typeof field !== 'string' || typeof targetField !== 'string') {
                    runtimeError('set_by(field, key, target_field, value) expects string field names');
                }
                const idx = firstIndex(field, key);
                if (idx === null) return null;
                const item = data.items[idx];
                if (!this.setIndexedField(item, targetField, value)) {
                    runtimeError('set_by requires item to be Map-like or class instance');
                }
                this.rebuildIndexed(data);
                return item;
            }),
            reindex: () => this.builtin('indexed.reindex', () => { this.rebuildIndexed(data); return null; }),
        };
        if (!(attr in methods)) runtimeError(`Indexed has no attribute '${attr}'`);
        const value = methods[attr]();
        return (value as any)?.type === 'builtin' ? value : this.builtin(`indexed.${attr}`, () => value);
    }

    private expectNativeArray(native: AuraNative, label: string): Value[] {
        if (!Array.isArray(native.data)) runtimeError(`${label} storage is invalid`);
        return native.data;
    }

    private expectNativeMap(native: AuraNative): Map<string, Value> {
        if (native.data instanceof Map) return native.data as Map<string, Value>;
        runtimeError('Map storage is invalid');
    }

    private expectHeap(native: AuraNative): NativeHeapData {
        const data = native.data as NativeHeapData;
        if (!data || !Array.isArray(data.items)) runtimeError('Heap storage is invalid');
        return data;
    }

    private expectIndexed(native: AuraNative): NativeIndexedData {
        const data = native.data as NativeIndexedData;
        if (!data || !Array.isArray(data.keys) || !Array.isArray(data.items) || !(data.maps instanceof Map)) {
            runtimeError('Indexed storage is invalid');
        }
        return data;
    }

    private indexedField(item: Value, field: string): Value | undefined {
        if ((item as any)?.type === 'map') return (item as AuraMap).entries.get(field);
        if ((item as any)?.type === 'instance') return (item as AuraInstance).fields.get(field);
        return undefined;
    }

    private setIndexedField(item: Value, field: string, value: Value): boolean {
        if ((item as any)?.type === 'map') {
            (item as AuraMap).entries.set(field, value);
            return true;
        }
        if ((item as any)?.type === 'instance') {
            (item as AuraInstance).fields.set(field, value);
            return true;
        }
        return false;
    }

    private indexIndexedItem(data: NativeIndexedData, item: Value, idx: number): void {
        for (const key of data.keys) {
            const raw = this.indexedField(item, key);
            if (raw === undefined || raw === null) continue;
            let map = data.maps.get(key);
            if (!map) {
                map = new Map<string, number[]>();
                data.maps.set(key, map);
            }
            const lookup = auraToString(raw);
            if (!map.has(lookup)) map.set(lookup, []);
            map.get(lookup)!.push(idx);
        }
    }

    private rebuildIndexed(data: NativeIndexedData): void {
        data.maps.clear();
        for (const key of data.keys) data.maps.set(key, new Map<string, number[]>());
        for (let i = 0; i < data.items.length; i++) this.indexIndexedItem(data, data.items[i], i);
    }

    private heapCompare(a: Value, b: Value, mode: 'min' | 'max'): number {
        const na = this.asNumber(a, 'heap');
        const nb = this.asNumber(b, 'heap');
        return mode === 'min' ? na - nb : nb - na;
    }

    private heapSiftUp(items: Value[], idx: number, mode: 'min' | 'max'): void {
        let i = idx;
        while (i > 0) {
            const parent = Math.floor((i - 1) / 2);
            if (this.heapCompare(items[parent], items[i], mode) <= 0) break;
            [items[parent], items[i]] = [items[i], items[parent]];
            i = parent;
        }
    }

    private heapSiftDown(items: Value[], idx: number, mode: 'min' | 'max'): void {
        let i = idx;
        while (true) {
            const left = i * 2 + 1;
            const right = i * 2 + 2;
            let best = i;
            if (left < items.length && this.heapCompare(items[best], items[left], mode) > 0) best = left;
            if (right < items.length && this.heapCompare(items[best], items[right], mode) > 0) best = right;
            if (best === i) break;
            [items[i], items[best]] = [items[best], items[i]];
            i = best;
        }
    }

    private heapPush(heap: NativeHeapData, value: Value): void {
        this.asNumber(value, 'heap');
        heap.items.push(value);
        this.heapSiftUp(heap.items, heap.items.length - 1, heap.mode);
    }

    private heapPop(heap: NativeHeapData): Value {
        if (heap.items.length === 0) return null;
        const root = heap.items[0];
        const tail = heap.items.pop()!;
        if (heap.items.length > 0) {
            heap.items[0] = tail;
            this.heapSiftDown(heap.items, 0, heap.mode);
        }
        return root;
    }

    private builtin(name: string, fn: (args: Value[]) => Value): BuiltinFn {
        return { type: 'builtin', name, fn };
    }

    private asNumber(v: Value, context: string): number {
        if (typeof v !== 'number') runtimeError(`${context} requires numeric values`);
        return v;
    }

    private materializeDefault(defaultVal: unknown): Value {
        if (defaultVal === undefined) return null;
        if (defaultVal !== null && typeof defaultVal === 'object' && 'kind' in (defaultVal as any)) return null;
        return this.cloneValue(defaultVal as Value);
    }

    private cloneValue(v: Value): Value {
        if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
        if ((v as any).type === 'measure') {
            const m = v as AuraMeasure;
            return { ...m };
        }
        if ((v as any).type === 'list') {
            const list = v as AuraList;
            return { type: 'list', items: list.items.map((item) => this.cloneValue(item)) };
        }
        if ((v as any).type === 'map') {
            const map = v as AuraMap;
            const entries = new Map<string, Value>();
            for (const [k, val] of map.entries.entries()) entries.set(k, this.cloneValue(val));
            return { type: 'map', entries };
        }
        if ((v as any).type === 'native') {
            const native = v as AuraNative;
            if (native.kind === 'hashmap' || native.kind === 'tree') {
                const entries = new Map<string, Value>();
                for (const [k, val] of this.expectNativeMap(native).entries()) entries.set(k, this.cloneValue(val));
                return { type: 'native', kind: native.kind, data: entries };
            }
            if (native.kind === 'indexed') {
                const src = this.expectIndexed(native);
                const cloned: NativeIndexedData = {
                    keys: [...src.keys],
                    items: src.items.map((item) => this.cloneValue(item)),
                    maps: new Map<string, Map<string, number[]>>(),
                };
                this.rebuildIndexed(cloned);
                return { type: 'native', kind: 'indexed', data: cloned };
            }
            if (native.kind === 'heap') {
                const heap = this.expectHeap(native);
                return { type: 'native', kind: 'heap', data: { items: heap.items.map((item) => this.cloneValue(item)), mode: heap.mode } };
            }
            const items = this.expectNativeArray(native, 'clone').map((item) => this.cloneValue(item));
            return { type: 'native', kind: native.kind, data: items };
        }
        return v;
    }

    private add(a: Value, b: Value): Value {
        if ((a as any)?.type === 'measure' && (b as any)?.type === 'measure') {
            const ma = a as AuraMeasure;
            const mb = b as AuraMeasure;
            if (ma.dimension !== mb.dimension) {
                runtimeError(`Cannot add measure:${ma.dimension} and measure:${mb.dimension}`);
            }
            return {
                type: 'measure',
                dimension: ma.dimension,
                baseValue: ma.baseValue + mb.baseValue,
                unit: ma.unit,
                factor: ma.factor,
            };
        }
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (typeof a === 'string' || typeof b === 'string') return auraToString(a) + auraToString(b);
        runtimeError(`Cannot add ${auraToString(a)} and ${auraToString(b)}`);
    }

    private sub(a: Value, b: Value): Value {
        if ((a as any)?.type === 'measure' && (b as any)?.type === 'measure') {
            const ma = a as AuraMeasure;
            const mb = b as AuraMeasure;
            if (ma.dimension !== mb.dimension) {
                runtimeError(`Cannot subtract measure:${mb.dimension} from measure:${ma.dimension}`);
            }
            return {
                type: 'measure',
                dimension: ma.dimension,
                baseValue: ma.baseValue - mb.baseValue,
                unit: ma.unit,
                factor: ma.factor,
            };
        }
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        runtimeError(`Cannot subtract ${auraToString(b)} from ${auraToString(a)}`);
    }

    private mul(a: Value, b: Value): Value {
        if ((a as any)?.type === 'measure' && typeof b === 'number') {
            const m = a as AuraMeasure;
            return { ...m, baseValue: m.baseValue * b };
        }
        if (typeof a === 'number' && (b as any)?.type === 'measure') {
            const m = b as AuraMeasure;
            return { ...m, baseValue: m.baseValue * a };
        }
        if ((a as any)?.type === 'measure' && (b as any)?.type === 'measure') {
            const ma = a as AuraMeasure;
            const mb = b as AuraMeasure;
            return {
                type: 'measure',
                dimension: `${ma.dimension}*${mb.dimension}`,
                baseValue: ma.baseValue * mb.baseValue,
                unit: `${ma.unit}*${mb.unit}`,
                factor: ma.factor * mb.factor,
            };
        }
        if (typeof a === 'number' && typeof b === 'number') return a * b;
        runtimeError(`Cannot multiply ${auraToString(a)} and ${auraToString(b)}`);
    }

    private div(a: Value, b: Value): Value {
        if (typeof b === 'number' && b === 0) runtimeError('Division by zero');
        if ((b as any)?.type === 'measure' && (b as AuraMeasure).baseValue === 0) runtimeError('Division by zero');
        if ((a as any)?.type === 'measure' && typeof b === 'number') {
            const m = a as AuraMeasure;
            return { ...m, baseValue: m.baseValue / b };
        }
        if ((a as any)?.type === 'measure' && (b as any)?.type === 'measure') {
            const ma = a as AuraMeasure;
            const mb = b as AuraMeasure;
            if (ma.dimension === mb.dimension) {
                return ma.baseValue / mb.baseValue;
            }
            return {
                type: 'measure',
                dimension: `${ma.dimension}/${mb.dimension}`,
                baseValue: ma.baseValue / mb.baseValue,
                unit: `${ma.unit}/${mb.unit}`,
                factor: ma.factor / mb.factor,
            };
        }
        if (typeof a === 'number' && typeof b === 'number') return a / b;
        runtimeError(`Cannot divide ${auraToString(a)} by ${auraToString(b)}`);
    }

    private compare(a: Value, b: Value): number {
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        if ((a as any)?.type === 'measure' && (b as any)?.type === 'measure') {
            const ma = a as AuraMeasure;
            const mb = b as AuraMeasure;
            if (ma.dimension !== mb.dimension) runtimeError(`Cannot compare measure:${ma.dimension} and measure:${mb.dimension}`);
            return ma.baseValue - mb.baseValue;
        }
        runtimeError(`Cannot compare ${auraToString(a)} and ${auraToString(b)}`);
    }

    private equal(a: Value, b: Value): boolean {
        if (a === b) return true;
        if ((a as any)?.type === 'measure' && (b as any)?.type === 'measure') {
            const ma = a as AuraMeasure;
            const mb = b as AuraMeasure;
            return ma.dimension === mb.dimension && ma.baseValue === mb.baseValue;
        }
        if ((a as any)?.type === 'enum' && (b as any)?.type === 'enum') {
            return (a as AuraEnum).tag === (b as AuraEnum).tag;
        }
        return false;
    }

    private rethrowWithStack(err: unknown, line: number): never {
        if (err instanceof AuraError && err.phase === 'Runtime') {
            const stackTrace = (err.stackTrace && err.stackTrace.length > 0)
                ? err.stackTrace
                : this.buildStackTrace(line);
            const top = stackTrace[0];
            throw new AuraError(
                err.message,
                top?.file ?? err.file,
                top?.line ?? line,
                0,
                'Runtime',
                stackTrace,
            );
        }
        throw err;
    }

    private buildStackTrace(currentLine: number): StackFrame[] {
        const trace: StackFrame[] = [];
        for (let i = this.frames.length - 1; i >= 0; i--) {
            const frame = this.frames[i];
            const line = i === this.frames.length - 1
                ? currentLine
                : (frame.chunk.code[Math.max(0, frame.ip - 1)]?.line ?? 0);
            trace.push({
                functionName: frame.fnName ?? frame.chunk.name ?? '<anon>',
                file: frame.file ?? frame.chunk.file ?? '<runtime>',
                line,
            });
        }
        return trace;
    }

    private pushFrame(chunk: Chunk, locals: Map<string, Value>, receiver?: AuraInstance, constructing?: AuraInstance): void {
        this.frames.push({
            chunk,
            ip: 0,
            locals,
            receiver,
            constructing,
            fnName: chunk.name,
            file: chunk.file,
        });
    }

    private push(v: Value): void { this.stack.push(v); }
    private pop(): Value { return this.stack.pop() ?? null; }
    private peek(): Value { return this.stack[this.stack.length - 1] ?? null; }
}
