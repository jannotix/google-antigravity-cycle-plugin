export function caseInsensitive(platform = process.platform) {
    return platform === "win32" || platform === "darwin";
}
export function normalizeScope(scope) {
    return scope.replaceAll("\\", "/").replace(/\/+$/u, "").trim();
}
function comparable(scope, platform) {
    const normalized = normalizeScope(scope);
    return caseInsensitive(platform) ? normalized.toLowerCase() : normalized;
}
export function inScope(path, scope, platform = process.platform) {
    const target = comparable(path, platform);
    const prefix = comparable(scope, platform);
    if (!prefix || !target)
        return false;
    return target === prefix || target.startsWith(`${prefix}/`);
}
export function insideAny(path, scopes, platform = process.platform) {
    return scopes.some((scope) => inScope(path, scope, platform));
}
export function scopesOverlap(left, right, platform = process.platform) {
    return left.some((a) => right.some((b) => inScope(a, b, platform) || inScope(b, a, platform)));
}
