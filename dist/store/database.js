import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
export class StoreError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "StoreError";
    }
}
export class Database {
    #database;
    #mode;
    #schemaVersion;
    #statements = new Map();
    #depth = 0;
    constructor(options) {
        if (options.path !== ":memory:")
            mkdirSync(dirname(options.path), { recursive: true });
        const database = new DatabaseSync(options.path);
        try {
            const row = database.prepare("pragma quick_check").get();
            if (row?.quick_check !== "ok")
                throw new Error(String(row?.quick_check ?? "unknown result"));
        }
        catch (error) {
            database.close();
            throw new StoreError("the Cycle database integrity check failed", { cause: error });
        }
        const existing = readSchemaVersion(database);
        if (existing > CURRENT_SCHEMA_VERSION) {
            database.close();
            this.#database = new DatabaseSync(options.path, { readOnly: true });
            this.#mode = "safe_read_only";
            this.#schemaVersion = existing;
            return;
        }
        database.exec("pragma foreign_keys = ON");
        database.exec("pragma busy_timeout = 5000");
        if (options.path !== ":memory:")
            database.exec("pragma journal_mode = WAL");
        migrate(database, existing);
        this.#database = database;
        this.#mode = "read_write";
        this.#schemaVersion = CURRENT_SCHEMA_VERSION;
    }
    get mode() {
        return this.#mode;
    }
    get schemaVersion() {
        return this.#schemaVersion;
    }
    run(sql, ...parameters) {
        this.#assertWritable();
        this.#prepare(sql).run(...parameters);
    }
    get(sql, ...parameters) {
        return this.#prepare(sql).get(...parameters);
    }
    all(sql, ...parameters) {
        return this.#prepare(sql).all(...parameters);
    }
    transaction(operation) {
        this.#assertWritable();
        if (this.#depth > 0) {
            const savepoint = `cycle_sp_${this.#depth}`;
            this.#depth += 1;
            this.#database.exec(`savepoint ${savepoint}`);
            try {
                const result = operation();
                this.#database.exec(`release ${savepoint}`);
                return result;
            }
            catch (error) {
                this.#database.exec(`rollback to ${savepoint}`);
                this.#database.exec(`release ${savepoint}`);
                throw error;
            }
            finally {
                this.#depth -= 1;
            }
        }
        this.#depth = 1;
        this.#database.exec("begin immediate");
        try {
            const result = operation();
            this.#database.exec("commit");
            return result;
        }
        catch (error) {
            this.#database.exec("rollback");
            throw error;
        }
        finally {
            this.#depth = 0;
        }
    }
    close() {
        this.#statements.clear();
        this.#database.close();
    }
    #assertWritable() {
        if (this.#mode === "safe_read_only") {
            throw new StoreError(`the store was written by schema version ${this.#schemaVersion}; this build supports ` +
                `${CURRENT_SCHEMA_VERSION} and opened it read-only`);
        }
    }
    #prepare(sql) {
        const cached = this.#statements.get(sql);
        if (cached !== undefined)
            return cached;
        const statement = this.#database.prepare(sql);
        this.#statements.set(sql, statement);
        return statement;
    }
}
function readSchemaVersion(database) {
    const row = database.prepare("pragma user_version").get();
    return typeof row?.user_version === "number" ? row.user_version : 0;
}
function migrate(database, from) {
    const pending = MIGRATIONS.filter((migration) => migration.version > from).sort((left, right) => left.version - right.version);
    if (pending.length === 0)
        return;
    for (const migration of pending) {
        database.exec("begin immediate");
        try {
            database.exec(migration.sql);
            database.exec(`pragma user_version = ${migration.version}`);
            database.exec("commit");
        }
        catch (error) {
            database.exec("rollback");
            throw new StoreError(`migration ${migration.version} (${migration.name}) failed`, {
                cause: error,
            });
        }
    }
}
