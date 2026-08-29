import assert from "node:assert/strict"
import { test } from "node:test"

import { contrastRatio, inspectDesign, parseColour } from "../src/evidence/design.ts"

const inspect = (path: string, content: string) => inspectDesign([{ content, path }])
const rules = (path: string, content: string): string[] =>
  inspect(path, content).map((finding) => finding.rule)

test("contrast is computed, not guessed", () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(2), "21.00")
  assert.equal(contrastRatio([255, 255, 255], [255, 255, 255]).toFixed(2), "1.00")
  assert.deepEqual(parseColour("#FFF"), [255, 255, 255])
  assert.deepEqual(parseColour("#1a2b3c"), [26, 43, 60])
  assert.deepEqual(parseColour("rgb(10, 20, 30)"), [10, 20, 30])
  assert.equal(parseColour("var(--brand)"), null)
})

test("text below the contrast minimum is a finding with its line", () => {
  const [finding] = inspect(
    "src/app.css",
    "body { margin: 0 }\n\n.hint {\n  color: #888888;\n  background-color: #ffffff;\n}\n",
  )

  assert.equal(finding?.rule, "design/contrast")
  assert.equal(finding?.severity, "medium")
  assert.equal(finding?.line, 3)
})

// Below 3:1 the text is unreadable rather than merely uncomfortable, and the severity says so.
test("contrast far below the minimum is high, not medium", () => {
  const [finding] = inspect("a.css", ".faint { color: #999999; background-color: #ffffff }")

  assert.equal(finding?.severity, "high")
})

test("adequate contrast is silent", () => {
  assert.deepEqual(rules("src/app.css", ".ok { color: #222; background: #fff; }"), [])
})

// A rule that fires on a colour it cannot resolve would report on every themed codebase.
test("a colour the detector cannot resolve produces nothing", () => {
  assert.deepEqual(
    rules("src/app.css", ".themed { color: var(--fg); background-color: var(--bg); }"),
    [],
  )
})

test("type below the readable floor is a finding, in px and in pt", () => {
  assert.deepEqual(rules("a.css", ".x { font-size: 10px }"), ["design/font-size"])
  assert.deepEqual(rules("a.css", ".x { font-size: 8pt }"), ["design/font-size"])
  assert.deepEqual(rules("a.css", ".x { font-size: 16px }"), [])
})

test("removing the focus outline without replacing it is a finding", () => {
  assert.deepEqual(rules("a.css", "button:focus { outline: none }"), [
    "design/focus-not-visible",
  ])
  assert.deepEqual(
    rules("a.css", "button:focus { outline: none }\nbutton:focus-visible { outline: 2px solid }"),
    [],
  )
})

test("a positive tabindex is a finding, zero and minus one are not", () => {
  assert.deepEqual(rules("a.tsx", '<div tabIndex={3} role="button" />'), [
    "design/positive-tabindex",
  ])
  assert.deepEqual(rules("a.html", '<div tabindex="0"></div>'), [])
})

test("a click handler on a passive element with no keyboard path is a finding", () => {
  assert.deepEqual(rules("a.tsx", "<div onClick={open}>Open</div>"), [
    "design/interactive-without-key",
  ])
  assert.deepEqual(rules("a.tsx", "<div onClick={open} onKeyDown={open}>Open</div>"), [])
  assert.deepEqual(rules("a.tsx", '<div onClick={open} role="button">Open</div>'), [])
  assert.deepEqual(rules("a.tsx", "<button onClick={open}>Open</button>"), [])
})

test("an image with no alt is a finding", () => {
  assert.deepEqual(rules("a.html", '<img src="x.png">'), ["design/image-without-alt"])
  assert.deepEqual(rules("a.html", '<img src="x.png" alt="">'), [])
})

test("motion without a reduced-motion alternative is reported once per file", () => {
  assert.deepEqual(rules("a.css", ".a { transition: all 1s }\n.b { animation: spin 2s }"), [
    "design/reduced-motion",
  ])
  assert.deepEqual(
    rules(
      "a.css",
      ".a { transition: all 1s }\n@media (prefers-reduced-motion: reduce) { .a { transition: none } }",
    ),
    [],
  )
})

test("a large fixed width with no breakpoint is a finding", () => {
  assert.deepEqual(rules("a.css", ".page { width: 960px }"), ["design/fixed-width"])
  assert.deepEqual(rules("a.css", ".page { width: 960px }\n@media (max-width: 600px) { .page { width: 100% } }"), [])
  assert.deepEqual(rules("a.css", ".chip { width: 48px }"), [])
})

test("100vw is a finding because it includes the scrollbar", () => {
  assert.deepEqual(rules("a.css", ".full { width: 100vw }"), ["design/viewport-width"])
})

test("interactive elements nested inside one another are a finding", () => {
  assert.deepEqual(rules("a.html", "<button><a href='/x'>go</a></button>"), [
    "design/invalid-nesting",
  ])
  assert.deepEqual(rules("a.html", "<button>ok</button><a href='/x'>go</a>"), [])
})

test("a block element inside a paragraph is a finding", () => {
  assert.deepEqual(rules("a.html", "<p><div>text</div></p>"), ["design/invalid-nesting"])
  assert.deepEqual(rules("a.html", "<p><span>text</span></p>"), [])
})

test("a component that fetches and never mentions failure is a finding", () => {
  assert.deepEqual(rules("a.tsx", "const r = await fetch('/api')\nreturn <div>{r}</div>"), [
    "design/no-error-state",
  ])
  assert.deepEqual(
    rules("a.tsx", "const r = await fetch('/api').catch(() => null)\nreturn <div>{r}</div>"),
    [],
  )
})

test("a file that is not an interface file is not inspected", () => {
  assert.deepEqual(rules("src/server.ts", "const x = { color: '#999', background: '#fff' }"), [])
})

test("findings are ordered by file then line", () => {
  const findings = inspectDesign([
    { content: ".x { font-size: 9px }", path: "b.css" },
    { content: "\n\n.y { width: 100vw }", path: "a.css" },
  ])

  assert.deepEqual(
    findings.map((finding) => [finding.file, finding.line]),
    [
      ["a.css", 3],
      ["b.css", 1],
    ],
  )
})
