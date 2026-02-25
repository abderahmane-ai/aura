#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Resolver } from './resolver.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';
import { AuraError } from './errors.js';

const VERSION = '0.1.0';

function usage(): void {
    process.stderr.write(
        'Usage:\n' +
        '  aurac <file>\n' +
        '  aurac run <file>\n' +
        '  aurac check <file>\n' +
        '  aurac version\n',
    );
}

function compileFile(filePath: string) {
    const absPath = resolvePath(process.cwd(), filePath);
    const source = readFileSync(absPath, 'utf8');
    const tokens = new Lexer(source, absPath).tokenize();
    const ast = new Parser(tokens, absPath).parseProgram();
    new Resolver(absPath).resolve(ast);
    return new Compiler(absPath).compile(ast);
}

function runCli(): number {
    const [, , cmd, arg] = process.argv;
    const looksLikeAuraFile = (value: string): boolean => extname(value).toLowerCase() === '.aura';
    try {
        if (cmd && !arg && looksLikeAuraFile(cmd)) {
            const chunk = compileFile(cmd);
            new VM().run(chunk);
            return 0;
        }
        if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
            process.stdout.write(`${VERSION}\n`);
            return 0;
        }
        if (cmd === 'run') {
            if (!arg) {
                usage();
                return 2;
            }
            const chunk = compileFile(arg);
            new VM().run(chunk);
            return 0;
        }
        if (cmd === 'check') {
            if (!arg) {
                usage();
                return 2;
            }
            compileFile(arg);
            process.stdout.write(`OK ${resolvePath(process.cwd(), arg)}\n`);
            return 0;
        }
        usage();
        return 2;
    } catch (err) {
        if (err instanceof AuraError) {
            process.stderr.write(err.format() + '\n');
            return 1;
        }
        process.stderr.write(String(err) + '\n');
        return 1;
    }
}

process.exit(runCli());
