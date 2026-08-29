// Writes a CycloneDX bill of materials for what the artifact actually ships.
//
//   node scripts/sbom.mjs           # write sbom.cdx.json
//   node scripts/sbom.mjs --check   # fail if the file on disk is not what this would write
//
// Cycle installs no packages: it has no runtime dependencies to resolve. What it does ship is a
// parser runtime and twelve grammars, vendored as WebAssembly so installation needs no compiler and
// no network. Those are the components a consumer needs an inventory of, so those are what this
// lists — read from the files that are really in vendor/, not from a list kept by hand beside them.
//
// Stated rather than glossed: the vendored artifacts carry no version or commit metadata and the
// build records no provenance for them, so every component here names its project and its licence
// and leaves `version` unset. An SBOM that invented version numbers would be worse than one that
// admits it does not know them.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'sbom.cdx.json')

const RUNTIME = {
  copyright: 'Copyright (c) 2018 Max Brunsfeld',
  files: ['vendor/runtime/tree-sitter.cjs', 'vendor/runtime/tree-sitter.wasm'],
  name: 'web-tree-sitter',
  url: 'https://github.com/tree-sitter/tree-sitter',
}

/** Grammar file stem to the project it came from and the copyright that project's LICENSE carries. */
const GRAMMARS = {
  'c-sharp': ['tree-sitter-c-sharp', 'Copyright (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors.'],
  cpp: ['tree-sitter-cpp', 'Copyright (c) 2014 Max Brunsfeld'],
  css: ['tree-sitter-css', 'Copyright (c) 2018 Max Brunsfeld'],
  go: ['tree-sitter-go', 'Copyright (c) 2014 Max Brunsfeld'],
  java: ['tree-sitter-java', 'Copyright (c) 2017 Ayman Nadeem'],
  javascript: ['tree-sitter-javascript', 'Copyright (c) 2014 Max Brunsfeld'],
  php: ['tree-sitter-php', 'Copyright (c) 2017 Josh Vera, GitHub; Copyright (c) 2019 Max Brunsfeld, Amaan Qureshi, Christian Froystad, Caleb White'],
  python: ['tree-sitter-python', 'Copyright (c) 2016 Max Brunsfeld'],
  ruby: ['tree-sitter-ruby', 'Copyright (c) 2016 Rob Rix'],
  rust: ['tree-sitter-rust', 'Copyright (c) 2017 Maxim Sokolov'],
  tsx: ['tree-sitter-typescript', 'Copyright (c) 2017 Max Brunsfeld'],
  typescript: ['tree-sitter-typescript', 'Copyright (c) 2017 Max Brunsfeld'],
}

const sha256 = (path) => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')

function component(name, url, copyright, files) {
  return {
    copyright,
    description: `Vendored as WebAssembly; shipped at ${files.join(', ')}`,
    externalReferences: [{ type: 'vcs', url }],
    hashes: files.map((path) => ({ alg: 'SHA-256', content: sha256(path) })),
    licenses: [{ license: { id: 'MIT' } }],
    name,
    scope: 'required',
    type: 'library',
  }
}

const stems = readdirSync(join(ROOT, 'vendor', 'grammars'))
  .filter((entry) => entry.endsWith('.wasm'))
  .map((entry) => entry.replace(/\.wasm$/u, ''))
  .sort()

const missing = stems.filter((stem) => GRAMMARS[stem] === undefined)
if (missing.length > 0) {
  // A grammar added to vendor/ without its attribution would otherwise ship unlisted, which is the
  // whole failure this file exists to prevent.
  console.error(`vendored grammars with no recorded attribution: ${missing.join(', ')}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const document = {
  bomFormat: 'CycloneDX',
  components: [
    component(RUNTIME.name, RUNTIME.url, RUNTIME.copyright, RUNTIME.files),
    ...stems.map((stem) => {
      const [project, copyright] = GRAMMARS[stem]
      return component(project, `https://github.com/tree-sitter/${project}`, copyright, [
        `vendor/grammars/${stem}.wasm`,
      ])
    }),
  ],
  metadata: {
    component: {
      description: manifest.description,
      licenses: [{ license: { name: 'FSL-1.1-MIT' } }],
      name: manifest.name,
      type: 'application',
      version: manifest.version,
    },
    properties: [
      {
        name: 'cycle:provenance',
        value:
          'The vendored artifacts carry no version or commit metadata and the build records none, ' +
          'so components name their project and licence and leave version unset. Pinning the ' +
          'upstream revision of each bundled file is open work.',
      },
    ],
  },
  specVersion: '1.5',
  version: 1,
}

const serialised = `${JSON.stringify(document, null, 2)}\n`

if (process.argv.includes('--check')) {
  const existing = readFileSync(OUTPUT, 'utf8')
  if (existing !== serialised) {
    console.error('sbom.cdx.json is not what vendor/ would produce; run: node scripts/sbom.mjs')
    process.exit(1)
  }
  console.log(`sbom.cdx.json matches vendor/ (${document.components.length} components)`)
} else {
  writeFileSync(OUTPUT, serialised)
  console.log(`sbom.cdx.json written (${document.components.length} components)`)
}
