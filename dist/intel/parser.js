import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "./extract.js";
import { languageForPath } from "./languages.js";
const VENDOR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor");
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
let runtime;
const grammars = new Map();
const parsers = new Map();
function loadRuntime() {
    runtime ??= (async () => {
        const required = createRequire(import.meta.url);
        const module = required(join(VENDOR, "runtime", "tree-sitter.cjs"));
        await module.Parser.init({ locateFile: () => join(VENDOR, "runtime", "tree-sitter.wasm") });
        return module;
    })();
    return runtime;
}
async function parserFor(language) {
    const existing = parsers.get(language.id);
    if (existing !== undefined)
        return existing;
    const module = await loadRuntime();
    let grammar = grammars.get(language.id);
    if (grammar === undefined) {
        grammar = readFile(join(VENDOR, "grammars", language.wasm)).then((bytes) => module.Language.load(bytes));
        grammars.set(language.id, grammar);
    }
    const parser = new module.Parser();
    parser.setLanguage(await grammar);
    parsers.set(language.id, parser);
    return parser;
}
export async function parseSource(path, source) {
    const language = languageForPath(path);
    if (language === undefined)
        return { path, reason: "unsupported language", skipped: true };
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
        return { path, reason: "source exceeds the parse size limit", skipped: true };
    }
    const parser = await parserFor(language);
    const tree = parser.parse(source);
    if (tree === null)
        return { path, reason: "parser returned no tree", skipped: true };
    return { ...extract(tree.rootNode, path), language: language.id, path };
}
export async function parseFile(path) {
    try {
        return await parseSource(path, await readFile(path, "utf8"));
    }
    catch (error) {
        return {
            path,
            reason: error instanceof Error ? error.message : String(error),
            skipped: true,
        };
    }
}
