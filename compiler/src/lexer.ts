import { TT, Token } from './types.js';
import { lexError } from './errors.js';

const KEYWORDS: Record<string, TT> = {
    let: 'LET', var: 'VAR', fn: 'FN', return: 'RETURN',
    if: 'IF', elif: 'ELIF', else: 'ELSE',
    for: 'FOR', in: 'IN', while: 'WHILE', repeat: 'REPEAT', cadence: 'CADENCE',
    indexed: 'INDEXED', by: 'BY',
    break: 'BREAK', continue: 'CONTINUE',
    constraint: 'CONSTRAINT', require: 'REQUIRE',
    unit: 'UNIT', measure: 'MEASURE',
    facet: 'FACET', adopts: 'ADOPTS',
    class: 'CLASS', interface: 'INTERFACE',
    trait: 'TRAIT', impl: 'IMPL', enum: 'ENUM',
    self: 'SELF', import: 'IMPORT', from: 'FROM', as: 'AS', module: 'MODULE',
    pub: 'PUB', mut: 'MUT', weak: 'WEAK',
    match: 'MATCH', case: 'CASE',
    and: 'AND', or: 'OR', not: 'NOT',
    true: 'TRUE', false: 'FALSE', nil: 'NIL',
    try: 'TRY', catch: 'CATCH', throw: 'THROW', defer: 'DEFER',
    where: 'WHERE', is: 'IS',
};

export class Lexer {
    private pos = 0;
    private line = 1;
    private col = 1;
    private indentStack: number[] = [0];
    private pendingDedents = 0;
    private atLineStart = true;
    private tokens: Token[] = [];

    constructor(private src: string, private file: string) { }

    tokenize(): Token[] {
        while (this.pos < this.src.length) {
            if (this.atLineStart) {
                this.handleIndentation();
                if (this.pendingDedents > 0) {
                    while (this.pendingDedents > 0) {
                        this.push('DEDENT', '');
                        this.pendingDedents--;
                    }
                    continue;
                }
            }
            this.scanToken();
        }
        // Close any open indentation levels
        while (this.indentStack.length > 1) {
            this.indentStack.pop();
            this.push('DEDENT', '');
        }
        this.push('EOF', '');
        return this.tokens;
    }

    private handleIndentation(): void {
        let indent = 0;
        const start = this.pos;
        while (this.pos < this.src.length && this.src[this.pos] === ' ') {
            indent++;
            this.pos++;
            this.col++;
        }
        // Skip blank lines and comment-only lines
        if (
            this.pos < this.src.length &&
            (this.src[this.pos] === '\n' || this.src[this.pos] === '\r' || this.src[this.pos] === '#')
        ) {
            return; // don't emit INDENT/DEDENT for empty lines
        }
        const current = this.indentStack[this.indentStack.length - 1];
        if (indent > current) {
            this.indentStack.push(indent);
            this.push('INDENT', '');
        } else if (indent < current) {
            while (this.indentStack.length > 1 && this.indentStack[this.indentStack.length - 1] > indent) {
                this.indentStack.pop();
                this.pendingDedents++;
            }
        }
        this.atLineStart = false;
    }

    private scanToken(): void {
        const c = this.src[this.pos];

        // Skip whitespace (not leading — that's handled by indentation)
        if (c === ' ' || c === '\t' || c === '\r') { this.pos++; this.col++; return; }

        // Newline
        if (c === '\n') {
            const last = this.tokens[this.tokens.length - 1];
            if (last && !['NEWLINE', 'INDENT', 'DEDENT', 'COLON'].includes(last.type)) {
                this.push('NEWLINE', '\n');
            }
            this.pos++; this.line++; this.col = 1; this.atLineStart = true; return;
        }

        // Comments
        if (c === '#') {
            while (this.pos < this.src.length && this.src[this.pos] !== '\n') { this.pos++; this.col++; }
            return;
        }

        // Strings
        if (c === '"') { this.lexString(); return; }
        if (c === "'") { this.lexChar(); return; }

        // Numbers
        if (c >= '0' && c <= '9') { this.lexNumber(); return; }

        // Identifiers / keywords
        if (c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) { this.lexIdent(); return; }

        // Operators & punctuation
        this.lexOp();
    }

