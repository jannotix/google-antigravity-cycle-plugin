/**
 * Every git invocation the plugin makes goes through these arguments.
 *
 * `core.longpaths` is set per invocation rather than written into the user's configuration: without
 * it, git on Windows cannot open a path beyond 260 characters and reports the directory as missing
 * rather than as unreadable. The plugin delegates its ignore policy and its change set to git, so a
 * file git cannot see is a file the index never parses and the candidate never contains — silently.
 * A candidate that is quietly missing a file is the one failure this product cannot tolerate.
 */
export function gitArgs(root: string, args: readonly string[]): string[] {
  return ["-c", "core.longpaths=true", "-C", root, ...args]
}
