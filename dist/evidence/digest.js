import { createHash } from "node:crypto";
import { DIGEST_DOMAIN } from "../store/ids.js";
export function outputHash() {
    return createHash("sha256").update(Buffer.from(DIGEST_DOMAIN.output, "utf8"));
}
export function outputDigest(text) {
    return outputHash().update(Buffer.from(text, "utf8")).digest("hex");
}
