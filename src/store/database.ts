import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"

import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.ts"

export type StoreMode = "read_write" | "safe_read_only"

export type Row = Record<string, unknown>

export class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "StoreError"
  }
}

export interface DatabaseOptions {
  readonly path: string
}

export class Database {
  readonly #database: DatabaseSync
  readonly #mode: StoreMode
  readonly #schemaVersion: number
  readonly #statements = new Map<string, StatementSync>()
  #depth = 0

  constructor(options: DatabaseOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true })

    const database = new DatabaseSync(options.path)
    try {
      const row = database.prepare("pragma quick_check").get() as
        | { quick_check?: string }
        | undefined
      if (row?.quick_check !== "ok") throw new Error(String(row?.quick_check ?? "unknown result"))
    } catch (error) {
      database.close()
      throw new StoreError("the Cycle database integrity check failed", { cause: error })
    }
    const existing = readSchemaVersion(database)

    // A store written by a newer plugin is opened read-only rather than migrated downward, so an
    // older installation can never truncate state it does not understand.
    if (existing > CURRENT_SCHEMA_VERSION) {
      database.close()
      this.#database = new DatabaseSync(options.path, { readOnly: true })
      this.#mode = "safe_read_only"
      this.#schemaVersion = existing
      return
    }

    database.exec("pragma foreign_keys = ON")
    database.exec("pragma busy_timeout = 5000")
    if (options.path !== ":memory:") database.exec("pragma journal_mode = WAL")
    migrate(database, existing)

    this.#database = database
    this.#mode = "read_write"
    this.#schemaVersion = CURRENT_SCHEMA_VERSION
  }

  get mode(): StoreMode {
    return this.#mode
  }

  get schemaVersion(): number {
    return this.#schemaVersion
  }

  run(sql: string, ...parameters: readonly SqlValue[]): void {
    this.#assertWritable()
    this.#prepare(sql).run(...parameters)
  }

  get<T extends Row>(sql: string, ...parameters: readonly SqlValue[]): T | undefined {
    return this.#prepare(sql).get(...parameters) as T | undefined
  }

  all<T extends Row>(sql: string, ...parameters: readonly SqlValue[]): T[] {
    return this.#prepare(sql).all(...parameters) as T[]
  }

  /**
   * Re-entrant: a repository that wraps another repository's write must not open a second
   * transaction. Nested calls join the outermost one through a savepoint.
   */
  transaction<T>(operation: () => T): T {
    this.#assertWritable()

    if (this.#depth > 0) {
      const savepoint = `cycle_sp_${this.#depth}`
      this.#depth += 1
      this.#database.exec(`savepoint ${savepoint}`)
      try {
        const result = operation()
        this.#database.exec(`release ${savepoint}`)
        return result
      } catch (error) {
        this.#database.exec(`rollback to ${savepoint}`)
        this.#database.exec(`release ${savepoint}`)
        throw error
      } finally {
        this.#depth -= 1
      }
    }

    this.#depth = 1
    this.#database.exec("begin immediate")
    try {
      const result = operation()
      this.#database.exec("commit")
      return result
    } catch (error) {
      this.#database.exec("rollback")
      throw error
    } finally {
      this.#depth = 0
    }
  }

  close(): void {
    this.#statements.clear()
    this.#database.close()
  }

  #assertWritable(): void {
    if (this.#mode === "safe_read_only") {
      throw new StoreError(
        `the store was written by schema version ${this.#schemaVersion}; this build supports ` +
          `${CURRENT_SCHEMA_VERSION} and opened it read-only`,
      )
    }
  }

  #prepare(sql: string): StatementSync {
    const cached = this.#statements.get(sql)
    if (cached !== undefined) return cached
    const statement = this.#database.prepare(sql)
    this.#statements.set(sql, statement)
    return statement
  }
}

export type SqlValue = Uint8Array | bigint | null | number | string

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("pragma user_version").get() as { user_version?: number } | undefined
  return typeof row?.user_version === "number" ? row.user_version : 0
}

function migrate(database: DatabaseSync, from: number): void {
  const pending = MIGRATIONS.filter((migration) => migration.version > from).sort(
    (left, right) => left.version - right.version,
  )
  if (pending.length === 0) return

  for (const migration of pending) {
    database.exec("begin immediate")
    try {
      database.exec(migration.sql)
      database.exec(`pragma user_version = ${migration.version}`)
      database.exec("commit")
    } catch (error) {
      database.exec("rollback")
      throw new StoreError(`migration ${migration.version} (${migration.name}) failed`, {
        cause: error,
      })
    }
  }
}
