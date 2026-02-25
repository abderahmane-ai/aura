// ─── Token Types ──────────────────────────────────────────────────────────────
export type TT =
    | 'NUMBER' | 'STRING' | 'IDENT' | 'TRUE' | 'FALSE' | 'NIL'
    | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH' | 'PERCENT' | 'POW'
    | 'EQ_EQ' | 'BANG_EQ' | 'LT' | 'GT' | 'LT_EQ' | 'GT_EQ'
    | 'EQ' | 'PLUS_EQ' | 'MINUS_EQ' | 'STAR_EQ' | 'SLASH_EQ'
    | 'DOT' | 'DOT_DOT' | 'DOT_DOT_EQ' | 'ARROW' | 'PIPE_GT'
    | 'BANG' | 'QUESTION' | 'COALESCE' | 'COLON' | 'COMMA' | 'SEMICOLON'
    | 'LPAREN' | 'RPAREN' | 'LBRACKET' | 'RBRACKET' | 'LBRACE' | 'RBRACE'
    | 'NEWLINE' | 'INDENT' | 'DEDENT'
    | 'LT_ANGLE' | 'GT_ANGLE'  // generic params < >
    | 'AMP' | 'PIPE'           // & |
    | 'LET' | 'VAR' | 'FN' | 'RETURN' | 'IF' | 'ELIF' | 'ELSE'
    | 'FOR' | 'IN' | 'WHILE' | 'REPEAT' | 'CADENCE' | 'BREAK' | 'CONTINUE'
    | 'INDEXED' | 'BY'
    | 'CONSTRAINT' | 'REQUIRE' | 'UNIT' | 'MEASURE' | 'FACET' | 'ADOPTS'
    | 'CLASS' | 'STRUCT' | 'INTERFACE' | 'TRAIT' | 'IMPL' | 'ENUM' | 'ACTOR'
    | 'SELF' | 'IMPORT' | 'FROM' | 'AS' | 'MODULE' | 'PUB' | 'MUT' | 'WEAK'
    | 'ASYNC' | 'AWAIT' | 'SPAWN' | 'SELECT'
    | 'MATCH' | 'CASE' | 'AND' | 'OR' | 'NOT'
    | 'TRY' | 'CATCH' | 'THROW' | 'DEFER' | 'WHERE' | 'IS'
    | 'EOF';

export interface Token {
    type: TT;
    value: string;
    line: number;
    col: number;
}

// ─── AST ──────────────────────────────────────────────────────────────────────
export type ASTNode =
    | Program | Block
    | LetStmt | VarStmt | AssignStmt | AugAssignStmt
    | FnDecl | ReturnStmt
    | ClassDecl | InterfaceDecl | TraitDecl | ImplDecl | EnumDecl
    | IfStmt | WhileStmt | ForStmt | BreakStmt | ContinueStmt
    | MatchStmt
    | ImportStmt | ModuleStmt
    | ExprStmt
    | NumberLit | StringLit | TemplateString | BoolLit | NilLit
    | Ident | SelfExpr
    | BinOp | UnaryOp
    | CallExpr | MethodCallExpr | SafeMethodCallExpr | AttributeExpr | SafeAttributeExpr | IndexExpr
    | ListExpr | ListComprehension | TupleExpr | MapExpr
    | FnExpr | EnumCtor
    | RangeExpr;

