/**
 * Verification commands run without a shell. These rules are enforced when the plan is validated,
 * long before anything executes, so an unsafe command is a rejected plan rather than a run-time
 * refusal. The evidence runner applies the same rules again at execution.
 */

const BLOCKED_PROGRAMS = new Set([
  "bash",
  "cmd",
  "del",
  "git",
  "powershell",
  "pwsh",
  "rm",
  "sh",
  "shutdown",
  "sudo",
  "zsh",
])

const BLOCKED_ARGUMENTS = new Set([
  "deploy",
  "destroy",
  "drop",
  "publish",
  "push",
  "reset",
])

const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "<", ">", ">>", "&"])

export interface SafeCommand {
  readonly arguments: readonly string[]
  readonly program: string
}

export class UnsafeCommand extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeCommand"
  }
}

/** Splits on whitespace honouring quotes; a shell is never involved, here or later. */
export function parseCommand(command: string): SafeCommand {
  const words = tokenize(command)
  const [program, ...args] = words
  if (program === undefined) throw new UnsafeCommand("verification command is empty")

  assertSafe(program, args)
  return { arguments: args, program }
}

export function assertSafe(program: string, args: readonly string[]): void {
  if (!program.trim() || /[\0\n\r]/u.test(program)) {
    throw new UnsafeCommand("verification program is empty or contains a control character")
  }

  const executable = program
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1)$/iu, "")
    .toLowerCase()

  if (BLOCKED_PROGRAMS.has(executable)) {
    throw new UnsafeCommand(
      `${executable} cannot be a verification command: gates run without a shell and must not ` +
        "alter the repository",
    )
  }

  for (const argument of args) {
    if (/[\0\n\r]/u.test(argument)) {
      throw new UnsafeCommand("verification argument contains a control character")
    }
    if (SHELL_OPERATORS.has(argument)) {
      throw new UnsafeCommand(
        `${argument} has no meaning without a shell; split the work into separate commands`,
      )
    }
    if (BLOCKED_ARGUMENTS.has(argument.toLowerCase())) {
      throw new UnsafeCommand(`${argument} is not permitted in a verification command`)
    }
  }
}

export function normalizeInvocation(command: SafeCommand): string {
  return [command.program, ...command.arguments].join("")
}

function tokenize(command: string): string[] {
  const words: string[] = []
  let current = ""
  let quote: string | null = null

  for (const character of command.trim()) {
    if (quote !== null) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/u.test(character)) {
      if (current) words.push(current)
      current = ""
      continue
    }
    current += character
  }

  if (quote !== null) throw new UnsafeCommand("verification command has an unterminated quote")
  if (current) words.push(current)
  return words
}
