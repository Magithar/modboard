// Secrets for blocks: kept in the OS keychain (here, the test stand-in), by
// name in your settings, given to a block of your own as an environment
// variable at run time, masked in what it prints, and never handed back.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { mask, setSecret } from '../lib/secrets.mjs'

const BOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'board.mjs')
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-')))

function machine() {
  const dir = tmp()
  const env = { ...process.env, BOARD_TEST_SECRETS_FILE: path.join(dir, 'keychain.json'), BOARD_SETTINGS_FILE: path.join(dir, 'settings.json'), BOARD_DIR: path.join(dir, '.modboard') }
  delete env.BOARD_AGENT
  const board = (args, input) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [BOARD, ...args], { cwd: dir, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) }
    } catch (err) {
      return { code: err.status, out: String(err.stderr) }
    }
  }
  return { dir, env, board, settings: () => fs.readFileSync(env.BOARD_SETTINGS_FILE, 'utf8') }
}

test('a secret is set from a pipe or a terminal, kept by name only, and never printed back', () => {
  const m = machine()
  assert.match(m.board(['secret', 'set', 'github', '--stdin'], 's3cr3t-value\n').out, /kept github in the keychain/)
  assert.deepEqual(JSON.parse(m.settings()).secrets, ['github'])
  assert.doesNotMatch(m.settings(), /s3cr3t/)
  assert.equal(m.board(['secret', 'list']).out.trim(), 'github')
  // No terminal and no --stdin: refused, not read from somewhere else.
  assert.match(m.board(['secret', 'set', 'other'], '').out, /asks at a terminal/)
  // No command gives a value back.
  for (const args of [['secret', 'get', 'github'], ['secret', 'show', 'github']]) assert.equal(m.board(args).code, 2)
  assert.match(m.board(['secret', 'remove', 'github']).out, /removed github/)
  assert.deepEqual(JSON.parse(m.settings()).secrets, [])
})

test('a secret has a good name and is one line', () => {
  const store = { set() {}, get: () => null, remove() {} }
  for (const [name, value] of [['', 'x'], ['1abc', 'x'], ['a b', 'x'], ['ok', ''], ['ok', 'two\nlines'], ['ok', 'x'.repeat(4097)]])
    assert.throws(() => setSecret(name, value, store), { code: 2 }, JSON.stringify([name, value.slice(0, 10)]))
  assert.deepEqual(setSecret('github.token', 'v', store), { secret: 'github.token', set: true })
})

test('a block of your own gets its secret as a variable, and its value is masked in the line', () => {
  const m = machine()
  m.board(['secret', 'set', 'api', '--stdin'], 's3cr3t-value')
  fs.writeFileSync(
    m.env.BOARD_SETTINGS_FILE,
    JSON.stringify({ secrets: ['api'], blocks: { enabled: ['check', 'leak', 'needs'], commands: {
      check: { run: 'test -n "$API_TOKEN" && echo "token is set"', secrets: { API_TOKEN: 'api' } },
      leak: { run: 'echo "token=$API_TOKEN"', secrets: { API_TOKEN: 'api' } },
      needs: { run: 'echo hi', secrets: { OTHER: 'missing-one' } },
    } } }),
  )
  const lines = Object.fromEntries(JSON.parse(m.board(['blocks', '--json']).out).lines.map(l => [l.id, l]))
  assert.equal(lines.check.text, 'token is set')
  assert.equal(lines.leak.text, 'token=••••')
  assert.deepEqual([lines.needs.state, lines.needs.text], ['missing', 'needs secret missing-one: board secret set missing-one'])
  assert.doesNotMatch(JSON.stringify(lines), /s3cr3t/)
  // --all names which secret a block uses, never its value.
  assert.match(m.board(['blocks', '--all']).out, /leak .*secrets: API_TOKEN=api/)
})

test('--secret takes VAR=name', () => {
  const m = machine()
  for (const bad of ['nope', '=api', 'lower=api'])
    assert.equal(m.board(['blocks', 'add', 'x', '--run', 'echo', '--secret', bad]).code, 2, bad)
})

test('mask hides every occurrence of a value, and leaves short ones', () => {
  assert.equal(mask('a s3cr3t b s3cr3t', ['s3cr3t']), 'a •••• b ••••')
  assert.equal(mask('abc', ['ab']), 'abc')
})
