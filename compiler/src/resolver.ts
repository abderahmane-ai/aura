import { ASTNode, MatchPattern } from './types.js';
import { compileError } from './errors.js';

const BUILTINS = new Set<string>([
    'print', 'len', 'min', 'max', 'str', 'int', 'float', 'abs', 'sqrt', 'range', 'List',
    'Stack', 'Queue', 'LinkedList', 'HashMap', 'Heap', 'TreeMap', 'Indexed', 'Tensor', 'TensorShape', 'TensorRand', 'TensorRandn', 'TensorEye',
    'to_list', 'sum', 'sort', 'unique', 'top_k', 'freq', 'chunk', 'window', 'take', 'drop',
    'Option', 'Some', 'None', 'Result', 'Ok', 'Err',
    'is_some', 'is_none', 'is_ok', 'is_err',
    '__json_parse', '__json_try_parse', '__json_valid', '__json_stringify', '__json_typeof', '__json_get_path', '__json_has_path',
    '__fs_exists', '__fs_read', '__fs_write', '__fs_append', '__fs_delete', '__fs_mkdir', '__fs_list', '__fs_stat',
    '__fs_copy', '__fs_move', '__fs_cwd', '__fs_abs', '__fs_join', '__fs_basename', '__fs_dirname', '__fs_extname', '__fs_normalize', '__fs_walk', '__fs_temp_dir',
    '__io_write', '__io_writeln', '__io_write_err', '__io_writeln_err', '__io_read_line', '__io_read_all_stdin',
    '__time_now_ms', '__time_now_unix_s', '__time_iso_now', '__time_monotonic_ms', '__time_sleep_ms', '__time_parse_iso', '__time_from_unix_ms', '__time_from_unix_s', '__time_to_unix_s', '__time_parts', '__time_add_ms', '__time_diff_ms',
    'panic', '__unit_register', '__measure', '__measure_expect',
]);

type Scope = Set<string>;

export class Resolver {
    private scopes: Scope[] = [new Set(BUILTINS)];
    private fnDepth = 0;
    private loopDepth = 0;
    private methodDepth = 0;

    constructor(private file: string) { }

    resolve(ast: ASTNode): void {
        this.resolveNode(ast);
    }

