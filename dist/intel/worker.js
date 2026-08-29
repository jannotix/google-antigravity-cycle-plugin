import { parentPort } from "node:worker_threads";
import { parseFile } from "./parser.js";
const port = parentPort;
if (port === null)
    throw new Error("intel worker must run on a worker thread");
port.on("message", (request) => {
    void (async () => {
        const results = [];
        for (const path of request.paths)
            results.push(await parseFile(path));
        port.postMessage({ id: request.id, results });
    })();
});
