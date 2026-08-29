import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const name = `cycle-antigravity-${pkg.version}.zip`
const artifact = readFileSync(join(root, 'build', name))
const digest = createHash('sha256').update(artifact).digest('hex')
const expected = readFileSync(join(root, 'build', `${name}.sha256`), 'utf8').trim().split(/\s+/u)[0]
if (digest !== expected) throw new Error('artifact checksum does not match its checksum file')
const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
if (status !== '' && !process.argv.includes('--allow-dirty')) throw new Error('refusing provenance for a dirty checkout')
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const sourceDate = execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const provenance = {
  artifact: name,
  artifactSha256: digest,
  buildType: 'https://github.com/jannotix/google-antigravity-cycle-plugin/.github/workflows/release-candidate.yml',
  builder: { node: process.version, platform: `${process.platform}/${process.arch}` },
  dirty: status !== '',
  source: { repository: pkg.repository.url, revision: sha, revisionCommittedAt: sourceDate },
  version: pkg.version,
}
const output = join(root, 'build', `${name}.provenance.json`)
writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`)
console.log(`${output}: ${digest}`)