    private resolveNode(node: ASTNode): void {
        switch (node.kind) {
            case 'Program': {
                for (const stmt of node.body) {
                    if (stmt.kind === 'FnDecl' || stmt.kind === 'ClassDecl' || stmt.kind === 'EnumDecl' ||
                        stmt.kind === 'InterfaceDecl' || stmt.kind === 'TraitDecl') {
                        this.declare(stmt.name);
                    }
                }
                for (const stmt of node.body) this.resolveNode(stmt);
                return;
            }

            case 'Block':
                this.withScope(() => node.stmts.forEach((stmt) => this.resolveNode(stmt)));
                return;

            case 'ImportStmt':
                this.declare(node.alias ?? this.importBindingName(node.path));
                return;
            case 'ModuleStmt':
            case 'EnumDecl':
            case 'InterfaceDecl':
                return;

            case 'LetStmt':
            case 'VarStmt':
                if (node.value) this.resolveNode(node.value);
                this.declare(node.name);
                return;

            case 'AssignStmt':
                this.resolveAssignTarget(node.target);
                this.resolveNode(node.value);
                return;

            case 'AugAssignStmt':
                this.resolveAssignTarget(node.target);
                this.resolveNode(node.value);
                return;

            case 'FnDecl':
                if (!this.current().has(node.name)) this.declare(node.name);
                this.resolveFunction(node.params.map((p) => p.name), node.body, false);
                return;

            case 'ClassDecl':
                if (!this.current().has(node.name)) this.declare(node.name);
                for (const field of node.fields) {
                    if (field.defaultVal && typeof field.defaultVal === 'object' && 'kind' in field.defaultVal) {
                        this.resolveNode(field.defaultVal as ASTNode);
                    }
                }
                for (const method of node.methods) this.resolveFunction(method.params.map((p) => p.name), method.body, true);
                return;

            case 'TraitDecl':
                if (!this.current().has(node.name)) this.declare(node.name);
                for (const method of node.methods) this.resolveFunction(method.params.map((p) => p.name), method.body, true);
                return;

            case 'ImplDecl':
                for (const method of node.methods) this.resolveFunction(method.params.map((p) => p.name), method.body, true);
                return;

            case 'ReturnStmt':
                if (this.fnDepth === 0) this.fail('return outside function', node.line);
                if (node.value) this.resolveNode(node.value);
                return;

            case 'IfStmt':
                this.resolveNode(node.cond);
                this.resolveNode(node.then);
                for (const el of node.elifs) {
                    this.resolveNode(el.cond);
                    this.resolveNode(el.body);
                }
                if (node.else_) this.resolveNode(node.else_);
                return;

            case 'WhileStmt':
                this.resolveNode(node.cond);
                this.loopDepth++;
                this.resolveNode(node.body);
                this.loopDepth--;
                return;

            case 'ForStmt':
                this.resolveNode(node.iter);
                this.loopDepth++;
                this.withScope(() => {
                    this.declare(node.name);
                    this.resolveNode(node.body);
                });
                this.loopDepth--;
                return;

            case 'BreakStmt':
            case 'ContinueStmt':
                if (this.loopDepth === 0) this.fail(`${node.kind === 'BreakStmt' ? 'break' : 'continue'} outside loop`, node.line);
                return;

            case 'MatchStmt':
                this.resolveNode(node.subject);
                for (const c of node.cases) {
                    this.withScope(() => {
                        this.bindMatchPattern(c.pattern);
                        this.resolveNode(c.body);
                    });
                }
                return;

            case 'ExprStmt':
                this.resolveNode(node.expr);
                return;

            case 'TemplateString':
                for (const part of node.parts) this.resolveNode(part);
                return;

            case 'Ident':
                if (!this.isDefined(node.name)) this.fail(`Undefined variable '${node.name}'`, node.line);
                return;

            case 'SelfExpr':
                if (this.methodDepth === 0) this.fail('self used outside method', node.line);
                return;

            case 'BinOp':
                this.resolveNode(node.left);
                this.resolveNode(node.right);
                return;

            case 'UnaryOp':
                this.resolveNode(node.operand);
                return;

            case 'CallExpr':
                this.resolveNode(node.callee);
                for (const arg of node.args) this.resolveNode(arg.value);
                return;

            case 'MethodCallExpr':
                this.resolveNode(node.obj);
                for (const arg of node.args) this.resolveNode(arg.value);
                return;

            case 'AttributeExpr':
                this.resolveNode(node.obj);
                return;

            case 'IndexExpr':
                this.resolveNode(node.obj);
                this.resolveNode(node.index);
                return;

            case 'ListExpr':
                for (const item of node.items) this.resolveNode(item);
                return;

            case 'TupleExpr':
                for (const item of node.items) this.resolveNode(item);
                return;

            case 'MapExpr':
                for (const entry of node.entries) {
                    this.resolveNode(entry.key);
                    this.resolveNode(entry.val);
                }
                return;

            case 'FnExpr':
                this.resolveFunction(node.params.map((p) => p.name), node.body, false);
                return;

            case 'EnumCtor':
                for (const arg of node.args) this.resolveNode(arg);
                return;

            case 'RangeExpr':
                this.resolveNode(node.start);
                this.resolveNode(node.end);
                return;

            case 'NumberLit':
            case 'StringLit':
            case 'BoolLit':
            case 'NilLit':
                return;

            default:
                return;
        }
    }

    private resolveFunction(params: string[], body: ASTNode, isMethod: boolean): void {
        this.fnDepth++;
        if (isMethod) this.methodDepth++;
        this.withScope(() => {
            if (isMethod) this.declare('self');
            for (const param of params) this.declare(param);
            this.resolveNode(body);
        });
        if (isMethod) this.methodDepth--;
        this.fnDepth--;
    }

    private resolveAssignTarget(target: ASTNode): void {
        if (target.kind === 'Ident') {
            if (!this.isDefined(target.name)) this.fail(`Assign to undefined variable '${target.name}'`, target.line);
            return;
        }
        if (target.kind === 'AttributeExpr') {
            this.resolveNode(target.obj);
            return;
        }
        if (target.kind === 'IndexExpr') {
            this.resolveNode(target.obj);
            this.resolveNode(target.index);
            return;
        }
        this.fail('Invalid assignment target', this.lineOf(target));
    }

    private bindMatchPattern(pattern: MatchPattern): void {
        if (pattern.kind === 'IdentPattern') {
            this.declare(pattern.name);
        } else if (pattern.kind === 'EnumPattern') {
            for (const b of pattern.bindings) this.declare(b);
        } else if (pattern.kind === 'LiteralPattern') {
            this.resolveNode(pattern.value);
        }
    }

    private declare(name: string): void {
        this.current().add(name);
    }

    private isDefined(name: string): boolean {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            if (this.scopes[i].has(name)) return true;
        }
        return false;
    }

    private withScope(fn: () => void): void {
        this.scopes.push(new Set());
        try { fn(); } finally { this.scopes.pop(); }
    }

    private current(): Scope {
        return this.scopes[this.scopes.length - 1];
    }

    private lineOf(node: ASTNode): number {
        return (node as { line?: number }).line ?? 0;
    }

    private fail(msg: string, line: number): never {
        compileError(msg, this.file, line);
    }

    private importBindingName(path: string): string {
        const parts = path.split('.');
        return parts[parts.length - 1];
    }
}