export interface Program { kind: 'Program'; body: ASTNode[]; }
export interface Block { kind: 'Block'; stmts: ASTNode[]; }
export interface LetStmt { kind: 'LetStmt'; name: string; typeAnn?: ASTNode; value?: ASTNode; line: number; }
export interface VarStmt { kind: 'VarStmt'; name: string; typeAnn?: ASTNode; value?: ASTNode; line: number; }
export interface AssignStmt { kind: 'AssignStmt'; target: ASTNode; value: ASTNode; line: number; }
export interface AugAssignStmt { kind: 'AugAssignStmt'; target: ASTNode; op: string; value: ASTNode; line: number; }
export interface FnDecl { kind: 'FnDecl'; name: string; params: Param[]; retType?: ASTNode; body: Block; isAsync: boolean; typeParams: string[]; line: number; }
export interface ReturnStmt { kind: 'ReturnStmt'; value?: ASTNode; line: number; }
export interface ClassDecl { kind: 'ClassDecl'; name: string; fields: FieldDef[]; methods: FnDecl[]; line: number; }
export interface InterfaceDecl { kind: 'InterfaceDecl'; name: string; methods: FnDecl[]; line: number; }
export interface TraitDecl { kind: 'TraitDecl'; name: string; methods: FnDecl[]; line: number; }
export interface ImplDecl { kind: 'ImplDecl'; traitName?: string; typeName: string; methods: FnDecl[]; line: number; }
export interface EnumDecl { kind: 'EnumDecl'; name: string; variants: EnumVariant[]; line: number; }
export interface IfStmt { kind: 'IfStmt'; cond: ASTNode; then: Block; elifs: { cond: ASTNode; body: Block }[]; else_?: Block; line: number; }
export interface WhileStmt { kind: 'WhileStmt'; cond: ASTNode; body: Block; line: number; }
export interface ForStmt { kind: 'ForStmt'; name: string; iter: ASTNode; body: Block; line: number; }
export interface BreakStmt { kind: 'BreakStmt'; line: number; }
export interface ContinueStmt { kind: 'ContinueStmt'; line: number; }
export interface MatchStmt { kind: 'MatchStmt'; subject: ASTNode; cases: MatchCase[]; line: number; }
export interface ImportStmt { kind: 'ImportStmt'; path: string; alias?: string; line: number; }
export interface ModuleStmt { kind: 'ModuleStmt'; path: string; line: number; }
export interface ExprStmt { kind: 'ExprStmt'; expr: ASTNode; line: number; }

export interface NumberLit { kind: 'NumberLit'; value: number; line: number; }
export interface StringLit { kind: 'StringLit'; value: string; line: number; }
export interface TemplateString { kind: 'TemplateString'; parts: ASTNode[]; line: number; }
export interface BoolLit { kind: 'BoolLit'; value: boolean; line: number; }
export interface NilLit { kind: 'NilLit'; line: number; }
export interface Ident { kind: 'Ident'; name: string; line: number; }
export interface SelfExpr { kind: 'SelfExpr'; line: number; }
export interface BinOp { kind: 'BinOp'; op: string; left: ASTNode; right: ASTNode; line: number; }
export interface UnaryOp { kind: 'UnaryOp'; op: string; operand: ASTNode; line: number; }
export interface CallExpr { kind: 'CallExpr'; callee: ASTNode; args: CallArg[]; line: number; }
export interface MethodCallExpr { kind: 'MethodCallExpr'; obj: ASTNode; method: string; args: CallArg[]; line: number; }
export interface AttributeExpr { kind: 'AttributeExpr'; obj: ASTNode; attr: string; line: number; }
export interface SafeMethodCallExpr { kind: 'SafeMethodCallExpr'; obj: ASTNode; method: string; args: CallArg[]; line: number; }
export interface SafeAttributeExpr { kind: 'SafeAttributeExpr'; obj: ASTNode; attr: string; line: number; }
export interface IndexExpr { kind: 'IndexExpr'; obj: ASTNode; index: ASTNode; line: number; }
export interface ListExpr { kind: 'ListExpr'; items: ASTNode[]; line: number; }
export interface ListComprehension { kind: 'ListComprehension'; expr: ASTNode; name: string; iter: ASTNode; cond?: ASTNode; line: number; }
export interface TupleExpr { kind: 'TupleExpr'; items: ASTNode[]; line: number; }
export interface MapExpr { kind: 'MapExpr'; entries: { key: ASTNode; val: ASTNode }[]; line: number; }
export interface FnExpr { kind: 'FnExpr'; params: Param[]; body: Block; line: number; }
export interface EnumCtor { kind: 'EnumCtor'; tag: string; args: ASTNode[]; line: number; }
export interface RangeExpr { kind: 'RangeExpr'; start: ASTNode; end: ASTNode; inclusive: boolean; line: number; }

export interface Param { name: string; typeAnn?: ASTNode; defaultVal?: ASTNode | Value; }
export interface FieldDef { name: string; typeAnn?: ASTNode; defaultVal?: ASTNode | Value; mutable: boolean; }
export interface CallArg { name?: string; value: ASTNode; }
export interface MatchCase { pattern: MatchPattern; guard?: ASTNode; body: Block; }
export interface EnumVariant { name: string; fields: ASTNode[]; }

