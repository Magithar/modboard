// Finds the storage block a board's config.json names and plugs it in.
//
//   { "store": "file" }                 the built-in block (the default)
//   { "store": "supabase" }             a block you installed: board block add
//   { "store": "@acme/board-store" }    the same, installed from a package folder
//
// A block is a module exporting createStore(config, { dir }), which returns a
// Store (the contract is written out in lib/store-file.mjs). The rest of
// config.json is the block's own: a URL, which env var holds its key, and so on.
//
// Where the code comes from is the security boundary. .modboard/ sits in the
// project, so a repo you clone can say anything there. So config.json may
// only name a block; the code is looked up in your own blocks folder
// (~/.config/modboard/blocks, or BOARD_BLOCKS_DIR), never in the project or
// its node_modules, and a path is refused. A block gets into that folder only
// through `board block add`, which a person confirms at a terminal.
//
// This guards how modBOARD loads blocks. It does not sandbox a block you
// installed (it runs with modBOARD's own access), and it does not stop an
// agent from running a project's code some other way.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BoardError } from './engine.mjs'
import * as file from './store-file.mjs'

const BUILT_IN = { file }
const METHODS = ['now', 'snapshot', 'commit', 'events', 'verify']

// A block's name: a package-style name, optionally scoped. No slashes beyond
// the scope's, no dots leading, so a name can't climb out of the folder.
const NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const FILE_EXTS = ['.mjs', '.js']

export const blocksDir = () =>
  process.env.BOARD_BLOCKS_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'modboard', 'blocks')

const real = p => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

// Inside the blocks folder, after symlinks are followed.
function insideBlocks(p) {
  const root = real(blocksDir())
  const at = real(p)
  return !!root && !!at && (at === root || at.startsWith(root + path.sep))
}

// The package's main entry for an ESM import: exports['.'] (or exports
// itself), taking the import, then node, then default condition, else main.
function entryOf(pkg) {
  let e = pkg.exports
  if (e && typeof e === 'object' && '.' in e) e = e['.']
  while (e && typeof e === 'object') e = e.import ?? e.node ?? e.default
  return typeof e === 'string' ? e : (pkg.main ?? 'index.js')
}

// The entry file of the block installed as `name`, or null when there is
// none. Refused when it lands outside the blocks folder (a symlink, or a
// package whose entry points out of it).
function installedEntry(name) {
  const base = path.join(blocksDir(), name)
  let entry = null
  for (const ext of FILE_EXTS) if (fs.existsSync(base + ext)) entry ??= base + ext
  if (!entry && fs.existsSync(path.join(base, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'))
    entry = path.join(base, entryOf(pkg))
  } else if (!entry && fs.existsSync(path.join(base, 'index.mjs'))) entry = path.join(base, 'index.mjs')
  if (!entry || !fs.existsSync(entry)) return null
  if (!insideBlocks(entry)) throw new BoardError(12, `storage block "${name}" points outside your blocks folder (${blocksDir()}); it won't run`)
  return entry
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
  return { configFile, config, spec: String(config.store ?? 'file') }
}

const looksLikePath = spec => spec.startsWith('.') || path.isAbsolute(spec) || spec.includes('\\') || (spec.includes('/') && !spec.startsWith('@'))

export async function loadStore(dir) {
  const { configFile, config, spec } = readConfig(dir)

  let block = BUILT_IN[spec]
  if (!block) {
    // What to do comes first: a pane or toast cuts the end of a long line.
    if (looksLikePath(spec)) {
      const at = path.resolve(dir, spec)
      throw new BoardError(
        12,
        `storage block "${spec}" is a file in this project, and modBOARD only runs blocks you installed yourself: ` +
          `read it, then run board block add at a terminal. The block: ${at}, named in ${configFile}`,
      )
    }
    if (!NAME.test(spec)) throw new BoardError(2, `"${spec}" in ${configFile} isn't a block name`)
    const entry = installedEntry(spec)
    if (!entry)
      throw new BoardError(
        12,
        `storage block "${spec}" isn't installed: install it yourself with board block add at a terminal, or ask whoever set up this board. Named in ${configFile}`,
      )
    try {
      block = await import(pathToFileURL(entry).href)
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

// ── Installing ───────────────────────────────────────────────────────────────
// board block add copies a block into the blocks folder: a single .mjs/.js
// file, or a folder (a package, with package.json, or one with index.mjs),
// symlinks followed, so later changes in the project don't reach it.

const CODE = /\.(m|c)?(j|t)sx?$|^package\.json$/

// The code files a folder holds, for a person to see before installing.
export function codeFiles(root) {
  const out = []
  const walk = d => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (CODE.test(e.name)) out.push(p)
    }
  }
  walk(root)
  return out
}

// What `board block add <src>` would install, under which name. Refuses what
// isn't a block.
export function blockPlan(src, name) {
  const from = path.resolve(src)
  const stat = fs.statSync(from, { throwIfNoEntry: false })
  if (!stat) throw new BoardError(2, `no file or folder at ${from}`)
  let as = name
  if (stat.isFile()) {
    const ext = path.extname(from)
    if (!FILE_EXTS.includes(ext)) throw new BoardError(2, `a block file is .mjs or .js: ${from}`)
    as ??= path.basename(from, ext)
    return { from, name: as, kind: 'file', ext, files: [from] }
  }
  const pkgFile = path.join(from, 'package.json')
  const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')) : null
  if (!pkg && !fs.existsSync(path.join(from, 'index.mjs'))) throw new BoardError(2, `${from} has no package.json or index.mjs, so it isn't a block`)
  as ??= pkg?.name ?? path.basename(from)
  return { from, name: as, kind: 'folder', files: codeFiles(from) }
}

export function installBlock(src, name) {
  const plan = blockPlan(src, name)
  if (!NAME.test(plan.name)) throw new BoardError(2, `"${plan.name}" isn't a block name; give one with --name (letters, digits, . _ -)`)
  if (BUILT_IN[plan.name]) throw new BoardError(2, `"${plan.name}" is a built-in block; give another with --name`)
  if (insideBlocks(plan.from)) throw new BoardError(2, `${plan.from} is in your blocks folder already`)
  const base = path.join(blocksDir(), plan.name)
  removeInstalled(plan.name)
  fs.mkdirSync(path.dirname(base), { recursive: true })
  if (plan.kind === 'file') fs.copyFileSync(plan.from, base + plan.ext)
  else fs.cpSync(plan.from, base, { recursive: true, dereference: true })
  return { name: plan.name, at: plan.kind === 'file' ? base + plan.ext : base }
}

function removeInstalled(name) {
  const base = path.join(blocksDir(), name)
  let removed = false
  for (const p of [base, ...FILE_EXTS.map(ext => base + ext)])
    if (fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false })) {
      fs.rmSync(p, { recursive: true, force: true })
      removed = true
    }
  return removed
}

export function removeBlock(name) {
  if (!NAME.test(name)) throw new BoardError(2, `"${name}" isn't a block name`)
  if (!removeInstalled(name)) throw new BoardError(4, `no block "${name}" is installed`)
  return { name }
}

export function listBlocks() {
  const root = blocksDir()
  const names = []
  const read = (d, scope = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      if (!scope && e.name.startsWith('@') && e.isDirectory()) read(path.join(d, e.name), `${e.name}/`)
      else if (e.isDirectory()) names.push(scope + e.name)
      else if (FILE_EXTS.includes(path.extname(e.name))) names.push(scope + path.basename(e.name, path.extname(e.name)))
    }
  }
  if (fs.existsSync(root)) read(root)
  return { dir: root, blocks: names.sort() }
}
