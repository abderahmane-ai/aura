declare function require(name: string): any;
const vscode: any = require('vscode');
const fs: any = require('fs');
const path: any = require('path');

type AuraType =
    | 'string'
    | 'list'
    | 'option'
    | 'result'
    | 'indexed'
    | 'stack'
    | 'queue'
    | 'linked_list'
    | 'hashmap'
    | 'tree'
    | 'heap'
    | 'instance'
    | 'unknown';

interface MethodSpec {
    name: string;
    detail: string;
    snippet?: string;
    doc?: string;
}

interface ImportPathInfo {
    modulePath: string;
    alias?: string;
    pathStart: number;
    pathEnd: number;
}

const KEYWORD_DOCS: Record<string, string> = {
    let: 'Declare an immutable binding.',
    var: 'Declare a mutable binding.',
    fn: 'Define a function.',
    class: 'Define a class.',
    interface: 'Define an interface contract.',
    trait: 'Define reusable methods for impl blocks.',
    impl: 'Implement trait methods for a class.',
    if: 'Conditional branch.',
    elif: 'Secondary conditional branch.',
    else: 'Fallback branch.',
    while: 'Loop while condition is truthy.',
    for: 'Iterate over ranges and collections.',
    repeat: 'Aura counted loop; optional `as` index alias.',
    cadence: 'Context-aware loop with phase hooks.',
    start: 'Cadence phase: runs once before non-empty iteration.',
    first: 'Cadence phase: runs only on first item.',
    each: 'Cadence phase: runs for every item.',
    between: 'Cadence phase: runs between items.',
    last: 'Cadence phase: runs only on last item.',
    empty: 'Cadence phase: runs only for empty input.',
    match: 'Pattern-match an enum or literal value.',
    case: 'A single match arm.',
    return: 'Return from function.',
    break: 'Exit nearest loop.',
    continue: 'Skip to next loop iteration.',
    constraint: 'Define validated type rules via require clauses.',
    require: 'A rule inside a constraint declaration.',
    unit: 'Define unit symbols and conversion factors.',
    measure: 'Typed numeric value bound to a unit dimension.',
    facet: 'Define a reusable role/capability bundle.',
    adopts: 'Attach a facet to a class.',
    as: 'Activate facet context for an object in a block.',
    indexed: 'Create a collection with automatic key indexes.',
    by: 'Declare index keys for an indexed collection.',
};

const BUILTIN_FUNCTIONS = [
    'print', 'len', 'min', 'max', 'str', 'int', 'float', 'abs', 'sqrt', 'range',
    'to_list', 'sum', 'sort', 'unique', 'top_k', 'freq', 'chunk', 'window', 'take', 'drop',
    'panic', 'is_some', 'is_none', 'is_ok', 'is_err',
];

const BUILTIN_CONSTRUCTORS = [
    'List', 'Stack', 'Queue', 'LinkedList', 'HashMap', 'TreeMap', 'Heap', 'Indexed',
    'Option', 'Some', 'None', 'Result', 'Ok', 'Err',
];

const TOP_LEVEL_SNIPPETS: Array<{ label: string; detail: string; insert: string; kind: any; doc?: string }> = [
    {
        label: 'fn',
        detail: 'Function declaration',
        insert: 'fn ${1:name}(${2:params})${3: -> ReturnType}:\n    ${0}',
        kind: vscode.CompletionItemKind.Snippet,
    },
    {
        label: 'class',
        detail: 'Class declaration',
        insert: 'class ${1:Name}:\n    ${0}',
        kind: vscode.CompletionItemKind.Snippet,
    },
    {
        label: 'repeat',
        detail: 'Aura counted loop',
        insert: 'repeat ${1:count} as ${2:i}:\n    ${0}',
        kind: vscode.CompletionItemKind.Snippet,
    },
    {
        label: 'cadence',
        detail: 'Aura context-aware loop',
        insert:
            'cadence ${1:item} in ${2:collection}:\n' +
            '    each:\n' +
            '        ${3}\n' +
            '    empty:\n' +
            '        ${0}',
        kind: vscode.CompletionItemKind.Snippet,
    },
    {
        label: 'constraint',
        detail: 'Constraint declaration',
        insert:
            'constraint ${1:TypeName}(value: ${2:Float64}):\n' +
            '    require ${3:value >= 0}\n' +
            '    ${0}',
        kind: vscode.CompletionItemKind.Snippet,
    },
    {
        label: 'unit',
        detail: 'Unit declaration',
        insert:
            'unit ${1:Dimension}:\n' +
            '    base: ${2:base_unit}\n' +
            '    ${3:alias} = ${2:base_unit} * ${4:1000}\n' +
            '    ${0}',
        kind: vscode.CompletionItemKind.Snippet,
    },
    {
        label: 'facet',
        detail: 'Facet declaration',
        insert: 'facet ${1:RoleName}:\n    ${0}',
        kind: vscode.CompletionItemKind.Snippet,
    },
    {
        label: 'indexed',
        detail: 'Indexed collection declaration',
        insert:
            'indexed ${1:items} by ${2:id}, ${3:email}\n' +
            '${1:items}.push({${2:id}: ${4:1}, ${3:email}: "${5:user@test.com}"})\n' +
            '${0}',
        kind: vscode.CompletionItemKind.Snippet,
    },
];

