import { languageForPath, type LanguageSpec, type NodeKind } from "./languages.ts"

export interface ExtractedNode {
  readonly endLine: number
  readonly kind: NodeKind
  readonly name: string
  readonly startLine: number
}

export interface ExtractedReference {
  readonly kind: "calls" | "imports"
  readonly line: number
  /** The literal text as written: a module specifier for imports, a callee name for calls. */
  readonly target: string
}

export interface Extraction {
  readonly nodes: readonly ExtractedNode[]
  readonly references: readonly ExtractedReference[]
}

/** Minimal structural surface of a tree-sitter node, so this module needs no runtime import. */
export interface SyntaxNode {
  childForFieldName(field: string): SyntaxNode | null
  readonly endPosition: { row: number }
  namedChild(index: number): SyntaxNode | null
  readonly namedChildCount: number
  readonly startPosition: { row: number }
  readonly text: string
  readonly type: string
}

const MAX_NAME = 256
const IDENTIFIER = /identifier|name|selector|field_expression|scoped_/u

// An allowlist, not a text fallback: an unmatched import node yields no edge rather than an edge
// whose target is the whole statement.
const SPECIFIER_TYPES =
  /^(string|string_value|string_literal|system_lib_string|relative_import|dotted_name|scoped_identifier|scoped_type_identifier|use_wildcard|use_as_clause|use_list|namespace_name|namespace_use_clause|qualified_name|identifier)$/u

export function extract(root: SyntaxNode, path: string): Extraction {
  const language = languageForPath(path)
  if (language === undefined) return { nodes: [], references: [] }

  const nodes: ExtractedNode[] = []
  const references: ExtractedReference[] = []
  walk(root, language, nodes, references, false)
  return { nodes, references }
}

function walk(
  node: SyntaxNode,
  language: LanguageSpec,
  nodes: ExtractedNode[],
  references: ExtractedReference[],
  insideType: boolean,
): void {
  let kind = language.definitions[node.type]
  if (kind !== undefined) {
    // Grammars that use one node type for both, such as Python's function_definition, are
    // disambiguated by position rather than by type.
    if (kind === "function" && insideType) kind = "method"

    const name = nameOf(node)
    if (name !== null) {
      nodes.push({
        endLine: node.endPosition.row,
        kind,
        name,
        startLine: node.startPosition.row,
      })
    }
  }

  if (language.imports.includes(node.type)) {
    const target = moduleSpecifier(node)
    if (target !== null) {
      references.push({ kind: "imports", line: node.startPosition.row, target })
    }
  }

  if (language.calls.includes(node.type)) {
    const target = calleeName(node)
    if (target !== null) {
      references.push({ kind: "calls", line: node.startPosition.row, target })
    }
  }

  const nested = insideType || kind === "class" || kind === "interface"
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (child !== null) walk(child, language, nodes, references, nested)
  }
}

/**
 * Most grammars expose a `name` field. C and C++ nest it under `declarator`, and CSS rule sets
 * name themselves by their selector, so both get an explicit fallback rather than a guess.
 */
function nameOf(node: SyntaxNode): string | null {
  const named = node.childForFieldName("name")
  if (named !== null) return bounded(named.text)

  const declarator = node.childForFieldName("declarator")
  if (declarator !== null) {
    const nested = nameOf(declarator)
    if (nested !== null) return nested
    return bounded(declarator.text)
  }

  const selectors = node.childForFieldName("selectors")
  if (selectors !== null) return bounded(selectors.text)

  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (child !== null && IDENTIFIER.test(child.type)) return bounded(child.text)
  }

  return null
}

/**
 * Returns null rather than falling back to the node's own text. `export function f() {}` is an
 * export_statement with no source, and a text fallback would record the whole statement as a
 * module specifier.
 */
function moduleSpecifier(node: SyntaxNode): string | null {
  for (const field of ["source", "module_name", "path", "argument", "name"]) {
    const child = node.childForFieldName(field)
    if (child !== null) return bounded(stripQuotes(child.text))
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (child === null) continue
    if (SPECIFIER_TYPES.test(child.type)) return bounded(stripQuotes(child.text))
  }

  return null
}

function calleeName(node: SyntaxNode): string | null {
  const callee =
    node.childForFieldName("function") ??
    node.childForFieldName("method") ??
    node.childForFieldName("constructor") ??
    node.childForFieldName("name") ??
    node.namedChild(0)
  if (callee === null) return null

  // A qualified callee such as `a.b.c()` is attributed to its final segment: that is the symbol a
  // definition elsewhere can actually match.
  const text = bounded(callee.text)
  return text === null ? null : (text.split(/[.:]|->/u).pop() ?? text) || null
}

function stripQuotes(value: string): string {
  return value.replace(/^["'`<]|["'`>];?$/gu, "").trim()
}

function bounded(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_NAME || trimmed.includes("\n")) return null
  return trimmed
}
