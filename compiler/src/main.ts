#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve as resolvePath, sep as pathSep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Resolver } from './resolver.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';
import { AuraError } from './errors.js';
import { ASTNode, ImportStmt, Program, AuraModule, Value } from './types.js';

const VERSION = '0.1.0';
const COMPILER_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolvePath(COMPILER_DIR, '..');

interface ModuleRecord {
    file: string;
    ast: Program;
    imports: ImportStmt[];
    exportNames: string[];
    moduleName: string;
    checked: boolean;
    executed: boolean;
    moduleValue?: AuraModule;
}

interface ModuleState {
    cache: Map<string, ModuleRecord>;
    loading: Set<string>;
    importPathCache: Map<string, string>;
    stdlibPathCache: Map<string, string | null>;
}

function usage(): void {
    process.stderr.write(
        'Usage:\n' +
        '  aurac <file>\n' +
        '  aurac run <file>\n' +
        '  aurac check <file>\n' +
        '  aurac test [path]\n' +
        '  aurac repl\n' +
        '  aurac version\n',
    );
}

function parseProgram(absPath: string): Program {
    const source = readFileSync(absPath, 'utf8');
    const tokens = new Lexer(source, absPath).tokenize();
    return new Parser(tokens, absPath).parseProgram();
}

function importBindingName(node: ImportStmt): string {
    if (node.alias) return node.alias;
    const parts = node.path.split('.');
    return parts[parts.length - 1];
}

function findStdlibModule(fromFile: string, stdRel: string, state: ModuleState): string | null {
    const cacheKey = fromFile + '\0' + stdRel;
    const cached = state.stdlibPathCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const roots = [dirname(fromFile), process.cwd(), REPO_ROOT];
    for (const root of roots) {
        let cur = resolvePath(root);
        while (true) {
            const candidate = resolvePath(cur, 'stdlib', stdRel);
            if (existsSync(candidate)) {
                state.stdlibPathCache.set(cacheKey, candidate);
                return candidate;
            }
            const parent = resolvePath(cur, '..');
            if (parent === cur) break;
            cur = parent;
        }
    }
    state.stdlibPathCache.set(cacheKey, null);
    return null;
}

function resolveImportPath(fromFile: string, modulePath: string, state: ModuleState): string {
    const cacheKey = fromFile + '\0' + modulePath;
    const cached = state.importPathCache.get(cacheKey);
    if (cached) return cached;

    if (modulePath.startsWith('std.')) {
        const stdRel = modulePath.slice('std.'.length).split('.').join(pathSep) + '.aura';
        const stdCandidate = findStdlibModule(fromFile, stdRel, state);
        if (stdCandidate) {
            state.importPathCache.set(cacheKey, stdCandidate);
            return stdCandidate;
        }
    }
    const rel = modulePath.split('.').join(pathSep) + '.aura';
    const candidateLocal = resolvePath(dirname(fromFile), rel);
    if (existsSync(candidateLocal)) {
        state.importPathCache.set(cacheKey, candidateLocal);
        return candidateLocal;
    }
    const candidateCwd = resolvePath(process.cwd(), rel);
    if (existsSync(candidateCwd)) {
        state.importPathCache.set(cacheKey, candidateCwd);
        return candidateCwd;
    }
    throw new AuraError(
        'Cannot resolve import ' + "'" + modulePath + "'",
        fromFile,
        0,
        0,
        'Compiler',
    );
}

function collectImports(ast: Program): ImportStmt[] {
    return ast.body.filter((node): node is ImportStmt => node.kind === 'ImportStmt');
}

function collectExports(ast: Program): string[] {
    const exports = new Set<string>();
    for (const node of ast.body) {
        if (node.kind === 'FnDecl' && node.name.startsWith('__constraint_')) continue;
        switch (node.kind) {
            case 'LetStmt':
            case 'VarStmt':
            case 'FnDecl':
            case 'ClassDecl':
            case 'InterfaceDecl':
            case 'TraitDecl':
            case 'EnumDecl':
                exports.add(node.name);
                break;
            default:
                break;
        }
    }
    return [...exports];
}

function bindModuleScope(value: Value, scope: Map<string, Value>): void {
    if ((value as any)?.type === 'function') {
        (value as any).moduleScope = scope;
        return;
    }
    if ((value as any)?.type === 'class') {
        const klass = value as any;
        for (const method of klass.methods.values()) {
            if ((method as any)?.type === 'function') (method as any).moduleScope = scope;
        }
    }
}

