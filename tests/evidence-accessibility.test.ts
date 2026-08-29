import assert from "node:assert/strict"
import { test } from "node:test"

import {
  inspectAccessibility,
  parseSnapshot,
  SnapshotRejected,
} from "../src/evidence/accessibility.ts"
import { browserEvidence } from "../src/evidence/browser.ts"

const node = (
  role: string,
  name = "",
  extra: { children?: unknown[]; level?: number | null } = {},
) => ({ children: extra.children ?? [], level: extra.level ?? null, name, role })

const snapshot = (nodes: unknown[]) => ({
  capturedFlow: "sign in and reach the dashboard",
  nodes,
  url: "http://localhost:3000/login",
})

const rules = (nodes: unknown[]): string[] =>
  inspectAccessibility(parseSnapshot(snapshot(nodes))).map((finding) => finding.rule)

test("a well-formed snapshot parses and keeps document order", () => {
  const parsed = parseSnapshot(
    snapshot([node("main", "Main", { children: [node("button", "Save")] })]),
  )

  assert.equal(parsed.url, "http://localhost:3000/login")
  assert.equal(parsed.nodes[0]?.children[0]?.name, "Save")
})

// The same strictness as plans and verdicts: a shape that is nearly right is rejected, not guessed.
test("a snapshot with an extra or missing key is rejected", () => {
  assert.throws(() => parseSnapshot({ ...snapshot([node("main", "M")]), extra: 1 }), SnapshotRejected)
  assert.throws(() => parseSnapshot({ nodes: [node("main", "M")], url: "http://x/" }), SnapshotRejected)
  assert.throws(() => parseSnapshot(snapshot([{ name: "M", role: "main" }])), SnapshotRejected)
})

test("a snapshot with no url, no nodes or a bad heading level is rejected", () => {
  assert.throws(() => parseSnapshot({ ...snapshot([node("main", "M")]), url: "dashboard" }), SnapshotRejected)
  assert.throws(() => parseSnapshot(snapshot([])), SnapshotRejected)
  assert.throws(() => parseSnapshot(snapshot([node("heading", "H", { level: 0 })])), SnapshotRejected)
})

test("a control with no accessible name is a high finding", () => {
  assert.deepEqual(rules([node("main", "M", { children: [node("button")] })]), [
    "a11y/unnamed-control",
  ])
  assert.deepEqual(rules([node("main", "M", { children: [node("button", "Save")] })]), [])
})

test("an unnamed image and an empty heading are findings", () => {
  assert.deepEqual(
    rules([node("main", "M", { children: [node("image"), node("heading", "", { level: 1 })] })]),
    ["a11y/unnamed-image", "a11y/empty-heading"],
  )
})

test("a gap in the heading outline is a finding", () => {
  assert.deepEqual(
    rules([
      node("main", "M", {
        children: [node("heading", "Title", { level: 1 }), node("heading", "Detail", { level: 3 })],
      }),
    ]),
    ["a11y/heading-order"],
  )
  assert.deepEqual(
    rules([
      node("main", "M", {
        children: [node("heading", "Title", { level: 1 }), node("heading", "Section", { level: 2 })],
      }),
    ]),
    [],
  )
})

test("a page with no main landmark, or with two, is a finding", () => {
  assert.deepEqual(rules([node("button", "Save")]), ["a11y/no-main-landmark"])
  assert.deepEqual(rules([node("main", "A"), node("main", "B")]), ["a11y/duplicate-main"])
})

// The interface layer's required-missing gates are satisfied by a flow a reviewer drove, not by a
// claim, and not by the executor's account of its own work.
test("a captured flow produces both interface gates", () => {
  const { evidence } = browserEvidence(parseSnapshot(snapshot([node("main", "M")])), "functional_reviewer", 1)

  assert.deepEqual(
    evidence.map((item) => [item.gate.name, item.status]),
    [
      ["browser:affected-user-flow", "passed"],
      ["accessibility:affected-user-flow", "passed"],
    ],
  )
  assert.ok(evidence.every((item) => item.gate.mandatory))
})

test("a control nobody can announce fails the accessibility gate", () => {
  const { evidence } = browserEvidence(
    parseSnapshot(snapshot([node("main", "M", { children: [node("button")] })])),
    "functional_reviewer",
    1,
  )

  assert.equal(evidence[1]?.status, "failed")
  assert.match(evidence[1]?.output ?? "", /a11y\/unnamed-control/u)
})

// A missing landmark is worth saying and not worth blocking a delivery over.
test("findings below high are recorded without failing the gate", () => {
  const { evidence } = browserEvidence(parseSnapshot(snapshot([node("button", "Save")])), "functional_reviewer", 1)

  assert.equal(evidence[1]?.status, "passed")
  assert.match(evidence[1]?.output ?? "", /a11y\/no-main-landmark/u)
})

// The executor supplied the object that became this evidence, and the control plane cannot tell a
// captured tree from an invented one. It was recorded as the mandatory gate passing, so the party
// being judged wrote the proof that unblocked it.
test("a flow the executor reported carries no mandatory weight", () => {
  const { evidence } = browserEvidence(parseSnapshot(snapshot([node("main", "M")])), "executor", 1)

  assert.deepEqual(
    evidence.map((item) => [item.gate.name, item.status]),
    [
      ["browser:executor-report", "warning"],
      ["accessibility:executor-report", "warning"],
    ],
  )
  assert.ok(evidence.every((item) => !item.gate.mandatory))
  assert.match(evidence[0]?.output ?? "", /does not satisfy the interface layer/u)
})
