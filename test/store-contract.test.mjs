// Holds every block this repo ships, and the loader, to the store contract.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { storeContract } from '../lib/contract.mjs'
import { fileStore } from '../lib/store-file.mjs'
import { installBlock } from '../lib/load-store.mjs'
import { createStore as memory } from '../examples/store-memory.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'board-'))
// Your own blocks folder, which the tests keep apart. board block add asks a
// person at a terminal, so the tests install through the library, as that
// person's yes would.
const BLOCKS = path.join(tmp(), 'blocks')
process.env.BOARD_BLOCKS_DIR = BLOCKS
const install = (src, name) => installBlock(src, name)

storeContract('file', () => fileStore(path.join(tmp(), '.modboard')))
storeContract('memory (example)', () => memory())

function board(dir, args, cwd) {
  try {
    return { code: 0, out: execFileSync('node', [path.join(ROOT, 'bin/board.mjs'), ...args], { env: { ...process.env, BOARD_DIR: dir, BOARD_BLOCKS_DIR: BLOCKS }, encoding: 'utf8', stdio: 'pipe', ...(cwd ? { cwd } : {}) }) }
  } catch (err) {
    return { code: err.status, out: String(err.stderr) }
  }
}

// A block that saves under a folder of its choosing and, when it runs,
// leaves a marker, so a test can tell whether its code ran at all.
const blockSource = (marker = '') =>
  (marker ? `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, 'ran')\n` : '') +
  `import { fileStore } from ${JSON.stringify(path.join(ROOT, 'lib/store-file.mjs'))}\n` +
  `export const createStore = (config, { dir }) => fileStore(dir + '/' + (config.folder ?? 'data'))\n`

// A project with a board, its config naming `store`.
function project(store, extra = {}) {
  const root = tmp()
  const dir = path.join(root, '.modboard')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store, ...extra }))
  return { root, dir }
}

test('a block file you installed loads by name', () => {
  const src = path.join(tmp(), 'my-block.mjs')
  fs.writeFileSync(src, blockSource())
  assert.equal(install(src).name, 'my-block')
  const { dir } = project('my-block', { folder: 'elsewhere' })
  assert.equal(board(dir, ['add', 'hello']).code, 0)
  assert.ok(fs.existsSync(path.join(dir, 'elsewhere', 'board.json')))
  assert.equal(JSON.parse(board(dir, ['doctor', '--json']).out).block, 'my-block')
  assert.match(board(dir, ['block', 'list']).out, /my-block/)
})

test('a package folder you installed loads by its name, in either common shape', () => {
  const shapes = {
    '@acme/board-store': { exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } }, file: 'dist/index.mjs' },
    'plain-store': { main: 'lib/store.mjs', file: 'lib/store.mjs' },
  }
  for (const [name, { file, ...pkg }] of Object.entries(shapes)) {
    const src = path.join(tmp(), 'pkg')
    fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true })
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name, type: 'module', ...pkg }))
    fs.writeFileSync(path.join(src, file), blockSource())
    assert.equal(install(src).name, name)
    const { dir } = project(name, { folder: 'x' })
    assert.equal(board(dir, ['add', 'hello']).code, 0, name)
    assert.equal(JSON.parse(board(dir, ['doctor', '--json']).out).block, name)
  }
})

test('a block that cannot load, or breaks the contract shape, is refused by name', () => {
  const src = path.join(tmp(), 'broken.mjs')
  fs.writeFileSync(src, 'export const createStore = () => { throw new Error("nope") }\nimport "./not-there.mjs"\n')
  install(src)
  const broken = board(project('broken').dir, ['list'])
  assert.equal(broken.code, 2)
  assert.match(broken.out, /cannot load storage block "broken"/)

  const half = path.join(tmp(), 'half.mjs')
  fs.writeFileSync(half, 'export const createStore = () => ({ now: () => 0, snapshot: () => ({}) })\n')
  install(half)
  const shape = board(project('half').dir, ['list'])
  assert.equal(shape.code, 2)
  assert.match(shape.out, /is missing: commit, events, verify/)
})

// The security boundary: a project names a block, but only code you installed runs.

