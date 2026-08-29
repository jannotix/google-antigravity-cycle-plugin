import assert from "node:assert/strict"
import { test } from "node:test"

import { inScope, insideAny, normalizeScope, scopesOverlap } from "../src/workflow/scopes.ts"

test("a scope covers itself and everything under it", () => {
  assert.equal(inScope("src/auth", "src/auth", "linux"), true)
  assert.equal(inScope("src/auth/token.ts", "src/auth", "linux"), true)
  assert.equal(inScope("src/auth/deep/nested/file.ts", "src/auth", "linux"), true)
})

test("a sibling that merely shares a prefix is outside", () => {
  assert.equal(inScope("src/authentication/x.ts", "src/auth", "linux"), false)
  assert.equal(inScope("src/auth-admin", "src/auth", "linux"), false)
  assert.equal(inScope("src", "src/auth", "linux"), false)
})

test("separators and trailing slashes do not change what a scope means", () => {
  assert.equal(inScope("src\\auth\\token.ts", "src/auth", "linux"), true)
  assert.equal(inScope("src/auth/token.ts", "src/auth/", "linux"), true)
  assert.equal(normalizeScope("src\\auth\\"), "src/auth")
})

// Certification 12.3: on Windows `SRC/Auth.ts` and `src/auth.ts` are one file, and a comparison
// that did not know it would refuse a legitimate write for the case somebody typed.
test("case decides the match on Linux and does not on Windows or macOS", () => {
  assert.equal(inScope("SRC/Auth/token.ts", "src/auth", "linux"), false)
  assert.equal(inScope("SRC/Auth/token.ts", "src/auth", "win32"), true)
  assert.equal(inScope("SRC/Auth/token.ts", "src/auth", "darwin"), true)
})

test("nothing is inside an empty scope, and an empty path is inside nothing", () => {
  assert.equal(inScope("src/auth.ts", "", "linux"), false)
  assert.equal(inScope("", "src", "linux"), false)
  assert.equal(insideAny("src/auth.ts", [], "linux"), false)
})

test("a path inside any one scope is authorized", () => {
  const scopes = ["src/auth", "docs"]
  assert.equal(insideAny("docs/readme.md", scopes, "linux"), true)
  assert.equal(insideAny("src/auth/token.ts", scopes, "linux"), true)
  assert.equal(insideAny("src/billing/charge.ts", scopes, "linux"), false)
})

test("two scope sets overlap when either contains the other", () => {
  assert.equal(scopesOverlap(["src"], ["src/auth"], "linux"), true)
  assert.equal(scopesOverlap(["src/auth"], ["src"], "linux"), true)
  assert.equal(scopesOverlap(["src/auth"], ["src/billing"], "linux"), false)
  assert.equal(scopesOverlap(["SRC"], ["src/auth"], "win32"), true)
  assert.equal(scopesOverlap(["SRC"], ["src/auth"], "linux"), false)
})