const CADENCE_CLAUSE_SNIPPETS = ['start', 'first', 'each', 'between', 'last', 'empty'];

const TYPE_METHODS: Record<AuraType, MethodSpec[]> = {
    string: [
        { name: 'len', detail: 'string.len() -> Int', doc: 'Length of the string.' },
        { name: 'is_empty', detail: 'string.is_empty() -> Bool', doc: 'True when string has length 0.' },
        { name: 'upper', detail: 'string.upper() -> String', doc: 'Upper-case copy.' },
        { name: 'lower', detail: 'string.lower() -> String', doc: 'Lower-case copy.' },
        { name: 'trim', detail: 'string.trim() -> String', doc: 'Trim leading/trailing whitespace.' },
        { name: 'split', detail: 'string.split(sep, limit?) -> List', snippet: 'split(${1:sep}${2:, ${3:limit}})' },
        { name: 'contains', detail: 'string.contains(substr) -> Bool', snippet: 'contains(${1:substr})' },
        { name: 'starts_with', detail: 'string.starts_with(prefix) -> Bool', snippet: 'starts_with(${1:prefix})' },
        { name: 'ends_with', detail: 'string.ends_with(suffix) -> Bool', snippet: 'ends_with(${1:suffix})' },
        { name: 'index_of', detail: 'string.index_of(substr) -> Int', snippet: 'index_of(${1:substr})' },
        { name: 'last_index_of', detail: 'string.last_index_of(substr) -> Int', snippet: 'last_index_of(${1:substr})' },
        { name: 'replace', detail: 'string.replace(from, to) -> String', snippet: 'replace(${1:from}, ${2:to})' },
        { name: 'repeat', detail: 'string.repeat(n) -> String', snippet: 'repeat(${1:n})' },
        { name: 'slice', detail: 'string.slice(start, end?) -> String', snippet: 'slice(${1:start}${2:, ${3:end}})' },
        { name: 'char_at', detail: 'string.char_at(index) -> String|nil', snippet: 'char_at(${1:index})' },
        { name: 'chars', detail: 'string.chars() -> List' },
        { name: 'lines', detail: 'string.lines() -> List' },
        { name: 'pad_left', detail: 'string.pad_left(width, fill?) -> String', snippet: 'pad_left(${1:width}${2:, ${3:" "}})' },
        { name: 'pad_right', detail: 'string.pad_right(width, fill?) -> String', snippet: 'pad_right(${1:width}${2:, ${3:" "}})' },
        { name: 'join', detail: 'string.join(collection) -> String', snippet: 'join(${1:items})' },
        { name: 'title', detail: 'string.title() -> String' },
        { name: 'words', detail: 'string.words() -> List' },
        { name: 'camel_case', detail: 'string.camel_case() -> String' },
        { name: 'snake_case', detail: 'string.snake_case() -> String' },
        { name: 'kebab_case', detail: 'string.kebab_case() -> String' },
        { name: 'remove_prefix', detail: 'string.remove_prefix(prefix) -> String', snippet: 'remove_prefix(${1:prefix})' },
        { name: 'remove_suffix', detail: 'string.remove_suffix(suffix) -> String', snippet: 'remove_suffix(${1:suffix})' },
    ],
    option: [
        { name: 'tag', detail: 'option.tag() -> String' },
        { name: 'values', detail: 'option.values() -> List' },
        { name: 'is_some', detail: 'option.is_some() -> Bool' },
        { name: 'is_none', detail: 'option.is_none() -> Bool' },
        { name: 'unwrap', detail: 'option.unwrap() -> Value' },
        { name: 'unwrap_or', detail: 'option.unwrap_or(fallback) -> Value', snippet: 'unwrap_or(${1:fallback})' },
        { name: 'expect', detail: 'option.expect(message) -> Value', snippet: 'expect(${1:"message"})' },
        { name: 'map', detail: 'option.map(fn) -> Option', snippet: 'map(${1:fn(x) = x})' },
        { name: 'and_then', detail: 'option.and_then(fn) -> Option', snippet: 'and_then(${1:fn(x) = Some(x)})' },
        { name: 'filter', detail: 'option.filter(fn) -> Option', snippet: 'filter(${1:fn(x) = true})' },
        { name: 'ok_or', detail: 'option.ok_or(err) -> Result', snippet: 'ok_or(${1:error})' },
        { name: 'or', detail: 'option.or(value) -> Option', snippet: 'or(${1:value})' },
        { name: 'tap', detail: 'option.tap(fn) -> Option', snippet: 'tap(${1:fn(x) = io.println(x)})' },
        { name: 'or_else', detail: 'option.or_else(fn) -> Option', snippet: 'or_else(${1:fn() = Some(value)})' },
    ],
    result: [
        { name: 'tag', detail: 'result.tag() -> String' },
        { name: 'values', detail: 'result.values() -> List' },
        { name: 'is_ok', detail: 'result.is_ok() -> Bool' },
        { name: 'is_err', detail: 'result.is_err() -> Bool' },
        { name: 'unwrap', detail: 'result.unwrap() -> Value' },
        { name: 'unwrap_err', detail: 'result.unwrap_err() -> Value' },
        { name: 'unwrap_or', detail: 'result.unwrap_or(fallback) -> Value', snippet: 'unwrap_or(${1:fallback})' },
        { name: 'expect', detail: 'result.expect(message) -> Value', snippet: 'expect(${1:"message"})' },
        { name: 'map', detail: 'result.map(fn) -> Result', snippet: 'map(${1:fn(x) = x})' },
        { name: 'map_err', detail: 'result.map_err(fn) -> Result', snippet: 'map_err(${1:fn(e) = e})' },
        { name: 'and_then', detail: 'result.and_then(fn) -> Result', snippet: 'and_then(${1:fn(x) = Ok(x)})' },
        { name: 'tap', detail: 'result.tap(fn) -> Result', snippet: 'tap(${1:fn(v) = io.println(v)})' },
        { name: 'tap_err', detail: 'result.tap_err(fn) -> Result', snippet: 'tap_err(${1:fn(e) = io.println(e)})' },
        { name: 'recover', detail: 'result.recover(fn) -> Result', snippet: 'recover(${1:fn(e) = 0})' },
        { name: 'to_option', detail: 'result.to_option() -> Option' },
        { name: 'or_else', detail: 'result.or_else(fn) -> Result', snippet: 'or_else(${1:fn(e) = Ok(value)})' },
    ],
    list: [
        { name: 'len', detail: 'list.len() -> Int' },
        { name: 'first', detail: 'list.first() -> Value|nil' },
        { name: 'last', detail: 'list.last() -> Value|nil' },
        { name: 'is_empty', detail: 'list.is_empty() -> Bool' },
        { name: 'pop', detail: 'list.pop() -> Value|nil' },
        { name: 'clear', detail: 'list.clear()' },
        { name: 'to_list', detail: 'list.to_list() -> List' },
        { name: 'sum', detail: 'list.sum() -> Number' },
        { name: 'append', detail: 'list.append(value)', snippet: 'append(${1:value})' },
        { name: 'push', detail: 'list.push(value)', snippet: 'push(${1:value})' },
        { name: 'map', detail: 'list.map(fn) -> List', snippet: 'map(${1:fn(x) = x})' },
        { name: 'filter', detail: 'list.filter(fn) -> List', snippet: 'filter(${1:fn(x) = true})' },
        { name: 'reduce', detail: 'list.reduce(fn, init) -> Value', snippet: 'reduce(${1:fn(acc, x) = acc}, ${2:init})' },
        { name: 'flat_map', detail: 'list.flat_map(fn) -> List', snippet: 'flat_map(${1:fn(x) = [x]})' },
        { name: 'flatten', detail: 'list.flatten(depth?) -> List', snippet: 'flatten(${1:1})' },
        { name: 'find', detail: 'list.find(fn) -> Value|nil', snippet: 'find(${1:fn(x) = true})' },
        { name: 'find_index', detail: 'list.find_index(fn) -> Int', snippet: 'find_index(${1:fn(x) = true})' },
        { name: 'any', detail: 'list.any(fn) -> Bool', snippet: 'any(${1:fn(x) = true})' },
        { name: 'all', detail: 'list.all(fn) -> Bool', snippet: 'all(${1:fn(x) = true})' },
        { name: 'count', detail: 'list.count(fn) -> Int', snippet: 'count(${1:fn(x) = true})' },
        { name: 'group_by', detail: 'list.group_by(fn) -> Map', snippet: 'group_by(${1:fn(x) = x})' },
        { name: 'key_by', detail: 'list.key_by(fn) -> Map', snippet: 'key_by(${1:fn(x) = x})' },
        { name: 'sort_by', detail: 'list.sort_by(fn) -> List', snippet: 'sort_by(${1:fn(x) = x})' },
        { name: 'min_by', detail: 'list.min_by(fn) -> Value|nil', snippet: 'min_by(${1:fn(x) = x})' },
        { name: 'max_by', detail: 'list.max_by(fn) -> Value|nil', snippet: 'max_by(${1:fn(x) = x})' },
        { name: 'zip', detail: 'list.zip(other) -> List', snippet: 'zip(${1:other})' },
        { name: 'enumerate', detail: 'list.enumerate() -> List' },
    ],
    indexed: [
        { name: 'len', detail: 'indexed.len() -> Int' },
        { name: 'is_empty', detail: 'indexed.is_empty() -> Bool' },
        { name: 'keys', detail: 'indexed.keys() -> List' },
        { name: 'to_list', detail: 'indexed.to_list() -> List' },
        { name: 'clear', detail: 'indexed.clear()' },
        { name: 'push', detail: 'indexed.push(item)', snippet: 'push(${1:item})' },
        { name: 'append', detail: 'indexed.append(item)', snippet: 'append(${1:item})' },
        { name: 'get', detail: 'indexed.get(key) -> item|nil', snippet: 'get(${1:key})' },
        { name: 'get_by', detail: 'indexed.get_by(field, key) -> item|nil', snippet: 'get_by("${1:field}", ${2:key})' },
        { name: 'has', detail: 'indexed.has(key) -> Bool', snippet: 'has(${1:key})' },
        { name: 'has_by', detail: 'indexed.has_by(field, key) -> Bool', snippet: 'has_by("${1:field}", ${2:key})' },
        { name: 'set_by', detail: 'indexed.set_by(field, key, target_field, value)', snippet: 'set_by("${1:field}", ${2:key}, "${3:target_field}", ${4:value})' },
        { name: 'remove_by', detail: 'indexed.remove_by(field, key) -> item|nil', snippet: 'remove_by("${1:field}", ${2:key})' },
        { name: 'reindex', detail: 'indexed.reindex()' },
    ],
    stack: [
        { name: 'len', detail: 'stack.len() -> Int' },
        { name: 'is_empty', detail: 'stack.is_empty() -> Bool' },
        { name: 'peek', detail: 'stack.peek() -> Value|nil' },
        { name: 'pop', detail: 'stack.pop() -> Value|nil' },
        { name: 'clear', detail: 'stack.clear()' },
        { name: 'to_list', detail: 'stack.to_list() -> List' },
        { name: 'push', detail: 'stack.push(value)', snippet: 'push(${1:value})' },
    ],
    queue: [
        { name: 'len', detail: 'queue.len() -> Int' },
        { name: 'is_empty', detail: 'queue.is_empty() -> Bool' },
        { name: 'peek', detail: 'queue.peek() -> Value|nil' },
        { name: 'dequeue', detail: 'queue.dequeue() -> Value|nil' },
        { name: 'pop', detail: 'queue.pop() -> Value|nil' },
        { name: 'clear', detail: 'queue.clear()' },
        { name: 'to_list', detail: 'queue.to_list() -> List' },
        { name: 'enqueue', detail: 'queue.enqueue(value)', snippet: 'enqueue(${1:value})' },
        { name: 'push', detail: 'queue.push(value)', snippet: 'push(${1:value})' },
    ],
    linked_list: [
        { name: 'len', detail: 'linked_list.len() -> Int' },
        { name: 'is_empty', detail: 'linked_list.is_empty() -> Bool' },
        { name: 'front', detail: 'linked_list.front() -> Value|nil' },
        { name: 'back', detail: 'linked_list.back() -> Value|nil' },
        { name: 'pop_front', detail: 'linked_list.pop_front() -> Value|nil' },
        { name: 'pop_back', detail: 'linked_list.pop_back() -> Value|nil' },
        { name: 'clear', detail: 'linked_list.clear()' },
        { name: 'to_list', detail: 'linked_list.to_list() -> List' },
        { name: 'push_front', detail: 'linked_list.push_front(value)', snippet: 'push_front(${1:value})' },
        { name: 'push_back', detail: 'linked_list.push_back(value)', snippet: 'push_back(${1:value})' },
        { name: 'push', detail: 'linked_list.push(value)', snippet: 'push(${1:value})' },
        { name: 'get', detail: 'linked_list.get(index)', snippet: 'get(${1:index})' },
        { name: 'set', detail: 'linked_list.set(index, value)', snippet: 'set(${1:index}, ${2:value})' },
        { name: 'insert', detail: 'linked_list.insert(index, value)', snippet: 'insert(${1:index}, ${2:value})' },
        { name: 'remove', detail: 'linked_list.remove(index)', snippet: 'remove(${1:index})' },
    ],
    hashmap: [
        { name: 'len', detail: 'hashmap.len() -> Int' },
        { name: 'clear', detail: 'hashmap.clear()' },
        { name: 'keys', detail: 'hashmap.keys() -> List' },
        { name: 'values', detail: 'hashmap.values() -> List' },
        { name: 'items', detail: 'hashmap.items() -> List' },
        { name: 'get', detail: 'hashmap.get(key, fallback?)', snippet: 'get(${1:key}, ${2:fallback})' },
        { name: 'set', detail: 'hashmap.set(key, value)', snippet: 'set(${1:key}, ${2:value})' },
        { name: 'has', detail: 'hashmap.has(key) -> Bool', snippet: 'has(${1:key})' },
        { name: 'delete', detail: 'hashmap.delete(key)', snippet: 'delete(${1:key})' },
        { name: 'merge', detail: 'hashmap.merge(other)', snippet: 'merge(${1:other})' },
    ],
    tree: [
        { name: 'len', detail: 'tree.len() -> Int' },
        { name: 'clear', detail: 'tree.clear()' },
        { name: 'keys', detail: 'tree.keys() -> List (sorted)' },
        { name: 'values', detail: 'tree.values() -> List (sorted)' },
        { name: 'items', detail: 'tree.items() -> List (sorted)' },
        { name: 'get', detail: 'tree.get(key, fallback?)', snippet: 'get(${1:key}, ${2:fallback})' },
        { name: 'set', detail: 'tree.set(key, value)', snippet: 'set(${1:key}, ${2:value})' },
        { name: 'has', detail: 'tree.has(key) -> Bool', snippet: 'has(${1:key})' },
        { name: 'delete', detail: 'tree.delete(key)', snippet: 'delete(${1:key})' },
        { name: 'merge', detail: 'tree.merge(other)', snippet: 'merge(${1:other})' },
    ],
    heap: [
        { name: 'len', detail: 'heap.len() -> Int' },
        { name: 'is_empty', detail: 'heap.is_empty() -> Bool' },
        { name: 'peek', detail: 'heap.peek() -> Value|nil' },
        { name: 'pop', detail: 'heap.pop() -> Value|nil' },
        { name: 'clear', detail: 'heap.clear()' },
        { name: 'to_list', detail: 'heap.to_list() -> List' },
        { name: 'push', detail: 'heap.push(value)', snippet: 'push(${1:value})' },
    ],
    instance: [
        { name: 'with', detail: 'instance.with(field, value)', snippet: 'with("${1:field}", ${2:value})' },
        { name: 'clone', detail: 'instance.clone() -> instance' },
    ],
    unknown: [
        { name: 'len', detail: 'len()' },
        { name: 'to_list', detail: 'to_list()' },
    ],
};