    private lexString(): void {
        const startLine = this.line; const startCol = this.col;
        this.pos++; this.col++; // skip opening "
        let value = '';
        let hasInterp = false;
        while (this.pos < this.src.length && this.src[this.pos] !== '"') {
            if (this.src[this.pos] === '{') {
                hasInterp = true;
                value += '{';
                this.pos++; this.col++;
                // Scan ahead until matching }
                let depth = 1;
                while (this.pos < this.src.length && depth > 0) {
                    if (this.src[this.pos] === '{') depth++;
                    if (this.src[this.pos] === '}') depth--;
                    if (depth > 0 || this.src[this.pos] !== '}') value += this.src[this.pos];
                    this.pos++; this.col++;
                }
                value += '}';
            } else if (this.src[this.pos] === '\\') {
                this.pos++; this.col++;
                const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '0': '\0' };
                value += esc[this.src[this.pos]] ?? this.src[this.pos];
                this.pos++; this.col++;
            } else {
                if (this.src[this.pos] === '\n') { this.line++; this.col = 0; }
                value += this.src[this.pos]; this.pos++; this.col++;
            }
        }
        if (this.pos >= this.src.length) lexError('Unterminated string', this.file, startLine, startCol);
        this.pos++; this.col++; // skip closing "
        this.pushAt(hasInterp ? 'STRING' : 'STRING', value, startLine, startCol);
        // Mark as interp by prefixing iff it has interpolation — the parser checks for `{`
    }

    private lexChar(): void {
        this.pos++; this.col++;
        let value = this.src[this.pos]; this.pos++; this.col++;
        if (this.src[this.pos] !== "'") lexError("Expected closing ' for char literal", this.file, this.line, this.col);
        this.pos++; this.col++;
        this.push('STRING', value);
    }

    private lexNumber(): void {
        const start = this.pos; const startLine = this.line; const startCol = this.col;
        if (this.src[this.pos] === '0' && (this.src[this.pos + 1] === 'x' || this.src[this.pos + 1] === 'b')) {
            this.pos += 2; this.col += 2;
            while (this.pos < this.src.length && /[0-9a-fA-F_]/.test(this.src[this.pos])) { this.pos++; this.col++; }
        } else {
            while (this.pos < this.src.length && /[0-9_]/.test(this.src[this.pos])) { this.pos++; this.col++; }
            if (this.src[this.pos] === '.' && this.src[this.pos + 1] !== '.') {
                this.pos++; this.col++;
                while (this.pos < this.src.length && /[0-9_]/.test(this.src[this.pos])) { this.pos++; this.col++; }
            }
        }
        this.pushAt('NUMBER', this.src.slice(start, this.pos), startLine, startCol);
    }

    private lexIdent(): void {
        const start = this.pos; const startLine = this.line; const startCol = this.col;
        while (this.pos < this.src.length && /[a-zA-Z0-9_]/.test(this.src[this.pos])) { this.pos++; this.col++; }
        const word = this.src.slice(start, this.pos);
        this.pushAt(KEYWORDS[word] ?? 'IDENT', word, startLine, startCol);
    }

    private lexOp(): void {
        const c = this.src[this.pos]; const n = this.src[this.pos + 1];
        const startLine = this.line; const startCol = this.col;
        const tok = (tt: TT, len: number, val?: string) => {
            this.pos += len; this.col += len;
            this.pushAt(tt, val ?? this.src.slice(this.pos - len, this.pos), startLine, startCol);
        };

        if (c === '.' && n === '.' && this.src[this.pos + 2] === '=') return tok('DOT_DOT_EQ', 3);
        if (c === '.' && n === '.') return tok('DOT_DOT', 2);
        if (c === '.' && n >= 'a' && n <= 'z') {
            // .identifier -> enum constructor prefix, emit DOT then let parser pick up IDENT
            return tok('DOT', 1, '.');
        }
        if (c === '-' && n === '>') return tok('ARROW', 2);
        if (c === '|' && n === '>') return tok('PIPE_GT', 2);
        if (c === '*' && n === '*') return tok('POW', 2);
        if (c === '=' && n === '=') return tok('EQ_EQ', 2);
        if (c === '!' && n === '=') return tok('BANG_EQ', 2);
        if (c === '<' && n === '=') return tok('LT_EQ', 2);
        if (c === '>' && n === '=') return tok('GT_EQ', 2);
        if (c === '+' && n === '=') return tok('PLUS_EQ', 2);
        if (c === '-' && n === '=') return tok('MINUS_EQ', 2);
        if (c === '*' && n === '=') return tok('STAR_EQ', 2);
        if (c === '/' && n === '=') return tok('SLASH_EQ', 2);

        const single: Record<string, TT> = {
            '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH', '%': 'PERCENT',
            '=': 'EQ', '<': 'LT', '>': 'GT', '!': 'BANG', '?': 'QUESTION',
            '.': 'DOT', ',': 'COMMA', ':': 'COLON', ';': 'SEMICOLON',
            '(': 'LPAREN', ')': 'RPAREN', '[': 'LBRACKET', ']': 'RBRACKET',
            '{': 'LBRACE', '}': 'RBRACE', '&': 'AMP', '|': 'PIPE',
        };
        if (single[c]) return tok(single[c], 1);
        lexError(`Unexpected character '${c}'`, this.file, this.line, this.col);
    }

    private push(type: TT, value: string): void {
        this.tokens.push({ type, value, line: this.line, col: this.col });
    }
    private pushAt(type: TT, value: string, line: number, col: number): void {
        this.tokens.push({ type, value, line, col });
    }
}
