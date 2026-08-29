// Antigravity PreToolUse safety hook. Role separation is enforced by each custom agent's explicit
// `tools` allowlist. This second layer covers the executor's required run_command capability and
// never removes the user's authority: high-impact commands are forced through an approval prompt.

import { fileURLToPath } from 'node:url'

const HIGH_IMPACT = [
  { pattern: /(?:^|[;&|]\s*)git\s+(?:[^;&|]*\s)?(?:push|tag|commit|reset|clean|rebase|filter-branch)\b/iu, reason: 'changes Git history or publishes repository state' },
  { pattern: /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+publish\b/iu, reason: 'publishes a package' },
  { pattern: /(?:^|[;&|]\s*)cargo\s+publish\b/iu, reason: 'publishes a crate' },
  { pattern: /(?:^|[;&|]\s*)gh\s+release\s+(?:create|delete|edit)\b/iu, reason: 'changes a public release' },
  { pattern: /\brm\s+-[^\r\n]*r[^\r\n]*f\b|\bRemove-Item\b[^\r\n]*(?:-Recurse|-Force)|\brmdir\s+\/s\b/iu, reason: 'recursively deletes files' },
]

export function decide(payload) {
  const call = payload?.toolCall
  if (call?.name !== 'run_command') return { decision: 'allow' }
  const command = String(call.args?.CommandLine ?? '')
  for (const rule of HIGH_IMPACT) {
    if (rule.pattern.test(command)) {
      return {
        decision: 'force_ask',
        reason: `Cycle requires explicit user approval because this command ${rule.reason}.`,
      }
    }
  }
  return { decision: 'allow' }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { raw += chunk })
  process.stdin.on('end', () => {
    try {
      process.stdout.write(JSON.stringify(decide(JSON.parse(raw))))
    } catch {
      process.stdout.write(JSON.stringify({
        decision: 'ask',
        reason: 'Cycle could not parse the safety-hook payload; review this command manually.',
      }))
    }
  })
}
