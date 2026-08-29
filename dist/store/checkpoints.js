import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIGEST_DOMAIN } from "./ids.js";
const KEY_DIRECTORY = "keys";
const KEY_FILE = "checkpoint.key";
export class SigningError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "SigningError";
    }
}
export function signingKey(dataDirectory) {
    const directory = join(dataDirectory, KEY_DIRECTORY);
    const path = join(directory, KEY_FILE);
    let privatePem;
    try {
        privatePem = readFileSync(path, "utf8");
    }
    catch {
        mkdirSync(directory, { recursive: true });
        const pair = generateKeyPairSync("ed25519");
        privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
        writeFileSync(path, privatePem, { encoding: "utf8", mode: 0o600 });
        restrict(path);
    }
    const privateKey = createPrivateKey(privatePem);
    return {
        privatePem,
        publicPem: createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString(),
    };
}
const ICACLS_TIMEOUT_MS = 5_000;
function restrict(path) {
    if (process.platform !== "win32") {
        try {
            chmodSync(path, 0o600);
        }
        catch {
        }
        return;
    }
    const account = principal();
    if (account === null)
        return;
    try {
        execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${account}:F`], {
            shell: false,
            stdio: "ignore",
            timeout: ICACLS_TIMEOUT_MS,
            windowsHide: true,
        });
    }
    catch {
    }
}
function principal() {
    const user = process.env["USERNAME"]?.trim();
    if (!user)
        return null;
    const domain = process.env["USERDOMAIN"]?.trim();
    return domain ? `${domain}\\${user}` : user;
}
export function keyPermissions(dataDirectory) {
    const path = join(dataDirectory, KEY_DIRECTORY, KEY_FILE);
    if (process.platform !== "win32") {
        try {
            const mode = statSync(path).mode & 0o777;
            return {
                detail: `0${mode.toString(8)}`,
                exists: true,
                restricted: (mode & 0o077) === 0,
            };
        }
        catch {
            return { detail: "no key yet", exists: false, restricted: true };
        }
    }
    let acl;
    try {
        acl = execFileSync("icacls", [path], {
            encoding: "utf8",
            shell: false,
            stdio: ["ignore", "pipe", "ignore"],
            timeout: ICACLS_TIMEOUT_MS,
            windowsHide: true,
        });
    }
    catch {
        return { detail: "no key yet", exists: false, restricted: true };
    }
    const inherited = acl.includes("(I)");
    const principals = [...acl.matchAll(/([^\s:]+):\((?!I\))/gu)].length;
    return {
        detail: inherited ? "inherited access is still granted" : `${principals} principal(s)`,
        exists: true,
        restricted: !inherited && principals <= 1,
    };
}
export function signCheckpoint(database, dataDirectory, now = Date.now()) {
    const head = database.get("select hash, sequence from history order by sequence desc limit 1");
    if (head === undefined)
        return null;
    const { privatePem, publicPem } = signingKey(dataDirectory);
    const signature = sign(null, payload(head.sequence, head.hash), createPrivateKey(privatePem))
        .toString("base64");
    database.run(`insert into checkpoints (sequence, hash, signature, public_key, created_at)
     values (?, ?, ?, ?, ?)
     on conflict (sequence) do update set
       hash = excluded.hash, signature = excluded.signature,
       public_key = excluded.public_key, created_at = excluded.created_at`, head.sequence, head.hash, signature, publicPem, now);
    return { createdAt: now, hash: head.hash, publicKey: publicPem, sequence: head.sequence, signature };
}
export function latestCheckpoint(database) {
    const row = database.get("select * from checkpoints order by sequence desc limit 1");
    return row === undefined ? undefined : toCheckpoint(row);
}
export function verifyCheckpoints(database) {
    const rows = database.all("select * from checkpoints order by sequence");
    let head = null;
    for (const row of rows) {
        const checkpoint = toCheckpoint(row);
        const entry = database.get("select hash from history where sequence = ?", checkpoint.sequence);
        if (entry === undefined || entry.hash !== checkpoint.hash) {
            return { reason: "detached", sequence: checkpoint.sequence, valid: false };
        }
        let ok = false;
        try {
            ok = verify(null, payload(checkpoint.sequence, checkpoint.hash), createPublicKey(checkpoint.publicKey), Buffer.from(checkpoint.signature, "base64"));
        }
        catch {
            ok = false;
        }
        if (!ok)
            return { reason: "signature", sequence: checkpoint.sequence, valid: false };
        head = checkpoint.sequence;
    }
    return { checked: rows.length, head, valid: true };
}
function payload(sequence, hash) {
    return Buffer.from(`${DIGEST_DOMAIN.historyEntry}/checkpoint/${sequence}/${hash}`, "utf8");
}
function toCheckpoint(row) {
    return {
        createdAt: Number(row["created_at"]),
        hash: String(row["hash"]),
        publicKey: String(row["public_key"]),
        sequence: Number(row["sequence"]),
        signature: String(row["signature"]),
    };
}
