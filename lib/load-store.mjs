// Finds the storage block a board's config.json names and plugs it in.
//
//   { "store": "file" }                    the built-in block (the default)
//   { "store": "./stores/supabase.mjs" }   a block file, relative to .modboard/
//   { "store": "modboard-supabase" }    a block published as a package
//
// A block is a module exporting createStore(config, { dir }), which returns a
// Store (the contract is written out in lib/store-file.mjs). The rest of
// config.json is the block's own: a URL, which env var holds its key, and so on.
//
// A block other than the built-in one is code, and .modboard/ sits in the
// project, so a repo you cloned could name one. It runs only once you have
// trusted it (`board trust`), which records a fingerprint of config.json and
// the block's file in your own config, outside the project. A change to
// either asks again.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

function readConfig(dir) {
  const configFile = path.join(dir, 'config.json')
  const raw = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''
  let config = {}
  try {
    config = raw ? JSON.parse(raw) : {}
  } catch (err) {
    throw new BoardError(2, `${configFile} is not valid JSON: ${err.message}`)
  }
  return { raw, config, spec: config.store ?? 'file' }
}

// Where a non-built-in block's code is: a file URL, or a bare name Node
// resolves beside modboard itself.
const targetOf = (spec, dir) =>
  spec.startsWith('.') || path.isAbsolute(spec) ? pathToFileURL(path.resolve(dir, spec)).href : (findPackage(spec, dir) ?? spec)

// What trusting a board covers: its config.json and the block's code. For a
// block file, every code file in its folder and below; for a package, every
// code file in the package. So a helper the block imports can't change
// unseen. (Packages it depends on, in their own node_modules, are not read.)
const CODE = /\.(m|c)?(j|t)sx?$|^package\.json$/
const MAX_FILES = 2000

function codeFiles(root) {
  const out = []
  const walk = d => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      if (e.name.startsWith('.') && e.isDirectory()) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p)
      } else if (e.isFile() && CODE.test(e.name)) out.push(p)
    }
  }
  walk(root)
  return out
}

function fingerprint(dir, raw, target) {
  const hash = crypto.createHash('sha256').update(raw).update('\0')
  if (!target.startsWith('file:')) return hash.update(target).digest('hex')
  const file = fileURLToPath(target)
  const root = (file.includes(`${path.sep}node_modules${path.sep}`) && findPackageDir(file)) || path.dirname(file)
  // The entry first, so a missing one never matches a trust made when it existed.
  hash.update(fs.existsSync(file) ? fs.readFileSync(file) : 'missing')
  for (const f of codeFiles(root)) hash.update('\0').update(path.relative(root, f)).update('\0').update(fs.readFileSync(f))
  return hash.digest('hex')
}

// The package folder holding a file under node_modules.
function findPackageDir(file) {
  for (let d = path.dirname(file); path.dirname(d) !== d; d = path.dirname(d)) if (fs.existsSync(path.join(d, 'package.json'))) return d
  return ''
}

// What `board trust` shows before asking: the block, and the code it covers.
export function trustPreview(dir) {
  const { spec } = readConfig(dir)
  if (BUILT_IN[spec]) return { block: spec, needed: false }
  const target = targetOf(spec, dir)
  if (!target.startsWith('file:')) return { block: spec, needed: true, code: target, files: [] }
  const file = fileURLToPath(target)
  const root = (file.includes(`${path.sep}node_modules${path.sep}`) && findPackageDir(file)) || path.dirname(file)
  return { block: spec, needed: true, code: file, files: codeFiles(root).map(f => path.relative(process.cwd(), f)) }
}

export const trustFile = () =>
  process.env.BOARD_TRUST_FILE ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'modboard', 'trusted.json')

const readTrust = () => {
  try {
    return JSON.parse(fs.readFileSync(trustFile(), 'utf8'))
  } catch {
    return {}
  }
}
const boardKey = dir => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

// `board trust`: record this board's block as yours to run. Answers what was
// trusted, or that the built-in block needs no trust.
export function trustBoard(dir) {
  const { raw, spec } = readConfig(dir)
  if (BUILT_IN[spec]) return { block: spec, needed: false }
  const target = targetOf(spec, dir)
  const trusted = readTrust()
  trusted[boardKey(dir)] = { block: spec, sha256: fingerprint(dir, raw, target), at: new Date().toISOString() }
  fs.mkdirSync(path.dirname(trustFile()), { recursive: true })
  fs.writeFileSync(trustFile(), JSON.stringify(trusted, null, 2) + '\n')
  return { block: spec, needed: true, code: target.startsWith('file:') ? fileURLToPath(target) : target }
}

export async function loadStore(dir) {
  const { raw, config, spec } = readConfig(dir)

  let block = BUILT_IN[spec]
  if (!block) {
    const target = targetOf(spec, dir)
    const entry = readTrust()[boardKey(dir)]
    if (entry?.sha256 !== fingerprint(dir, raw, target)) {
      const where = target.startsWith('file:') ? fileURLToPath(target) : target
      // What to do comes first: a pane or toast cuts the end of a long line.
      throw new BoardError(
        12,
        `storage block "${spec}" runs code on this machine and ${entry ? 'changed since you trusted it' : "isn't trusted yet"}. ` +
          `Read ${where} (named in ${path.join(dir, 'config.json')}), then run board trust at a terminal`,
      )
    }
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
