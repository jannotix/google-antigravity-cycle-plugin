#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const REQUIRED = ['plugin.json', 'mcp_config.json', 'hooks.json', 'dist/server.js']
const command = process.argv[2]
const options = parse(process.argv.slice(3))
const configRoot = resolve(options.configRoot ?? process.env.GEMINI_CONFIG_DIR ?? join(homedir(), '.gemini', 'config'))
const plugins = join(configRoot, 'plugins')
const target = join(plugins, 'cycle')
const backups = join(configRoot, 'cycle-backups')

if (!['install', 'upgrade', 'rollback', 'uninstall'].includes(command ?? '')) {
  fail('usage: cycle-lifecycle <install|upgrade|rollback|uninstall> [--source DIR] [--config-root DIR] [--backup DIR]')
}

await mkdir(plugins, { recursive: true })
await mkdir(backups, { recursive: true })

if (command === 'uninstall') {
  const backup = await preserve(target)
  print({ action: command, backup, installed: false, target })
} else if (command === 'rollback') {
  const source = options.backup ? resolve(options.backup) : await latestBackup()
  if (source === null) fail('no Cycle backup is available')
  await validateTree(source)
  const replaced = await preserve(target)
  await installFrom(source)
  print({ action: command, installed: true, restoredFrom: source, replaced, target })
} else {
  const source = resolve(options.source ?? process.cwd())
  await validateTree(source)
  const backup = await preserve(target)
  try {
    await installFrom(source)
  } catch (error) {
    if (backup !== null) await installFrom(backup)
    throw error
  }
  print({ action: command, backup, installed: true, source, target })
}

async function installFrom(source) {
  const staging = join(plugins, `.cycle-staging-${randomUUID()}`)
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    await validateTree(staging)
    await rename(staging, target)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function preserve(path) {
  if (!(await exists(path))) return null
  const destination = join(backups, `${timestamp()}-${basename(path)}`)
  await rename(path, destination)
  return destination
}

async function latestBackup() {
  const entries = await readdir(backups, { withFileTypes: true })
  const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => join(backups, entry.name)).sort().reverse()
  return candidates[0] ?? null
}

async function validateTree(root) {
  for (const path of REQUIRED) {
    const item = await stat(join(root, path)).catch(() => null)
    if (item === null || !item.isFile()) fail(`plugin source is missing ${path}`)
  }
  await rejectLinks(root)
  const manifest = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(join(root, 'plugin.json'), 'utf8')))
  if (manifest.name !== 'cycle') fail('plugin source has the wrong manifest name')
}

async function rejectLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail(`plugin source contains a symbolic link: ${join(directory, entry.name)}`)
    if (entry.isDirectory()) await rejectLinks(join(directory, entry.name))
  }
}

async function exists(path) { return stat(path).then(() => true, () => false) }
function timestamp() { return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') }
function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }
function fail(message) { throw new Error(message) }
function parse(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || value === undefined) fail(`invalid option: ${key ?? ''}`)
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    parsed[name] = value
  }
  return parsed
}
