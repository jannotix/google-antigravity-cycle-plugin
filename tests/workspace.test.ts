import { expect, test } from "bun:test"

type PackageJson = {
  name?: string
  version?: string
  author?: string
  license?: string
  repository?: { type?: string; url?: string }
}

const readPackage = (path: string) => Bun.file(new URL(path, import.meta.url)).json() as Promise<PackageJson>

test("workspace publishes certified Antigravity Cycle identity", async () => {
  const root = await readPackage("../package.json")
  expect(root.name).toBe("cycle-antigravity")
  expect(root.version).toBe("1.0.0")
  expect(root.author).toBe("Gianluca Iannotta")
  expect(root.license).toBe("FSL-1.1-MIT")
  expect(root.repository?.url).toBe("https://github.com/jannotix/google-antigravity-cycle-plugin.git")
  expect(await Bun.file("NOTICE").text()).toContain("Cycle for Antigravity")
  expect(await Bun.file("NOTICE").text()).toContain("Gianluca Iannotta")
})
