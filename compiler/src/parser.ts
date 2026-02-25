import {
    Token, TT, ASTNode, Block, Param, FieldDef, CallArg,
    MatchCase, MatchPattern, EnumVariant,
    Program, FnDecl, ClassDecl, InterfaceDecl, TraitDecl,
    ImplDecl, EnumDecl,
} from './types.js';
import { Lexer } from './lexer.js';
import { parseError } from './errors.js';

// ─── Pratt Precedence ─────────────────────────────────────────────────────────
const enum Prec {
    NONE = 0, ASSIGN, OR, AND, EQUALITY, COMPARE,
    RANGE, SUM, PRODUCT, POWER, UNARY, CALL,
}
const INFIX_PREC: Partial<Record<TT, Prec>> = {
    OR: Prec.OR, AND: Prec.AND,
    EQ_EQ: Prec.EQUALITY, BANG_EQ: Prec.EQUALITY,
    LT: Prec.COMPARE, GT: Prec.COMPARE, LT_EQ: Prec.COMPARE, GT_EQ: Prec.COMPARE,
    DOT_DOT: Prec.RANGE, DOT_DOT_EQ: Prec.RANGE,
    PLUS: Prec.SUM, MINUS: Prec.SUM,
    STAR: Prec.PRODUCT, SLASH: Prec.PRODUCT, PERCENT: Prec.PRODUCT,
    POW: Prec.POWER,
    LPAREN: Prec.CALL, DOT: Prec.CALL, LBRACKET: Prec.CALL,
    PIPE_GT: Prec.CALL,
};

export class Parser {
    private pos = 0;
    private repeatCounter = 0;
    private cadenceCounter = 0;
    private facets = new Map<string, { fields: FieldDef[]; methods: FnDecl[] }>();
    private facetMethodNames = new Map<string, Set<string>>();
    private unitSymbols = new Map<string, { dimension: string; factor: number; base: string }>();
    constructor(private tokens: Token[], private file: string) { }

    // ─── Entry ─────────────────────────────────────────────────────────────────
    parseProgram(): Program {
        this.skipNewlines();
        const body: ASTNode[] = [];
        while (!this.check('EOF')) {
            body.push(this.parseTopLevel());
            this.skipNewlines();
        }
        return { kind: 'Program', body };
    }

    // ─── Top-level items ────────────────────────────────────────────────────────
    private parseTopLevel(): ASTNode {
        const t = this.peek();
        if (t.type === 'FN' || (t.type === 'ASYNC' && this.peekAt(1).type === 'FN')) return this.parseFnDecl(false);
        if (t.type === 'CLASS') return this.parseClassDecl();
        if (t.type === 'INTERFACE') return this.parseInterfaceDecl();
        if (t.type === 'TRAIT') return this.parseTraitDecl();
        if (t.type === 'IMPL') return this.parseImplDecl();
        if (t.type === 'ENUM') return this.parseEnumDecl();
        if (t.type === 'CONSTRAINT') return this.parseConstraintDecl();
        if (t.type === 'UNIT') return this.parseUnitDecl();
        if (t.type === 'FACET') return this.parseFacetDecl();
        if (t.type === 'IMPORT') return this.parseImport();
        if (t.type === 'MODULE') return this.parseModule();
        return this.parseStatement();
    }

    // ─── Statements ─────────────────────────────────────────────────────────────
    private parseStatement(): ASTNode {
        this.skipNewlines();
        const t = this.peek();
        switch (t.type) {
            case 'LET': return this.parseLetVar('let');
            case 'VAR': return this.parseLetVar('var');
            case 'RETURN': return this.parseReturn();
            case 'IF': return this.parseIf();
            case 'WHILE': return this.parseWhile();
            case 'FOR': return this.parseFor();
            case 'REPEAT': return this.parseRepeat();
            case 'CADENCE': return this.parseCadence();
            case 'INDEXED': return this.parseIndexedDecl();
            case 'MATCH': return this.parseMatch();
            case 'AS': return this.parseAsFacetBlock();
            case 'BREAK': this.advance(); this.skipNewlines(); return { kind: 'BreakStmt', line: t.line };
            case 'CONTINUE': this.advance(); this.skipNewlines(); return { kind: 'ContinueStmt', line: t.line };
            case 'FN':
            case 'ASYNC': return this.parseFnDecl(false);
            case 'CLASS': return this.parseClassDecl();
            case 'IMPL': return this.parseImplDecl();
            case 'TRAIT': return this.parseTraitDecl();
            default: {
                const expr = this.parseExpr();
                // Assignment?
                const next = this.peek();
                if (next.type === 'EQ') {
                    this.advance();
                    const val = this.parseExpr();
                    this.skipNewlines();
                    return { kind: 'AssignStmt', target: expr, value: val, line: t.line };
                }
                if (['PLUS_EQ', 'MINUS_EQ', 'STAR_EQ', 'SLASH_EQ'].includes(next.type)) {
                    this.advance();
                    const op = next.value[0]; // +, -, *, /
                    const val = this.parseExpr();
                    this.skipNewlines();
                    return { kind: 'AugAssignStmt', target: expr, op, value: val, line: t.line };
                }
                this.skipNewlines();
                return { kind: 'ExprStmt', expr, line: t.line };
            }
        }
    }

    private parseBlock(): Block {
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const stmts: ASTNode[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            stmts.push(this.parseStatement());
        }
        if (this.check('DEDENT')) this.advance();
        return { kind: 'Block', stmts };
    }

    private parseLetVar(kind: 'let' | 'var'): ASTNode {
        const line = this.peek().line;
        this.advance();
        const name = this.expectIdent();
        let typeAnn: ASTNode | undefined;
        if (this.check('COLON')) { this.advance(); typeAnn = this.parseTypeExpr(); }
        let value: ASTNode | undefined;
        if (this.check('EQ')) { this.advance(); value = this.parseExpr(); }
        this.skipNewlines();
        return kind === 'let'
            ? { kind: 'LetStmt', name, typeAnn, value, line }
            : { kind: 'VarStmt', name, typeAnn, value, line };
    }

