import { availableParallelism } from "node:os";
import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import { parseFile } from "./parser.js";
const BATCH = 32;
export class ParsePool {
    #idle = [];
    #pending = new Map();
    #queue = [];
    #size;
    #workers = new Set();
    #inProcess = false;
    #next = 0;
    constructor(size = Math.max(1, Math.min(8, availableParallelism() - 1))) {
        this.#size = size;
    }
    async parse(paths) {
        if (paths.length === 0)
            return [];
        const batches = [];
        for (let index = 0; index < paths.length; index += BATCH) {
            batches.push(this.#dispatch(paths.slice(index, index + BATCH)));
        }
        return (await Promise.all(batches)).flat();
    }
    async dispose() {
        const workers = [...this.#workers];
        this.#workers.clear();
        this.#idle.length = 0;
        await Promise.allSettled(workers.map((worker) => worker.terminate()));
    }
    async #dispatch(paths) {
        if (this.#inProcess)
            return this.#inProcessParse(paths);
        const worker = this.#acquire();
        if (worker === undefined) {
            return new Promise((resolve, reject) => {
                this.#queue.push({ paths, pending: { reject, resolve } });
            });
        }
        return new Promise((resolve, reject) => {
            const id = (this.#next += 1);
            this.#pending.set(id, { reject, resolve });
            worker.postMessage({ id, paths });
        });
    }
    async #inProcessParse(paths) {
        const results = [];
        for (const path of paths)
            results.push(await parseFile(path));
        return results;
    }
    #acquire() {
        const idle = this.#idle.pop();
        if (idle !== undefined)
            return idle;
        if (this.#workers.size >= this.#size)
            return undefined;
        return this.#spawn();
    }
    #spawn() {
        try {
            const entry = new URL(`./worker${extname(import.meta.url)}`, import.meta.url);
            const worker = new Worker(entry);
            worker.unref();
            worker.on("message", (message) => {
                this.#pending.get(message.id)?.resolve(message.results);
                this.#pending.delete(message.id);
                this.#release(worker);
            });
            worker.on("error", (error) => this.#fail(worker, error));
            this.#workers.add(worker);
            return worker;
        }
        catch {
            this.#inProcess = true;
            return undefined;
        }
    }
    #release(worker) {
        const next = this.#queue.shift();
        if (next === undefined) {
            this.#idle.push(worker);
            return;
        }
        const id = (this.#next += 1);
        this.#pending.set(id, next.pending);
        worker.postMessage({ id, paths: next.paths });
    }
    #fail(worker, error) {
        this.#workers.delete(worker);
        this.#inProcess = true;
        for (const [id, pending] of this.#pending) {
            pending.reject(error);
            this.#pending.delete(id);
        }
        for (const queued of this.#queue.splice(0)) {
            this.#inProcessParse(queued.paths).then(queued.pending.resolve, queued.pending.reject);
        }
    }
}
