import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "server.js")

export interface Response {
  readonly error?: { code: number; message: string }
  readonly id: number
  readonly result?: Record<string, unknown>
}

export interface ExchangeOptions {
  /** Always isolated: a test must never write into the caller's real data directory. */
  readonly dataDirectory?: string
  readonly options?: Readonly<Record<string, string>>
}

export function isolatedDataDirectory(): string {
  return mkdtempSync(join(tmpdir(), "cycle-mcp-"))
}

export async function exchange(
  requests: readonly unknown[],
  { dataDirectory = isolatedDataDirectory(), options = {} }: ExchangeOptions = {},
): Promise<Response[]> {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith("CLAUDE_PLUGIN_OPTION_") || key.startsWith("CYCLE_OPTION_")) delete environment[key]
  }
  environment["CYCLE_OPTION_DATA_DIR"] = dataDirectory
  for (const [key, value] of Object.entries(options)) {
    environment[`CYCLE_OPTION_${key}`] = value
  }

  const child = spawn(process.execPath, [SERVER], {
    env: environment,
    stdio: ["pipe", "pipe", "ignore"],
  })

  let output = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    output += chunk
  })

  // A raw string is written verbatim so malformed input can be exercised.
  for (const request of requests) {
    child.stdin.write(`${typeof request === "string" ? request : JSON.stringify(request)}\n`)
  }
  child.stdin.end()

  await new Promise((resolve) => child.on("close", resolve))
  return output.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Response)
}

/**
 * The server answers each line independently, so a slow tool can reply after a fast one sent later.
 * A test that mixes the two correlates by id, exactly as a real client does.
 */
export function byId(responses: readonly Response[], id: number): Response | undefined {
  return responses.find((response) => response.id === id)
}

export function call(id: number, name: string, args: Record<string, unknown> = {}): unknown {
  return { id, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }
}

export function payload<T>(response: Response | undefined): T {
  const content = response?.result?.["content"] as { text: string }[] | undefined
  if (content === undefined) throw new Error(`no tool content in response: ${JSON.stringify(response)}`)
  return JSON.parse(content[0]!.text) as T
}
