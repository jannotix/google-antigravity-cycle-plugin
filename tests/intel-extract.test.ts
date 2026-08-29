import assert from "node:assert/strict"
import { test } from "node:test"

import { isSupported, languageForPath } from "../src/intel/languages.ts"
import { parseSource } from "../src/intel/parser.ts"

const names = (nodes: readonly { kind: string; name: string }[]): string[] =>
  nodes.map((node) => `${node.kind}:${node.name}`)

const refs = (list: readonly { kind: string; target: string }[], kind: string): string[] =>
  list.filter((reference) => reference.kind === kind).map((reference) => reference.target)

test("extensions map to the grammar that parses them", () => {
  assert.equal(languageForPath("a/b.ts")?.id, "typescript")
  assert.equal(languageForPath("a/b.tsx")?.id, "tsx")
  assert.equal(languageForPath("a/b.mjs")?.id, "javascript")
  // C is parsed by the C++ grammar rather than shipping a second wasm for it.
  assert.equal(languageForPath("a/b.c")?.id, "cpp")
  assert.equal(languageForPath("a/b.h")?.id, "cpp")
  assert.equal(languageForPath("A/B.PY")?.id, "python")
  assert.equal(languageForPath("a/b.zig"), undefined)
  assert.equal(isSupported("a/README.md"), false)
})

test("typescript yields definitions, imports and calls", async () => {
  const result = await parseSource(
    "a.ts",
    `import { a } from "./m"\nexport function f(x: number) { return a(x) }\nexport class C { m() { f(1) } }\nexport interface I { k: string }\nexport type T = string`,
  )

  assert.ok(!("skipped" in result))
  assert.deepEqual(names(result.nodes), [
    "function:f",
    "class:C",
    "method:m",
    "interface:I",
    "type:T",
  ])
  assert.deepEqual(refs(result.references, "imports"), ["./m"])
  assert.deepEqual(refs(result.references, "calls"), ["a", "f"])
})

// export_statement is an import node type only when it re-exports. Without the guard the whole
// statement text was recorded as a module specifier.
test("an export that is not a re-export produces no import edge", async () => {
  const result = await parseSource("a.ts", `export function f() { return 1 }`)

  assert.ok(!("skipped" in result))
  assert.deepEqual(refs(result.references, "imports"), [])
})

test("a re-export is still an import", async () => {
  const result = await parseSource("a.ts", `export { a } from "./m"`)

  assert.ok(!("skipped" in result))
  assert.deepEqual(refs(result.references, "imports"), ["./m"])
})

test("python reports the module, not the imported symbol", async () => {
  const result = await parseSource("b.py", `from .m import a\ndef f():\n    return a()`)

  assert.ok(!("skipped" in result))
  assert.deepEqual(refs(result.references, "imports"), [".m"])
})

// Python uses one node type for both; the distinction has to come from position in the tree.
test("a python function inside a class is a method", async () => {
  const result = await parseSource("b.py", `def f():\n    pass\nclass C:\n    def m(self):\n        pass`)

  assert.ok(!("skipped" in result))
  assert.deepEqual(names(result.nodes), ["function:f", "class:C", "method:m"])
})

test("go, rust, java, cpp, ruby and css all extract", async () => {
  const cases: [string, string, string[], string[]][] = [
    ["c.go", `package p\nimport "fmt"\nfunc F(x int) int { return G(x) }\ntype T struct{}`, ["function:F", "type:T"], ["fmt"]],
    ["d.rs", `use crate::m::a;\npub fn f() { a() }\npub struct S;\npub trait Tr {}`, ["function:f", "class:S", "interface:Tr"], ["crate::m::a"]],
    ["h.java", `import java.util.List;\npublic class C { void m() { f(); } }`, ["class:C", "method:m"], ["java.util.List"]],
    ["e.cpp", `#include <vector>\nnamespace n { class C {}; int f() { return g(); } }`, ["module:n", "class:C", "function:f"], ["vector"]],
    ["f.rb", `class C\n  def m\n    f(1)\n  end\nend`, ["class:C", "method:m"], []],
    ["g.css", `@import "a.css";\n.x { color: red }`, ["component:.x"], ["a.css"]],
  ]

  for (const [path, source, expectedNodes, expectedImports] of cases) {
    const result = await parseSource(path, source)
    assert.ok(!("skipped" in result), `${path} was skipped`)
    assert.deepEqual(names(result.nodes), expectedNodes, path)
    assert.deepEqual(refs(result.references, "imports"), expectedImports, path)
  }
})

test("a qualified callee is attributed to its final segment", async () => {
  const result = await parseSource("a.ts", `function f() { return lib.util.parse(1) }`)

  assert.ok(!("skipped" in result))
  assert.deepEqual(refs(result.references, "calls"), ["parse"])
})

test("an unsupported language is skipped with a reason instead of failing", async () => {
  const result = await parseSource("a.zig", "const x = 1;")

  assert.ok("skipped" in result)
  assert.match(result.reason, /unsupported/u)
})

test("a source beyond the parse limit is skipped, not truncated", async () => {
  const result = await parseSource("a.ts", "const x = 1\n".repeat(300_000))

  assert.ok("skipped" in result)
  assert.match(result.reason, /size limit/u)
})
