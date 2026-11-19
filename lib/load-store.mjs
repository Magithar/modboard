// Finds the storage block a board's config.json names and plugs it in.
//
//   { "store": "file" }                    the built-in block (the default)
//   { "store": "./stores/supabase.mjs" }   a block file, relative to .modboard/
//   { "store": "modboard-supabase" }    a block published as a package
//
// A block is a module exporting createStore(config, { dir }), which returns a
// Store (the contract is written out in lib/store-file.mjs). The rest of
// config.json is the block's own: a URL, which env var holds its key, and so on.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BoardError } from './engine.mjs'
import * as file from './store-file.mjs'

const BUILT_IN = { file }
const METHODS = ['now', 'snapshot', 'commit', 'events', 'verify']

// A package block is looked up from the board's folder upward, the way Node
// would from the project that installed it. A bare import() would look only
// beside modboard itself. Returns its entry as a file URL, or null when no
// node_modules above the board has it (import() then tries modboard's own).
function findPackage(spec, dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const pkgDir = path.join(d, 'node_modules', spec)
    const pkgFile = path.join(pkgDir, 'package.json')
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
      return pathToFileURL(path.join(pkgDir, entryOf(pkg))).href
    }
    if (path.dirname(d) === d) return null
  }
}

// The package's main entry for an ESM import: exports['.'] (or exports
// itself), taking the import, then node, then default condition, else main.
function entryOf(pkg) {
  let e = pkg.exports
  if (e && typeof e === 'object' && '.' in e) e = e['.']
  while (e && typeof e === 'object') e = e.import ?? e.node ?? e.default
  return typeof e === 'string' ? e : (pkg.main ?? 'index.js')
}

export async function loadStore(dir) {
  const configFile = path.join(dir, 'config.json')
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {}
  const spec = config.store ?? 'file'

  let block = BUILT_IN[spec]
  if (!block) {
    const target = spec.startsWith('.') || path.isAbsolute(spec) ? pathToFileURL(path.resolve(dir, spec)).href : (findPackage(spec, dir) ?? spec)
    try {
      block = await import(target)
    } catch (err) {
      throw new BoardError(2, `cannot load storage block "${spec}": ${err.message}`)
    }
  }
  if (typeof block.createStore !== 'function') throw new BoardError(2, `storage block "${spec}" does not export createStore`)

  const store = await block.createStore(config, { dir })
  const missing = METHODS.filter(m => typeof store?.[m] !== 'function')
  if (missing.length) throw new BoardError(2, `storage block "${spec}" is missing: ${missing.join(', ')}`)
  return { store, name: spec }
}
