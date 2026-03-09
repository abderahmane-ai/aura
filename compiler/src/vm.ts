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

interface NativeTensorData {
    shape: number[];
    values: number[];
}

interface CallFrame {
    chunk: Chunk;
    ip: number;
    locals: Map<string, Value>;
    localSlots?: Value[];
    receiver?: AuraInstance;
    constructing?: AuraInstance;
    fnName?: string;
    file?: string;
    moduleScope?: Map<string, Value>;
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

    snapshotGlobals(): Map<string, Value> {
        return new Map(this.globals);
    }

    restoreGlobals(snapshot: Map<string, Value>): void {
        this.globals = new Map(snapshot);
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
                        if (frame.moduleScope?.has(name)) {
                            this.push(frame.moduleScope.get(name)!);
                            break;
                        }
                        if (!this.globals.has(name)) runtimeError(`Undefined name '${name}'`);
                        this.push(this.globals.get(name)!);
                        break;
                    }
                    case 'SET_GLOBAL': this.globals.set(instr.arg as string, this.pop()); break;
                    case 'GET_LOCAL': {
                        const name = instr.arg as string;
                        if (name === 'self' && frame.receiver) { this.push(frame.receiver); break; }
                        if (!frame.locals.has(name)) {
                            if (frame.moduleScope?.has(name)) { this.push(frame.moduleScope.get(name)!); break; }
                            if (this.globals.has(name)) { this.push(this.globals.get(name)!); break; }
                            runtimeError(`Undefined local '${name}'`);
                        }
                        this.push(frame.locals.get(name)!);
                        break;
                    }
                    case 'SET_LOCAL': frame.locals.set(instr.arg as string, this.pop()); break;
                    case 'GET_LOCAL_SLOT': {
                        const slot = instr.arg as number;
                        const slots = frame.localSlots;
                        if (!slots || slot < 0 || slot >= slots.length) {
                            runtimeError('Invalid local slot read ' + slot);
                        }
                        this.push(slots[slot] ?? null);
                        break;
                    }
                    case 'SET_LOCAL_SLOT': {
                        const slot = instr.arg as number;
                        const slots = frame.localSlots;
                        if (!slots || slot < 0 || slot >= slots.length) {
                            runtimeError('Invalid local slot write ' + slot);
                        }
                        slots[slot] = this.pop();
                        break;
                    }

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
            const receiver = fn.receiver;
            const bindings = this.buildFrameBindings(fn, args, receiver);
            this.pushFrame(fn.chunk, bindings.locals, receiver, undefined, this.moduleScopeOf(fn), bindings.localSlots);
            return;
        }
        if ((callee as any)?.type === 'class') {
            const klass = callee as AuraClass;
            const inst: AuraInstance = { type: 'instance', klass, fields: new Map() };
            for (const f of klass.fields) inst.fields.set(f.name, this.materializeDefault(f.defaultVal));
            const initFn = klass.methods.get('init');
            if (initFn) {
                const bindings = this.buildFrameBindings(initFn, args, inst);
                this.pushFrame(initFn.chunk, bindings.locals, inst, inst, this.moduleScopeOf(initFn), bindings.localSlots);
            } else {
                this.push(inst);
            }
            return;
        }
        runtimeError('Cannot call ' + auraToString(callee));
    }

    private callMethod(obj: Value, method: string, args: Value[]): void {
        if (method === 'add_method') {
            const name = auraToString(args[1]);
            const fn = args[0] as AuraFunction;
            if ((obj as any)?.type === 'class') (obj as AuraClass).methods.set(name, fn);
            this.push(null);
            return;
        }

        const fast = this.fastCallMethod(obj, method, args);
        if (fast !== undefined) {
            this.push(fast);
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
            const receiver = inst ?? fn.receiver;
            const bindings = this.buildFrameBindings(fn, args, receiver);
            this.pushFrame(fn.chunk, bindings.locals, receiver, undefined, this.moduleScopeOf(fn), bindings.localSlots);
            return;
        }
        runtimeError("'" + method + "' is not callable on " + auraToString(obj));
    }

    private invokeCallable(callee: Value, args: Value[]): Value {
        if ((callee as any)?.type === 'builtin') {
            return (callee as BuiltinFn).fn(args);
        }
        if ((callee as any)?.type === 'function') {
            const fn = callee as AuraFunction;
            const receiver = fn.receiver;
            const bindings = this.buildFrameBindings(fn, args, receiver);
            const baseDepth = this.frames.length;
            this.pushFrame(fn.chunk, bindings.locals, receiver, undefined, this.moduleScopeOf(fn), bindings.localSlots);
            return this.execute(baseDepth);
        }
        runtimeError('Expected callable, got ' + auraToString(callee));
    }

    private buildFrameBindings(fn: AuraFunction, args: Value[], receiver?: AuraInstance): { locals: Map<string, Value>; localSlots?: Value[] } {
        const locals = new Map<string, Value>();
        const slotCount = fn.localCount ?? 0;
        const localSlots = slotCount > 0 ? new Array<Value>(slotCount).fill(null) : undefined;

        fn.params.forEach((p, i) => {
            const value = i < args.length ? args[i] : this.materializeDefault(p.defaultVal);
            locals.set(p.name, value);
            const slot = fn.paramSlots?.[i];
            if (localSlots && slot !== undefined && slot >= 0 && slot < localSlots.length) {
                localSlots[slot] = value;
            }
        });

        if (receiver) {
            locals.set('self', receiver);
            const selfSlot = fn.selfSlot;
            if (localSlots && selfSlot !== undefined && selfSlot >= 0 && selfSlot < localSlots.length) {
                localSlots[selfSlot] = receiver;
            }
        }

        return { locals, localSlots };
    }

    private fastCallMethod(obj: Value, method: string, args: Value[]): Value | undefined {
        if (typeof obj === 'string') return this.fastCallStringMethod(obj, method, args);
        if ((obj as any)?.type === 'list') return this.fastCallListMethod(obj as AuraList, method, args);
        return undefined;
    }

    private fastCallStringMethod(str: string, method: string, args: Value[]): Value | undefined {
        switch (method) {
            case 'len':
                if (args.length !== 0) runtimeError('string.len() takes no arguments');
                return str.length;
            case 'is_empty':
                if (args.length !== 0) runtimeError('string.is_empty() takes no arguments');
                return str.length === 0;
            case 'upper':
                if (args.length !== 0) runtimeError('string.upper() takes no arguments');
                return str.toUpperCase();
            case 'lower':
                if (args.length !== 0) runtimeError('string.lower() takes no arguments');
                return str.toLowerCase();
            case 'trim':
                if (args.length !== 0) runtimeError('string.trim() takes no arguments');
                return str.trim();
            case 'contains':
                if (args.length !== 1) runtimeError('string.contains(substr) expects exactly 1 argument');
                return str.includes(auraToString(args[0]));
            case 'starts_with':
                if (args.length !== 1) runtimeError('string.starts_with(prefix) expects exactly 1 argument');
                return str.startsWith(auraToString(args[0]));
            case 'ends_with':
                if (args.length !== 1) runtimeError('string.ends_with(suffix) expects exactly 1 argument');
                return str.endsWith(auraToString(args[0]));
            case 'split': {
                if (args.length < 1 || args.length > 2) runtimeError('string.split(sep, limit?) expects 1 or 2 arguments');
                const sep = auraToString(args[0]);
                const limit = args.length === 2 ? Math.max(0, Math.trunc(this.asNumber(args[1], 'string.split'))) : undefined;
                const items = limit === undefined ? str.split(sep) : str.split(sep, limit);
                return { type: 'list', items } as AuraList;
            }
            case 'index_of':
                if (args.length !== 1) runtimeError('string.index_of(substr) expects exactly 1 argument');
                return str.indexOf(auraToString(args[0]));
            case 'last_index_of':
                if (args.length !== 1) runtimeError('string.last_index_of(substr) expects exactly 1 argument');
                return str.lastIndexOf(auraToString(args[0]));
            case 'repeat': {
                if (args.length !== 1) runtimeError('string.repeat(n) expects exactly 1 argument');
                const count = Math.trunc(this.asNumber(args[0], 'string.repeat'));
                if (count < 0) runtimeError('string.repeat(n) requires n >= 0');
                return str.repeat(count);
            }
            case 'slice': {
                if (args.length < 1 || args.length > 2) runtimeError('string.slice(start, end?) expects 1 or 2 arguments');
                const start = Math.trunc(this.asNumber(args[0], 'string.slice'));
                if (args.length === 1) return str.slice(start);
                const end = Math.trunc(this.asNumber(args[1], 'string.slice'));
                return str.slice(start, end);
            }
            case 'char_at': {
                if (args.length !== 1) runtimeError('string.char_at(index) expects exactly 1 argument');
                const idx = Math.trunc(this.asNumber(args[0], 'string.char_at'));
                const realIdx = idx < 0 ? str.length + idx : idx;
                if (realIdx < 0 || realIdx >= str.length) return null;
                return str[realIdx];
            }
            default:
                return undefined;
        }
    }

    private fastCallListMethod(list: AuraList, method: string, args: Value[]): Value | undefined {
        switch (method) {
            case 'len':
                if (args.length !== 0) runtimeError('list.len() takes no arguments');
                return list.items.length;
            case 'is_empty':
                if (args.length !== 0) runtimeError('list.is_empty() takes no arguments');
                return list.items.length === 0;
            case 'first':
                if (args.length !== 0) runtimeError('list.first() takes no arguments');
                return list.items.length > 0 ? list.items[0] : null;
            case 'last':
                if (args.length !== 0) runtimeError('list.last() takes no arguments');
                return list.items.length > 0 ? list.items[list.items.length - 1] : null;
            case 'pop':
                if (args.length !== 0) runtimeError('list.pop() takes no arguments');
                return list.items.pop() ?? null;
            case 'clear':
                if (args.length !== 0) runtimeError('list.clear() takes no arguments');
                list.items.length = 0;
                return null;
            case 'to_list':
                if (args.length !== 0) runtimeError('list.to_list() takes no arguments');
                return { type: 'list', items: [...list.items] } as AuraList;
            case 'append':
            case 'push':
                if (args.length !== 1) runtimeError('list.push(value) expects exactly 1 argument');
                list.items.push(args[0]);
                return null;
            default:
                return undefined;
        }
    }

    private getAttr(obj: Value, attr: string): Value {
        if (obj === null) runtimeError(`Cannot access '${attr}' on nil`);
        if (typeof obj === 'string') {
            const str = obj as string;
            const words = (): string[] => str.match(/[A-Za-z0-9]+/g) ?? [];
            const toTitle = (): string => {
                const chunks = str.split(/([^A-Za-z0-9]+)/);
                return chunks.map((chunk) => {
                    if (!/^[A-Za-z0-9]+$/.test(chunk)) return chunk;
                    return chunk[0].toUpperCase() + chunk.slice(1).toLowerCase();
                }).join('');
            };
            const strMethods: Record<string, BuiltinFn> = {
                len: this.builtin('string.len', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.len() takes no arguments');
                    return str.length;
                }),
                is_empty: this.builtin('string.is_empty', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.is_empty() takes no arguments');
                    return str.length === 0;
                }),
                upper: this.builtin('string.upper', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.upper() takes no arguments');
                    return str.toUpperCase();
                }),
                lower: this.builtin('string.lower', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.lower() takes no arguments');
                    return str.toLowerCase();
                }),
                trim: this.builtin('string.trim', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.trim() takes no arguments');
                    return str.trim();
                }),
                split: this.builtin('string.split', (args: Value[]) => {
                    if (args.length < 1 || args.length > 2) runtimeError('string.split(sep, limit?) expects 1 or 2 arguments');
                    const sep = auraToString(args[0]);
                    const limit = args.length === 2 ? Math.max(0, Math.trunc(this.asNumber(args[1], 'string.split'))) : undefined;
                    return {
                        type: 'list',
                        items: limit === undefined ? str.split(sep) : str.split(sep, limit),
                    } as AuraList;
                }),
                contains: this.builtin('string.contains', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.contains(substr) expects exactly 1 argument');
                    return str.includes(auraToString(args[0]));
                }),
                starts_with: this.builtin('string.starts_with', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.starts_with(prefix) expects exactly 1 argument');
                    return str.startsWith(auraToString(args[0]));
                }),
                ends_with: this.builtin('string.ends_with', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.ends_with(suffix) expects exactly 1 argument');
                    return str.endsWith(auraToString(args[0]));
                }),
                index_of: this.builtin('string.index_of', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.index_of(substr) expects exactly 1 argument');
                    return str.indexOf(auraToString(args[0]));
                }),
                last_index_of: this.builtin('string.last_index_of', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.last_index_of(substr) expects exactly 1 argument');
                    return str.lastIndexOf(auraToString(args[0]));
                }),
                replace: this.builtin('string.replace', (args: Value[]) => {
                    if (args.length !== 2) runtimeError('string.replace(from, to) expects exactly 2 arguments');
                    const from = auraToString(args[0]);
                    if (from.length === 0) runtimeError('string.replace(from, to) requires non-empty "from"');
                    return str.split(from).join(auraToString(args[1]));
                }),
                repeat: this.builtin('string.repeat', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.repeat(n) expects exactly 1 argument');
                    const count = Math.trunc(this.asNumber(args[0], 'string.repeat'));
                    if (count < 0) runtimeError('string.repeat(n) requires n >= 0');
                    return str.repeat(count);
                }),
                slice: this.builtin('string.slice', (args: Value[]) => {
                    if (args.length < 1 || args.length > 2) runtimeError('string.slice(start, end?) expects 1 or 2 arguments');
                    const start = Math.trunc(this.asNumber(args[0], 'string.slice'));
                    if (args.length === 1) return str.slice(start);
                    const end = Math.trunc(this.asNumber(args[1], 'string.slice'));
                    return str.slice(start, end);
                }),
                char_at: this.builtin('string.char_at', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.char_at(index) expects exactly 1 argument');
                    const idx = Math.trunc(this.asNumber(args[0], 'string.char_at'));
                    const realIdx = idx < 0 ? str.length + idx : idx;
                    if (realIdx < 0 || realIdx >= str.length) return null;
                    return str[realIdx];
                }),
                chars: this.builtin('string.chars', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.chars() takes no arguments');
                    return { type: 'list', items: [...str] } as AuraList;
                }),
                lines: this.builtin('string.lines', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.lines() takes no arguments');
                    return { type: 'list', items: str.replace(/\r\n/g, '\n').split('\n') } as AuraList;
                }),
                pad_left: this.builtin('string.pad_left', (args: Value[]) => {
                    if (args.length < 1 || args.length > 2) runtimeError('string.pad_left(width, fill?) expects 1 or 2 arguments');
                    const width = Math.max(0, Math.trunc(this.asNumber(args[0], 'string.pad_left')));
                    const fill = args.length === 2 ? auraToString(args[1]) : ' ';
                    if (fill.length === 0) runtimeError('string.pad_left(width, fill?) requires non-empty fill');
                    return str.padStart(width, fill);
                }),
                pad_right: this.builtin('string.pad_right', (args: Value[]) => {
                    if (args.length < 1 || args.length > 2) runtimeError('string.pad_right(width, fill?) expects 1 or 2 arguments');
                    const width = Math.max(0, Math.trunc(this.asNumber(args[0], 'string.pad_right')));
                    const fill = args.length === 2 ? auraToString(args[1]) : ' ';
                    if (fill.length === 0) runtimeError('string.pad_right(width, fill?) requires non-empty fill');
                    return str.padEnd(width, fill);
                }),
                join: this.builtin('string.join', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.join(collection) expects exactly 1 argument');
                    const it = makeIterator(args[0]);
                    const out: string[] = [];
                    while (true) {
                        const next = iterNext(it);
                        if (next === DONE) break;
                        out.push(auraToString(next));
                    }
                    return out.join(str);
                }),
                title: this.builtin('string.title', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.title() takes no arguments');
                    return toTitle();
                }),
                words: this.builtin('string.words', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.words() takes no arguments');
                    return { type: 'list', items: words() } as AuraList;
                }),
                camel_case: this.builtin('string.camel_case', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.camel_case() takes no arguments');
                    const parts = words().map((w) => w.toLowerCase());
                    if (parts.length === 0) return '';
                    return parts[0] + parts.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
                }),
                snake_case: this.builtin('string.snake_case', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.snake_case() takes no arguments');
                    return words().map((w) => w.toLowerCase()).join('_');
                }),
                kebab_case: this.builtin('string.kebab_case', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('string.kebab_case() takes no arguments');
                    return words().map((w) => w.toLowerCase()).join('-');
                }),
                remove_prefix: this.builtin('string.remove_prefix', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.remove_prefix(prefix) expects exactly 1 argument');
                    const prefix = auraToString(args[0]);
                    return str.startsWith(prefix) ? str.slice(prefix.length) : str;
                }),
                remove_suffix: this.builtin('string.remove_suffix', (args: Value[]) => {
                    if (args.length !== 1) runtimeError('string.remove_suffix(suffix) expects exactly 1 argument');
                    const suffix = auraToString(args[0]);
                    return str.endsWith(suffix) ? str.slice(0, str.length - suffix.length) : str;
                }),
            };
            if (strMethods[attr]) return strMethods[attr];
            runtimeError(`String has no attribute '${attr}'`);
        }
        if ((obj as any)?.type === 'enum') return this.getEnumAttr(obj as AuraEnum, attr);
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
            const compareKeys = (a: Value, b: Value): number => {
                if (typeof a === 'number' && typeof b === 'number') return a - b;
                return auraToString(a).localeCompare(auraToString(b));
            };
            const flattenItems = (items: Value[], depth: number): Value[] => {
                if (depth <= 0) return [...items];
                const out: Value[] = [];
                for (const item of items) {
                    if ((item as any)?.type === 'list') {
                        out.push(...flattenItems((item as AuraList).items, depth - 1));
                    } else {
                        out.push(item);
                    }
                }
                return out;
            };
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
                reduce: () => this.builtin('list.reduce', (args: Value[]) => {
                    if (args.length !== 2) runtimeError('list.reduce(fn, init) expects exactly 2 arguments');
                    const fn = args[0];
                    let acc = args[1];
                    for (let i = 0; i < list.items.length; i++) {
                        acc = this.invokeCallable(fn, [acc, list.items[i], i, list]);
                    }
                    return acc;
                }),
                flat_map: () => this.builtin('list.flat_map', ([fn]: Value[]) => {
                    const out: Value[] = [];
                    for (let i = 0; i < list.items.length; i++) {
                        const mapped = this.invokeCallable(fn, [list.items[i], i, list]);
                        if ((mapped as any)?.type === 'list') out.push(...(mapped as AuraList).items);
                        else out.push(mapped);
                    }
                    return { type: 'list', items: out } as AuraList;
                }),
                flatten: () => this.builtin('list.flatten', (args: Value[]) => {
                    if (args.length > 1) runtimeError('list.flatten(depth?) expects at most 1 argument');
                    const depth = args.length === 0 ? 1 : Math.max(0, Math.trunc(this.asNumber(args[0], 'list.flatten')));
                    return { type: 'list', items: flattenItems(list.items, depth) } as AuraList;
                }),
                find: () => this.builtin('list.find', ([fn]: Value[]) => {
                    for (let i = 0; i < list.items.length; i++) {
                        const item = list.items[i];
                        if (isTruthy(this.invokeCallable(fn, [item, i, list]))) return item;
                    }
                    return null;
                }),
                find_index: () => this.builtin('list.find_index', ([fn]: Value[]) => {
                    for (let i = 0; i < list.items.length; i++) {
                        if (isTruthy(this.invokeCallable(fn, [list.items[i], i, list]))) return i;
                    }
                    return -1;
                }),
                any: () => this.builtin('list.any', ([fn]: Value[]) => {
                    for (let i = 0; i < list.items.length; i++) {
                        if (isTruthy(this.invokeCallable(fn, [list.items[i], i, list]))) return true;
                    }
                    return false;
                }),
                all: () => this.builtin('list.all', ([fn]: Value[]) => {
                    for (let i = 0; i < list.items.length; i++) {
                        if (!isTruthy(this.invokeCallable(fn, [list.items[i], i, list]))) return false;
                    }
                    return true;
                }),
                count: () => this.builtin('list.count', ([fn]: Value[]) => {
                    let total = 0;
                    for (let i = 0; i < list.items.length; i++) {
                        if (isTruthy(this.invokeCallable(fn, [list.items[i], i, list]))) total++;
                    }
                    return total;
                }),
                group_by: () => this.builtin('list.group_by', ([fn]: Value[]) => {
                    const grouped = new Map<string, Value>();
                    for (let i = 0; i < list.items.length; i++) {
                        const item = list.items[i];
                        const key = auraToString(this.invokeCallable(fn, [item, i, list]));
                        const current = grouped.get(key);
                        if ((current as any)?.type === 'list') {
                            (current as AuraList).items.push(item);
                        } else {
                            grouped.set(key, { type: 'list', items: [item] } as AuraList);
                        }
                    }
                    return { type: 'map', entries: grouped } as AuraMap;
                }),
                key_by: () => this.builtin('list.key_by', ([fn]: Value[]) => {
                    const keyed = new Map<string, Value>();
                    for (let i = 0; i < list.items.length; i++) {
                        const item = list.items[i];
                        const key = auraToString(this.invokeCallable(fn, [item, i, list]));
                        keyed.set(key, item);
                    }
                    return { type: 'map', entries: keyed } as AuraMap;
                }),
                sort_by: () => this.builtin('list.sort_by', ([fn]: Value[]) => {
                    const rows = list.items.map((item, i) => ({ item, key: this.invokeCallable(fn, [item, i, list]), i }));
                    rows.sort((a, b) => {
                        const cmp = compareKeys(a.key, b.key);
                        if (cmp !== 0) return cmp;
                        return a.i - b.i;
                    });
                    return { type: 'list', items: rows.map((r) => r.item) } as AuraList;
                }),
                min_by: () => this.builtin('list.min_by', ([fn]: Value[]) => {
                    if (list.items.length === 0) return null;
                    let bestItem = list.items[0];
                    let bestKey = this.invokeCallable(fn, [bestItem, 0, list]);
                    for (let i = 1; i < list.items.length; i++) {
                        const item = list.items[i];
                        const key = this.invokeCallable(fn, [item, i, list]);
                        if (compareKeys(key, bestKey) < 0) {
                            bestItem = item;
                            bestKey = key;
                        }
                    }
                    return bestItem;
                }),
                max_by: () => this.builtin('list.max_by', ([fn]: Value[]) => {
                    if (list.items.length === 0) return null;
                    let bestItem = list.items[0];
                    let bestKey = this.invokeCallable(fn, [bestItem, 0, list]);
                    for (let i = 1; i < list.items.length; i++) {
                        const item = list.items[i];
                        const key = this.invokeCallable(fn, [item, i, list]);
                        if (compareKeys(key, bestKey) > 0) {
                            bestItem = item;
                            bestKey = key;
                        }
                    }
                    return bestItem;
                }),
                zip: () => this.builtin('list.zip', ([other]: Value[]) => {
                    const it = makeIterator(other);
                    const pairs: Value[] = [];
                    for (let i = 0; i < list.items.length; i++) {
                        const next = iterNext(it);
                        if (next === DONE) break;
                        pairs.push({ type: 'list', items: [list.items[i], next] } as AuraList);
                    }
                    return { type: 'list', items: pairs } as AuraList;
                }),
                enumerate: () => this.builtin('list.enumerate', (args: Value[]) => {
                    if (args.length !== 0) runtimeError('list.enumerate() takes no arguments');
                    const pairs = list.items.map((item, i) => ({ type: 'list', items: [i, item] } as AuraList));
                    return { type: 'list', items: pairs } as AuraList;
                }),
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

    private getEnumAttr(value: AuraEnum, attr: string): Value {
        const isOption = value.tag === 'some' || value.tag === 'none';
        const isResult = value.tag === 'ok' || value.tag === 'error';
        const first = (): Value => value.values.length > 0 ? value.values[0] : null;
        const some = (v: Value): AuraEnum => ({ type: 'enum', tag: 'some', values: [v] });
        const none = (): AuraEnum => ({ type: 'enum', tag: 'none', values: [] });
        const ok = (v: Value): AuraEnum => ({ type: 'enum', tag: 'ok', values: [v] });
        const err = (v: Value): AuraEnum => ({ type: 'enum', tag: 'error', values: [v] });

        const methods: Record<string, () => Value> = {
            tag: () => value.tag,
            values: () => ({ type: 'list', items: [...value.values] } as AuraList),
        };

        if (isOption) {
            methods.is_some = () => value.tag === 'some';
            methods.is_none = () => value.tag === 'none';
            methods.unwrap = () => {
                if (value.tag !== 'some') runtimeError('Called unwrap() on None');
                return first();
            };
            methods.unwrap_or = () => this.builtin('option.unwrap_or', ([fallback]: Value[]) => value.tag === 'some' ? first() : (fallback ?? null));
            methods.expect = () => this.builtin('option.expect', ([msg]: Value[]) => {
                if (value.tag === 'some') return first();
                runtimeError(auraToString(msg ?? 'Expected Some, got None'));
            });
            methods.map = () => this.builtin('option.map', ([fn]: Value[]) => {
                if (value.tag !== 'some') return none();
                return some(this.invokeCallable(fn, [first()]));
            });
            methods.and_then = () => this.builtin('option.and_then', ([fn]: Value[]) => {
                if (value.tag !== 'some') return none();
                return this.invokeCallable(fn, [first()]);
            });
            methods.filter = () => this.builtin('option.filter', ([fn]: Value[]) => {
                if (value.tag !== 'some') return none();
                return isTruthy(this.invokeCallable(fn, [first()])) ? value : none();
            });
            methods.or_else = () => this.builtin('option.or_else', ([fn]: Value[]) => value.tag === 'some' ? value : this.invokeCallable(fn, []));
            methods.ok_or = () => this.builtin('option.ok_or', ([errorValue]: Value[]) => value.tag === 'some' ? ok(first()) : err(errorValue ?? null));
            methods.or = () => this.builtin('option.or', ([fallback]: Value[]) => {
                if (value.tag === 'some') return value;
                if ((fallback as any)?.type === 'enum') {
                    const e = fallback as AuraEnum;
                    if (e.tag === 'some' || e.tag === 'none') return fallback;
                }
                if (fallback === null) return none();
                return some(fallback);
            });
            methods.tap = () => this.builtin('option.tap', ([fn]: Value[]) => {
                if (value.tag === 'some') this.invokeCallable(fn, [first()]);
                return value;
            });
        }

        if (isResult) {
            methods.is_ok = () => value.tag === 'ok';
            methods.is_err = () => value.tag === 'error';
            methods.unwrap = () => {
                if (value.tag !== 'ok') runtimeError(`Called unwrap() on Err(${auraToString(first())})`);
                return first();
            };
            methods.unwrap_err = () => {
                if (value.tag !== 'error') runtimeError('Called unwrap_err() on Ok');
                return first();
            };
            methods.unwrap_or = () => this.builtin('result.unwrap_or', ([fallback]: Value[]) => value.tag === 'ok' ? first() : (fallback ?? null));
            methods.expect = () => this.builtin('result.expect', ([msg]: Value[]) => {
                if (value.tag === 'ok') return first();
                runtimeError(auraToString(msg ?? `Expected Ok, got Err(${auraToString(first())})`));
            });
            methods.map = () => this.builtin('result.map', ([fn]: Value[]) => value.tag === 'ok' ? ok(this.invokeCallable(fn, [first()])) : value);
            methods.map_err = () => this.builtin('result.map_err', ([fn]: Value[]) => value.tag === 'error' ? err(this.invokeCallable(fn, [first()])) : value);
            methods.and_then = () => this.builtin('result.and_then', ([fn]: Value[]) => value.tag === 'ok' ? this.invokeCallable(fn, [first()]) : value);
            methods.or_else = () => this.builtin('result.or_else', ([fn]: Value[]) => value.tag === 'error' ? this.invokeCallable(fn, [first()]) : value);
            methods.tap = () => this.builtin('result.tap', ([fn]: Value[]) => {
                if (value.tag === 'ok') this.invokeCallable(fn, [first()]);
                return value;
            });
            methods.tap_err = () => this.builtin('result.tap_err', ([fn]: Value[]) => {
                if (value.tag === 'error') this.invokeCallable(fn, [first()]);
                return value;
            });
            methods.recover = () => this.builtin('result.recover', ([fn]: Value[]) => value.tag === 'ok' ? value : ok(this.invokeCallable(fn, [first()])));
            methods.to_option = () => this.builtin('result.to_option', (args: Value[]) => {
                if (args.length !== 0) runtimeError('result.to_option() takes no arguments');
                return value.tag === 'ok' ? some(first()) : none();
            });
        }

        if (!(attr in methods)) runtimeError(`Enum has no attribute '${attr}'`);
        const out = methods[attr]();
        return (out as any)?.type === 'builtin' ? out : this.builtin(`enum.${attr}`, () => out);
    }

    private getNativeAttr(native: AuraNative, attr: string): Value {
        if (attr === 'explain_plan') {
            const summary = native.kind === 'stack' ? 'LIFO array-backed container'
                : native.kind === 'queue' ? 'FIFO array-backed container'
                    : native.kind === 'linked_list' ? 'Linked-list API with low-code methods'
                        : native.kind === 'heap' ? 'Binary heap with O(log n) push/pop'
                            : native.kind === 'hashmap' ? 'Hash map with average O(1) operations'
                                : native.kind === 'tree' ? 'Tree map with sorted key traversal'
                                    : native.kind === 'tensor' ? 'Dense numeric tensor with vectorized arithmetic'
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
        if (native.kind === 'tensor') return this.getTensorAttr(native, attr);
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

    private getTensorAttr(native: AuraNative, attr: string): Value {
        const data = this.expectTensor(native);
        const methods: Record<string, () => Value> = {
            len: () => data.values.length,
            rank: () => data.shape.length,
            shape: () => ({ type: 'list', items: [...data.shape] } as AuraList),
            to_list: () => this.tensorToNested(data.shape, data.values),
            to_flat_list: () => ({ type: 'list', items: data.values.map((v) => v as Value) } as AuraList),
            clone: () => ({ type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: [...data.values] } as NativeTensorData } as AuraNative),
            sum: () => data.values.reduce((acc, cur) => acc + cur, 0),
            mean: () => data.values.length === 0 ? 0 : data.values.reduce((acc, cur) => acc + cur, 0) / data.values.length,
            min: () => {
                if (data.values.length === 0) runtimeError('tensor.min requires non-empty tensor');
                let out = data.values[0];
                for (let i = 1; i < data.values.length; i++) if (data.values[i] < out) out = data.values[i];
                return out;
            },
            max: () => {
                if (data.values.length === 0) runtimeError('tensor.max requires non-empty tensor');
                let out = data.values[0];
                for (let i = 1; i < data.values.length; i++) if (data.values[i] > out) out = data.values[i];
                return out;
            },
            argmin: () => {
                if (data.values.length === 0) runtimeError('tensor.argmin requires non-empty tensor');
                let best = 0;
                for (let i = 1; i < data.values.length; i++) if (data.values[i] < data.values[best]) best = i;
                return best;
            },
            argmax: () => {
                if (data.values.length === 0) runtimeError('tensor.argmax requires non-empty tensor');
                let best = 0;
                for (let i = 1; i < data.values.length; i++) if (data.values[i] > data.values[best]) best = i;
                return best;
            },
            variance: () => this.builtin('tensor.variance', ([sample]: Value[]) => {
                if (data.values.length === 0) runtimeError('tensor.variance requires non-empty tensor');
                const sampleMode = sample === true;
                if (sampleMode && data.values.length < 2) runtimeError('tensor.variance(sample=true) requires at least 2 values');
                const mean = data.values.reduce((acc, cur) => acc + cur, 0) / data.values.length;
                let acc = 0;
                for (const v of data.values) {
                    const d = v - mean;
                    acc += d * d;
                }
                const denom = sampleMode ? data.values.length - 1 : data.values.length;
                return acc / denom;
            }),
            std: () => this.builtin('tensor.std', ([sample]: Value[]) => {
                const variance = (methods.variance() as BuiltinFn).fn([sample]);
                return Math.sqrt(this.asNumber(variance, 'tensor.std'));
            }),
            flatten: () => ({ type: 'native', kind: 'tensor', data: { shape: [data.values.length], values: [...data.values] } as NativeTensorData } as AuraNative),
            reshape: () => this.builtin('tensor.reshape', (args: Value[]) => {
                const dimsRaw = args.length === 1 && (args[0] as any)?.type === 'list'
                    ? (args[0] as AuraList).items
                    : args;
                if (dimsRaw.length === 0) runtimeError('tensor.reshape(shape) expects at least one dimension');
                const dims: number[] = [];
                for (const raw of dimsRaw) {
                    const dim = this.asNumber(raw, 'tensor.reshape');
                    const n = Math.trunc(dim);
                    if (n < 0 || n !== dim) runtimeError('tensor.reshape dimensions must be non-negative integers');
                    dims.push(n);
                }
                if (this.tensorSize(dims) !== data.values.length) runtimeError('tensor.reshape size mismatch');
                return { type: 'native', kind: 'tensor', data: { shape: dims, values: [...data.values] } as NativeTensorData } as AuraNative;
            }),
            transpose: () => {
                if (data.shape.length !== 2) runtimeError('tensor.transpose() currently supports rank-2 tensors');
                const rows = data.shape[0];
                const cols = data.shape[1];
                const out = new Array<number>(rows * cols);
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        out[c * rows + r] = data.values[r * cols + c];
                    }
                }
                return { type: 'native', kind: 'tensor', data: { shape: [cols, rows], values: out } as NativeTensorData } as AuraNative;
            },
            sum_axis: () => this.builtin('tensor.sum_axis', ([axis]: Value[]) => this.tensorReduceAxis(data, axis, 'sum')),
            mean_axis: () => this.builtin('tensor.mean_axis', ([axis]: Value[]) => this.tensorReduceAxis(data, axis, 'mean')),
            get: () => this.builtin('tensor.get', ([idx]: Value[]) => {
                const at = this.tensorLinearIndex(data.values.length, idx, 'tensor.get');
                return data.values[at];
            }),
            set: () => this.builtin('tensor.set', ([idx, value]: Value[]) => {
                const at = this.tensorLinearIndex(data.values.length, idx, 'tensor.set');
                data.values[at] = this.asNumber(value, 'tensor.set');
                return native;
            }),
            at: () => this.builtin('tensor.at', (args: Value[]) => {
                const at = this.tensorOffset(data.shape, args);
                return data.values[at];
            }),
            set_at: () => this.builtin('tensor.set_at', (args: Value[]) => {
                if (args.length < 2) runtimeError('tensor.set_at(i..., value) expects indices and value');
                const value = this.asNumber(args[args.length - 1], 'tensor.set_at');
                const at = this.tensorOffset(data.shape, args.slice(0, args.length - 1));
                data.values[at] = value;
                return native;
            }),
            fill_: () => this.builtin('tensor.fill_', ([value]: Value[]) => {
                const fill = this.asNumber(value, 'tensor.fill_');
                for (let i = 0; i < data.values.length; i++) data.values[i] = fill;
                return native;
            }),
            map: () => this.builtin('tensor.map', ([fn]: Value[]) => {
                const out = new Array<number>(data.values.length);
                for (let i = 0; i < data.values.length; i++) {
                    out[i] = this.asNumber(this.invokeCallable(fn, [data.values[i], i]), 'tensor.map');
                }
                return { type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: out } as NativeTensorData } as AuraNative;
            }),
            zip_map: () => this.builtin('tensor.zip_map', ([other, fn]: Value[]) => {
                const rhs = this.tensorFromValue(other, 'tensor.zip_map');
                if (!this.tensorSameShape(data.shape, rhs.shape)) runtimeError('tensor.zip_map expects tensors with same shape');
                const out = new Array<number>(data.values.length);
                for (let i = 0; i < data.values.length; i++) {
                    out[i] = this.asNumber(this.invokeCallable(fn, [data.values[i], rhs.values[i], i]), 'tensor.zip_map');
                }
                return { type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: out } as NativeTensorData } as AuraNative;
            }),
            add: () => this.builtin('tensor.add', ([rhs]: Value[]) => this.tensorBinaryOp(data, rhs, 'add', (a, b) => a + b)),
            sub: () => this.builtin('tensor.sub', ([rhs]: Value[]) => this.tensorBinaryOp(data, rhs, 'sub', (a, b) => a - b)),
            mul: () => this.builtin('tensor.mul', ([rhs]: Value[]) => this.tensorBinaryOp(data, rhs, 'mul', (a, b) => a * b)),
            div: () => this.builtin('tensor.div', ([rhs]: Value[]) => this.tensorBinaryOp(data, rhs, 'div', (a, b) => {
                if (b === 0) runtimeError('tensor.div division by zero');
                return a / b;
            })),
            add_: () => this.builtin('tensor.add_', ([rhs]: Value[]) => this.tensorBinaryOpInPlace(native, data, rhs, 'add', (a, b) => a + b)),
            sub_: () => this.builtin('tensor.sub_', ([rhs]: Value[]) => this.tensorBinaryOpInPlace(native, data, rhs, 'sub', (a, b) => a - b)),
            mul_: () => this.builtin('tensor.mul_', ([rhs]: Value[]) => this.tensorBinaryOpInPlace(native, data, rhs, 'mul', (a, b) => a * b)),
            div_: () => this.builtin('tensor.div_', ([rhs]: Value[]) => this.tensorBinaryOpInPlace(native, data, rhs, 'div', (a, b) => {
                if (b === 0) runtimeError('tensor.div_ division by zero');
                return a / b;
            })),
            exp: () => ({ type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: data.values.map((v) => Math.exp(v)) } as NativeTensorData } as AuraNative),
            log: () => ({ type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: data.values.map((v) => {
                if (v <= 0) runtimeError('tensor.log expects values > 0');
                return Math.log(v);
            }) } as NativeTensorData } as AuraNative),
            sigmoid: () => ({ type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: data.values.map((v) => 1 / (1 + Math.exp(-v))) } as NativeTensorData } as AuraNative),
            relu: () => ({ type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: data.values.map((v) => Math.max(0, v)) } as NativeTensorData } as AuraNative),
            tanh: () => ({ type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: data.values.map((v) => Math.tanh(v)) } as NativeTensorData } as AuraNative),
            abs: () => ({ type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: data.values.map((v) => Math.abs(v)) } as NativeTensorData } as AuraNative),
            sqrt: () => ({ type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: data.values.map((v) => {
                if (v < 0) runtimeError('tensor.sqrt expects values >= 0');
                return Math.sqrt(v);
            }) } as NativeTensorData } as AuraNative),
            pow: () => this.builtin('tensor.pow', ([rhs]: Value[]) => this.tensorBinaryOp(data, rhs, 'pow', (a, b) => Math.pow(a, b))),
            clip: () => this.builtin('tensor.clip', ([minVal, maxVal]: Value[]) => {
                const lo = this.asNumber(minVal, 'tensor.clip min');
                const hi = this.asNumber(maxVal, 'tensor.clip max');
                if (hi < lo) runtimeError('tensor.clip expects max >= min');
                return {
                    type: 'native',
                    kind: 'tensor',
                    data: { shape: [...data.shape], values: data.values.map((v) => Math.min(hi, Math.max(lo, v))) } as NativeTensorData,
                } as AuraNative;
            }),
            l2_norm: () => Math.sqrt(data.values.reduce((acc, cur) => acc + cur * cur, 0)),
            normalize: () => this.builtin('tensor.normalize', ([epsVal]: Value[]) => {
                const eps = epsVal === undefined ? 1e-12 : this.asNumber(epsVal, 'tensor.normalize eps');
                const norm = Math.sqrt(data.values.reduce((acc, cur) => acc + cur * cur, 0));
                const denom = norm + eps;
                return {
                    type: 'native',
                    kind: 'tensor',
                    data: { shape: [...data.shape], values: data.values.map((v) => v / denom) } as NativeTensorData,
                } as AuraNative;
            }),
            softmax: () => this.builtin('tensor.softmax', ([axis]: Value[]) => this.tensorSoftmax(data, axis, false)),
            log_softmax: () => this.builtin('tensor.log_softmax', ([axis]: Value[]) => this.tensorSoftmax(data, axis, true)),
            dot: () => this.builtin('tensor.dot', ([other]: Value[]) => {
                const rhs = this.tensorFromValue(other, 'tensor.dot');
                if (data.shape.length !== 1 || rhs.shape.length !== 1) runtimeError('tensor.dot expects rank-1 tensors');
                if (data.values.length !== rhs.values.length) runtimeError('tensor.dot expects vectors with same length');
                let out = 0;
                for (let i = 0; i < data.values.length; i++) out += data.values[i] * rhs.values[i];
                return out;
            }),
            matmul: () => this.builtin('tensor.matmul', ([other]: Value[]) => {
                const rhs = this.tensorFromValue(other, 'tensor.matmul');
                return this.tensorMatmul(data, rhs);
            }),
            mse_loss: () => this.builtin('tensor.mse_loss', ([target]: Value[]) => {
                const rhs = this.tensorFromValue(target, 'tensor.mse_loss');
                if (!this.tensorSameShape(data.shape, rhs.shape)) runtimeError('tensor.mse_loss expects tensors with same shape');
                if (data.values.length === 0) return 0;
                let acc = 0;
                for (let i = 0; i < data.values.length; i++) {
                    const d = data.values[i] - rhs.values[i];
                    acc += d * d;
                }
                return acc / data.values.length;
            }),
            bce_loss: () => this.builtin('tensor.bce_loss', ([target, epsVal]: Value[]) => {
                const rhs = this.tensorFromValue(target, 'tensor.bce_loss');
                if (!this.tensorSameShape(data.shape, rhs.shape)) runtimeError('tensor.bce_loss expects tensors with same shape');
                if (data.values.length === 0) return 0;
                const eps = epsVal === undefined ? 1e-12 : this.asNumber(epsVal, 'tensor.bce_loss eps');
                let acc = 0;
                for (let i = 0; i < data.values.length; i++) {
                    const p = Math.min(1 - eps, Math.max(eps, data.values[i]));
                    const y = rhs.values[i];
                    acc += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
                }
                return acc / data.values.length;
            }),
        };

        if (!(attr in methods)) runtimeError('Tensor has no attribute ' + "'" + attr + "'");
        const value = methods[attr]();
        return (value as any)?.type === 'builtin' ? value : this.builtin('tensor.' + attr, () => value);
    }

    private tensorSize(shape: number[]): number {
        let size = 1;
        for (const dim of shape) size *= dim;
        return size;
    }

    private tensorSameShape(a: number[], b: number[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    private tensorLinearIndex(length: number, idx: Value, label: string): number {
        if (typeof idx !== 'number') runtimeError(label + ' expects numeric index');
        const raw = Math.trunc(idx);
        const resolved = raw < 0 ? length + raw : raw;
        if (resolved < 0 || resolved >= length) runtimeError(label + ' index out of bounds');
        return resolved;
    }

    private tensorOffset(shape: number[], indices: Value[]): number {
        if (shape.length !== indices.length) runtimeError('tensor index rank mismatch');
        let offset = 0;
        for (let i = 0; i < shape.length; i++) {
            const dim = shape[i];
            const idx = this.tensorLinearIndex(dim, indices[i], 'tensor index');
            offset = offset * dim + idx;
        }
        return offset;
    }

    private tensorToNested(shape: number[], values: number[]): Value {
        if (shape.length === 0) return values[0] ?? 0;
        if (shape.length === 1) return { type: 'list', items: values.map((v) => v as Value) } as AuraList;
        const step = this.tensorSize(shape.slice(1));
        const out: Value[] = [];
        for (let i = 0; i < shape[0]; i++) {
            const start = i * step;
            out.push(this.tensorToNested(shape.slice(1), values.slice(start, start + step)));
        }
        return { type: 'list', items: out } as AuraList;
    }

    private tensorFromValue(value: Value, context: string): NativeTensorData {
        if ((value as any)?.type === 'native' && (value as AuraNative).kind === 'tensor') {
            return this.expectTensor(value as AuraNative);
        }
        runtimeError(context + ' expects a Tensor');
    }

    private tensorStrides(shape: number[]): number[] {
        const strides = new Array<number>(shape.length);
        let stride = 1;
        for (let i = shape.length - 1; i >= 0; i--) {
            strides[i] = stride;
            stride *= shape[i];
        }
        return strides;
    }

    private tensorBroadcastShape(a: number[], b: number[]): number[] | undefined {
        const n = Math.max(a.length, b.length);
        const out = new Array<number>(n);
        for (let i = 0; i < n; i++) {
            const da = a[a.length - 1 - i] ?? 1;
            const db = b[b.length - 1 - i] ?? 1;
            if (da !== db && da !== 1 && db !== 1) return undefined;
            out[n - 1 - i] = Math.max(da, db);
        }
        return out;
    }

    private tensorBroadcastBinary(
        lhs: NativeTensorData,
        rhs: NativeTensorData,
        op: (a: number, b: number) => number,
    ): AuraNative | undefined {
        const outShape = this.tensorBroadcastShape(lhs.shape, rhs.shape);
        if (!outShape) return undefined;

        const outSize = this.tensorSize(outShape);
        const outValues = new Array<number>(outSize);
        const outStrides = this.tensorStrides(outShape);
        const lhsStrides = this.tensorStrides(lhs.shape);
        const rhsStrides = this.tensorStrides(rhs.shape);

        for (let idx = 0; idx < outSize; idx++) {
            let rem = idx;
            let lhsOffset = 0;
            let rhsOffset = 0;
            for (let d = 0; d < outShape.length; d++) {
                const coord = outStrides[d] === 0 ? 0 : Math.floor(rem / outStrides[d]);
                rem = outStrides[d] === 0 ? 0 : rem % outStrides[d];

                const lhsD = d - (outShape.length - lhs.shape.length);
                if (lhsD >= 0) {
                    const lhsDim = lhs.shape[lhsD];
                    const lhsCoord = lhsDim === 1 ? 0 : coord;
                    lhsOffset += lhsCoord * lhsStrides[lhsD];
                }

                const rhsD = d - (outShape.length - rhs.shape.length);
                if (rhsD >= 0) {
                    const rhsDim = rhs.shape[rhsD];
                    const rhsCoord = rhsDim === 1 ? 0 : coord;
                    rhsOffset += rhsCoord * rhsStrides[rhsD];
                }
            }
            outValues[idx] = op(lhs.values[lhsOffset], rhs.values[rhsOffset]);
        }

        return { type: 'native', kind: 'tensor', data: { shape: outShape, values: outValues } as NativeTensorData } as AuraNative;
    }

    private tensorBinaryOp(
        lhs: NativeTensorData,
        rhsValue: Value,
        context: string,
        op: (a: number, b: number) => number,
    ): AuraNative {
        if (typeof rhsValue === 'number') {
            return {
                type: 'native',
                kind: 'tensor',
                data: { shape: [...lhs.shape], values: lhs.values.map((v) => op(v, rhsValue)) } as NativeTensorData,
            } as AuraNative;
        }

        const rhs = this.tensorFromValue(rhsValue, 'tensor.' + context);
        const broadcasted = this.tensorBroadcastBinary(lhs, rhs, op);
        if (broadcasted) return broadcasted;

        runtimeError('tensor.' + context + ' expects tensors with broadcast-compatible shapes');
    }

    private tensorBinaryOpInPlace(
        targetNative: AuraNative,
        target: NativeTensorData,
        rhsValue: Value,
        context: string,
        op: (a: number, b: number) => number,
    ): AuraNative {
        const out = this.tensorBinaryOp(target, rhsValue, context, op);
        const outData = this.expectTensor(out);
        if (!this.tensorSameShape(outData.shape, target.shape)) {
            runtimeError('tensor.' + context + '_ requires result shape to match target tensor shape');
        }
        target.values = [...outData.values];
        return targetNative;
    }

    private tensorReduceAxis(data: NativeTensorData, axisValue: Value, kind: 'sum' | 'mean'): Value {
        if (data.shape.length === 1) {
            if (axisValue !== undefined && axisValue !== null) {
                const axis = Math.trunc(this.asNumber(axisValue, 'tensor.' + kind + '_axis'));
                if (axis !== 0 && axis !== -1) runtimeError('tensor.' + kind + '_axis axis must be 0 or -1 for rank-1 tensor');
            }
            const total = data.values.reduce((acc, cur) => acc + cur, 0);
            return kind === 'sum' ? total : (data.values.length === 0 ? 0 : total / data.values.length);
        }

        if (data.shape.length !== 2) runtimeError('tensor.' + kind + '_axis currently supports rank-1 and rank-2 tensors');

        const rows = data.shape[0];
        const cols = data.shape[1];
        const axis = axisValue === undefined || axisValue === null
            ? -1
            : Math.trunc(this.asNumber(axisValue, 'tensor.' + kind + '_axis'));

        if (axis === -1 || axis === 1) {
            const out = new Array<number>(rows).fill(0);
            for (let r = 0; r < rows; r++) {
                let acc = 0;
                for (let c = 0; c < cols; c++) acc += data.values[r * cols + c];
                out[r] = kind === 'mean' ? (cols === 0 ? 0 : acc / cols) : acc;
            }
            return { type: 'native', kind: 'tensor', data: { shape: [rows], values: out } as NativeTensorData } as AuraNative;
        }

        if (axis === 0) {
            const out = new Array<number>(cols).fill(0);
            for (let c = 0; c < cols; c++) {
                let acc = 0;
                for (let r = 0; r < rows; r++) acc += data.values[r * cols + c];
                out[c] = kind === 'mean' ? (rows === 0 ? 0 : acc / rows) : acc;
            }
            return { type: 'native', kind: 'tensor', data: { shape: [cols], values: out } as NativeTensorData } as AuraNative;
        }

        runtimeError('tensor.' + kind + '_axis axis must be 0, 1, or -1');
    }

    private tensorSoftmax(data: NativeTensorData, axisValue: Value, logOutput: boolean): AuraNative {
        if (data.shape.length === 1) {
            const maxVal = data.values.length === 0 ? 0 : Math.max(...data.values);
            const exps = data.values.map((v) => Math.exp(v - maxVal));
            const sum = exps.reduce((acc, cur) => acc + cur, 0);
            const vals = exps.map((v) => {
                const p = sum === 0 ? 0 : v / sum;
                return logOutput ? Math.log(Math.max(1e-12, p)) : p;
            });
            return { type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: vals } as NativeTensorData } as AuraNative;
        }

        if (data.shape.length !== 2) runtimeError('tensor.softmax/log_softmax currently supports rank-1 and rank-2 tensors');

        const rows = data.shape[0];
        const cols = data.shape[1];
        const axis = axisValue === undefined || axisValue === null
            ? -1
            : Math.trunc(this.asNumber(axisValue, 'tensor.softmax axis'));
        const out = new Array<number>(data.values.length).fill(0);

        if (axis === -1 || axis === 1) {
            for (let r = 0; r < rows; r++) {
                let maxVal = -Infinity;
                for (let c = 0; c < cols; c++) {
                    const v = data.values[r * cols + c];
                    if (v > maxVal) maxVal = v;
                }
                let sum = 0;
                for (let c = 0; c < cols; c++) {
                    const e = Math.exp(data.values[r * cols + c] - maxVal);
                    out[r * cols + c] = e;
                    sum += e;
                }
                for (let c = 0; c < cols; c++) {
                    const p = sum === 0 ? 0 : out[r * cols + c] / sum;
                    out[r * cols + c] = logOutput ? Math.log(Math.max(1e-12, p)) : p;
                }
            }
            return { type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: out } as NativeTensorData } as AuraNative;
        }

        if (axis === 0) {
            for (let c = 0; c < cols; c++) {
                let maxVal = -Infinity;
                for (let r = 0; r < rows; r++) {
                    const v = data.values[r * cols + c];
                    if (v > maxVal) maxVal = v;
                }
                let sum = 0;
                for (let r = 0; r < rows; r++) {
                    const e = Math.exp(data.values[r * cols + c] - maxVal);
                    out[r * cols + c] = e;
                    sum += e;
                }
                for (let r = 0; r < rows; r++) {
                    const p = sum === 0 ? 0 : out[r * cols + c] / sum;
                    out[r * cols + c] = logOutput ? Math.log(Math.max(1e-12, p)) : p;
                }
            }
            return { type: 'native', kind: 'tensor', data: { shape: [...data.shape], values: out } as NativeTensorData } as AuraNative;
        }

        runtimeError('tensor.softmax/log_softmax axis must be 0, 1, or -1');
    }

    private tensorMatmul(lhs: NativeTensorData, rhs: NativeTensorData): Value {
        if (lhs.shape.length === 1 && rhs.shape.length === 1) {
            if (lhs.values.length !== rhs.values.length) runtimeError('tensor.matmul vector length mismatch');
            let sum = 0;
            for (let i = 0; i < lhs.values.length; i++) sum += lhs.values[i] * rhs.values[i];
            return sum;
        }

        if (lhs.shape.length === 1 && rhs.shape.length === 2) {
            const n = lhs.shape[0];
            const rhsRows = rhs.shape[0];
            const p = rhs.shape[1];
            if (n !== rhsRows) runtimeError('tensor.matmul dimension mismatch');
            const out = new Array<number>(p).fill(0);
            for (let c = 0; c < p; c++) {
                let sum = 0;
                for (let k = 0; k < n; k++) sum += lhs.values[k] * rhs.values[k * p + c];
                out[c] = sum;
            }
            return { type: 'native', kind: 'tensor', data: { shape: [p], values: out } as NativeTensorData } as AuraNative;
        }

        if (lhs.shape.length === 2 && rhs.shape.length === 1) {
            const m = lhs.shape[0];
            const n = lhs.shape[1];
            const rhsLen = rhs.shape[0];
            if (n !== rhsLen) runtimeError('tensor.matmul dimension mismatch');
            const out = new Array<number>(m).fill(0);
            for (let r = 0; r < m; r++) {
                let sum = 0;
                for (let k = 0; k < n; k++) sum += lhs.values[r * n + k] * rhs.values[k];
                out[r] = sum;
            }
            return { type: 'native', kind: 'tensor', data: { shape: [m], values: out } as NativeTensorData } as AuraNative;
        }

        if (lhs.shape.length === 2 && rhs.shape.length === 2) {
            const m = lhs.shape[0];
            const n = lhs.shape[1];
            const rhsRows = rhs.shape[0];
            const p = rhs.shape[1];
            if (n !== rhsRows) runtimeError('tensor.matmul dimension mismatch');
            const out = new Array<number>(m * p).fill(0);
            for (let r = 0; r < m; r++) {
                for (let c = 0; c < p; c++) {
                    let sum = 0;
                    for (let k = 0; k < n; k++) {
                        sum += lhs.values[r * n + k] * rhs.values[k * p + c];
                    }
                    out[r * p + c] = sum;
                }
            }
            return { type: 'native', kind: 'tensor', data: { shape: [m, p], values: out } as NativeTensorData } as AuraNative;
        }

        runtimeError('tensor.matmul currently supports rank-1/rank-2 combinations only');
    }

    private expectTensor(native: AuraNative): NativeTensorData {
        const data = native.data as NativeTensorData;
        if (!data || !Array.isArray(data.shape) || !Array.isArray(data.values)) runtimeError('Tensor storage is invalid');
        if (!data.shape.every((dim) => Number.isInteger(dim) && dim >= 0)) runtimeError('Tensor shape must be non-negative integers');
        if (!data.values.every((v) => typeof v === 'number')) runtimeError('Tensor values must be numeric');
        if (this.tensorSize(data.shape) !== data.values.length) runtimeError('Tensor shape/value length mismatch');
        return data;
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
            if (native.kind === 'tensor') {
                const tensor = this.expectTensor(native);
                return { type: 'native', kind: 'tensor', data: { shape: [...tensor.shape], values: [...tensor.values] } };
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

    private pushFrame(
        chunk: Chunk,
        locals: Map<string, Value>,
        receiver?: AuraInstance,
        constructing?: AuraInstance,
        moduleScope?: Map<string, Value>,
        localSlots?: Value[],
    ): void {
        this.frames.push({
            chunk,
            ip: 0,
            locals,
            localSlots,
            receiver,
            constructing,
            fnName: chunk.name,
            file: chunk.file,
            moduleScope,
        });
    }

    private moduleScopeOf(fn: AuraFunction): Map<string, Value> | undefined {
        const scope = (fn as any).moduleScope;
        if (scope instanceof Map) return scope as Map<string, Value>;
        return undefined;
    }

    private push(v: Value): void { this.stack.push(v); }
    private pop(): Value { return this.stack.pop() ?? null; }
    private peek(): Value { return this.stack[this.stack.length - 1] ?? null; }
}