function moduleName(ast: Program, fallbackFile: string): string {
    for (const node of ast.body) {
        if (node.kind === 'ModuleStmt') return node.path;
    }
    return basename(fallbackFile, '.aura');
}

function ensureRecord(file: string, state: ModuleState): ModuleRecord {
    const existing = state.cache.get(file);
    if (existing) return existing;
    const ast = parseProgram(file);
    const rec: ModuleRecord = {
        file,
        ast,
        imports: collectImports(ast),
        exportNames: collectExports(ast),
        moduleName: moduleName(ast, file),
        checked: false,
        executed: false,
    };
    state.cache.set(file, rec);
    return rec;
}

function checkModule(file: string, state: ModuleState): void {
    const rec = ensureRecord(file, state);
    if (rec.checked) return;
    if (state.loading.has(file)) {
        throw new AuraError(`Cyclic import detected at '${file}'`, file, 0, 0, 'Compiler');
    }
    state.loading.add(file);
    try {
        for (const imp of rec.imports) {
            const depPath = resolveImportPath(file, imp.path, state);
            checkModule(depPath, state);
        }
        new Resolver(file).resolve(rec.ast);
        new Compiler(file, { autoInvokeMain: false }).compile(rec.ast);
        rec.checked = true;
    } finally {
        state.loading.delete(file);
    }
}

function executeModule(file: string, state: ModuleState, vm: VM, isEntry = false): ModuleRecord {
    const rec = ensureRecord(file, state);
    if (rec.executed) return rec;
    if (state.loading.has(file)) {
        throw new AuraError(`Cyclic import detected at '${file}'`, file, 0, 0, 'Compiler');
    }
    state.loading.add(file);
    const globalsBefore = isEntry ? null : vm.snapshotGlobals();
    try {
        for (const imp of rec.imports) {
            const depPath = resolveImportPath(file, imp.path, state);
            const dep = executeModule(depPath, state, vm, false);
            if (dep.moduleValue) vm.setGlobal(importBindingName(imp), dep.moduleValue);
        }

        new Resolver(file).resolve(rec.ast);
        const chunk = new Compiler(file, { autoInvokeMain: isEntry }).compile(rec.ast);
        vm.run(chunk);

        const attrs = new Map<string, Value>();
        const moduleScope = new Map<string, Value>();
        for (const imp of rec.imports) {
            const alias = importBindingName(imp);
            if (vm.hasGlobal(alias)) moduleScope.set(alias, vm.getGlobal(alias)!);
        }
        for (const name of rec.exportNames) {
            if (vm.hasGlobal(name)) {
                const value = vm.getGlobal(name)!;
                attrs.set(name, value);
                moduleScope.set(name, value);
            }
        }
        for (const value of attrs.values()) {
            bindModuleScope(value, moduleScope);
        }
        rec.moduleValue = { type: 'module', name: rec.moduleName, attrs };
        rec.executed = true;
        return rec;
    } finally {
        if (globalsBefore) vm.restoreGlobals(globalsBefore);
        state.loading.delete(file);
    }
}

function runFile(filePath: string): void {
    const absPath = resolvePath(process.cwd(), filePath);
    const state: ModuleState = {
        cache: new Map(),
        loading: new Set(),
        importPathCache: new Map(),
        stdlibPathCache: new Map(),
    };
    const vm = new VM();
    executeModule(absPath, state, vm, true);
}

function checkFile(filePath: string): void {
    const absPath = resolvePath(process.cwd(), filePath);
    const state: ModuleState = {
        cache: new Map(),
        loading: new Set(),
        importPathCache: new Map(),
        stdlibPathCache: new Map(),
    };
    checkModule(absPath, state);
}

function isAuraFile(file: string): boolean {
    return extname(file).toLowerCase() === '.aura';
}

function isTestFile(file: string): boolean {
    const lower = file.toLowerCase();
    return lower.endsWith('.test.aura') || lower.endsWith('_test.aura');
}

function discoverTests(targetPath?: string): string[] {
    const cwd = process.cwd();
    const root = targetPath ? resolvePath(cwd, targetPath) : resolvePath(cwd, 'tests');
    if (!existsSync(root)) return [];
    const rootStats = statSync(root);
    if (rootStats.isFile()) {
        if (!isAuraFile(root)) return [];
        return [root];
    }

    const out: string[] = [];
    const walk = (dir: string): void => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = resolvePath(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!isTestFile(entry.name)) continue;
            out.push(full);
        }
    };
    walk(root);
    out.sort((a, b) => a.localeCompare(b));
    return out;
}

