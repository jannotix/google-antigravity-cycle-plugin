import { createInterface } from "node:readline"

const JSONRPC = "2.0"
const FALLBACK_PROTOCOL_VERSION = "2025-06-18"

export interface ToolDefinition {
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly name: string
  run(args: Record<string, unknown>): Promise<unknown> | unknown
}

export interface ServerIdentity {
  readonly name: string
  readonly version: string
}

interface Request {
  readonly id?: number | string | null
  readonly method?: unknown
  readonly params?: unknown
}

const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InternalError: -32603,
} as const

export function serve(identity: ServerIdentity, tools: readonly ToolDefinition[]): void {
  const registry = new Map(tools.map((tool) => [tool.name, tool]))
  const input = createInterface({ input: process.stdin })

  let inFlight = 0
  let inputClosed = false

  process.stdout.on("error", () => process.exit(0))

  // Piped input reaches EOF immediately, so closing stdin cannot end the process while an
  // asynchronous request is still working: it would answer nothing.
  input.on("close", () => {
    inputClosed = true
    if (inFlight === 0) process.exit(0)
  })

  input.on("line", (line) => {
    inFlight += 1
    void handle(line).finally(() => {
      inFlight -= 1
      if (inputClosed && inFlight === 0) process.exit(0)
    })
  })

  async function handle(line: string): Promise<void> {
    if (!line.trim()) return

    let request: Request
    try {
      request = JSON.parse(line) as Request
    } catch {
      write({ error: { code: ErrorCode.ParseError, message: "invalid JSON" }, id: null, jsonrpc: JSONRPC })
      return
    }

    const { id, method } = request
    if (typeof method !== "string") {
      if (id !== undefined) {
        write({ error: { code: ErrorCode.InvalidRequest, message: "missing method" }, id, jsonrpc: JSONRPC })
      }
      return
    }

    // Notifications carry no id and must never produce a response.
    if (id === undefined) return

    try {
      write({ id, jsonrpc: JSONRPC, result: await dispatch(method, request.params) })
    } catch (error) {
      write({
        error: { code: codeOf(error), message: messageOf(error) },
        id,
        jsonrpc: JSONRPC,
      })
    }
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          capabilities: { tools: {} },
          protocolVersion: requestedProtocolVersion(params),
          serverInfo: identity,
        }
      case "ping":
        return {}
      case "tools/list":
        return {
          tools: tools.map(({ description, inputSchema, name }) => ({
            description,
            inputSchema,
            name,
          })),
        }
      case "tools/call":
        return callTool(params)
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `unknown method: ${method}`)
    }
  }

  async function callTool(params: unknown): Promise<unknown> {
    const request = asRecord(params)
    const name = request["name"]
    if (typeof name !== "string") throw new RpcError(ErrorCode.InvalidRequest, "missing tool name")

    const tool = registry.get(name)
    if (tool === undefined) throw new RpcError(ErrorCode.MethodNotFound, `unknown tool: ${name}`)

    try {
      const result = await tool.run(asRecord(request["arguments"]))
      return { content: [{ text: JSON.stringify(result, null, 2), type: "text" }] }
    } catch (error) {
      return { content: [{ text: messageOf(error), type: "text" }], isError: true }
    }
  }
}

class RpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
    this.name = "RpcError"
  }
}

function requestedProtocolVersion(params: unknown): string {
  const requested = asRecord(params)["protocolVersion"]
  return typeof requested === "string" && requested.length <= 32
    ? requested
    : FALLBACK_PROTOCOL_VERSION
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function codeOf(error: unknown): number {
  return error instanceof RpcError ? error.code : ErrorCode.InternalError
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A client that goes away closes stdout under us. That is a normal shutdown, not a fault, so the
 * write is guarded rather than left to surface as an unhandled error event.
 */
function write(message: unknown): void {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error !== null && error !== undefined) process.exit(0)
    })
  } catch {
    process.exit(0)
  }
}