test("a downloaded project's own block never runs: by path, absolute path, or climbing out", () => {
  for (const store of ['./evil.mjs', 'evil.mjs/../evil.mjs', '../evil.mjs', 'sub/evil.mjs']) {
    const { dir } = project(store)
    const marker = path.join(dir, 'ran')
    fs.writeFileSync(path.join(dir, 'evil.mjs'), blockSource(marker))
    const r = board(dir, ['list'])
    assert.equal(r.code, 12, store)
    assert.match(r.out, /only runs blocks you installed yourself/, store)
    assert.equal(fs.existsSync(marker), false, `${store}: the block never ran`)
  }
  const { dir } = project('placeholder')
  const marker = path.join(dir, 'ran')
  fs.writeFileSync(path.join(dir, 'evil.mjs'), blockSource(marker))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: path.join(dir, 'evil.mjs') }))
  assert.equal(board(dir, ['list']).code, 12, 'absolute path')
  assert.equal(fs.existsSync(marker), false)
})

test('a name that tries to climb out of the blocks folder is refused', () => {
  for (const store of ['..', '.hidden', '@x/../../evil', 'a\\..\\evil']) {
    const r = board(project(store).dir, ['list'])
    assert.ok(r.code === 2 || r.code === 12, `${store}: ${r.code} ${r.out}`)
  }
})

test("a project can't stand in for a block through node_modules, installed or not", () => {
  const { root, dir } = project('board-store')
  const marker = path.join(root, 'ran')
  const pkgDir = path.join(root, 'node_modules', 'board-store')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'board-store', type: 'module', main: 'index.mjs' }))
  fs.writeFileSync(path.join(pkgDir, 'index.mjs'), blockSource(marker))

  // Not installed: refused, though the project ships one by that name.
  const r = board(dir, ['list'], root)
  assert.equal(r.code, 12)
  assert.match(r.out, /isn't installed/)
  assert.equal(fs.existsSync(marker), false)

  // Installed: yours runs, never the project's.
  const mine = path.join(tmp(), 'board-store.mjs')
  const mineMarker = path.join(tmp(), 'mine-ran')
  fs.writeFileSync(mine, blockSource(mineMarker))
  install(mine)
  assert.equal(board(dir, ['list'], root).code, 0)
  assert.equal(fs.existsSync(mineMarker), true)
  assert.equal(fs.existsSync(marker), false)
})

test('an installed block is a copy: changing the original in the project changes nothing', () => {
  const src = path.join(tmp(), 'copied.mjs')
  fs.writeFileSync(src, blockSource())
  install(src)
  const marker = path.join(tmp(), 'ran')
  fs.writeFileSync(src, blockSource(marker))
  assert.equal(board(project('copied').dir, ['list']).code, 0)
  assert.equal(fs.existsSync(marker), false)
})

test('a symlink in the blocks folder pointing out of it is refused', () => {
  const outside = path.join(tmp(), 'outside.mjs')
  const marker = path.join(tmp(), 'ran')
  fs.writeFileSync(outside, blockSource(marker))
  fs.mkdirSync(BLOCKS, { recursive: true })
  fs.symlinkSync(outside, path.join(BLOCKS, 'linked.mjs'))
  const r = board(project('linked').dir, ['list'])
  assert.equal(r.code, 12)
  assert.match(r.out, /outside your blocks folder/)
  assert.equal(fs.existsSync(marker), false)
})

test("an agent can't install a block: board block add asks a person at a terminal", () => {
  const src = path.join(tmp(), 'sneaky.mjs')
  fs.writeFileSync(src, blockSource())
  const r = board(project('file').dir, ['block', 'add', src])
  assert.equal(r.code, 2)
  assert.match(r.out, /asks a person to confirm/)
  assert.doesNotMatch(board(project('file').dir, ['block', 'list']).out, /sneaky/)
})

test('the built-in file block needs nothing installed, and a removed block stops loading', () => {
  assert.equal(board(project('file').dir, ['add', 'x']).code, 0)
  assert.equal(board(path.join(tmp(), '.modboard'), ['add', 'x']).code, 0)
  const src = path.join(tmp(), 'gone.mjs')
  fs.writeFileSync(src, blockSource())
  install(src)
  const { dir } = project('gone')
  assert.equal(board(dir, ['list']).code, 0)
  assert.equal(board(dir, ['block', 'remove', 'gone']).code, 0)
  assert.equal(board(dir, ['list']).code, 12)
})

