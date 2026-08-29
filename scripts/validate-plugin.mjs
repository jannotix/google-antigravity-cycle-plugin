import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'))
const fields = Object.keys(manifest).sort()
if (JSON.stringify(fields) !== JSON.stringify(['description', 'name']) || manifest.name !== 'cycle') {
  throw new Error('plugin.json does not match the Antigravity manifest contract')
}
for (const required of ['mcp_config.json', 'hooks.json', 'dist/server.js']) {
  if (!(await stat(join(root, required))).isFile()) throw new Error(`missing ${required}`)
}
const mcp = JSON.parse(await readFile(join(root, 'mcp_config.json'), 'utf8'))
if (Object.keys(mcp.mcpServers ?? {}).length !== 1) throw new Error('expected one MCP server')
const hooks = JSON.parse(await readFile(join(root, 'hooks.json'), 'utf8'))
if (Object.keys(hooks).length !== 1) throw new Error('expected one native hook')
const skills = (await readdir(join(root, 'skills'), { withFileTypes: true })).filter((entry) => entry.isDirectory())
const agents = (await readdir(join(root, 'agents'), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
if (skills.length !== 24) throw new Error(`expected 24 skills, found ${skills.length}`)
if (agents.length !== 7) throw new Error(`expected 7 agents, found ${agents.length}`)
for (const agent of agents) {
  const text = await readFile(join(root, 'agents', agent.name), 'utf8')
  for (const field of ['tools:', 'mainAgent:', 'subagent:', 'commandExecutionPolicy:']) {
    if (!text.includes(field)) throw new Error(`${agent.name} is missing ${field}`)
  }
  if (/disallowedTools|\bTask\b|\bBash\b/u.test(text.split('---')[1] ?? '')) {
    throw new Error(`${agent.name} contains Claude-specific frontmatter`)
  }
}
console.log(`Antigravity contract: ${skills.length} skills, ${agents.length} agents, 1 MCP, 1 hook`)
