import { languageForPath } from "./languages.js";
const MAX_NAME = 256;
const IDENTIFIER = /identifier|name|selector|field_expression|scoped_/u;
const SPECIFIER_TYPES = /^(string|string_value|string_literal|system_lib_string|relative_import|dotted_name|scoped_identifier|scoped_type_identifier|use_wildcard|use_as_clause|use_list|namespace_name|namespace_use_clause|qualified_name|identifier)$/u;
export function extract(root, path) {
    const language = languageForPath(path);
    if (language === undefined)
        return { nodes: [], references: [] };
    const nodes = [];
    const references = [];
    walk(root, language, nodes, references, false);
    return { nodes, references };
}
function walk(node, language, nodes, references, insideType) {
    let kind = language.definitions[node.type];
    if (kind !== undefined) {
        if (kind === "function" && insideType)
            kind = "method";
        const name = nameOf(node);
        if (name !== null) {
            nodes.push({
                endLine: node.endPosition.row,
                kind,
                name,
                startLine: node.startPosition.row,
            });
        }
    }
    if (language.imports.includes(node.type)) {
        const target = moduleSpecifier(node);
        if (target !== null) {
            references.push({ kind: "imports", line: node.startPosition.row, target });
        }
    }
    if (language.calls.includes(node.type)) {
        const target = calleeName(node);
        if (target !== null) {
            references.push({ kind: "calls", line: node.startPosition.row, target });
        }
    }
    const nested = insideType || kind === "class" || kind === "interface";
    for (let index = 0; index < node.namedChildCount; index += 1) {
        const child = node.namedChild(index);
        if (child !== null)
            walk(child, language, nodes, references, nested);
    }
}
function nameOf(node) {
    const named = node.childForFieldName("name");
    if (named !== null)
        return bounded(named.text);
    const declarator = node.childForFieldName("declarator");
    if (declarator !== null) {
        const nested = nameOf(declarator);
        if (nested !== null)
            return nested;
        return bounded(declarator.text);
    }
    const selectors = node.childForFieldName("selectors");
    if (selectors !== null)
        return bounded(selectors.text);
    for (let index = 0; index < node.namedChildCount; index += 1) {
        const child = node.namedChild(index);
        if (child !== null && IDENTIFIER.test(child.type))
            return bounded(child.text);
    }
    return null;
}
function moduleSpecifier(node) {
    for (const field of ["source", "module_name", "path", "argument", "name"]) {
        const child = node.childForFieldName(field);
        if (child !== null)
            return bounded(stripQuotes(child.text));
    }
    for (let index = 0; index < node.namedChildCount; index += 1) {
        const child = node.namedChild(index);
        if (child === null)
            continue;
        if (SPECIFIER_TYPES.test(child.type))
            return bounded(stripQuotes(child.text));
    }
    return null;
}
function calleeName(node) {
    const callee = node.childForFieldName("function") ??
        node.childForFieldName("method") ??
        node.childForFieldName("constructor") ??
        node.childForFieldName("name") ??
        node.namedChild(0);
    if (callee === null)
        return null;
    const text = bounded(callee.text);
    return text === null ? null : (text.split(/[.:]|->/u).pop() ?? text) || null;
}
function stripQuotes(value) {
    return value.replace(/^["'`<]|["'`>];?$/gu, "").trim();
}
function bounded(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_NAME || trimmed.includes("\n"))
        return null;
    return trimmed;
}
