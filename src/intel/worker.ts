import { parentPort } from "node:worker_threads"

import { parseFile, type ParseOutcome } from "./parser.ts"

interface Request {
  readonly id: number
  readonly paths: readonly string[]
}

const port = parentPort
if (port === null) throw new Error("intel worker must run on a worker thread")

port.on("message", (request: Request) => {
  void (async () => {
    const results: ParseOutcome[] = []
    for (const path of request.paths) results.push(await parseFile(path))
    port.postMessage({ id: request.id, results })
  })()
})