export function activate(context: any): void {
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        { language: 'aura' },
        {
            provideCompletionItems(document: any, position: any): any[] {
                return provideAuraCompletions(document, position);
            },
        },
        '.',
        ':',
    );

    const hoverProvider = vscode.languages.registerHoverProvider({ language: 'aura' }, {
        provideHover(document: any, position: any): any {
            const importHover = provideImportHover(document, position);
            if (importHover) return importHover;

            const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
            if (!range) return undefined;
            const word = document.getText(range);
            const doc = KEYWORD_DOCS[word];
            if (!doc) return undefined;
            return new vscode.Hover(new vscode.MarkdownString(`**${word}**\n\n${doc}`), range);
        },
    });

    const definitionProvider = vscode.languages.registerDefinitionProvider({ language: 'aura' }, {
        provideDefinition(document: any, position: any): any {
            const resolved = resolveImportDefinition(document, position);
            if (!resolved) return undefined;
            const uri = vscode.Uri.file(resolved);
            return new vscode.Location(uri, new vscode.Position(0, 0));
        },
    });

    const documentLinkProvider = vscode.languages.registerDocumentLinkProvider({ language: 'aura' }, {
        provideDocumentLinks(document: any): any[] {
            return buildImportDocumentLinks(document);
        },
    });

    context.subscriptions.push(completionProvider, hoverProvider, definitionProvider, documentLinkProvider);
}

