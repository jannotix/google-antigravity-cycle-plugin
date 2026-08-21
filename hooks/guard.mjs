// Layer two of section 5.2: the runtime boundary between the roles.
//
// Reads one PreToolUse payload on stdin and denies the calls a role is not permitted to make —
// a write by a read-only role, a subtask by any role, a git invocation by the executor that would
// move HEAD, rewrite history or destroy the candidate.
//
// It answers only for Cycle's own roles. A payload with no role in it is the user's own session
// and is left alone: a hook that denied what it could not identify would take the application down
// with it. That is also why every failure here is silent — layers one and three do not depend on
// this process running, and a boundary that needs all three to be up is not three layers.

import { fileURLToPath } from 'node:url'

const READ_ONLY = new Set([
  'architect',
  'executor-advisor',
  'functional-reviewer',
  'security-reviewer',
  'arbiter',
  'operator',
])

const ROLES = new Set([...READ_ONLY, 'executor'])

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Verbs that move HEAD, rewrite history, publish, or delete what the candidate is made of. */
const FORBIDDEN_GIT = new Set([
  'am',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'filter-branch',
  'merge',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'tag',
  'worktree',
])

/** git's own options come before the subcommand, and two of them take a value. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

function roleOf(payload) {
  const candidates = [
    payload.agent_type,
    payload.agentType,
    payload.subagent_type,
    payload.agent?.type,
    payload.context?.agent_type,
  ]
  for (const value of candidates) {
    if (typeof value !== 'string' || !value) continue
    const name = value.startsWith('cycle:') ? value.slice('cycle:'.length) : value
    if (ROLES.has(name)) return name
  }
  return null
}

/** Splits a command line on the operators that start a new command, without running any of it. */
function segments(command) {
  return command
    .split(/(?:&&|\|\||[;\n|])/u)
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * Quote-aware, because a Windows git lives at a path with a space in it and stripping the quotes
 * first would break `"C:/Program Files/Git/bin/git.exe" commit` into tokens where no `git` remains.
 */
function tokens(segment) {
  const parts = []
  let current = ''
  let quote = null

  for (const character of segment) {
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
      if (current) parts.push(current)
      current = ''
      continue
    }
    current += character
  }

  if (current) parts.push(current)
  return parts
}

/** The git subcommand in one segment, or null when the segment does not invoke git. */
function gitVerb(segment) {
  const parts = tokens(segment)
  let index = 0
  // Leading environment assignments are not the program.
  while (index < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(parts[index])) index += 1

  const program = parts[index]
  if (program === undefined) return null
  const base = program.split(/[\\/]/u).at(-1)?.replace(/\.exe$/iu, '')
  if (base !== 'git') return null

  index += 1
  while (index < parts.length) {
    const option = parts[index]
    if (!option.startsWith('-')) return option.toLowerCase()
    if (option.includes('=')) {
      index += 1
      continue
    }
    index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1
  }
  return null
}

/** The decision for one payload, or null when this hook has no opinion about it. */
export function decide(payload) {
  const role = roleOf(payload)
  if (role === null) return null

  const tool = String(payload.tool_name ?? payload.toolName ?? '')

  if (tool === 'Task') {
    return deny(
      `The ${role} may not spawn a subtask. Every Cycle role runs in one isolated session, and a ` +
        'role that could delegate would move work outside the boundary it was given.',
    )
  }

  if (WRITE_TOOLS.has(tool) && READ_ONLY.has(role)) {
    return deny(
      `The ${role} is read-only. Only the executor modifies files, and only inside the write ` +
        'scopes of its assigned task.',
    )
  }

  if (tool !== 'Bash') return null

  if (READ_ONLY.has(role)) {
    return deny(
      `The ${role} is read-only and may not run commands. Inspect the repository with the ` +
        'read-only tools instead.',
    )
  }

  const command = String(payload.tool_input?.command ?? payload.toolInput?.command ?? '')
  for (const segment of segments(command)) {
    const verb = gitVerb(segment)
    if (verb !== null && FORBIDDEN_GIT.has(verb)) {
      return deny(
        `The executor may not run \`git ${verb}\`. The candidate is frozen byte for byte and ` +
          'delivered by the control plane; a role that could move HEAD or rewrite history could ' +
          'change what an arbiter approved after it was approved.',
      )
    }
  }

  return null
}

// Only when run as the hook itself; importing it for tests must not consume stdin.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    raw += chunk
  })
  process.stdin.on('end', () => {
    let decision = null
    try {
      decision = decide(JSON.parse(raw))
    } catch {
      decision = null
    }
    if (decision !== null) process.stdout.write(JSON.stringify(decision))
    process.exit(0)
  })
}