export type MatchPattern =
    | { kind: 'EnumPattern'; tag: string; bindings: string[]; }
    | { kind: 'LiteralPattern'; value: ASTNode; }
    | { kind: 'IdentPattern'; name: string; }
    | { kind: 'WildcardPattern'; };

// ─── Bytecode ─────────────────────────────────────────────────────────────────
export type OpCode =
    | 'PUSH_CONST' | 'PUSH_TRUE' | 'PUSH_FALSE' | 'PUSH_NIL'
    | 'POP' | 'DUP' | 'SWAP'
    | 'DEFINE_GLOBAL' | 'GET_GLOBAL' | 'SET_GLOBAL'
    | 'GET_LOCAL' | 'SET_LOCAL'
    | 'ADD' | 'SUB' | 'MUL' | 'DIV' | 'MOD' | 'POW' | 'NEG'
    | 'CONCAT'   // string concat
    | 'EQ' | 'NEQ' | 'LT' | 'GT' | 'LE' | 'GE'
    | 'AND' | 'OR' | 'NOT'
    | 'JUMP' | 'JUMP_IF_FALSE' | 'JUMP_IF_TRUE'
    | 'CALL' | 'RETURN'
    | 'CLOSURE'
    | 'NEW_OBJECT' | 'GET_ATTR' | 'SET_ATTR' | 'CALL_METHOD'
    | 'BUILD_STRING'       // BUILD_STRING n  — concat n values as strings
    | 'BUILD_LIST'         // BUILD_LIST n
    | 'BUILD_MAP'          // BUILD_MAP n  (n pairs)
    | 'BUILD_RANGE'        // BUILD_RANGE inclusive(bool)
    | 'BUILD_ENUM'         // BUILD_ENUM tag argc
    | 'GET_ITER'           // convert TOS to iterator
    | 'FOR_ITER'           // advance iter; if done jump
    | 'MATCH_ENUM'         // MATCH_ENUM tag argc — peek TOS, jump if no match, else push bound vars
    | 'MATCH_LITERAL'      // MATCH_LITERAL — peek TOS == next item on stack?
    | 'MATCH_SUCCESS'      // no-op marker  
    | 'GET_INDEX'          // obj[index]
    | 'SET_INDEX'
    | 'PRINT'              // built-in print
    | 'HALT';

export interface Instruction {
    op: OpCode;
    arg?: number | string | boolean;
    line: number;
}

export interface Chunk {
    name: string;
    file?: string;
    code: Instruction[];
    constants: Value[];
}

// ─── Runtime Values ───────────────────────────────────────────────────────────
export type Value =
    | null | boolean | number | string
    | AuraList | AuraMap | AuraRange | AuraIterator | AuraNative | AuraMeasure
    | AuraFunction | AuraClass | AuraInstance
    | AuraEnum | AuraModule | BuiltinFn;

export interface AuraList { type: 'list'; items: Value[]; }
export interface AuraMap { type: 'map'; entries: Map<string, Value>; }
export interface AuraRange { type: 'range'; start: number; end: number; inclusive: boolean; }
export interface AuraIterator { type: 'iter'; source: AuraList | AuraRange; index: number; }
export interface AuraNative {
    type: 'native';
    kind: 'stack' | 'queue' | 'heap' | 'hashmap' | 'linked_list' | 'tree' | 'indexed';
    data: any;
}
export interface AuraMeasure {
    type: 'measure';
    dimension: string;
    baseValue: number;
    unit: string;
    factor: number;
}
export interface AuraFunction {
    type: 'function';
    name: string;
    params: Param[];
    chunk: Chunk;
    closure: Scope;
    receiver?: AuraInstance;
}
export interface AuraClass {
    type: 'class';
    name: string;
    fields: FieldDef[];
    methods: Map<string, AuraFunction>;
}
export interface AuraInstance {
    type: 'instance';
    klass: AuraClass;
    fields: Map<string, Value>;
}
export interface AuraEnum { type: 'enum'; tag: string; values: Value[]; }
export interface AuraModule { type: 'module'; name: string; attrs: Map<string, Value>; }
export interface BuiltinFn { type: 'builtin'; name: string; fn: (args: Value[]) => Value; }

export type Scope = Map<string, Value>[];

export interface CallFrame {
    chunk: Chunk;
    ip: number;
    base: number;     // stack base for locals
    locals: Map<string, Value>;
    receiver?: AuraInstance;
}