function provideAuraCompletions(document: any, position: any): any[] {
    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);
    if (before.includes('#')) return [];
    if (isInsideString(before)) return [];

    const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z0-9_]*$/.exec(before);
    if (dotMatch) {
        const receiver = dotMatch[1];
        return completionForReceiver(document, position.line, receiver);
    }

    const items: any[] = [];

    for (const k of Object.keys(KEYWORD_DOCS)) {
        items.push(makeSimpleCompletion(k, vscode.CompletionItemKind.Keyword, 'Aura keyword', '30'));
    }

    for (const f of BUILTIN_FUNCTIONS) {
        const c = makeSimpleCompletion(f, vscode.CompletionItemKind.Function, 'Builtin function', '20');
        c.insertText = new vscode.SnippetString(`${f}(${f === 'print' ? '${1:value}' : ''})`);
        c.commitCharacters = ['('];
        items.push(c);
    }

    for (const ctor of BUILTIN_CONSTRUCTORS) {
        const c = makeSimpleCompletion(ctor, vscode.CompletionItemKind.Constructor, 'Builtin constructor', '21');
        c.insertText = new vscode.SnippetString(`${ctor}(${ctor === 'Indexed' ? '${1:["id","email"]}${2:, ${3:items}}' : '${1}'})`);
        c.commitCharacters = ['('];
        items.push(c);
    }

    for (const snippet of TOP_LEVEL_SNIPPETS) {
        const c = makeSimpleCompletion(snippet.label, snippet.kind, snippet.detail, '10');
        c.insertText = new vscode.SnippetString(snippet.insert);
        c.preselect = snippet.label === 'fn';
        if (snippet.doc) c.documentation = new vscode.MarkdownString(snippet.doc);
        items.push(c);
    }

    if (isCadenceClauseContext(document, position)) {
        for (const clause of CADENCE_CLAUSE_SNIPPETS) {
            const c = makeSimpleCompletion(clause, vscode.CompletionItemKind.Keyword, 'Cadence clause', '05');
            c.insertText = new vscode.SnippetString(`${clause}:\n    ${0}`);
            items.push(c);
        }
    }

    return dedupe(items);
}

