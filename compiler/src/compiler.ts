import {
    ASTNode, Chunk, Instruction, OpCode, Value,
    AuraFunction, AuraClass, Param, FieldDef, FnDecl,
} from './types.js';
import { compileError } from './errors.js';

// ─── Scope ─────────────────────────────────────────────────────────────────────
type ScopeFrame = Map<string, true>;
type TypeGuard =
    | { kind: 'constraint'; name: string; checker: string }
    | { kind: 'measure'; dimension: string };

type FunctionCompileState = {
    scopeBase: number;
    slotScopes: Map<string, number>[];
    nextSlot: number;
    maxSlot: number;
    paramSlots: number[];
    selfSlot?: number;
};

export class Compiler {
    private chunk: Chunk;
    private scopes: ScopeFrame[] = [];
    private classStack: string[] = [];          // current class being compiled
    private traitMethods = new Map<string, FnDecl[]>();   // trait name → default methods
    private classMap = new Map<string, AuraClass>();       // class name → class obj
    private constraintFns = new Map<string, string>();     // constraint type -> checker fn name
    private globalTypeGuards = new Map<string, TypeGuard>();
    private typeGuardScopes: Map<string, TypeGuard>[] = [];
    private loopStarts: number[] = [];
    private breakPatches: number[][] = [];
    private functionStates: FunctionCompileState[] = [];
    private constIndexByChunk = new WeakMap<Chunk, Map<string, number>>();

    constructor(private file: string, private options: { autoInvokeMain?: boolean } = {}) {
        this.chunk = { name: '<top>', file, code: [], constants: [] };
    }

    compile(program: ASTNode): Chunk {
        if (program.kind === 'Program') {
            for (const node of program.body) {
                if (node.kind === 'FnDecl' && node.name.startsWith('__constraint_')) {
                    const typeName = node.name.slice('__constraint_'.length);
                    this.constraintFns.set(typeName, node.name);
                }
            }
        }
        this.emit_node(program);
        if ((this.options.autoInvokeMain ?? true) &&
            program.kind === 'Program' &&
            program.body.some(n => n.kind === 'FnDecl' && n.name === 'main')) {
            this.emit('GET_GLOBAL', 'main', 0);
            this.emit('CALL', 0, 0);
        }
        this.emit('HALT', undefined, 0);
        return this.chunk;
    }

