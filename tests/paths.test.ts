import assert from "node:assert/strict"
import { test } from "node:test"

import { PathError, resolveDataDirectory } from "../src/paths.ts"

// Certification 1.9.
test("an explicit data directory wins over every fallback", () => {
  const resolved = resolveDataDirectory("/explicit", { CLAUDE_PLUGIN_DATA: "/plugin" }, "linux")

  assert.equal(resolved, "/explicit")
})

/**
 * Verified against the host: `claude plugin uninstall` removes the plugin's data directory whole.
 * That is correct for a cache and fatal for a signed history of delivered work, so the host's
 * directory is ignored even when it is offered.
 */
test("the host's plugin data directory is refused, because uninstalling removes it", () => {
  const resolved = resolveDataDirectory(
    undefined,
    { CLAUDE_PLUGIN_DATA: "/plugin", XDG_DATA_HOME: "/home/a/.local/share" },
    "linux",
  )

  assert.equal(resolved, "/home/a/.local/share/cycle")
})

// Certification 1.11.
test("each platform falls back outside the application installation", () => {
  assert.equal(
    resolveDataDirectory(undefined, { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32"),
    "C:\\Users\\a\\AppData\\Local\\Cycle",
  )
  assert.equal(
    resolveDataDirectory(undefined, { XDG_DATA_HOME: "/home/a/.data" }, "linux"),
    "/home/a/.data/cycle",
  )
})

test("a missing Windows base directory fails loudly instead of guessing", () => {
  assert.throws(() => resolveDataDirectory(undefined, {}, "win32"), PathError)
})

// Certification 12.8: a WSL installation and the Windows one it sits next to are separate
// installations. They resolve to different directories from the same environment, so neither can
// read, lock or corrupt the other's store — which is what "independent" has to mean for two
// installations sharing one disk.
test("Windows and WSL resolve to separate data directories from one environment", () => {
  const environment = {
    LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    XDG_DATA_HOME: "/home/a/.local/share",
  }

  const windows = resolveDataDirectory(undefined, environment, "win32")
  const linux = resolveDataDirectory(undefined, environment, "linux")

  assert.notEqual(windows, linux)
  assert.ok(windows.startsWith("C:\\"))
  assert.ok(linux.startsWith("/home/"))
})

test("an explicit directory is the one thing that can be shared, and only on purpose", () => {
  const shared = "/mnt/c/shared/cycle"

  assert.equal(resolveDataDirectory(shared, {}, "win32"), shared)
  assert.equal(resolveDataDirectory(shared, {}, "linux"), shared)
})