function completionForReceiver(document: any, line: number, receiver: string): any[] {
    if (receiver === 'io') {
        return [
            makeMethodCompletion('println', 'io.println(value)', 'println(${1:value})'),
            makeMethodCompletion('print', 'io.print(value)', 'print(${1:value})'),
        ];
    }

    const inferred = inferTypeForName(document, line, receiver);
    if (inferred === 'unknown') return [];
    const methods = TYPE_METHODS[inferred] ?? TYPE_METHODS.unknown;
    return methods.map((m) => makeMethodCompletion(m.name, m.detail, m.snippet, m.doc));
}

function inferTypeForName(document: any, line: number, name: string): AuraType {
    const known = new Map<string, AuraType>();

    for (let i = 0; i <= line; i++) {
        const raw = document.lineAt(i).text;
        const text = raw.replace(/#.*$/, '').trim();
        if (!text) continue;

        const indexedDecl = /^indexed\s+([A-Za-z_][A-Za-z0-9_]*)\s+by\b/.exec(text);
        if (indexedDecl) {
            known.set(indexedDecl[1], 'indexed');
            continue;
        }

        const decl = /^(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([^=]+))?(?:\s*=\s*(.+))?$/.exec(text);
        if (!decl) continue;

        const varName = decl[1];
        const typeAnn = (decl[2] ?? '').trim();
        const rhs = (decl[3] ?? '').trim();

        const byAnn = inferFromTypeAnn(typeAnn);
        let byRhs = inferFromRhs(rhs);
        if (!byRhs) {
            const rhsName = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(rhs);
            if (rhsName) byRhs = known.get(rhsName[1]);
        }
        known.set(varName, byRhs ?? byAnn ?? 'unknown');
    }

    return known.get(name) ?? 'unknown';
}

function inferFromTypeAnn(typeAnn: string): AuraType | undefined {
    if (!typeAnn) return undefined;
    if (/String\b/.test(typeAnn)) return 'string';
    if (/List\b/.test(typeAnn)) return 'list';
    if (/Option\b/.test(typeAnn)) return 'option';
    if (/Result\b/.test(typeAnn)) return 'result';
    if (/Indexed\b/.test(typeAnn)) return 'indexed';
    if (/Stack\b/.test(typeAnn)) return 'stack';
    if (/Queue\b/.test(typeAnn)) return 'queue';
    if (/LinkedList\b/.test(typeAnn)) return 'linked_list';
    if (/HashMap\b/.test(typeAnn)) return 'hashmap';
    if (/TreeMap\b/.test(typeAnn)) return 'tree';
    if (/Heap\b/.test(typeAnn)) return 'heap';
    return undefined;
}

function inferFromRhs(rhs: string): AuraType | undefined {
    if (!rhs) return undefined;
    if (/^".*"$/.test(rhs) || /^'.*'$/.test(rhs)) return 'string';
    if (/^\[/.test(rhs)) return 'list';
    if (/^(Some|None|Option)\s*\(/.test(rhs)) return 'option';
    if (/^(Ok|Err|Result)\s*\(/.test(rhs)) return 'result';
    if (/^\{/.test(rhs)) return 'unknown';
    if (/^Stack\s*\(/.test(rhs)) return 'stack';
    if (/^Queue\s*\(/.test(rhs)) return 'queue';
    if (/^LinkedList\s*\(/.test(rhs)) return 'linked_list';
    if (/^HashMap\s*\(/.test(rhs)) return 'hashmap';
    if (/^TreeMap\s*\(/.test(rhs)) return 'tree';
    if (/^Heap\s*\(/.test(rhs)) return 'heap';
    if (/^Indexed\s*\(/.test(rhs)) return 'indexed';
    if (/^[A-Z][A-Za-z0-9_]*\s*\(/.test(rhs)) return 'instance';
    return undefined;
}

function isCadenceClauseContext(document: any, position: any): boolean {
    const current = document.lineAt(position.line).text;
    const before = current.slice(0, position.character).trim();
    if (!/^(|start|first|each|between|last|empty)$/.test(before)) return false;

    const currentIndent = indentation(current);
    for (let i = position.line - 1; i >= 0; i--) {
        const text = document.lineAt(i).text;
        const trimmed = text.trim();
        if (!trimmed) continue;

        const indent = indentation(text);
        if (indent < currentIndent && /^cadence\b/.test(trimmed)) return true;
        if (indent < currentIndent && /^(fn|class|trait|interface|impl|if|for|while|match)\b/.test(trimmed)) return false;
    }

    return false;
}

function indentation(line: string): number {
    const m = /^(\s*)/.exec(line);
    return m ? m[1].length : 0;
}

function isInsideString(before: string): boolean {
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    for (const ch of before) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '"' && !inSingle) inDouble = !inDouble;
        if (ch === '\'' && !inDouble) inSingle = !inSingle;
    }
    return inSingle || inDouble;
}

function provideImportHover(document: any, position: any): any {
    const lineText = document.lineAt(position.line).text;
    const info = parseImportPathInfo(lineText);
    if (!info) return undefined;
    if (position.character < info.pathStart || position.character > info.pathEnd) return undefined;

    const resolved = resolveAuraImport(document.uri.fsPath, info.modulePath);
    const md = new vscode.MarkdownString(
        resolved
            ? `**Module** \`${info.modulePath}\`\n\nResolves to \`${resolved}\`.\n\nUse *Go to Definition* (Shift+Enter / F12 in supported IDEs).`
            : `**Module** \`${info.modulePath}\`\n\nModule file not found from current workspace.`,
    );
    return new vscode.Hover(md, new vscode.Range(position.line, info.pathStart, position.line, info.pathEnd));
}

function resolveImportDefinition(document: any, position: any): string | undefined {
    const lineText = document.lineAt(position.line).text;
    const info = parseImportPathInfo(lineText);
    if (info && position.character >= info.pathStart && position.character <= info.pathEnd) {
        return resolveAuraImport(document.uri.fsPath, info.modulePath);
    }

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    const aliasMap = collectImportAliases(document, position.line);
    const modulePath = aliasMap.get(word);
    if (!modulePath) return undefined;
    return resolveAuraImport(document.uri.fsPath, modulePath);
}

function buildImportDocumentLinks(document: any): any[] {
    const links: any[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        const lineText = document.lineAt(i).text;
        const info = parseImportPathInfo(lineText);
        if (!info) continue;
        const resolved = resolveAuraImport(document.uri.fsPath, info.modulePath);
        if (!resolved) continue;
        const range = new vscode.Range(i, info.pathStart, i, info.pathEnd);
        const link = new vscode.DocumentLink(range, vscode.Uri.file(resolved));
        link.tooltip = `Open ${info.modulePath}`;
        links.push(link);
    }
    return links;
}

function collectImportAliases(document: any, upToLine: number): Map<string, string> {
    const aliases = new Map<string, string>();
    for (let i = 0; i <= upToLine; i++) {
        const text = document.lineAt(i).text;
        const info = parseImportPathInfo(text);
        if (!info) continue;
        const fallback = info.modulePath.split('.').pop() ?? info.modulePath;
        aliases.set(info.alias ?? fallback, info.modulePath);
    }
    return aliases;
}

function parseImportPathInfo(lineText: string): ImportPathInfo | undefined {
    const noComment = lineText.replace(/#.*$/, '');
    const m = /^\s*import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/.exec(noComment);
    if (!m) return undefined;
    const modulePath = m[1];
    const alias = m[2];
    const pathStart = noComment.indexOf(modulePath);
    if (pathStart < 0) return undefined;
    return {
        modulePath,
        alias,
        pathStart,
        pathEnd: pathStart + modulePath.length,
    };
}

function resolveAuraImport(fromFile: string, modulePath: string): string | undefined {
    const fromDir = path.dirname(fromFile);
    if (modulePath.startsWith('std.')) {
        const stdRel = modulePath.slice('std.'.length).split('.').join(path.sep) + '.aura';
        const fromUp = findStdlibByWalkingUp(fromDir, stdRel);
        if (fromUp) return fromUp;
        for (const root of workspaceRoots()) {
            const candidate = path.resolve(root, 'stdlib', stdRel);
            if (fs.existsSync(candidate)) return candidate;
        }
    }

    const rel = modulePath.split('.').join(path.sep) + '.aura';
    const localCandidate = path.resolve(fromDir, rel);
    if (fs.existsSync(localCandidate)) return localCandidate;
    for (const root of workspaceRoots()) {
        const candidate = path.resolve(root, rel);
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

function findStdlibByWalkingUp(startDir: string, stdRel: string): string | undefined {
    let cur = path.resolve(startDir);
    while (true) {
        const candidate = path.resolve(cur, 'stdlib', stdRel);
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    return undefined;
}

function workspaceRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.map((f: any) => f.uri.fsPath);
}

function makeSimpleCompletion(label: string, kind: any, detail: string, sortGroup = '50'): any {
    const item = new vscode.CompletionItem(label, kind);
    item.detail = detail;
    item.documentation = KEYWORD_DOCS[label] ? new vscode.MarkdownString(KEYWORD_DOCS[label]) : undefined;
    item.sortText = `${sortGroup}_${label}`;
    return item;
}

function makeMethodCompletion(name: string, detail: string, snippet?: string, doc?: string): any {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
    item.detail = detail;
    item.insertText = new vscode.SnippetString(snippet ?? `${name}()`);
    item.documentation = new vscode.MarkdownString(doc ?? detail);
    item.sortText = `0_${name}`;
    return item;
}

function dedupe(items: any[]): any[] {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const item of items) {
        const key = `${item.label}|${item.detail ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

export function deactivate(): void {
    // no-op
}
