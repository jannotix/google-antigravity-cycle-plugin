const ECMASCRIPT_DEFINITIONS = {
    class_declaration: "class",
    enum_declaration: "type",
    function_declaration: "function",
    generator_function_declaration: "function",
    interface_declaration: "interface",
    method_definition: "method",
    type_alias_declaration: "type",
    variable_declarator: "constant",
};
const ECMASCRIPT_IMPORTS = ["import_statement", "export_statement"];
const ECMASCRIPT_CALLS = ["call_expression", "new_expression"];
export const LANGUAGES = [
    {
        id: "typescript",
        extensions: [".ts", ".mts", ".cts"],
        wasm: "typescript.wasm",
        definitions: ECMASCRIPT_DEFINITIONS,
        imports: ECMASCRIPT_IMPORTS,
        calls: ECMASCRIPT_CALLS,
    },
    {
        id: "tsx",
        extensions: [".tsx", ".jsx"],
        wasm: "tsx.wasm",
        definitions: ECMASCRIPT_DEFINITIONS,
        imports: ECMASCRIPT_IMPORTS,
        calls: ECMASCRIPT_CALLS,
    },
    {
        id: "javascript",
        extensions: [".js", ".mjs", ".cjs"],
        wasm: "javascript.wasm",
        definitions: ECMASCRIPT_DEFINITIONS,
        imports: ECMASCRIPT_IMPORTS,
        calls: ECMASCRIPT_CALLS,
    },
    {
        id: "python",
        extensions: [".py", ".pyi"],
        wasm: "python.wasm",
        definitions: { class_definition: "class", function_definition: "function" },
        imports: ["import_statement", "import_from_statement"],
        calls: ["call"],
    },
    {
        id: "go",
        extensions: [".go"],
        wasm: "go.wasm",
        definitions: {
            function_declaration: "function",
            method_declaration: "method",
            type_spec: "type",
        },
        imports: ["import_spec"],
        calls: ["call_expression"],
    },
    {
        id: "rust",
        extensions: [".rs"],
        wasm: "rust.wasm",
        definitions: {
            enum_item: "type",
            function_item: "function",
            mod_item: "module",
            struct_item: "class",
            trait_item: "interface",
            type_item: "type",
        },
        imports: ["use_declaration"],
        calls: ["call_expression", "macro_invocation"],
    },
    {
        id: "java",
        extensions: [".java"],
        wasm: "java.wasm",
        definitions: {
            class_declaration: "class",
            enum_declaration: "type",
            interface_declaration: "interface",
            method_declaration: "method",
            record_declaration: "class",
        },
        imports: ["import_declaration"],
        calls: ["method_invocation", "object_creation_expression"],
    },
    {
        id: "c-sharp",
        extensions: [".cs"],
        wasm: "c-sharp.wasm",
        definitions: {
            class_declaration: "class",
            interface_declaration: "interface",
            method_declaration: "method",
            namespace_declaration: "module",
            record_declaration: "class",
            struct_declaration: "class",
        },
        imports: ["using_directive"],
        calls: ["invocation_expression", "object_creation_expression"],
    },
    {
        id: "cpp",
        extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".c", ".h"],
        wasm: "cpp.wasm",
        definitions: {
            class_specifier: "class",
            function_definition: "function",
            namespace_definition: "module",
            struct_specifier: "class",
        },
        imports: ["preproc_include"],
        calls: ["call_expression"],
    },
    {
        id: "ruby",
        extensions: [".rb"],
        wasm: "ruby.wasm",
        definitions: { class: "class", method: "method", module: "module" },
        imports: [],
        calls: ["call"],
    },
    {
        id: "php",
        extensions: [".php"],
        wasm: "php.wasm",
        definitions: {
            class_declaration: "class",
            function_definition: "function",
            interface_declaration: "interface",
            method_declaration: "method",
            namespace_definition: "module",
            trait_declaration: "interface",
        },
        imports: ["namespace_use_declaration"],
        calls: ["function_call_expression", "member_call_expression", "object_creation_expression"],
    },
    {
        id: "css",
        extensions: [".css"],
        wasm: "css.wasm",
        definitions: { rule_set: "component" },
        imports: ["import_statement"],
        calls: [],
    },
];
const BY_EXTENSION = new Map(LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language])));
export function languageForPath(path) {
    const dot = path.lastIndexOf(".");
    return dot < 0 ? undefined : BY_EXTENSION.get(path.slice(dot).toLowerCase());
}
export function isSupported(path) {
    return languageForPath(path) !== undefined;
}
