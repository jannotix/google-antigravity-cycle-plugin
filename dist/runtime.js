import { join } from "node:path";
import { AdmissionController } from "./admission.js";
import { readConfiguration } from "./config.js";
import { identifyProject } from "./project.js";
import { resolveDataDirectory } from "./paths.js";
import { CpuSampler, readResources } from "./resources.js";
import { Database } from "./store/database.js";
const DATABASE_FILE = "cycle.db";
export class Runtime {
    admission = new AdmissionController();
    configuration;
    dataDirectory;
    project;
    #sampler = new CpuSampler();
    #database;
    #failure;
    constructor(environment = process.env) {
        this.configuration = readConfiguration(environment);
        this.dataDirectory = resolveDataDirectory(this.configuration.dataDirectory, environment);
        this.project = identifyProject(undefined, environment);
    }
    store() {
        if (this.#database !== undefined)
            return this.#database;
        if (this.#failure !== undefined)
            return undefined;
        try {
            this.#database = new Database({ path: join(this.dataDirectory, DATABASE_FILE) });
            return this.#database;
        }
        catch (error) {
            this.#failure = error instanceof Error ? error : new Error(String(error));
            return undefined;
        }
    }
    resources(now = Date.now()) {
        return readResources(this.dataDirectory, this.#sampler, now);
    }
    storeFailure() {
        return this.#failure;
    }
    requireStore() {
        const database = this.store();
        if (database === undefined) {
            throw this.#failure ?? new Error("the Cycle store is unavailable");
        }
        return database;
    }
    close() {
        this.#database?.close();
        this.#database = undefined;
    }
}