    // ─── Node dispatch ───────────────────────────────────────────────────────────
    private emit_node(node: ASTNode): void {
        switch (node.kind) {
            case 'Program': node.body.forEach(n => this.emit_node(n)); break;
            case 'Block': node.stmts.forEach(n => this.emit_node(n)); break;
            case 'ModuleStmt': break; // ignore
            case 'ImportStmt': break; // ignore for MVP

            case 'LetStmt':
            case 'VarStmt': {
                const guard = this.guardFromTypeAnn(node.typeAnn);
                if (node.value) this.emit_node(node.value);
                else this.emit('PUSH_NIL', undefined, node.line);
                if (guard && node.value) this.emitGuardCheck(guard, node.line);
                if (this.scopes.length > 0) {
                    this.scopes[this.scopes.length - 1].set(node.name, true);
                    this.declareLocalSlot(node.name);
                    if (guard && this.typeGuardScopes.length > 0) {
                        this.typeGuardScopes[this.typeGuardScopes.length - 1].set(node.name, guard);
                    } else if (this.typeGuardScopes.length > 0) {
                        this.typeGuardScopes[this.typeGuardScopes.length - 1].delete(node.name);
                    }
                    this.emitSet(node.name, node.line);
                } else {
                    if (guard) this.globalTypeGuards.set(node.name, guard);
                    else this.globalTypeGuards.delete(node.name);
                    this.emit('DEFINE_GLOBAL', node.name, node.line);
                }
                break;
            }

            case 'AssignStmt': {
                const t = node.target;
                if (t.kind === 'Ident') {
                    this.emit_node(node.value);
                    const guard = this.lookupGuard(t.name);
                    if (guard) this.emitGuardCheck(guard, node.line);
                    this.emitSet(t.name, node.line);
                } else if (t.kind === 'AttributeExpr') {
                    // compile object chain up to the last attribute
                    this.compileAttrChain(t.obj);
                    this.emit_node(node.value);
                    this.emit('SET_ATTR', t.attr, node.line);
                } else if (t.kind === 'IndexExpr') {
                    this.emit_node(t.obj);
                    this.emit_node(t.index);
                    this.emit_node(node.value);
                    this.emit('SET_INDEX', undefined, node.line);
                }
                break;
            }

            case 'AugAssignStmt': {
                const t = node.target;
                if (t.kind === 'Ident') {
                    this.emitGet(t.name, node.line);
                    this.emit_node(node.value);
                    this.emitArith(node.op, node.line);
                    const guard = this.lookupGuard(t.name);
                    if (guard) this.emitGuardCheck(guard, node.line);
                    this.emitSet(t.name, node.line);
                } else if (t.kind === 'AttributeExpr') {
                    // DUP the object, get current attr, add value, set attr
                    this.compileAttrChain(t.obj); // push obj
                    this.emit('DUP', undefined, node.line);
                    this.emit('GET_ATTR', t.attr, node.line);  // push current val
                    this.emit_node(node.value);
                    this.emitArith(node.op, node.line);
                    this.emit('SET_ATTR', t.attr, node.line);
                }
                break;
            }

            case 'FnDecl': {
                const fn = this.compileFnDecl(node);
                this.emit('PUSH_CONST', this.addConst(fn), node.line);
                if (this.scopes.length > 0) {
                    this.scopes[this.scopes.length - 1].set(node.name, true);
                    this.declareLocalSlot(node.name);
                    this.emitSet(node.name, node.line);
                } else {
                    this.emit('DEFINE_GLOBAL', node.name, node.line);
                }
                break;
            }

            case 'ClassDecl': {
                this.classStack.push(node.name);
                const fields = node.fields.map((f) => ({
                    ...f,
                    defaultVal: this.tryConstValue(f.defaultVal as ASTNode | undefined),
                }));
                const klass: AuraClass = {
                    type: 'class',
                    name: node.name,
                    fields,
                    methods: new Map(),
                };
                // Compile all methods
                for (const m of node.methods) {
                    klass.methods.set(m.name, this.compileFnDecl(m));
                }
                this.classStack.pop();
                this.classMap.set(node.name, klass);
                this.emit('PUSH_CONST', this.addConst(klass), node.line);
                this.emit('DEFINE_GLOBAL', node.name, node.line);
                break;
            }

            case 'InterfaceDecl': break; // duck typing — no-op at runtime

            case 'TraitDecl': {
                // Store default methods for later impl
                this.traitMethods.set(node.name, node.methods.filter(m => m.body.stmts.length > 0));
                break;
            }

            case 'ImplDecl': {
                const klass = this.classMap.get(node.typeName);
                if (!klass) {
                    // Class defined later — we'll patch it; emit as deferred global patch
                    // For now store and process at end
                    this.deferImplDecl(node);
                    break;
                }
                this.classStack.push(node.typeName);
                // Add trait default methods first (can be overridden)
                if (node.traitName) {
                    const defaults = this.traitMethods.get(node.traitName) ?? [];
                    for (const m of defaults) {
                        if (!klass.methods.has(m.name)) {
                            klass.methods.set(m.name, this.compileFnDecl(m));
                        }
                    }
                }
                for (const m of node.methods) {
                    klass.methods.set(m.name, this.compileFnDecl(m));
                }
                this.classStack.pop();
                break;
            }

            case 'EnumDecl': break; // variants handled as EnumCtor at runtime

            case 'ReturnStmt': {
                if (node.value) this.emit_node(node.value);
                else this.emit('PUSH_NIL', undefined, node.line);
                this.emit('RETURN', undefined, node.line);
                break;
            }

            case 'IfStmt': {
                this.emit_node(node.cond);
                const toElif = this.emitJump('JUMP_IF_FALSE', node.line);
                this.emit_node(node.then);
                const toEnd: number[] = [];
                toEnd.push(this.emitJump('JUMP', node.line));
                this.patchJump(toElif);
                for (const elif of node.elifs) {
                    this.emit_node(elif.cond);
                    const skip = this.emitJump('JUMP_IF_FALSE', node.line);
                    this.emit_node(elif.body);
                    toEnd.push(this.emitJump('JUMP', node.line));
                    this.patchJump(skip);
                }
                if (node.else_) this.emit_node(node.else_);
                toEnd.forEach(j => this.patchJump(j));
                break;
            }

            case 'WhileStmt': {
                const loopStart = this.chunk.code.length;
                this.loopStarts.push(loopStart);
                const breaks: number[] = [];
                this.breakPatches.push(breaks);
                this.emit_node(node.cond);
                const exitJump = this.emitJump('JUMP_IF_FALSE', node.line);
                this.emit_node(node.body);
                this.emit('JUMP', loopStart, node.line);
                this.patchJump(exitJump);
                breaks.forEach(b => this.patchJump(b));
                this.loopStarts.pop();
                this.breakPatches.pop();
                break;
            }

            case 'ForStmt': {
                this.emit_node(node.iter);
                this.emit('GET_ITER', undefined, node.line);
                const loopStart = this.chunk.code.length;
                this.loopStarts.push(loopStart);
                const breaks: number[] = [];
                this.breakPatches.push(breaks);
                const exitJump = this.emitJump('FOR_ITER', node.line);
                // Push scope for loop variable
                this.pushScope();
                this.scopes[this.scopes.length - 1].set(node.name, true);
                this.declareLocalSlot(node.name);
                this.emitSet(node.name, node.line);
                this.emit_node(node.body);
                this.popScope();
                this.emit('JUMP', loopStart, node.line);
                this.patchJump(exitJump);
                this.emit('POP', undefined, node.line); // pop the iterator
                breaks.forEach(b => this.patchJump(b));
                this.loopStarts.pop();
                this.breakPatches.pop();
                break;
            }

            case 'BreakStmt': {
                const jumps = this.breakPatches[this.breakPatches.length - 1];
                if (!jumps) compileError('break outside loop', this.file, node.line);
                jumps.push(this.emitJump('JUMP', node.line));
                break;
            }

            case 'ContinueStmt': {
                const start = this.loopStarts[this.loopStarts.length - 1];
                this.emit('JUMP', start, node.line);
                break;
            }

            case 'MatchStmt': {
                this.emit_node(node.subject);
                const toEnds: number[] = [];
                for (const c of node.cases) {
                    const pat = c.pattern;
                    if (pat.kind === 'WildcardPattern' || pat.kind === 'IdentPattern') {
                        // Always matches
                        if (pat.kind === 'IdentPattern') {
                            this.pushScope();
                            this.scopes[this.scopes.length - 1].set(pat.name, true);
                            this.declareLocalSlot(pat.name);
                            this.emit('DUP', undefined, node.line);
                            this.emitSet(pat.name, node.line);
                        }
                        this.emit_node(c.body);
                        this.emit('POP', undefined, node.line); // pop match subject
                        if (pat.kind === 'IdentPattern') this.popScope();
                        toEnds.push(this.emitJump('JUMP', node.line));
                        break;
                    } else if (pat.kind === 'EnumPattern') {
                        // MATCH_ENUM "tag:bindings:jumpTarget"
                        this.emit('MATCH_ENUM', `${pat.tag}:${pat.bindings.length}:0`, node.line);
                        const matchIdx = this.chunk.code.length - 1;
                        this.pushScope();
                        for (const b of [...pat.bindings].reverse()) {
                            this.scopes[this.scopes.length - 1].set(b, true);
                            this.declareLocalSlot(b);
                            this.emitSet(b, node.line);
                        }
                        this.emit_node(c.body);
                        this.emit('POP', undefined, node.line); // pop match subject
                        this.popScope();
                        toEnds.push(this.emitJump('JUMP', node.line));
                        this.chunk.code[matchIdx].arg = `${pat.tag}:${pat.bindings.length}:${this.chunk.code.length}`;
                    } else if (pat.kind === 'LiteralPattern') {
                        this.emit('DUP', undefined, node.line);
                        this.emit_node(pat.value);
                        this.emit('EQ', undefined, node.line);
                        const skip = this.emitJump('JUMP_IF_FALSE', node.line);
                        this.emit_node(c.body);
                        this.emit('POP', undefined, node.line); // pop match subject
                        toEnds.push(this.emitJump('JUMP', node.line));
                        this.patchJump(skip);
                    }
                }
                this.emit('POP', undefined, node.line); // pop subject if no case matched
                toEnds.forEach(j => this.patchJump(j));
                break;
            }

            case 'ExprStmt': {
                this.emit_node(node.expr);
                this.emit('POP', undefined, node.line);
                break;
            }

            // ── Expressions ──────────────────────────────────────────────────────────
            case 'NumberLit': this.emit('PUSH_CONST', this.addConst(node.value), node.line); break;
            case 'StringLit': this.emit('PUSH_CONST', this.addConst(node.value), node.line); break;
            case 'BoolLit': this.emit(node.value ? 'PUSH_TRUE' : 'PUSH_FALSE', undefined, node.line); break;
            case 'NilLit': this.emit('PUSH_NIL', undefined, node.line); break;

            case 'TemplateString': {
                for (const p of node.parts) this.emit_node(p);
                this.emit('BUILD_STRING', node.parts.length, node.line);
                break;
            }

            case 'Ident': {
                this.emitGet(node.name, node.line);
                break;
            }

            case 'SelfExpr': {
                this.emitGet('self', node.line);
                break;
            }

            case 'BinOp': {
                if (node.op === 'and') {
                    this.emit_node(node.left);
                    this.emit('DUP', undefined, node.line);
                    const skip = this.emitJump('JUMP_IF_FALSE', node.line);
                    this.emit('POP', undefined, node.line);
                    this.emit_node(node.right);
                    this.patchJump(skip);
                    break;
                }
                if (node.op === 'or') {
                    this.emit_node(node.left);
                    this.emit('DUP', undefined, node.line);
                    const skip = this.emitJump('JUMP_IF_TRUE', node.line);
                    this.emit('POP', undefined, node.line);
                    this.emit_node(node.right);
                    this.patchJump(skip);
                    break;
                }
                this.emit_node(node.left);
                this.emit_node(node.right);
                const opMap: Record<string, OpCode> = {
                    '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD', '**': 'POW',
                    '==': 'EQ', '!=': 'NEQ', '<': 'LT', '>': 'GT', '<=': 'LE', '>=': 'GE',
                };
                const op = opMap[node.op];
                if (!op) compileError(`Unknown binary op: ${node.op}`, this.file, node.line);
                this.emit(op, undefined, node.line);
                break;
            }

            case 'UnaryOp': {
                this.emit_node(node.operand);
                if (node.op === '-') this.emit('NEG', undefined, node.line);
                else if (node.op === 'not' || node.op === '!') this.emit('NOT', undefined, node.line);
                break;
            }

            case 'RangeExpr': {
                this.emit_node(node.start);
                this.emit_node(node.end);
                this.emit('BUILD_RANGE', node.inclusive, node.line);
                break;
            }

            case 'ListExpr': {
                for (const item of node.items) this.emit_node(item);
                this.emit('BUILD_LIST', node.items.length, node.line);
                break;
            }

            case 'MapExpr': {
                for (const e of node.entries) { this.emit_node(e.key); this.emit_node(e.val); }
                this.emit('BUILD_MAP', node.entries.length, node.line);
                break;
            }

            case 'TupleExpr': {
                for (const item of node.items) this.emit_node(item);
                this.emit('BUILD_LIST', node.items.length, node.line); // treat as list for MVP
                break;
            }

            case 'EnumCtor': {
                for (const a of node.args) this.emit_node(a);
                this.emit('BUILD_ENUM', node.tag + ':' + node.args.length, node.line);
                break;
            }

            case 'AttributeExpr': {
                this.compileAttrChain(node.obj);
                this.emit('GET_ATTR', node.attr, node.line);
                break;
            }

            case 'IndexExpr': {
                this.emit_node(node.obj);
                this.emit_node(node.index);
                this.emit('GET_INDEX', undefined, node.line);
                break;
            }

            case 'CallExpr': {
                // Check for special print(...)
                if (node.callee.kind === 'Ident' && node.callee.name === 'print') {
                    for (const a of node.args) this.emit_node(a.value);
                    this.emit('PRINT', node.args.length, node.line);
                    break;
                }
                this.emit_node(node.callee);
                for (const a of node.args) this.emit_node(a.value);
                this.emit('CALL', node.args.length, node.line);
                break;
            }

            case 'MethodCallExpr': {
                this.compileAttrChain(node.obj);
                for (const a of node.args) this.emit_node(a.value);
                this.emit('CALL_METHOD', node.method + ':' + node.args.length, node.line);
                break;
            }

            case 'FnExpr': {
                const fn = this.compileFnDecl({
                    kind: 'FnDecl', name: '<lambda>', params: node.params,
                    body: node.body, isAsync: false, typeParams: [], line: node.line,
                    retType: undefined,
                });
                this.emit('PUSH_CONST', this.addConst(fn), node.line);
                break;
            }

            default:
                compileError(`Cannot compile node kind: ${(node as any).kind}`, this.file, 0);
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────────
    private compileFnDecl(node: FnDecl): AuraFunction {
        const savedChunk = this.chunk;
        const fnChunk: Chunk = { name: node.name, file: this.file, code: [], constants: [] };
        this.chunk = fnChunk;

        const fnState: FunctionCompileState = {
            scopeBase: this.scopes.length,
            slotScopes: [],
            nextSlot: 0,
            maxSlot: 0,
            paramSlots: [],
        };
        this.functionStates.push(fnState);

        this.pushScope();

        if (this.classStack.length > 0) {
            this.scopes[this.scopes.length - 1].set('self', true);
            fnState.selfSlot = this.declareLocalSlot('self');
        }

        const params: Param[] = node.params.map((p) => ({
            ...p,
            defaultVal: this.tryConstValue(p.defaultVal as ASTNode | undefined),
        }));

        for (const p of params) {
            this.scopes[this.scopes.length - 1].set(p.name, true);
            const slot = this.declareLocalSlot(p.name);
            if (slot !== undefined) fnState.paramSlots.push(slot);
            const guard = this.guardFromTypeAnn(p.typeAnn);
            if (guard && this.typeGuardScopes.length > 0) {
                this.typeGuardScopes[this.typeGuardScopes.length - 1].set(p.name, guard);
            }
        }

        for (const p of params) {
            const guard = this.guardFromTypeAnn(p.typeAnn);
            if (!guard) continue;
            this.emitGet(p.name, node.line);
            this.emitGuardCheck(guard, node.line);
            this.emitSet(p.name, node.line);
        }

        this.emit_node(node.body);
        this.emit('PUSH_NIL', undefined, node.line);
        this.emit('RETURN', undefined, node.line);

        this.popScope();
        this.functionStates.pop();
        this.chunk = savedChunk;

        return {
            type: 'function',
            name: node.name,
            params,
            chunk: fnChunk,
            closure: [],
            paramSlots: fnState.paramSlots,
            localCount: fnState.maxSlot,
            selfSlot: fnState.selfSlot,
        };
    }

    private compileAttrChain(node: ASTNode): void {
        if (node.kind === 'AttributeExpr') {
            this.compileAttrChain(node.obj);
            this.emit('GET_ATTR', node.attr, node.line);
        } else {
            this.emit_node(node);
        }
    }

    private deferImplDecl(node: any): void {
        // Emit a special instruction that will patch the class at runtime
        const methods = node.methods as FnDecl[];
        const traitName: string | undefined = node.traitName;
        const typeName: string = node.typeName;

        // Store compiled methods in the constant pool
        this.classStack.push(typeName);
        const compiled = methods.map(m => ({ name: m.name, fn: this.compileFnDecl(m) }));
        this.classStack.pop();

        // Emit as inline code that patches globals
        // This runs at the top level, classes are defined as globals
        for (const { name, fn } of compiled) {
            this.emit('GET_GLOBAL', typeName, node.line);
            this.emit('PUSH_CONST', this.addConst(fn), node.line);
            this.emit('PUSH_CONST', this.addConst(name), node.line);
            this.emit('CALL_METHOD', 'add_method:2', node.line);
        }
        if (traitName) {
            const defaults = this.traitMethods.get(traitName) ?? [];
            this.classStack.push(typeName);
            const defCompiled = defaults.map(m => ({ name: m.name, fn: this.compileFnDecl(m) }));
            this.classStack.pop();
            for (const { name, fn } of defCompiled) {
                this.emit('GET_GLOBAL', typeName, node.line);
                this.emit('PUSH_CONST', this.addConst(fn), node.line);
                this.emit('PUSH_CONST', this.addConst(name), node.line);
                this.emit('CALL_METHOD', 'add_method:2', node.line);
            }
        }
    }

    private emitGet(name: string, line: number): void {
        for (let i = this.scopes.length - 1; i >= this.currentScopeFloor(); i--) {
            if (!this.scopes[i].has(name)) continue;
            const slot = this.lookupLocalSlot(name);
            if (slot !== undefined) this.emit('GET_LOCAL_SLOT', slot, line);
            else this.emit('GET_LOCAL', name, line);
            return;
        }
        this.emit('GET_GLOBAL', name, line);
    }

    private emitSet(name: string, line: number): void {
        for (let i = this.scopes.length - 1; i >= this.currentScopeFloor(); i--) {
            if (!this.scopes[i].has(name)) continue;
            const slot = this.lookupLocalSlot(name);
            if (slot !== undefined) this.emit('SET_LOCAL_SLOT', slot, line);
            else this.emit('SET_LOCAL', name, line);
            return;
        }
        this.emit('SET_GLOBAL', name, line);
    }

    private currentFunctionState(): FunctionCompileState | undefined {
        return this.functionStates[this.functionStates.length - 1];
    }

    private currentScopeFloor(): number {
        const fnState = this.currentFunctionState();
        return fnState ? fnState.scopeBase : 0;
    }

    private declareLocalSlot(name: string): number | undefined {
        const fnState = this.currentFunctionState();
        if (!fnState) return undefined;
        const current = fnState.slotScopes[fnState.slotScopes.length - 1];
        if (!current) return undefined;
        const existing = current.get(name);
        if (existing !== undefined) return existing;
        const slot = fnState.nextSlot++;
        current.set(name, slot);
        if (fnState.nextSlot > fnState.maxSlot) fnState.maxSlot = fnState.nextSlot;
        return slot;
    }

    private lookupLocalSlot(name: string): number | undefined {
        const fnState = this.currentFunctionState();
        if (!fnState) return undefined;
        for (let i = fnState.slotScopes.length - 1; i >= 0; i--) {
            const slot = fnState.slotScopes[i].get(name);
            if (slot !== undefined) return slot;
        }
        return undefined;
    }

    private emitArith(op: string, line: number): void {
        const m: Record<string, OpCode> = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD' };
        this.emit(m[op] ?? 'ADD', undefined, line);
    }

    private guardFromTypeAnn(typeAnn?: ASTNode): TypeGuard | undefined {
        if (!typeAnn || typeAnn.kind !== 'Ident') return undefined;
        if (typeAnn.name.startsWith('measure:')) {
            return { kind: 'measure', dimension: typeAnn.name.slice('measure:'.length) };
        }
        const checker = this.constraintFns.get(typeAnn.name);
        if (checker) return { kind: 'constraint', name: typeAnn.name, checker };
        return undefined;
    }

    private lookupGuard(name: string): TypeGuard | undefined {
        for (let i = this.scopes.length - 1; i >= this.currentScopeFloor(); i--) {
            if (this.scopes[i].has(name)) {
                return this.typeGuardScopes[i].get(name);
            }
        }
        return this.globalTypeGuards.get(name);
    }

    private emitGuardCheck(guard: TypeGuard, line: number): void {
        // Stack in: [value]
        // Keep original value for assignment while checker validates it.
        this.emit('DUP', undefined, line); // [value, value]
        if (guard.kind === 'constraint') {
            this.emitGet(guard.checker, line); // [value, value, checker]
            this.emit('SWAP', undefined, line); // [value, checker, value]
            this.emit('CALL', 1, line);
            this.emit('POP', undefined, line);
            return;
        }
        this.emitGet('__measure_expect', line); // [value, value, expect]
        this.emit('SWAP', undefined, line);      // [value, expect, value]
        this.emit('PUSH_CONST', this.addConst(guard.dimension), line); // [value, expect, value, dim]
        this.emit('CALL', 2, line);
        this.emit('POP', undefined, line);
    }

    private tryConstValue(node?: ASTNode): Value | undefined {
        if (!node) return undefined;
        switch (node.kind) {
            case 'NumberLit': return node.value;
            case 'StringLit': return node.value;
            case 'BoolLit': return node.value;
            case 'NilLit': return null;
            case 'UnaryOp': {
                if (node.op === '-' && node.operand.kind === 'NumberLit') return -node.operand.value;
                return undefined;
            }
            case 'ListExpr': {
                const items: Value[] = [];
                for (const item of node.items) {
                    const v = this.tryConstValue(item);
                    if (v === undefined) return undefined;
                    items.push(v);
                }
                return { type: 'list', items };
            }
            case 'TupleExpr': {
                const items: Value[] = [];
                for (const item of node.items) {
                    const v = this.tryConstValue(item);
                    if (v === undefined) return undefined;
                    items.push(v);
                }
                return { type: 'list', items };
            }
            case 'MapExpr': {
                const entries = new Map<string, Value>();
                for (const entry of node.entries) {
                    const key = this.tryConstValue(entry.key);
                    const val = this.tryConstValue(entry.val);
                    if (key === undefined || val === undefined) return undefined;
                    entries.set(String(key), val);
                }
                return { type: 'map', entries };
            }
            default:
                return undefined;
        }
    }

    private emit(op: OpCode, arg: Instruction['arg'], line: number): void {
        this.chunk.code.push({ op, arg, line });
    }

    private addConst(v: Value): number {
        const cache = this.chunkConstCache();
        const key = this.primitiveConstKey(v);
        if (key !== undefined) {
            const existing = cache.get(key);
            if (existing !== undefined) return existing;
            this.chunk.constants.push(v);
            const idx = this.chunk.constants.length - 1;
            cache.set(key, idx);
            return idx;
        }
        this.chunk.constants.push(v);
        return this.chunk.constants.length - 1;
    }

    private chunkConstCache(): Map<string, number> {
        let cache = this.constIndexByChunk.get(this.chunk);
        if (!cache) {
            cache = new Map<string, number>();
            this.constIndexByChunk.set(this.chunk, cache);
        }
        return cache;
    }

    private primitiveConstKey(v: Value): string | undefined {
        if (v === null) return 'n:null';
        if (typeof v === 'boolean') return 'b:' + (v ? '1' : '0');
        if (typeof v === 'number') return 'd:' + (Object.is(v, -0) ? '-0' : String(v));
        if (typeof v === 'string') return 's:' + v;
        return undefined;
    }

    private emitJump(op: OpCode, line: number): number {
        this.emit(op, 9999, line);
        return this.chunk.code.length - 1;
    }

    private patchJump(idx: number): void {
        this.chunk.code[idx].arg = this.chunk.code.length;
    }

    private pushScope(): void {
        this.scopes.push(new Map());
        this.typeGuardScopes.push(new Map());
        const fnState = this.currentFunctionState();
        if (fnState) fnState.slotScopes.push(new Map());
    }
    private popScope(): void {
        this.scopes.pop();
        this.typeGuardScopes.pop();
        const fnState = this.currentFunctionState();
        if (fnState) fnState.slotScopes.pop();
    }
}
