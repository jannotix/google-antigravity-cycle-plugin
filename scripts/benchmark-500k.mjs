import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { statfsSync } from 'node:fs'
import { freemem, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { indexProject } from '../dist/intel/indexer.js'
import { Database } from '../dist/store/database.js'

const count = positiveIntegerOption('--files', 500_000)
const memoryFloor = positiveNumberOption('--minimum-free-memory-gib', 8) * 1024 ** 3
const diskFloor = positiveNumberOption('--minimum-free-disk-gib', 15) * 1024 ** 3
const output = resolve(stringOption('--output-dir', join(process.cwd(), 'certification-artifacts')))
mkdirSync(output, { recursive: true })
const availableMemory = freemem()
const disk = statfsSync(tmpdir())
const availableDisk = Number(disk.bavail) * Number(disk.bsize)

if (availableMemory < memoryFloor || availableDisk < diskFloor) {
  const report = {
    availableDiskBytes: availableDisk,
    availableMemoryBytes: availableMemory,
    requestedFiles: count,
    requiredDiskBytes: diskFloor,
    requiredMemoryBytes: memoryFloor,
    status: 'BLOCKED_RESOURCE_ADMISSION',
  }
  writeFileSync(join(output, 'benchmark-500k.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.error(`benchmark blocked: memory=${availableMemory}, disk=${availableDisk}`)
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), 'cycle-500k-'))
const database = new Database({ path: join(root, 'index.db') })
try {
  const project = join(root, 'project')
  mkdirSync(project)
  execFileSync('git', ['init', '--quiet'], { cwd: project })
  const generatedAt = Date.now()
  for (let index = 0; index < count; index += 1) {
    const directory = join(project, `d${Math.floor(index / 1000).toString().padStart(4, '0')}`)
    if (index % 1000 === 0) mkdirSync(directory)
    const semantic = index % 10 === 0
    const content = semantic ? `export const value${index} = ${index}\n` : `// file ${index}\n`
    writeFileSync(join(directory, `f${index}.js`), content)
  }
  const generationMs = Date.now() - generatedAt
  const coldAt = Date.now()
  const cold = await indexProject(database, 'benchmark-500k', project)
  const coldMs = Date.now() - coldAt
  const warmAt = Date.now()
  const warm = await indexProject(database, 'benchmark-500k', project)
  const warmMs = Date.now() - warmAt
  const report = {
    cold,
    coldMs,
    fileMix: { symbolBearingJavaScript: Math.ceil(count / 10), syntaxOnlyJavaScript: count - Math.ceil(count / 10) },
    generatedFiles: count,
    generationMs,
    peakRssBytes: process.memoryUsage().rss,
    status:
      cold.files === count &&
      cold.updated === count &&
      cold.skipped === 0 &&
      warm.updated === 0 &&
      warm.unchanged === count
        ? 'PASS'
        : 'FAIL',
    warm,
    warmMs,
  }
  writeFileSync(join(output, 'benchmark-500k.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`benchmark ${report.status}: cold=${coldMs}ms warm=${warmMs}ms files=${count}`)
  if (report.status !== 'PASS') process.exitCode = 1
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}

function positiveIntegerOption(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function positiveNumberOption(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}

function stringOption(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value) throw new Error(`${name} requires a value`)
  return value
}