    private parseReturn(): ASTNode {
        const line = this.advance().line;
        let value: ASTNode | undefined;
        if (!this.check('NEWLINE') && !this.check('DEDENT') && !this.check('EOF')) {
            value = this.parseExpr();
        }
        this.skipNewlines();
        return { kind: 'ReturnStmt', value, line };
    }

    private parseIf(): ASTNode {
        const line = this.advance().line; // consume 'if'
        const cond = this.parseExpr();
        const then = this.parseBlock();
        const elifs: { cond: ASTNode; body: Block }[] = [];
        let else_: Block | undefined;
        this.skipNewlines();
        while (this.check('ELIF')) {
            this.advance();
            const ec = this.parseExpr();
            const eb = this.parseBlock();
            elifs.push({ cond: ec, body: eb });
            this.skipNewlines();
        }
        if (this.check('ELSE')) {
            this.advance();
            else_ = this.parseBlock();
        }
        return { kind: 'IfStmt', cond, then, elifs, else_, line };
    }

    private parseWhile(): ASTNode {
        const line = this.advance().line;
        const cond = this.parseExpr();
        const body = this.parseBlock();
        return { kind: 'WhileStmt', cond, body, line };
    }

    private parseFor(): ASTNode {
        const line = this.advance().line;
        const name = this.expectIdent();
        this.expect('IN');
        const iter = this.parseExpr();
        const body = this.parseBlock();
        return { kind: 'ForStmt', name, iter, body, line };
    }

    private parseRepeat(): ASTNode {
        const line = this.advance().line;
        const end = this.parseExpr();
        let name = `__repeat_${this.repeatCounter++}`;
        if (this.check('AS')) {
            this.advance();
            name = this.expectIdent();
        }
        const iter: ASTNode = {
            kind: 'RangeExpr',
            start: { kind: 'NumberLit', value: 0, line },
            end,
            inclusive: false,
            line,
        };
        const body = this.parseBlock();
        return { kind: 'ForStmt', name, iter, body, line };
    }

    private parseIndexedDecl(): ASTNode {
        const line = this.advance().line; // indexed
        const name = this.expectIdent();
        this.expect('BY');
        const keys: string[] = [this.expectIdent()];
        while (this.check('COMMA')) {
            this.advance();
            keys.push(this.expectIdent());
        }

        let initial: ASTNode | undefined;
        if (this.check('EQ')) {
            this.advance();
            initial = this.parseExpr();
        }
        this.skipNewlines();

        const ctorCall: ASTNode = {
            kind: 'CallExpr',
            callee: { kind: 'Ident', name: 'Indexed', line },
            args: [
                {
                    value: {
                        kind: 'ListExpr',
                        items: keys.map((k) => ({ kind: 'StringLit', value: k, line })),
                        line,
                    },
                },
                ...(initial ? [{ value: initial }] : []),
            ],
            line,
        };
        return { kind: 'LetStmt', name, value: ctorCall, line };
    }

    private parseCadence(): ASTNode {
        const cadenceTok = this.advance(); // cadence
        const line = cadenceTok.line;
        const itemName = this.expectIdent();
        this.expect('IN');
        const iterable = this.parseExpr();
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');

        const allowed = new Set(['start', 'first', 'each', 'between', 'last', 'empty']);
        const clauses: Partial<Record<'start' | 'first' | 'each' | 'between' | 'last' | 'empty', Block>> = {};

        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            const labelTok = this.peek();
            if (labelTok.type !== 'IDENT') parseError('Expected cadence clause name', labelTok, this.file);
            const label = this.advance().value;
            if (!allowed.has(label)) {
                parseError(`Unknown cadence clause '${label}'`, labelTok, this.file);
            }
            const clause = label as 'start' | 'first' | 'each' | 'between' | 'last' | 'empty';
            if (clauses[clause]) {
                parseError(`Duplicate cadence clause '${label}'`, labelTok, this.file);
            }
            clauses[clause] = this.parseCadenceClauseBlock();
            this.skipNewlines();
        }
        if (this.check('DEDENT')) this.advance();

        if (!clauses.each) {
            parseError("cadence requires an 'each:' clause", cadenceTok, this.file);
        }