// The file block's own failure modes: a writer that stalls holding the lock,
// and a crash partway through a write.

const bump = (store, by) => {
  const cur = store.snapshot().tasks.counter
  return store.commit({ writes: [{ kind: 'task', key: 'counter', value: { n: (cur?.n ?? 0) + 1 }, expect: cur?.version ?? 0 }], events: [{ type: 'bump', by }] })
}

test('a writer whose lock was taken while it stalled writes nothing, and the other write survives', () => {
  const dir = path.join(tmp(), '.modboard')
  const stalled = fileStore(dir)
  const other = fileStore(dir)
  assert.equal(bump(stalled, 'seed').ok, true)

  // Mid-commit, the stalled writer's lock is judged stale and taken; the
  // other writer commits while it is frozen.
  const append = fs.appendFileSync
  let stolen = false
  fs.appendFileSync = (...args) => {
    if (!stolen) {
      stolen = true
      fs.rmSync(path.join(dir, 'lock'), { recursive: true, force: true })
      assert.equal(bump(other, 'other').ok, true)
    }
    return append(...args)
  }
  let result
  try {
    result = bump(stalled, 'stalled')
  } finally {
    fs.appendFileSync = append
  }
  assert.deepEqual(result, { ok: false, conflict: 'lock' })
  assert.ok(fs.existsSync(path.join(dir, 'lock')) === false, 'the other writer released its lock')
  assert.equal(bump(stalled, 'stalled').ok, true)
  assert.equal(stalled.snapshot().tasks.counter.n, 3)
  assert.deepEqual(stalled.events(0).map(e => e.seq), [1, 2, 3])
  assert.equal(stalled.verify().ok, true)
})

test('a half-written ledger line is skipped by readers, reported, and cut by the next commit', () => {
  const dir = path.join(tmp(), '.modboard')
  const store = fileStore(dir)
  for (let i = 0; i < 3; i++) bump(store, 'a')
  fs.appendFileSync(path.join(dir, 'ledger.jsonl'), '{"seq":4,"at":"2026')
  assert.deepEqual(store.events(0).map(e => e.seq), [1, 2, 3])
  const report = store.verify()
  assert.equal(report.ok, false)
  assert.match(report.problems.join('\n'), /unreadable/)

  assert.equal(bump(store, 'a').ok, true)
  assert.deepEqual(store.events(0).map(e => e.seq), [1, 2, 3, 4])
  assert.equal(store.verify().ok, true)
})

test('an event a crash left in the ledger but not the state is reported, then replaced, not duplicated', () => {
  const dir = path.join(tmp(), '.modboard')
  const store = fileStore(dir)
  bump(store, 'a')
  fs.appendFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify({ seq: 2, at: new Date().toISOString(), type: 'bump', by: 'crashed' }) + '\n')
  assert.equal(store.verify().ok, false)

  assert.equal(bump(store, 'b').ok, true)
  assert.deepEqual(store.events(0).map(e => [e.seq, e.by]), [[1, 'a'], [2, 'b']])
  assert.equal(store.verify().ok, true)
})

test('verify reports a seq used twice', () => {
  const dir = path.join(tmp(), '.modboard')
  const store = fileStore(dir)
  bump(store, 'a')
  bump(store, 'b')
  const ledger = path.join(dir, 'ledger.jsonl')
  const [first, second] = fs.readFileSync(ledger, 'utf8').trim().split('\n')
  fs.writeFileSync(ledger, [first, second.replace('"seq":2', '"seq":1'), ''].join('\n'))
  assert.match(store.verify().problems.join('\n'), /seq 1 comes after seq 1/)
})

test('events after a seq read only the end of a long ledger, and match a full read', () => {
  const dir = path.join(tmp(), '.modboard')
  const store = fileStore(dir)
  for (let i = 0; i < 2000; i++) store.commit({ writes: [], events: [{ type: 'tick', n: i, pad: 'x'.repeat(40) }] })
  const all = store.events(0)
  for (const since of [1, 500, 1990, 1999, 2000]) assert.deepEqual(store.events(since), all.filter(e => e.seq > since), `since ${since}`)
})
