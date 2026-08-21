import { availableParallelism } from "node:os"
import { extname } from "node:path"
import { Worker } from "node:worker_threads"

import { parseFile, type ParseOutcome } from "./parser.ts"

const BATCH = 32

interface Pending {
  readonly reject: (error: unknown) => void
  readonly resolve: (results: ParseOutcome[]) => void
}

/**
 * Parses batches across worker threads. Grammar loading costs about a second per language per
 * thread, so files are batched rather than dispatched one at a time.
 *
 * Falls back to in-process parsing when a worker cannot start: correctness must not depend on
 * threads being available.
 */
export class ParsePool {
  readonly #idle: Worker[] = []
  readonly #pending = new Map<number, Pending>()
  readonly #queue: { paths: string[]; pending: Pending }[] = []
  readonly #size: number
  readonly #workers = new Set<Worker>()
  #inProcess = false
  #next = 0

  constructor(size = Math.max(1, Math.min(8, availableParallelism() - 1))) {
    this.#size = size
  }

  async parse(paths: readonly string[]): Promise<ParseOutcome[]> {
    if (paths.length === 0) return []

    const batches: Promise<ParseOutcome[]>[] = []
    for (let index = 0; index < paths.length; index += BATCH) {
      batches.push(this.#dispatch(paths.slice(index, index + BATCH)))
    }
    return (await Promise.all(batches)).flat()
  }

  async dispose(): Promise<void> {
    const workers = [...this.#workers]
    this.#workers.clear()
    this.#idle.length = 0
    await Promise.allSettled(workers.map((worker) => worker.terminate()))
  }

  async #dispatch(paths: string[]): Promise<ParseOutcome[]> {
    if (this.#inProcess) return this.#inProcessParse(paths)

    const worker = this.#acquire()
    if (worker === undefined) {
      return new Promise((resolve, reject) => {
        this.#queue.push({ paths, pending: { reject, resolve } })
      })
    }

    return new Promise((resolve, reject) => {
      const id = (this.#next += 1)
      this.#pending.set(id, { reject, resolve })
      worker.postMessage({ id, paths })
    })
  }

  async #inProcessParse(paths: readonly string[]): Promise<ParseOutcome[]> {
    const results: ParseOutcome[] = []
    for (const path of paths) results.push(await parseFile(path))
    return results
  }

  #acquire(): Worker | undefined {
    const idle = this.#idle.pop()
    if (idle !== undefined) return idle
    if (this.#workers.size >= this.#size) return undefined
    return this.#spawn()
  }

  #spawn(): Worker | undefined {
    try {
      const entry = new URL(`./worker${extname(import.meta.url)}`, import.meta.url)
      const worker = new Worker(entry)
      worker.unref()
      worker.on("message", (message: { id: number; results: ParseOutcome[] }) => {
        this.#pending.get(message.id)?.resolve(message.results)
        this.#pending.delete(message.id)
        this.#release(worker)
      })
      worker.on("error", (error) => this.#fail(worker, error))
      this.#workers.add(worker)
      return worker
    } catch {
      this.#inProcess = true
      return undefined
    }
  }

  #release(worker: Worker): void {
    const next = this.#queue.shift()
    if (next === undefined) {
      this.#idle.push(worker)
      return
    }
    const id = (this.#next += 1)
    this.#pending.set(id, next.pending)
    worker.postMessage({ id, paths: next.paths })
  }

  /** A dead worker must not strand its callers: they finish in process instead. */
  #fail(worker: Worker, error: unknown): void {
    this.#workers.delete(worker)
    this.#inProcess = true
    for (const [id, pending] of this.#pending) {
      pending.reject(error)
      this.#pending.delete(id)
    }
    for (const queued of this.#queue.splice(0)) {
      this.#inProcessParse(queued.paths).then(queued.pending.resolve, queued.pending.reject)
    }
  }
}
