import { Token } from './types.js';

export class AuraError extends Error {
    constructor(
        public readonly message: string,
        public readonly file: string,
        public readonly line: number,
        public readonly col: number,
        public readonly phase: 'Lexer' | 'Parser' | 'Compiler' | 'Runtime',
    ) {
        super(message);
        this.name = 'AuraError';
    }

    format(): string {
        const label = `\x1b[31merror[${this.phase}]\x1b[0m`;
        return `${label}: ${this.message}\n  \x1b[36m-->\x1b[0m ${this.file}:${this.line}:${this.col}`;
    }
}

export function lexError(msg: string, file: string, line: number, col: number): never {
    throw new AuraError(msg, file, line, col, 'Lexer');
}
export function parseError(msg: string, tok: Token, file: string): never {
    throw new AuraError(msg, file, tok.line, tok.col, 'Parser');
}
export function compileError(msg: string, file: string, line: number): never {
    throw new AuraError(msg, file, line, 0, 'Compiler');
}
export function runtimeError(msg: string): never {
    throw new AuraError(msg, '<runtime>', 0, 0, 'Runtime');
}
