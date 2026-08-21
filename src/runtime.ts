import { join } from "node:path"

import { AdmissionController } from "./admission.ts"
import { readConfiguration, type Configuration } from "./config.ts"
import { identifyProject, type Project } from "./project.ts"
import { resolveDataDirectory } from "./paths.ts"
import { CpuSampler, readResources, type ResourceReading } from "./resources.ts"
import { Database } from "./store/database.ts"

const DATABASE_FILE = "cycle.db"

/**
 * One process-wide handle. The server is long lived, so the store is opened once and shared rather
 * than reopened per call, which would race two connections through migration on first use.
 */
export class Runtime {
  readonly admission = new AdmissionController()
  readonly configuration: Configuration
  readonly dataDirectory: string
  readonly project: Project

  readonly #sampler = new CpuSampler()

  #database: Database | undefined
  #failure: Error | undefined

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.configuration = readConfiguration(environment)
    this.dataDirectory = resolveDataDirectory(this.configuration.dataDirectory, environment)
    this.project = identifyProject(undefined, environment)
  }

  /** Returns undefined rather than throwing, so diagnostics can report an unusable store. */
  store(): Database | undefined {
    if (this.#database !== undefined) return this.#database
    if (this.#failure !== undefined) return undefined

    try {
      this.#database = new Database({ path: join(this.dataDirectory, DATABASE_FILE) })
      return this.#database
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error))
      return undefined
    }
  }

  /** What the machine has right now. Measured on demand: a cached reading is an opinion. */
  resources(now = Date.now()): Promise<ResourceReading> {
    return readResources(this.dataDirectory, this.#sampler, now)
  }

  storeFailure(): Error | undefined {
    return this.#failure
  }

  requireStore(): Database {
    const database = this.store()
    if (database === undefined) {
      throw this.#failure ?? new Error("the Cycle store is unavailable")
    }
    return database
  }

  close(): void {
    this.#database?.close()
    this.#database = undefined
  }
}
