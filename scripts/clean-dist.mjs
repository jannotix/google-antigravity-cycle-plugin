import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(process.cwd())
const dist = resolve(join(root, 'dist'))
if (!dist.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
  throw new Error('refusing to clean a dist directory outside the project')
}
await rm(dist, { recursive: true, force: true })
