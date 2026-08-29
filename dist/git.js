export function gitArgs(root, args) {
    return ["-c", "core.longpaths=true", "-C", root, ...args];
}