        return this.lowerCadence(line, itemName, iterable, clauses);
    }

    private parseCadenceClauseBlock(): Block {
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const stmts: ASTNode[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            stmts.push(this.parseStatement());
        }
        if (this.check('DEDENT')) this.advance();
        return { kind: 'Block', stmts };
    }

    private lowerCadence(
        line: number,
        itemName: string,
        iterable: ASTNode,
        clauses: Partial<Record<'start' | 'first' | 'each' | 'between' | 'last' | 'empty', Block>>,
    ): ASTNode {
        const id = this.cadenceCounter++;
        const itemsName = `__cadence_items_${id}`;
        const lenName = `__cadence_len_${id}`;
        const indexName = `__cadence_i_${id}`;

        const makeIdent = (name: string): ASTNode => ({ kind: 'Ident', name, line });
        const makeNumber = (value: number): ASTNode => ({ kind: 'NumberLit', value, line });
        const makeCall = (name: string, args: ASTNode[]): ASTNode => ({
            kind: 'CallExpr',
            callee: makeIdent(name),
            args: args.map((value) => ({ value })),
            line,
        });

        const itemsDecl: ASTNode = {
            kind: 'LetStmt',
            name: itemsName,
            value: makeCall('to_list', [iterable]),
            line,
        };
        const lenDecl: ASTNode = {
            kind: 'LetStmt',
            name: lenName,
            value: makeCall('len', [makeIdent(itemsName)]),
            line,
        };

        const loopBody: ASTNode[] = [
            {
                kind: 'LetStmt',
                name: itemName,
                value: {
                    kind: 'IndexExpr',
                    obj: makeIdent(itemsName),
                    index: makeIdent(indexName),
                    line,
                },
                line,
            },
        ];

        if (clauses.first) {
            loopBody.push({
                kind: 'IfStmt',
                cond: { kind: 'BinOp', op: '==', left: makeIdent(indexName), right: makeNumber(0), line },
                then: { kind: 'Block', stmts: [...clauses.first.stmts] },
                elifs: [],
                line,
            });
        }

        loopBody.push(...(clauses.each?.stmts ?? []));

        const lastIndexExpr: ASTNode = {
            kind: 'BinOp',
            op: '-',
            left: makeIdent(lenName),
            right: makeNumber(1),
            line,
        };
        const isLastExpr: ASTNode = { kind: 'BinOp', op: '==', left: makeIdent(indexName), right: lastIndexExpr, line };

        if (clauses.between && clauses.last) {
            loopBody.push({
                kind: 'IfStmt',
                cond: isLastExpr,
                then: { kind: 'Block', stmts: [...clauses.last.stmts] },
                elifs: [],
                else_: { kind: 'Block', stmts: [...clauses.between.stmts] },
                line,
            });
        } else if (clauses.between) {
            loopBody.push({
                kind: 'IfStmt',
                cond: { kind: 'BinOp', op: '<', left: makeIdent(indexName), right: lastIndexExpr, line },
                then: { kind: 'Block', stmts: [...clauses.between.stmts] },
                elifs: [],
                line,
            });
        } else if (clauses.last) {
            loopBody.push({
                kind: 'IfStmt',
                cond: isLastExpr,
                then: { kind: 'Block', stmts: [...clauses.last.stmts] },
                elifs: [],
                line,
            });
        }

        const nonEmptyStmts: ASTNode[] = [];
        if (clauses.start) nonEmptyStmts.push(...clauses.start.stmts);
        nonEmptyStmts.push({
            kind: 'ForStmt',
            name: indexName,
            iter: { kind: 'RangeExpr', start: makeNumber(0), end: makeIdent(lenName), inclusive: false, line },
            body: { kind: 'Block', stmts: loopBody },
            line,
        });

        const emptyStmts = clauses.empty ? [...clauses.empty.stmts] : [];
        const branch: ASTNode = {
            kind: 'IfStmt',
            cond: { kind: 'BinOp', op: '==', left: makeIdent(lenName), right: makeNumber(0), line },
            then: { kind: 'Block', stmts: emptyStmts },
            elifs: [],
            else_: { kind: 'Block', stmts: nonEmptyStmts },
            line,
        };

        return { kind: 'Block', stmts: [itemsDecl, lenDecl, branch] };
    }

    private parseMatch(): ASTNode {
        const line = this.advance().line;
        const subject = this.parseExpr();
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const cases: MatchCase[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            this.expect('CASE');
            const pattern = this.parseMatchPattern();
            const body = this.parseBlock();
            cases.push({ pattern, body });
            this.skipNewlines();
        }
        if (this.check('DEDENT')) this.advance();
        return { kind: 'MatchStmt', subject, cases, line };
    }

    private parseMatchPattern(): MatchPattern {
        const t = this.peek();
        // .ok(msg), .error(err), .someName(a, b, ...)
        if (t.type === 'DOT') {
            this.advance();
            const tag = this.expectIdent();
            const bindings: string[] = [];
            if (this.check('LPAREN')) {
                this.advance();
                while (!this.check('RPAREN') && !this.check('EOF')) {
                    bindings.push(this.expectIdent());
                    if (!this.check('RPAREN')) this.expect('COMMA');
                }
                this.expect('RPAREN');
            }
            return { kind: 'EnumPattern', tag, bindings };
        }
        // wildcard _
        if (t.type === 'IDENT' && t.value === '_') { this.advance(); return { kind: 'WildcardPattern' }; }
        // named binding
        if (t.type === 'IDENT') { this.advance(); return { kind: 'IdentPattern', name: t.value }; }
        // literal
        const val = this.parsePrimary();
        return { kind: 'LiteralPattern', value: val };
    }

    // ─── Declarations ────────────────────────────────────────────────────────────
    parseFnDecl(_insideClass: boolean, allowDeclOnly = false): FnDecl {
        let isAsync = false;
        if (this.check('ASYNC')) { isAsync = true; this.advance(); }
        const line = this.advance().line; // consume 'fn'
        const name = this.expectIdent();
        const typeParams = this.parseTypeParams();
        const params = this.parseParams();
        let retType: ASTNode | undefined;
        if (this.check('ARROW')) { this.advance(); retType = this.parseTypeExpr(); }
        let body: Block;
        if (this.check('EQ')) {
            // single-expression shorthand: fn double(x) -> Int = x * 2
            this.advance();
            const expr = this.parseExpr();
            this.skipNewlines();
            body = { kind: 'Block', stmts: [{ kind: 'ReturnStmt', value: expr, line }] };
        } else if (this.check('COLON')) {
            body = this.parseBlock();
        } else if (allowDeclOnly && (this.check('NEWLINE') || this.check('DEDENT') || this.check('EOF'))) {
            this.skipNewlines();
            body = { kind: 'Block', stmts: [] };
        } else {
            parseError('Expected function body (`:` block or `= expr`)', this.peek(), this.file);
        }
        return { kind: 'FnDecl', name, params, retType, body, isAsync, typeParams, line };
    }

    private parseParams(): Param[] {
        this.expect('LPAREN');
        const params: Param[] = [];
        while (!this.check('RPAREN') && !this.check('EOF')) {
            // skip modifiers
            if (this.check('MUT') || this.check('WEAK') || this.check('PUB')) this.advance();
            const name = this.expectIdent();
            let typeAnn: ASTNode | undefined;
            if (this.check('COLON')) { this.advance(); typeAnn = this.parseTypeExpr(); }
            let defaultVal: ASTNode | undefined;
            if (this.check('EQ')) { this.advance(); defaultVal = this.parseExpr(); }
            params.push({ name, typeAnn, defaultVal });
            if (!this.check('RPAREN')) this.expect('COMMA');
        }
        this.expect('RPAREN');
        return params;
    }

    private parseTypeParams(): string[] {
        const params: string[] = [];
        if (!this.check('LT')) return params;
        this.advance();
        let depth = 1;
        while (depth > 0 && !this.check('EOF')) {
            const t = this.advance();
            if (t.type === 'LT') depth++;
            else if (t.type === 'GT') depth--;
            else if (t.type === 'IDENT' && depth === 1) params.push(t.value);
        }
        return params;
    }

    private parseClassDecl(): ClassDecl {
        const line = this.advance().line; // 'class'
        const name = this.expectIdent();
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const fields: FieldDef[] = [];
        const methods: FnDecl[] = [];
        const adopts: string[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            if (this.check('FN') || this.check('ASYNC') ||
                (this.check('PUB') && this.peekAt(1).type === 'FN')) {
                if (this.check('PUB')) this.advance();
                methods.push(this.parseFnDecl(true, true));
            } else if (this.check('ADOPTS')) {
                this.advance();
                adopts.push(this.expectIdent());
                this.skipNewlines();
            } else if (this.check('LET') || this.check('VAR')) {
                const mutable = this.peek().type === 'VAR';
                this.advance();
                const fname = this.expectIdent();
                let typeAnn: ASTNode | undefined;
                if (this.check('COLON')) { this.advance(); typeAnn = this.parseTypeExpr(); }
                let defaultVal: ASTNode | undefined;
                if (this.check('EQ')) { this.advance(); defaultVal = this.parseExpr(); }
                this.skipNewlines();
                fields.push({ name: fname, typeAnn, defaultVal, mutable });
            } else {
                // Skip unknown tokens in class body
                this.advance(); this.skipNewlines();
            }
        }
        if (this.check('DEDENT')) this.advance();

        for (const facetName of adopts) {
            const facet = this.facets.get(facetName);
            if (!facet) parseError(`Unknown facet '${facetName}'`, this.peek(), this.file);
            for (const f of facet.fields) {
                fields.push({ ...f, name: this.prefixFacetName(facetName, f.name) });
            }
            for (const m of facet.methods) {
                methods.push(this.rewriteFacetMethod(facetName, m));
            }
        }
        return { kind: 'ClassDecl', name, fields, methods, line };
    }

    private parseInterfaceDecl(): InterfaceDecl {
        const line = this.advance().line;
        const name = this.expectIdent();
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const methods: FnDecl[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            if (this.check('FN') || this.check('ASYNC')) {
                methods.push(this.parseFnDecl(true, true));
            } else { this.advance(); this.skipNewlines(); }
        }
        if (this.check('DEDENT')) this.advance();
        return { kind: 'InterfaceDecl', name, methods, line };
    }

    private parseTraitDecl(): TraitDecl {
        const line = this.advance().line;
        const name = this.expectIdent();
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const methods: FnDecl[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            if (this.check('FN') || this.check('ASYNC')) {
                methods.push(this.parseFnDecl(true, true));
            } else { this.advance(); this.skipNewlines(); }
        }
        if (this.check('DEDENT')) this.advance();
        return { kind: 'TraitDecl', name, methods, line };
    }

    private parseImplDecl(): ImplDecl {
        const line = this.advance().line; // 'impl'
        const first = this.expectIdent();
        let traitName: string | undefined;
        let typeName: string;
        if (this.check('FOR')) {
            this.advance();
            traitName = first;
            typeName = this.expectIdent();
        } else {
            typeName = first;
        }
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const methods: FnDecl[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            if (this.check('FN') || this.check('ASYNC')) {
                methods.push(this.parseFnDecl(true));
            } else { this.advance(); this.skipNewlines(); }
        }
        if (this.check('DEDENT')) this.advance();
        return { kind: 'ImplDecl', traitName, typeName, methods, line };
    }

    private parseEnumDecl(): EnumDecl {
        const line = this.advance().line;
        const name = this.expectIdent();
        this.parseTypeParams(); // skip
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const variants: EnumVariant[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            this.expect('CASE');
            const vname = this.expectIdent();
            const fields: ASTNode[] = [];
            if (this.check('LPAREN')) {
                this.advance();
                while (!this.check('RPAREN') && !this.check('EOF')) {
                    fields.push(this.parseTypeExpr());
                    if (!this.check('RPAREN')) this.expect('COMMA');
                }
                this.expect('RPAREN');
            }
            this.skipNewlines();
            variants.push({ name: vname, fields });
        }
        if (this.check('DEDENT')) this.advance();
        return { kind: 'EnumDecl', name, variants, line };
    }

    private parseConstraintDecl(): ASTNode {
        const line = this.advance().line; // constraint
        const name = this.expectIdent();
        this.expect('LPAREN');
        const paramName = this.expectIdent();
        if (this.check('COLON')) { this.advance(); this.parseTypeExpr(); }
        this.expect('RPAREN');
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const requirements: ASTNode[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            this.expect('REQUIRE');
            requirements.push(this.parseExpr());
            this.skipNewlines();
        }
        if (this.check('DEDENT')) this.advance();
        if (requirements.length === 0) {
            parseError(`constraint '${name}' requires at least one require clause`, this.peek(), this.file);
        }

        const panicCall = (msg: string): ASTNode => ({
            kind: 'ExprStmt',
            expr: {
                kind: 'CallExpr',
                callee: { kind: 'Ident', name: 'panic', line },
                args: [{ value: { kind: 'StringLit', value: msg, line } }],
                line,
            },
            line,
        });

        const stmts: ASTNode[] = requirements.map((req, idx) => ({
            kind: 'IfStmt',
            cond: { kind: 'UnaryOp', op: 'not', operand: req, line },
            then: { kind: 'Block', stmts: [panicCall(`Constraint ${name} failed at rule ${idx + 1}`)] },
            elifs: [],
            line,
        }));
        stmts.push({
            kind: 'ReturnStmt',
            value: { kind: 'Ident', name: paramName, line },
            line,
        });

        return {
            kind: 'FnDecl',
            name: `__constraint_${name}`,
            params: [{ name: paramName }],
            retType: undefined,
            body: { kind: 'Block', stmts },
            isAsync: false,
            typeParams: [],
            line,
        };
    }

    private parseUnitDecl(): ASTNode {
        const line = this.advance().line; // unit
        const dimension = this.expectIdent();
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');

        let baseUnit: string | undefined;
        const factors = new Map<string, number>();

        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            if (this.check('IDENT') && this.peek().value === 'base') {
                this.advance();
                this.expect('COLON');
                baseUnit = this.expectIdent();
                factors.set(baseUnit, 1);
                this.skipNewlines();
                continue;
            }
            const unitName = this.expectIdent();
            this.expect('EQ');
            const factorExpr = this.parseExpr();
            const factor = this.evalUnitFactor(factorExpr, factors);
            factors.set(unitName, factor);
            this.skipNewlines();
        }
        if (this.check('DEDENT')) this.advance();
        if (!baseUnit) parseError(`unit '${dimension}' requires 'base: <symbol>'`, this.peek(), this.file);

        for (const [unit, factor] of factors.entries()) {
            this.unitSymbols.set(unit, { dimension, factor, base: baseUnit! });
        }

        const mkCall = (name: string, args: ASTNode[]): ASTNode => ({
            kind: 'ExprStmt',
            expr: {
                kind: 'CallExpr',
                callee: { kind: 'Ident', name, line },
                args: args.map((value) => ({ value })),
                line,
            },
            line,
        });

        const stmts: ASTNode[] = [];
        for (const [unit, factor] of factors.entries()) {
            stmts.push(mkCall('__unit_register', [
                { kind: 'StringLit', value: dimension, line },
                { kind: 'StringLit', value: baseUnit!, line },
                { kind: 'StringLit', value: unit, line },
                { kind: 'NumberLit', value: factor, line },
            ]));
        }
        return { kind: 'Block', stmts };
    }

    private evalUnitFactor(expr: ASTNode, factors: Map<string, number>): number {
        switch (expr.kind) {
            case 'NumberLit': return expr.value;
            case 'Ident': {
                const found = factors.get(expr.name);
                if (found === undefined) parseError(`Unknown unit symbol '${expr.name}' in unit definition`, this.peek(), this.file);
                return found;
            }
            case 'BinOp': {
                const left = this.evalUnitFactor(expr.left, factors);
                const right = this.evalUnitFactor(expr.right, factors);
                if (expr.op === '*') return left * right;
                if (expr.op === '/') return left / right;
                parseError(`Unsupported operator '${expr.op}' in unit definition`, this.peek(), this.file);
            }
            default:
                parseError('Unsupported expression in unit definition', this.peek(), this.file);
        }
    }

    private parseFacetDecl(): ASTNode {
        const line = this.advance().line; // facet
        const name = this.expectIdent();
        this.expect('COLON');
        this.skipNewlines();
        this.expect('INDENT');
        const fields: FieldDef[] = [];
        const methods: FnDecl[] = [];
        while (!this.check('DEDENT') && !this.check('EOF')) {
            this.skipNewlines();
            if (this.check('DEDENT') || this.check('EOF')) break;
            if (this.check('FN') || this.check('ASYNC') ||
                (this.check('PUB') && this.peekAt(1).type === 'FN')) {
                if (this.check('PUB')) this.advance();
                methods.push(this.parseFnDecl(true, true));
            } else if (this.check('LET') || this.check('VAR')) {
                const mutable = this.peek().type === 'VAR';
                this.advance();
                const fname = this.expectIdent();
                let typeAnn: ASTNode | undefined;
                if (this.check('COLON')) { this.advance(); typeAnn = this.parseTypeExpr(); }
                let defaultVal: ASTNode | undefined;
                if (this.check('EQ')) { this.advance(); defaultVal = this.parseExpr(); }
                this.skipNewlines();
                fields.push({ name: fname, typeAnn, defaultVal, mutable });
            } else {
                this.advance();
                this.skipNewlines();
            }
        }
        if (this.check('DEDENT')) this.advance();
        this.facets.set(name, { fields, methods });
        this.facetMethodNames.set(name, new Set(methods.map((m) => m.name)));
        return { kind: 'Block', stmts: [] };
    }

    private parseAsFacetBlock(): ASTNode {
        const line = this.advance().line; // as
        const objectName = this.expectIdent();
        this.expect('COLON');
        const facetName = this.expectIdent();
        const facet = this.facets.get(facetName);
        if (!facet) parseError(`Unknown facet '${facetName}'`, this.peek(), this.file);
        const methodNames = this.facetMethodNames.get(facetName) ?? new Set<string>();
        const fieldNames = new Set(facet!.fields.map((f) => f.name));
        const block = this.parseBlock();
        return this.rewriteAst(block, (node) => {
            if (node.kind === 'MethodCallExpr' && node.obj.kind === 'Ident' && node.obj.name === objectName && methodNames.has(node.method)) {
                return { ...node, method: this.prefixFacetName(facetName, node.method) };
            }
            if (node.kind === 'AttributeExpr' && node.obj.kind === 'Ident' && node.obj.name === objectName && fieldNames.has(node.attr)) {
                return { ...node, attr: this.prefixFacetName(facetName, node.attr) };
            }
            return node;
        });
    }

    private parseImport(): ASTNode {
        const line = this.advance().line;
        let path = this.expectIdent();
        while (this.check('DOT')) { this.advance(); path += '.' + this.expectIdent(); }
        let alias: string | undefined;
        if (this.check('AS')) { this.advance(); alias = this.expectIdent(); }
        this.skipNewlines();
        return { kind: 'ImportStmt', path, alias, line };
    }

    private parseModule(): ASTNode {
        const line = this.advance().line;
        let path = this.expectIdent();
        while (this.check('DOT')) { this.advance(); path += '.' + this.expectIdent(); }
        this.skipNewlines();
        return { kind: 'ModuleStmt', path, line };
    }

    // ─── Expressions ─────────────────────────────────────────────────────────────
    parseExpr(minPrec: Prec = Prec.NONE): ASTNode {
        let left = this.parseUnary();
        while (true) {
            const t = this.peek();
            const prec = INFIX_PREC[t.type];
            if (prec === undefined || prec <= minPrec) break;
            this.advance();
            left = this.parseBinary(left, t, prec);
        }
        return left;
    }

    private parseBinary(left: ASTNode, op: Token, prec: Prec): ASTNode {
        const line = op.line;
        switch (op.type) {
            case 'DOT_DOT':
            case 'DOT_DOT_EQ': {
                const right = this.parseExpr(prec);
                return { kind: 'RangeExpr', start: left, end: right, inclusive: op.type === 'DOT_DOT_EQ', line };
            }
            case 'DOT': {
                const name = this.expectIdent();
                if (this.check('LPAREN')) {
                    const args = this.parseArgs();
                    return { kind: 'MethodCallExpr', obj: left, method: name, args, line };
                }
                return { kind: 'AttributeExpr', obj: left, attr: name, line };
            }
            case 'LPAREN': {
                // postfix call (pipe or direct)
                const args = this.parseArgsFrom();
                return { kind: 'CallExpr', callee: left, args, line };
            }
            case 'LBRACKET': {
                const index = this.parseExpr();
                this.expect('RBRACKET');
                return { kind: 'IndexExpr', obj: left, index, line };
            }
            case 'PIPE_GT': {
                const right = this.parseExpr(prec);
                return { kind: 'CallExpr', callee: right, args: [{ value: left }], line };
            }
            default: {
                const right = this.parseExpr(prec);
                return { kind: 'BinOp', op: op.value, left, right, line };
            }
        }
    }

    private parseUnary(): ASTNode {
        const t = this.peek();
        if (t.type === 'MINUS' || t.type === 'NOT' || t.type === 'BANG') {
            this.advance();
            const operand = this.parseUnary();
            return { kind: 'UnaryOp', op: t.value, operand, line: t.line };
        }
        return this.parsePostfix();
    }

    private parsePostfix(): ASTNode {
        let node = this.parsePrimary();
        while (true) {
            const t = this.peek();
            if (t.type === 'DOT') {
                this.advance();
                const name = this.expectIdent();
                if (this.check('LPAREN')) {
                    const args = this.parseArgs();
                    node = { kind: 'MethodCallExpr', obj: node, method: name, args, line: t.line };
                } else {
                    node = { kind: 'AttributeExpr', obj: node, attr: name, line: t.line };
                }
            } else if (t.type === 'LPAREN') {
                const args = this.parseArgs();
                node = { kind: 'CallExpr', callee: node, args, line: t.line };
            } else if (t.type === 'LBRACKET') {
                this.advance();
                const index = this.parseExpr();
                this.expect('RBRACKET');
                node = { kind: 'IndexExpr', obj: node, index, line: t.line };
            } else if (t.type === 'BANG') {
                this.advance();
                // force-unwrap — treat as a unary postfix op
                node = { kind: 'UnaryOp', op: '!', operand: node, line: t.line };
            } else {
                break;
            }
        }
        return node;
    }

    private parsePrimary(): ASTNode {
        const t = this.peek();
        switch (t.type) {
            case 'NUMBER': {
                this.advance();
                const raw = t.value.replace(/_/g, '');
                const v = raw.startsWith('0x') ? parseInt(raw, 16)
                    : raw.startsWith('0b') ? parseInt(raw.slice(2), 2)
                        : parseFloat(raw);
                if (this.check('IDENT')) {
                    const unit = this.peek().value;
                    if (this.unitSymbols.has(unit)) {
                        this.advance();
                        return {
                            kind: 'CallExpr',
                            callee: { kind: 'Ident', name: '__measure', line: t.line },
                            args: [
                                { value: { kind: 'NumberLit', value: v, line: t.line } },
                                { value: { kind: 'StringLit', value: unit, line: t.line } },
                            ],
                            line: t.line,
                        };
                    }
                }
                return { kind: 'NumberLit', value: v, line: t.line };
            }
            case 'STRING': {
                this.advance();
                return this.buildStringNode(t.value, t.line);
            }
            case 'TRUE': this.advance(); return { kind: 'BoolLit', value: true, line: t.line };
            case 'FALSE': this.advance(); return { kind: 'BoolLit', value: false, line: t.line };
            case 'NIL': this.advance(); return { kind: 'NilLit', line: t.line };
            case 'SELF': this.advance(); return { kind: 'SelfExpr', line: t.line };
            case 'IDENT': {
                this.advance();
                return { kind: 'Ident', name: t.value, line: t.line };
            }
            case 'DOT': {
                // Enum constructor: .ok(val) or .north
                this.advance();
                const tag = this.expectIdent();
                const args: ASTNode[] = [];
                if (this.check('LPAREN')) {
                    this.advance();
                    while (!this.check('RPAREN') && !this.check('EOF')) {
                        args.push(this.parseExpr());
                        if (!this.check('RPAREN')) this.expect('COMMA');
                    }
                    this.expect('RPAREN');
                }
                return { kind: 'EnumCtor', tag, args, line: t.line };
            }
            case 'LPAREN': {
                this.advance();
                // Empty tuple or grouped expr
                if (this.check('RPAREN')) { this.advance(); return { kind: 'TupleExpr', items: [], line: t.line }; }
                const first = this.parseExpr();
                if (this.check('COMMA')) {
                    const items = [first];
                    while (this.check('COMMA')) { this.advance(); if (this.check('RPAREN')) break; items.push(this.parseExpr()); }
                    this.expect('RPAREN');
                    return { kind: 'TupleExpr', items, line: t.line };
                }
                this.expect('RPAREN');
                return first;
            }
            case 'LBRACKET': {
                this.advance();
                const items: ASTNode[] = [];
                while (!this.check('RBRACKET') && !this.check('EOF')) {
                    items.push(this.parseExpr());
                    if (!this.check('RBRACKET')) this.expect('COMMA');
                }
                this.expect('RBRACKET');
                return { kind: 'ListExpr', items, line: t.line };
            }
            case 'LBRACE': {
                this.advance();
                const entries: { key: ASTNode; val: ASTNode }[] = [];
                while (!this.check('RBRACE') && !this.check('EOF')) {
                    const key = this.parseExpr();
                    this.expect('COLON');
                    const val = this.parseExpr();
                    entries.push({ key, val });
                    if (!this.check('RBRACE')) this.expect('COMMA');
                }
                this.expect('RBRACE');
                return { kind: 'MapExpr', entries, line: t.line };
            }
            case 'FN': {
                // Lambda: fn(x) = expr  or  fn(x): block
                this.advance();
                const params = this.parseParams();
                let body: Block;
                if (this.check('EQ')) {
                    this.advance();
                    const expr = this.parseExpr();
                    body = { kind: 'Block', stmts: [{ kind: 'ReturnStmt', value: expr, line: t.line }] };
                } else {
                    body = this.parseBlock();
                }
                return { kind: 'FnExpr', params, body, line: t.line };
            }
            default:
                parseError(`Unexpected token '${t.value}' (${t.type})`, t, this.file);
        }
    }

    // Split a raw string like "hello {name} world" into a TemplateString
    private buildStringNode(raw: string, line: number): ASTNode {
        if (!raw.includes('{')) return { kind: 'StringLit', value: raw, line };
        const parts: ASTNode[] = [];
        let i = 0; let text = '';
        while (i < raw.length) {
            if (raw[i] === '{') {
                if (text) { parts.push({ kind: 'StringLit', value: text, line }); text = ''; }
                let depth = 1; let j = i + 1; let exprSrc = '';
                while (j < raw.length && depth > 0) {
                    if (raw[j] === '{') depth++;
                    if (raw[j] === '}') { depth--; if (depth === 0) break; }
                    exprSrc += raw[j++];
                }
                i = j + 1;
                // parse the embedded expression
                const subLexer = new Lexer(exprSrc, '<interp>');
                const subTokens = subLexer.tokenize();
                const subParser = new Parser(subTokens, '<interp>');
                parts.push(subParser.parseExpr());
            } else {
                text += raw[i++];
            }
        }
        if (text) parts.push({ kind: 'StringLit', value: text, line });
        return { kind: 'TemplateString', parts, line };
    }

    private parseArgs(): CallArg[] {
        this.expect('LPAREN');
        return this.parseArgsFrom();
    }

    private parseArgsFrom(): CallArg[] {
        const args: CallArg[] = [];
        while (!this.check('RPAREN') && !this.check('EOF')) {
            // named arg? ident: expr
            if (this.check('IDENT') && this.peekAt(1).type === 'COLON') {
                const name = this.advance().value;
                this.advance(); // consume :
                const value = this.parseExpr();
                args.push({ name, value });
            } else {
                args.push({ value: this.parseExpr() });
            }
            if (!this.check('RPAREN')) this.expect('COMMA');
        }
        this.expect('RPAREN');
        return args;
    }

    // ─── Type expressions (parsed but largely ignored at runtime) ────────────────
    private parseTypeExpr(): ASTNode {
        let base: ASTNode;
        if (this.check('MEASURE')) {
            const line = this.advance().line;
            const dim = this.expectIdent();
            base = { kind: 'Ident', name: `measure:${dim}`, line };
        } else if (this.check('IDENT')) {
            base = { kind: 'Ident', name: this.advance().value, line: this.peek().line };
        } else if (this.check('LBRACKET')) {
            this.advance();
            const inner = this.parseTypeExpr();
            this.expect('RBRACKET');
            base = inner;
        } else {
            base = { kind: 'NilLit', line: this.peek().line }; // fallback
        }
        // Skip generic params: <T, E>
        if (this.check('LT')) {
            let depth = 1; this.advance();
            while (depth > 0 && !this.check('EOF')) {
                if (this.advance().type === 'LT') depth++;
                else if (this.tokens[this.pos - 1].type === 'GT') depth--;
            }
        }
        // Optional postfix ?
        if (this.check('QUESTION')) this.advance();
        return base;
    }

    private prefixFacetName(facetName: string, name: string): string {
        return `__facet_${facetName}__${name}`;
    }

    private rewriteFacetMethod(facetName: string, method: FnDecl): FnDecl {
        const facet = this.facets.get(facetName);
        if (!facet) return method;
        const fieldNames = new Set(facet.fields.map((f) => f.name));
        const methodNames = new Set(facet.methods.map((m) => m.name));
        const rewrittenBody = this.rewriteAst(method.body, (node) => {
            if (node.kind === 'AttributeExpr' && node.obj.kind === 'SelfExpr' && fieldNames.has(node.attr)) {
                return { ...node, attr: this.prefixFacetName(facetName, node.attr) };
            }
            if (node.kind === 'MethodCallExpr' && node.obj.kind === 'SelfExpr' && methodNames.has(node.method)) {
                return { ...node, method: this.prefixFacetName(facetName, node.method) };
            }
            return node;
        }) as Block;
        return { ...method, name: this.prefixFacetName(facetName, method.name), body: rewrittenBody };
    }

    private rewriteAst(node: ASTNode, transform: (node: ASTNode) => ASTNode): ASTNode {
        const current = transform(node);
        switch (current.kind) {
            case 'Program':
                return { ...current, body: current.body.map((n) => this.rewriteAst(n, transform)) };
            case 'Block':
                return { ...current, stmts: current.stmts.map((n) => this.rewriteAst(n, transform)) };
            case 'LetStmt':
            case 'VarStmt':
                return {
                    ...current,
                    typeAnn: current.typeAnn ? this.rewriteAst(current.typeAnn, transform) : undefined,
                    value: current.value ? this.rewriteAst(current.value, transform) : undefined,
                };
            case 'AssignStmt':
                return {
                    ...current,
                    target: this.rewriteAst(current.target, transform),
                    value: this.rewriteAst(current.value, transform),
                };
            case 'AugAssignStmt':
                return {
                    ...current,
                    target: this.rewriteAst(current.target, transform),
                    value: this.rewriteAst(current.value, transform),
                };
            case 'FnDecl':
                return {
                    ...current,
                    params: current.params.map((p) => ({
                        ...p,
                        typeAnn: p.typeAnn ? this.rewriteAst(p.typeAnn, transform) : undefined,
                        defaultVal: p.defaultVal && typeof p.defaultVal === 'object' && 'kind' in p.defaultVal
                            ? this.rewriteAst(p.defaultVal as ASTNode, transform)
                            : p.defaultVal,
                    })),
                    retType: current.retType ? this.rewriteAst(current.retType, transform) : undefined,
                    body: this.rewriteAst(current.body, transform) as Block,
                };
            case 'ReturnStmt':
                return { ...current, value: current.value ? this.rewriteAst(current.value, transform) : undefined };
            case 'IfStmt':
                return {
                    ...current,
                    cond: this.rewriteAst(current.cond, transform),
                    then: this.rewriteAst(current.then, transform) as Block,
                    elifs: current.elifs.map((e) => ({
                        cond: this.rewriteAst(e.cond, transform),
                        body: this.rewriteAst(e.body, transform) as Block,
                    })),
                    else_: current.else_ ? (this.rewriteAst(current.else_, transform) as Block) : undefined,
                };
            case 'WhileStmt':
                return { ...current, cond: this.rewriteAst(current.cond, transform), body: this.rewriteAst(current.body, transform) as Block };
            case 'ForStmt':
                return { ...current, iter: this.rewriteAst(current.iter, transform), body: this.rewriteAst(current.body, transform) as Block };
            case 'MatchStmt':
                return {
                    ...current,
                    subject: this.rewriteAst(current.subject, transform),
                    cases: current.cases.map((c) => ({
                        ...c,
                        guard: c.guard ? this.rewriteAst(c.guard, transform) : undefined,
                        body: this.rewriteAst(c.body, transform) as Block,
                    })),
                };
            case 'ExprStmt':
                return { ...current, expr: this.rewriteAst(current.expr, transform) };
            case 'TemplateString':
                return { ...current, parts: current.parts.map((p) => this.rewriteAst(p, transform)) };
            case 'BinOp':
                return { ...current, left: this.rewriteAst(current.left, transform), right: this.rewriteAst(current.right, transform) };
            case 'UnaryOp':
                return { ...current, operand: this.rewriteAst(current.operand, transform) };
            case 'CallExpr':
                return {
                    ...current,
                    callee: this.rewriteAst(current.callee, transform),
                    args: current.args.map((a) => ({ ...a, value: this.rewriteAst(a.value, transform) })),
                };
            case 'MethodCallExpr':
                return {
                    ...current,
                    obj: this.rewriteAst(current.obj, transform),
                    args: current.args.map((a) => ({ ...a, value: this.rewriteAst(a.value, transform) })),
                };
            case 'AttributeExpr':
                return { ...current, obj: this.rewriteAst(current.obj, transform) };
            case 'IndexExpr':
                return { ...current, obj: this.rewriteAst(current.obj, transform), index: this.rewriteAst(current.index, transform) };
            case 'ListExpr':
                return { ...current, items: current.items.map((i) => this.rewriteAst(i, transform)) };
            case 'TupleExpr':
                return { ...current, items: current.items.map((i) => this.rewriteAst(i, transform)) };
            case 'MapExpr':
                return {
                    ...current,
                    entries: current.entries.map((e) => ({ key: this.rewriteAst(e.key, transform), val: this.rewriteAst(e.val, transform) })),
                };
            case 'FnExpr':
                return { ...current, body: this.rewriteAst(current.body, transform) as Block };
            case 'EnumCtor':
                return { ...current, args: current.args.map((a) => this.rewriteAst(a, transform)) };
            case 'RangeExpr':
                return { ...current, start: this.rewriteAst(current.start, transform), end: this.rewriteAst(current.end, transform) };
            default:
                return current;
        }
    }

    // ─── Utilities ────────────────────────────────────────────────────────────────
    private peek(): Token { return this.tokens[this.pos] ?? { type: 'EOF', value: '', line: 0, col: 0 }; }
    private peekAt(offset: number): Token { return this.tokens[this.pos + offset] ?? { type: 'EOF', value: '', line: 0, col: 0 }; }
    private advance(): Token { return this.tokens[this.pos++] ?? { type: 'EOF', value: '', line: 0, col: 0 }; }
    private check(type: TT): boolean { return this.peek().type === type; }
    private expect(type: TT): Token {
        if (!this.check(type)) parseError(`Expected '${type}' but got '${this.peek().type}' ('${this.peek().value}')`, this.peek(), this.file);
        return this.advance();
    }
    private expectIdent(): string {
        const t = this.peek();
        if (t.type !== 'IDENT' && t.type !== 'SELF') parseError(`Expected identifier but got '${t.type}' ('${t.value}')`, t, this.file);
        return this.advance().value;
    }
    private skipNewlines(): void {
        while (this.check('NEWLINE') || this.check('SEMICOLON')) this.advance();
    }
}
