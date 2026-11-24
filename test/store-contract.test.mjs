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
import { createStore as memory } from '../examples/store-memory.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'board-'))
// Trust is recorded in the user's config; these tests keep their own.
const TRUST = path.join(tmp(), 'trusted.json')

storeContract('file', () => fileStore(path.join(tmp(), '.modboard')))
storeContract('memory (example)', () => memory())

function board(dir, args) {
  try {
    return { code: 0, out: execFileSync('node', [path.join(ROOT, 'bin/board.mjs'), ...args], { env: { ...process.env, BOARD_DIR: dir, BOARD_TRUST_FILE: TRUST }, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (err) {
    return { code: err.status, out: String(err.stderr) }
  }
}

test('config.json can name a block file, which the CLI loads', () => {
  const dir = path.join(tmp(), '.modboard')
  fs.mkdirSync(dir, { recursive: true })
  // A block of its own: the file block, saving under a folder of its choosing.
  fs.writeFileSync(
    path.join(dir, 'my-block.mjs'),
    `import { fileStore } from ${JSON.stringify(path.join(ROOT, 'lib/store-file.mjs'))}\n` +
      `export const createStore = (config, { dir }) => fileStore(dir + '/' + config.folder)\n`,
  )
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: './my-block.mjs', folder: 'elsewhere' }))
  assert.equal(board(dir, ['trust']).code, 0)
  assert.equal(board(dir, ['add', 'hello']).code, 0)
  assert.ok(fs.existsSync(path.join(dir, 'elsewhere', 'board.json')))
  assert.equal(JSON.parse(board(dir, ['doctor', '--json']).out).block, './my-block.mjs')
})

test('config.json can name a block package installed in the project, not beside modboard', () => {
  const project = tmp()
  const dir = path.join(project, '.modboard')
  fs.mkdirSync(dir, { recursive: true })
  const block = `import { fileStore } from ${JSON.stringify(path.join(ROOT, 'lib/store-file.mjs'))}\n` +
    `export const createStore = (config, { dir }) => fileStore(dir + '/' + config.folder)\n`
  // Two common shapes: conditional exports (scoped name), and a plain main.
  const shapes = {
    '@acme/board-store': { exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } }, file: 'dist/index.mjs' },
    'plain-store': { main: 'lib/store.mjs', file: 'lib/store.mjs' },
  }
  for (const [name, { file, ...pkg }] of Object.entries(shapes)) {
    const pkgDir = path.join(project, 'node_modules', name)
    fs.mkdirSync(path.dirname(path.join(pkgDir, file)), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, type: 'module', ...pkg }))
    fs.writeFileSync(path.join(pkgDir, file), block)
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: name, folder: name.replace('/', '_') }))
    assert.equal(board(dir, ['trust']).code, 0, name)
    assert.equal(board(dir, ['add', 'hello']).code, 0, name)
    assert.ok(fs.existsSync(path.join(dir, name.replace('/', '_'), 'board.json')), name)
    assert.equal(JSON.parse(board(dir, ['doctor', '--json']).out).block, name)
  }
})

test('a block that cannot load, or breaks the contract shape, is refused by name', () => {
  const dir = path.join(tmp(), '.modboard')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: './missing.mjs' }))
  board(dir, ['trust'])
  const missing = board(dir, ['list'])
  assert.equal(missing.code, 2)
  assert.match(missing.out, /cannot load storage block "\.\/missing\.mjs"/)

  fs.writeFileSync(path.join(dir, 'half.mjs'), 'export const createStore = () => ({ now: () => 0, snapshot: () => ({}) })\n')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: './half.mjs' }))
  board(dir, ['trust'])
  const half = board(dir, ['list'])
  assert.equal(half.code, 2)
  assert.match(half.out, /is missing: commit, events, verify/)
})

test("a project's block runs only once trusted, and a change to it asks again", () => {
  const dir = path.join(tmp(), '.modboard')
  fs.mkdirSync(dir, { recursive: true })
  const marker = path.join(dir, 'ran')
  const block = extra =>
    `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, 'yes')\n` +
    `import { fileStore } from ${JSON.stringify(path.join(ROOT, 'lib/store-file.mjs'))}\n` +
    `export const createStore = (config, { dir }) => fileStore(dir + '/data')\n${extra}`
  fs.writeFileSync(path.join(dir, 'cloned.mjs'), block(''))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: './cloned.mjs' }))

  const refused = board(dir, ['list'])
  assert.equal(refused.code, 12)
  assert.match(refused.out, /runs code on this machine.*board trust/)
  assert.equal(fs.existsSync(marker), false, 'the block never ran')

  assert.equal(board(dir, ['trust']).code, 0)
  assert.equal(board(dir, ['list']).code, 0)
  assert.equal(fs.existsSync(marker), true)

  fs.writeFileSync(path.join(dir, 'cloned.mjs'), block('// changed'))
  const changed = board(dir, ['list'])
  assert.equal(changed.code, 12)
  assert.match(changed.out, /changed since you trusted it/)

  // The built-in block needs none.
  const plain = path.join(tmp(), '.modboard')
  assert.equal(board(plain, ['add', 'x']).code, 0)
  assert.match(board(plain, ['trust']).out, /needs no trust/)
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