function displayTestPath(absPath: string): string {
    const relPath = relative(process.cwd(), absPath);
    return relPath.length === 0 ? absPath : relPath;
}

function runTests(targetPath?: string): number {
    const files = discoverTests(targetPath);
    if (files.length === 0) {
        process.stderr.write(
            targetPath
                ? `No test files found in '${targetPath}'. Use *.test.aura or *_test.aura.\n`
                : "No test files found in './tests'. Use *.test.aura or *_test.aura.\n",
        );
        return 1;
    }

    let passed = 0;
    let failed = 0;
    for (const file of files) {
        const name = displayTestPath(file);
        try {
            runFile(file);
            passed++;
            process.stdout.write(`[PASS] ${name}\n`);
        } catch (err) {
            failed++;
            process.stdout.write(`[FAIL] ${name}\n`);
            if (err instanceof AuraError) process.stderr.write(err.format() + '\n');
            else process.stderr.write(String(err) + '\n');
        }
    }

    const total = passed + failed;
    process.stdout.write(`\nTests run: ${total}\n`);
    process.stdout.write(`Passed: ${passed}\n`);
    process.stdout.write(`Failed: ${failed}\n`);
    return failed === 0 ? 0 : 1;
}

function maybeWrapReplExpr(ast: Program): Program {
    if (ast.body.length !== 1) return ast;
    const only = ast.body[0];
    if (only.kind !== 'ExprStmt') return ast;
    const line = only.line;
    const wrapped: ASTNode = {
        kind: 'ExprStmt',
        expr: {
            kind: 'CallExpr',
            callee: { kind: 'Ident', name: 'print', line },
            args: [{ value: only.expr }],
            line,
        },
        line,
    };
    return { kind: 'Program', body: [wrapped] };
}

function runRepl(): void {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const vm = new VM();
    let lineBuffer = '';
    let braceDepth = 0;
    let parenDepth = 0;
    let indentLevel = 0;

    process.stdout.write(`Aura ${VERSION} REPL\n`);
    process.stdout.write('Type "exit" or press Ctrl+C to quit\n\n');

    const prompt = () => {
        process.stdout.write(lineBuffer ? '...   ' : 'aura> ');
    };

    prompt();

    rl.on('line', (line) => {
        if (!lineBuffer && line.trim() === 'exit') {
            rl.close();
            return;
        }

        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '(') parenDepth++;
            else if (c === ')') parenDepth--;
            else if (c === '{') braceDepth++;
            else if (c === '}') braceDepth--;
        }

        if (line.trim().endsWith(':')) {
            indentLevel++;
        } else if (line.trim() === '' && indentLevel > 0) {
            indentLevel--;
        }

        lineBuffer += (lineBuffer ? '\n' : '') + line;

        const totalDepth = braceDepth + parenDepth + indentLevel;
        if (totalDepth === 0 && lineBuffer.trim() !== '') {
            try {
                const tokens = new Lexer(lineBuffer, '<repl>').tokenize();
                const parsed = new Parser(tokens, '<repl>').parseProgram();
                const ast = maybeWrapReplExpr(parsed);
                new Resolver('<repl>').resolve(ast);
                const chunk = new Compiler('<repl>').compile(ast);
                vm.run(chunk);
            } catch (err) {
                if (err instanceof AuraError) {
                    process.stderr.write(err.format() + '\n');
                } else {
                    process.stderr.write(String(err) + '\n');
                }
            }
            lineBuffer = '';
            braceDepth = 0;
            parenDepth = 0;
            indentLevel = 0;
            prompt();
        } else {
            prompt();
        }
    });

    rl.on('close', () => {
        process.stdout.write('\n');
        process.exit(0);
    });
}

function runCli(): number {
    const args = process.argv.slice(2);
    const cmd = args[0];
    const arg = args[1];
    const looksLikeAuraFile = (value: string): boolean => isAuraFile(value);
    try {
        if (cmd && !arg && looksLikeAuraFile(cmd)) {
            runFile(cmd);
            return 0;
        }
        if (!cmd) {
            runRepl();
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
            runFile(arg);
            return 0;
        }
        if (cmd === 'check') {
            if (!arg) {
                usage();
                return 2;
            }
            checkFile(arg);
            process.stdout.write(`OK ${resolvePath(process.cwd(), arg)}\n`);
            return 0;
        }
        if (cmd === 'test') {
            return runTests(arg);
        }
        if (cmd === 'repl') {
            runRepl();
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

