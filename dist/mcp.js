import { createInterface } from "node:readline";
const JSONRPC = "2.0";
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";
const ErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InternalError: -32603,
};
export function serve(identity, tools) {
    const registry = new Map(tools.map((tool) => [tool.name, tool]));
    const input = createInterface({ input: process.stdin });
    let inFlight = 0;
    let inputClosed = false;
    process.stdout.on("error", () => process.exit(0));
    input.on("close", () => {
        inputClosed = true;
        if (inFlight === 0)
            process.exit(0);
    });
    input.on("line", (line) => {
        inFlight += 1;
        void handle(line).finally(() => {
            inFlight -= 1;
            if (inputClosed && inFlight === 0)
                process.exit(0);
        });
    });
    async function handle(line) {
        if (!line.trim())
            return;
        let request;
        try {
            request = JSON.parse(line);
        }
        catch {
            write({ error: { code: ErrorCode.ParseError, message: "invalid JSON" }, id: null, jsonrpc: JSONRPC });
            return;
        }
        const { id, method } = request;
        if (typeof method !== "string") {
            if (id !== undefined) {
                write({ error: { code: ErrorCode.InvalidRequest, message: "missing method" }, id, jsonrpc: JSONRPC });
            }
            return;
        }
        if (id === undefined)
            return;
        try {
            write({ id, jsonrpc: JSONRPC, result: await dispatch(method, request.params) });
        }
        catch (error) {
            write({
                error: { code: codeOf(error), message: messageOf(error) },
                id,
                jsonrpc: JSONRPC,
            });
        }
    }
    async function dispatch(method, params) {
        switch (method) {
            case "initialize":
                return {
                    capabilities: { tools: {} },
                    protocolVersion: requestedProtocolVersion(params),
                    serverInfo: identity,
                };
            case "ping":
                return {};
            case "tools/list":
                return {
                    tools: tools.map(({ description, inputSchema, name }) => ({
                        description,
                        inputSchema,
                        name,
                    })),
                };
            case "tools/call":
                return callTool(params);
            default:
                throw new RpcError(ErrorCode.MethodNotFound, `unknown method: ${method}`);
        }
    }
    async function callTool(params) {
        const request = asRecord(params);
        const name = request["name"];
        if (typeof name !== "string")
            throw new RpcError(ErrorCode.InvalidRequest, "missing tool name");
        const tool = registry.get(name);
        if (tool === undefined)
            throw new RpcError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
        try {
            const result = await tool.run(asRecord(request["arguments"]));
            return { content: [{ text: JSON.stringify(result, null, 2), type: "text" }] };
        }
        catch (error) {
            return { content: [{ text: messageOf(error), type: "text" }], isError: true };
        }
    }
}
class RpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "RpcError";
    }
}
function requestedProtocolVersion(params) {
    const requested = asRecord(params)["protocolVersion"];
    return typeof requested === "string" && requested.length <= 32
        ? requested
        : FALLBACK_PROTOCOL_VERSION;
}
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function codeOf(error) {
    return error instanceof RpcError ? error.code : ErrorCode.InternalError;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function write(message) {
    try {
        process.stdout.write(`${JSON.stringify(message)}\n`, (error) => {
            if (error !== null && error !== undefined)
                process.exit(0);
        });
    }
    catch {
        process.exit(0);
    }
}
