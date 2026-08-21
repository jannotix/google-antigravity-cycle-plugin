import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { extract, type Extraction, type SyntaxNode } from "./extract.ts"
import { languageForPath, type LanguageSpec } from "./languages.ts"

const VENDOR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor")
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

interface TreeSitterParser {
  parse(source: string): { rootNode: SyntaxNode } | null
  setLanguage(language: unknown): void
}

interface TreeSitterModule {
  readonly Language: { load(bytes: Uint8Array): Promise<unknown> }
  readonly Parser: {
    init(options: { locateFile(): string }): Promise<void>
    new (): TreeSitterParser
  }
}

let runtime: Promise<TreeSitterModule> | undefined
const grammars = new Map<string, Promise<unknown>>()
const parsers = new Map<string, TreeSitterParser>()

/**
 * The vendored runtime is a UMD bundle that reads `__filename`, so it is loaded through
 * createRequire as CommonJS rather than imported as ESM.
 */
function loadRuntime(): Promise<TreeSitterModule> {
  runtime ??= (async () => {
    const required = createRequire(import.meta.url)
    const module = required(join(VENDOR, "runtime", "tree-sitter.cjs")) as TreeSitterModule
    await module.Parser.init({ locateFile: () => join(VENDOR, "runtime", "tree-sitter.wasm") })
    return module
  })()
  return runtime
}

async function parserFor(language: LanguageSpec): Promise<TreeSitterParser> {
  const existing = parsers.get(language.id)
  if (existing !== undefined) return existing

  const module = await loadRuntime()
  let grammar = grammars.get(language.id)
  if (grammar === undefined) {
    grammar = readFile(join(VENDOR, "grammars", language.wasm)).then((bytes) =>
      module.Language.load(bytes),
    )
    grammars.set(language.id, grammar)
  }

  const parser = new module.Parser()
  parser.setLanguage(await grammar)
  parsers.set(language.id, parser)
  return parser
}

export interface ParseResult extends Extraction {
  readonly language: string
  readonly path: string
}

export type ParseOutcome =
  | ParseResult
  | { readonly path: string; readonly reason: string; readonly skipped: true }

export async function parseSource(path: string, source: string): Promise<ParseOutcome> {
  const language = languageForPath(path)
  if (language === undefined) return { path, reason: "unsupported language", skipped: true }
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    return { path, reason: "source exceeds the parse size limit", skipped: true }
  }

  const parser = await parserFor(language)
  const tree = parser.parse(source)
  if (tree === null) return { path, reason: "parser returned no tree", skipped: true }

  return { ...extract(tree.rootNode, path), language: language.id, path }
}

export async function parseFile(path: string): Promise<ParseOutcome> {
  try {
    return await parseSource(path, await readFile(path, "utf8"))
  } catch (error) {
    return {
      path,
      reason: error instanceof Error ? error.message : String(error),
      skipped: true,
    }
  }
}
